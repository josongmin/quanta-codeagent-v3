/**
 * RFC-07 packet G4 — atomic inline per-attempt failure-facts persistence.
 *
 * The DTO + atomic writer + strict reader hellgate:
 *   - close/reopen ROUNDTRIP: a committed record survives a fresh reader
 *     ("restart"), on a REAL temp disk via the production `nodeFactsStoreIO`;
 *   - ATOMICITY: an injected writer failure publishes NEITHER result nor facts
 *     (the reader sees `absent`), never a partial;
 *   - REJECT: an `unavailable` extraction (mismatch/incomplete) is NOT persisted
 *     (partial/mismatched facts rejected);
 *   - STRICT identity: run/attempt/source disagreement ⇒ explicit `unavailable`;
 *   - fail-closed decode: legacy absence / corrupt / unknown record version /
 *     unknown facts version ⇒ `unavailable`, never a best-effort partial.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { FailureFactsExtraction, FailureFactsIdentity } from "@/agent/observation/metrics"
import {
  FAILURE_TAXONOMY_SCHEMA_VERSION,
  type FailureTaxonomyFactsV1,
} from "@/observability/failure-taxonomy"
import {
  ATTEMPT_FACTS_RECORD_SCHEMA_VERSION,
  attemptFactsRecordPath,
  commitAttemptFacts,
  type FactsStoreIO,
  nodeFactsStoreIO,
  readAttemptFacts,
} from "@/runner/batch/failure-facts"

const facts = (over: Partial<FailureTaxonomyFactsV1> = {}): FailureTaxonomyFactsV1 => ({
  schemaVersion: FAILURE_TAXONOMY_SCHEMA_VERSION,
  runId: "run-1",
  attemptId: "inst.0",
  sourceDigest: "fnv1a32:abc1234",
  rawCounts: { subagentsSpawned: 2, questionsAsked: 1 },
  ...over,
})

const id = (over: Partial<FailureFactsIdentity> = {}): FailureFactsIdentity => ({
  runId: "run-1",
  attemptId: "inst.0",
  sourceDigest: "fnv1a32:abc1234",
  ...over,
})

const extracted = (f: FailureTaxonomyFactsV1): FailureFactsExtraction => ({
  kind: "extracted",
  facts: f,
})

/** In-memory store that models the atomicity contract: `writeAtomic` publishes
 *  ONLY on success (a throw leaves the map untouched — no partial). */
const memIO = (
  opts: { throwOnWrite?: boolean } = {},
): { io: FactsStoreIO; store: Map<string, string> } => {
  const store = new Map<string, string>()
  return {
    store,
    io: {
      ensureDir: () => {},
      writeAtomic: (path, data) => {
        if (opts.throwOnWrite) throw new Error("injected writer failure")
        store.set(path, data)
      },
      read: (path) => store.get(path),
    },
  }
}

const PATH = "/facts/run-1/inst.0.facts.json"

describe("commitAttemptFacts — atomic inline write", () => {
  test("extracted ⇒ persists a versioned record readable back (roundtrip)", () => {
    const { io } = memIO()
    const commit = commitAttemptFacts(io, PATH, extracted(facts()))
    expect(commit.kind).toBe("persisted")
    const read = readAttemptFacts(io, PATH, id())
    expect(read.kind).toBe("available")
    if (read.kind === "available") expect(read.facts).toEqual(facts())
  })

  test("ATOMICITY: injected writer failure ⇒ throws AND publishes NEITHER result nor facts", () => {
    const { io, store } = memIO({ throwOnWrite: true })
    expect(() => commitAttemptFacts(io, PATH, extracted(facts()))).toThrow(
      "injected writer failure",
    )
    expect(store.size).toBe(0)
    // A reader sees absence — no partial record landed.
    expect(readAttemptFacts(io, PATH, id())).toEqual({ kind: "unavailable", reason: "absent" })
  })

  test("REJECT: an `unavailable` extraction is NOT persisted (mismatch/partial rejected)", () => {
    const { io, store } = memIO()
    const commit = commitAttemptFacts(io, PATH, {
      kind: "unavailable",
      reason: "identity_mismatch",
      mismatch: { axis: "runId", expected: "run-1", observed: "run-OTHER" },
    })
    expect(commit).toEqual({ kind: "rejected", reason: "identity_mismatch" })
    expect(store.size).toBe(0)
    expect(readAttemptFacts(io, PATH, id()).kind).toBe("unavailable")
  })
})

