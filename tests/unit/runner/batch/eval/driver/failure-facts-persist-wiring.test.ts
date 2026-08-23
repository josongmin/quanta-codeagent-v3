/**
 * RFC-07 packet G4 — PRODUCTION failure-facts persist wiring.
 *
 * Proves the extractor now runs in PRODUCTION (its only prior caller was a test)
 * and PERSISTS inline, at three escalating fidelities:
 *
 *   1. `buildLocalizeFailureFactsSeam` — the production provider — persists an
 *      identity-matched record via the atomic writer, and REJECTS a stream-crossed
 *      (capturedUnder-mismatch) observation (nothing written).
 *   2. The REAL `prepareIssueHint` seam, driven with the production provider,
 *      persists a readable record — deleting the `extractFailureFacts(...)` call
 *      in localize-prep leaves the store empty (non-vacuous seam proof).
 *   3. The PRODUCTION entry `prepareAttemptContext`, end-to-end (stub LLM +
 *      temp sandbox + observe handle), writes a real on-disk facts record —
 *      removing the wiring in `prepareHintAndReproContext` makes the extractor
 *      silent again (red-on-injection).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentlessLocalizeResult } from "@/agent"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import {
  buildLocalizeFailureFactsSeam,
  prepareAttemptContext,
  prepareIssueHint,
  type RunInstanceDeps,
} from "@/runner/batch/eval/driver"
import {
  attemptFactsRecordPath,
  type FactsStoreIO,
  nodeFactsStoreIO,
  readAttemptFacts,
} from "@/runner/batch/failure-facts"
import type { AttemptObservation } from "@/runner/batch/observe"
import type { Instance } from "../../../../../../src/apps/bench/types"

/** In-memory facts store injected into the production provider. */
const memIO = (): { io: FactsStoreIO; store: Map<string, string> } => {
  const store = new Map<string, string>()
  return {
    store,
    io: {
      ensureDir: () => {},
      writeAtomic: (path, data) => {
        store.set(path, data)
      },
      read: (path) => store.get(path),
    },
  }
}

/** Stub LLM whose localize reply parses into exactly `pkg/a.py`. */
class FileLineLLM implements LLMPort {
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: "FILE: pkg/a.py\nREASON: the bug lives here\n" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

const OBSERVE = (dir: string): AttemptObservation => ({ dir, runId: "run-1", attempt: 0 })

describe("buildLocalizeFailureFactsSeam — the production provider", () => {
  test("identity-matched observation ⇒ persists a record readable by attempt identity", () => {
    const { io } = memIO()
    const seam = buildLocalizeFailureFactsSeam(OBSERVE("/obs"), "inst", io)
    // The live localize bundle: onObservationBundle binds the expected source
    // digest, then the failure-facts sink fires with a matching capturedUnder.
    const bundle = {
      owners: [{ file: "pkg/a.py", evidence: "e", source: "static-owner" }],
      contributors: ["static-owner"],
    }
    seam.onObservationBundle(bundle)
    seam.failureFacts.onFacts({
      schemaVersion: 1,
      runId: "run-1",
      attemptId: "inst.0",
      sourceDigest: seam.failureFacts.expected.sourceDigest,
      rawCounts: {},
    })
    const path = attemptFactsRecordPath("/obs", "run-1", "inst", 0)
    const read = readAttemptFacts(io, path, {
      runId: "run-1",
      attemptId: "inst.0",
      sourceDigest: seam.failureFacts.expected.sourceDigest,
    })
    expect(read.kind).toBe("available")
  })

  test("BEST-EFFORT: a persist IO failure does NOT throw out of the sink (attempt survives)", () => {
    const throwingIO: FactsStoreIO = {
      ensureDir: () => {},
      writeAtomic: () => {
        throw new Error("disk full")
      },
      read: () => undefined,
    }
    const seam = buildLocalizeFailureFactsSeam(OBSERVE("/obs"), "inst", throwingIO)
    seam.onObservationBundle({ owners: [], contributors: [] })
    // Observe-only: an IO fault must be swallowed (logged), never propagated —
    // otherwise a benign facts-write hiccup would degrade the whole instance.
    expect(() =>
      seam.failureFacts.onFacts({
        schemaVersion: 1,
        runId: "run-1",
        attemptId: "inst.0",
        sourceDigest: "fnv1a32:x",
        rawCounts: {},
      }),
    ).not.toThrow()
  })

  test("REJECT: an unavailable outcome (crossed stream) persists NOTHING", () => {
    const { io, store } = memIO()
    const seam = buildLocalizeFailureFactsSeam(OBSERVE("/obs"), "inst", io)
    seam.failureFacts.onUnavailable({
      kind: "unavailable",
      reason: "identity_mismatch",
      mismatch: { axis: "runId", expected: "run-1", observed: "run-OTHER" },
    })
    expect(store.size).toBe(0)
  })
})

describe("prepareIssueHint — production provider at the REAL live seam", () => {
  const fakeLocalize = async (): Promise<AgentlessLocalizeResult> => ({
    files: ["pkg/a.py", "pkg/b.py"],
    rationales: ["r1", "r2"],
    rawResponse: "raw",
  })

  class StubLLM implements LLMPort {
    async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
      yield { type: "message_stop", stop_reason: "end_turn" }
    }
  }

  test("the extractor RUNS at the real seam and the provider PERSISTS an inline record", async () => {
    const { io, store } = memIO()
    const seam = buildLocalizeFailureFactsSeam(OBSERVE("/obs"), "inst", io)
    await prepareIssueHint(
      { id: "inst", repoPath: "/tmp/x", problemStatement: "bug in pkg/a.py", testCmd: "true" },
      "/tmp/sb",
      "agentless",
      {
        llm: new StubLLM(),
        issueHintExpectedActual: false,
        fileTree: async () => ["pkg/a.py", "pkg/b.py"],
        localize: fakeLocalize,
        lspPrefetch: false,
        renderObservations: false,
        onObservationBundle: seam.onObservationBundle,
        failureFacts: seam.failureFacts,
      },
    )
    // A record landed at the attempt path (deleting extractFailureFacts in
    // localize-prep would leave `store` empty → RED).
    expect(store.size).toBe(1)
    const read = readAttemptFacts(io, attemptFactsRecordPath("/obs", "run-1", "inst", 0), {
      runId: "run-1",
      attemptId: "inst.0",
      sourceDigest: seam.failureFacts.expected.sourceDigest,
    })
    expect(read.kind).toBe("available")
    // No agent-run events at the pre-agent localize seam ⇒ counts ABSENT.
    if (read.kind === "available") expect(read.facts.rawCounts).toEqual({})
  })
})

