/**
 * RFC-07 packet G3 — bundle-live failure-facts EXTRACTOR unit tests.
 *
 * Pins the derivation contract: exact-identity binding (never inferred), an
 * explicit `unavailable` on incomplete/mismatched identity (source/run/attempt
 * mismatch REPRESENTABLE, not silently mis-stamped), the closed event→count
 * mapping, and — the load-bearing anti-vacuity invariant — an ABSENT event slice
 * leaves counts absent (per-signal unavailable) rather than fabricating a 0.
 */

import { beforeEach, describe, expect, test } from "bun:test"
import {
  adaptFailureCountEvents,
  computeFailureSourceDigest,
  extractFailureFacts,
  type FailureFactsIdentity,
  type MetricEvent,
} from "@/agent/observation/metrics"
import { FAILURE_TAXONOMY_SCHEMA_VERSION } from "@/observability/failure-taxonomy"
import { bundle, call, emptyBundle, owner, resetSeq } from "./fixtures"

beforeEach(resetSeq)

const B = bundle([owner("pkg/a.py"), owner("pkg/b.py")])
const CAPTURED = { runId: "run-1", attemptId: "att-1" } as const

/** Build the caller binding whose sourceDigest matches the given bundle. */
const bindingFor = (b: Parameters<typeof computeFailureSourceDigest>[0]): FailureFactsIdentity => ({
  runId: CAPTURED.runId,
  attemptId: CAPTURED.attemptId,
  sourceDigest: computeFailureSourceDigest(b),
})

const spawnAgent = (): MetricEvent => call("agent", { description: "child" })
const spawnSide = (): MetricEvent => call("side_agent_spawn", { description: "daemon" })
const askInput = (): MetricEvent => call("request_user_input", { question: "?" })
const askUser = (): MetricEvent => call("ask_user", { question: "?" })

describe("adaptFailureCountEvents — closed normalization", () => {
  test("maps the two spawn tools and the two question tools; drops everything else", () => {
    const events = [
      spawnAgent(),
      spawnSide(),
      askInput(),
      askUser(),
      call("read", { path: "x.py" }),
      call("bash", { command: "ls" }),
      { kind: "assistant_text", data: { delta: "hi" } } as MetricEvent,
    ]
    const adapted = adaptFailureCountEvents(events)
    expect(adapted).toEqual([
      { kind: "subagent_spawn" },
      { kind: "subagent_spawn" },
      { kind: "user_question" },
      { kind: "user_question" },
    ])
  })

  test("an unrelated tool never inflates a count (empty out)", () => {
    expect(adaptFailureCountEvents([call("web_search", { q: "x" })])).toEqual([])
  })
})

describe("computeFailureSourceDigest — stable + source-bound", () => {
  test("deterministic for the same bundle", () => {
    expect(computeFailureSourceDigest(B)).toBe(computeFailureSourceDigest(B))
  })

  test("changes when the source (owners/contributors) changes", () => {
    expect(computeFailureSourceDigest(B)).not.toBe(
      computeFailureSourceDigest(bundle([owner("pkg/a.py")])),
    )
    expect(computeFailureSourceDigest(emptyBundle())).not.toBe(computeFailureSourceDigest(B))
  })
})