describe("readAttemptFacts — strict, fail-closed decode", () => {
  test("legacy absence ⇒ unavailable(absent)", () => {
    const { io } = memIO()
    expect(readAttemptFacts(io, PATH, id())).toEqual({ kind: "unavailable", reason: "absent" })
  })

  test("STRICT identity: each of run/attempt/source mismatch ⇒ unavailable(identity_mismatch)", () => {
    const { io } = memIO()
    commitAttemptFacts(io, PATH, extracted(facts()))
    for (const [over, axis] of [
      [{ runId: "run-OTHER" }, "runId"],
      [{ attemptId: "inst.9" }, "attemptId"],
      [{ sourceDigest: "fnv1a32:deadbeef" }, "sourceDigest"],
    ] as const) {
      const read = readAttemptFacts(io, PATH, id(over))
      expect(read.kind).toBe("unavailable")
      if (read.kind === "unavailable") {
        expect(read.reason).toBe("identity_mismatch")
        expect(read.mismatch?.axis).toBe(axis)
      }
    }
  })

  test("corrupt JSON ⇒ unavailable(corrupt)", () => {
    const { io, store } = memIO()
    store.set(PATH, "{not json")
    expect(readAttemptFacts(io, PATH, id())).toEqual({ kind: "unavailable", reason: "corrupt" })
  })

  test("unknown RECORD version ⇒ unavailable(unknown_record_version), never best-effort", () => {
    const { io, store } = memIO()
    store.set(PATH, JSON.stringify({ recordSchemaVersion: 999, facts: facts() }))
    expect(readAttemptFacts(io, PATH, id())).toEqual({
      kind: "unavailable",
      reason: "unknown_record_version",
    })
  })

  test("unknown FACTS version ⇒ unavailable(unknown_facts_version)", () => {
    const { io, store } = memIO()
    store.set(
      PATH,
      JSON.stringify({
        recordSchemaVersion: ATTEMPT_FACTS_RECORD_SCHEMA_VERSION,
        facts: { ...facts(), schemaVersion: 999 },
      }),
    )
    expect(readAttemptFacts(io, PATH, id())).toEqual({
      kind: "unavailable",
      reason: "unknown_facts_version",
    })
  })

  test("malformed facts (missing field) ⇒ unavailable(malformed_facts)", () => {
    const { io, store } = memIO()
    store.set(
      PATH,
      JSON.stringify({
        recordSchemaVersion: ATTEMPT_FACTS_RECORD_SCHEMA_VERSION,
        facts: { schemaVersion: 1 },
      }),
    )
    expect(readAttemptFacts(io, PATH, id())).toEqual({
      kind: "unavailable",
      reason: "malformed_facts",
    })
  })
})

describe("nodeFactsStoreIO — REAL disk close/reopen roundtrip (restart survival)", () => {
  test("committed record survives a fresh reader; write is atomic (no .tmp left)", () => {
    const dir = mkdtempSync(join(tmpdir(), "g4-facts-"))
    try {
      const path = attemptFactsRecordPath(dir, "run-1", "inst", 0)
      const commit = commitAttemptFacts(nodeFactsStoreIO, path, extracted(facts()))
      expect(commit.kind).toBe("persisted")
      expect(existsSync(path)).toBe(true)
      // Fresh read (simulates process restart) via the production reader.
      const read = readAttemptFacts(nodeFactsStoreIO, path, id())
      expect(read.kind).toBe("available")
      if (read.kind === "available") expect(read.facts).toEqual(facts())
      // The on-disk payload is exactly the versioned record envelope.
      const onDisk = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
      expect(onDisk.recordSchemaVersion).toBe(ATTEMPT_FACTS_RECORD_SCHEMA_VERSION)
      // No orphaned temp sibling remains after the atomic rename.
      const runDir = join(dir, "run-1")
      expect(readdirSync(runDir).filter((f) => f.endsWith(".tmp"))).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