describe("prepareAttemptContext — end-to-end PRODUCTION persist (real disk)", () => {
  const ENV_KEYS = ["QUANTA_BENCH_ISSUE_HINT", "QUANTA_OBS_LSP_PREFETCH"] as const
  let saved: Map<string, string | undefined>
  let dir: string
  beforeEach(() => {
    saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]))
    process.env.QUANTA_BENCH_ISSUE_HINT = "agentless"
    process.env.QUANTA_OBS_LSP_PREFETCH = "0"
    dir = mkdtempSync(join(tmpdir(), "g4-e2e-"))
  })
  afterEach(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(dir, { recursive: true, force: true })
  })

  test("observation ON ⇒ the localize seam persists a real facts record for the attempt", async () => {
    const sandbox = join(dir, "sb")
    mkdirSync(join(sandbox, "pkg"), { recursive: true })
    writeFileSync(join(sandbox, "pkg", "a.py"), "def f():\n    return 1\n")
    const observeDir = join(dir, "obs")

    const instance: Instance = {
      id: "inst",
      repoPath: sandbox,
      problemStatement: "there is a bug in pkg/a.py that returns the wrong value",
      testCmd: "true",
    }
    const deps: RunInstanceDeps = {
      llm: new FileLineLLM(),
      maxTurns: 1,
      timeoutMs: 5_000,
      observe: { dir: observeDir, runId: "run-1", attempt: 0 },
    }

    await prepareAttemptContext(instance, sandbox, deps, new AbortController().signal)

    // The production wiring in prepareHintAndReproContext derived + persisted the
    // facts inline. Removing that wiring makes this file absent (red-on-injection).
    const path = attemptFactsRecordPath(observeDir, "run-1", "inst", 0)
    expect(existsSync(path)).toBe(true)
    const record = JSON.parse(readFileSync(path, "utf8")) as {
      recordSchemaVersion: number
      facts: { runId: string; attemptId: string; sourceDigest: string; schemaVersion: number }
    }
    expect(record.recordSchemaVersion).toBe(1)
    expect(record.facts.runId).toBe("run-1")
    expect(record.facts.attemptId).toBe("inst.0")
    // Re-read strictly using the record's OWN (production-derived) digest — a real
    // record decodes to `available` under its authoritative identity.
    const read = readAttemptFacts(nodeFactsStoreIO, path, {
      runId: "run-1",
      attemptId: "inst.0",
      sourceDigest: record.facts.sourceDigest,
    })
    expect(read.kind).toBe("available")
  })
})