describe("extractFailureFacts — complete observation", () => {
  test("events present ⇒ stream-derived tally (both counts defined), exact identity + computed digest stamped", () => {
    const events = [spawnAgent(), spawnSide(), askInput(), call("read", { path: "x.py" })]
    const expected = bindingFor(B)
    const out = extractFailureFacts({ bundle: B, events, capturedUnder: CAPTURED }, expected)
    expect(out.kind).toBe("extracted")
    if (out.kind !== "extracted") throw new Error("arm")
    expect(out.facts.schemaVersion).toBe(FAILURE_TAXONOMY_SCHEMA_VERSION)
    expect(out.facts.runId).toBe("run-1")
    expect(out.facts.attemptId).toBe("att-1")
    // Digest is the one the LIVE bundle actually produces, not a caller assertion.
    expect(out.facts.sourceDigest).toBe(computeFailureSourceDigest(B))
    // 2 spawns, 1 question — mapping direction is not swapped.
    expect(out.facts.rawCounts.subagentsSpawned).toBe(2)
    expect(out.facts.rawCounts.questionsAsked).toBe(1)
  })

  test("empty event slice ⇒ real tally of ZERO (both counts DEFINED as 0)", () => {
    const out = extractFailureFacts(
      { bundle: B, events: [], capturedUnder: CAPTURED },
      bindingFor(B),
    )
    if (out.kind !== "extracted") throw new Error("arm")
    expect(out.facts.rawCounts.subagentsSpawned).toBe(0)
    expect(out.facts.rawCounts.questionsAsked).toBe(0)
  })

  test("ABSENT event slice ⇒ counts absent (per-signal unavailable), NEVER a fabricated 0", () => {
    const out = extractFailureFacts({ bundle: B, capturedUnder: CAPTURED }, bindingFor(B))
    if (out.kind !== "extracted") throw new Error("arm")
    expect(out.facts.rawCounts.subagentsSpawned).toBeUndefined()
    expect(out.facts.rawCounts.questionsAsked).toBeUndefined()
    expect(out.facts.rawCounts).toEqual({})
  })
})

describe("extractFailureFacts — explicit unavailable (fail-closed)", () => {
  const good = bindingFor(B)

  test("incomplete expected identity ⇒ identity_incomplete (each axis)", () => {
    for (const bad of [
      { ...good, runId: "" },
      { ...good, attemptId: "" },
      { ...good, sourceDigest: "" },
    ]) {
      const out = extractFailureFacts({ bundle: B, capturedUnder: CAPTURED }, bad)
      expect(out).toEqual({ kind: "unavailable", reason: "identity_incomplete" })
    }
  })

  test("incomplete capturedUnder identity ⇒ identity_incomplete", () => {
    const out = extractFailureFacts(
      { bundle: B, capturedUnder: { runId: "", attemptId: "att-1" } },
      good,
    )
    expect(out).toEqual({ kind: "unavailable", reason: "identity_incomplete" })
  })

  test("run mismatch is REPRESENTED + surfaced (not silently stamped)", () => {
    const out = extractFailureFacts(
      { bundle: B, capturedUnder: { runId: "run-OTHER", attemptId: "att-1" } },
      good,
    )
    expect(out).toEqual({
      kind: "unavailable",
      reason: "identity_mismatch",
      mismatch: { axis: "runId", expected: "run-1", observed: "run-OTHER" },
    })
  })

  test("attempt mismatch is represented (axis=attemptId)", () => {
    const out = extractFailureFacts(
      { bundle: B, capturedUnder: { runId: "run-1", attemptId: "att-OTHER" } },
      good,
    )
    if (out.kind !== "unavailable") throw new Error("arm")
    expect(out.mismatch).toEqual({ axis: "attemptId", expected: "att-1", observed: "att-OTHER" })
  })

  test("SOURCE mismatch (live bundle digest ≠ caller's bound digest) ⇒ axis=sourceDigest", () => {
    // Caller bound the digest of a DIFFERENT source; the live bundle disagrees.
    const staleBinding: FailureFactsIdentity = {
      ...CAPTURED,
      sourceDigest: computeFailureSourceDigest(bundle([owner("pkg/z.py")])),
    }
    const out = extractFailureFacts({ bundle: B, capturedUnder: CAPTURED }, staleBinding)
    if (out.kind !== "unavailable") throw new Error("arm")
    expect(out.reason).toBe("identity_mismatch")
    expect(out.mismatch?.axis).toBe("sourceDigest")
    expect(out.mismatch?.observed).toBe(computeFailureSourceDigest(B))
  })

  test("mismatch precedence: run before attempt before source", () => {
    const out = extractFailureFacts(
      { bundle: B, capturedUnder: { runId: "x", attemptId: "y" } },
      { runId: "a", attemptId: "b", sourceDigest: "nope" },
    )
    if (out.kind !== "unavailable") throw new Error("arm")
    expect(out.mismatch?.axis).toBe("runId")
  })
})
