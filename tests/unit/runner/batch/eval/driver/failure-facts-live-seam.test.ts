/**
 * RFC-07 packet G3 — bundle-live failure-facts LIVE-SEAM integration.
 *
 * Drives the runner-side adapter (`deriveLiveFailureFacts`) AND the real
 * `prepareIssueHint` seam it is wired into, proving:
 *   - a real observation callback (live bundle + in-memory events) NOW emits a
 *     versioned fact record (RED before the extractor call existed);
 *   - a source/run/attempt mismatch is surfaced as an explicit `unavailable`
 *     (representable, not silently mis-stamped);
 *   - the wiring is NON-VACUOUS: deleting the `extractFailureFacts(...)` call
 *     inside the adapter leaves BOTH sinks silent — a bare import is insufficient.
 */

import { describe, expect, test } from "bun:test"
import type { AgentlessLocalizeResult } from "@/agent"
import { computeFailureSourceDigest } from "@/agent/observation/metrics"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import type { FailureTaxonomyFactsV1 } from "@/observability/failure-taxonomy"
import {
  deriveLiveFailureFacts,
  type FailureFactsUnavailable,
  type FailureFactsWiring,
  prepareIssueHint,
} from "@/runner/batch/eval/driver"
import type { Instance } from "../../../../../../src/apps/bench/types"
import { bundle, call, owner } from "../../../../agent/observation/metrics/fixtures"

const B = bundle([owner("pkg/a.py"), owner("pkg/b.py")])
const CAPTURED = { runId: "run-1", attemptId: "att-1" } as const

class StubLLM implements LLMPort {
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

const mkInstance = (problemStatement: string): Instance => ({
  id: "test",
  repoPath: "/tmp/x",
  problemStatement,
  testCmd: "true",
})

/** Collecting sinks for one wiring invocation. */
const sinks = (): {
  facts: FailureTaxonomyFactsV1[]
  unavailable: FailureFactsUnavailable[]
  wiring: (extra: Partial<FailureFactsWiring>) => FailureFactsWiring
} => {
  const facts: FailureTaxonomyFactsV1[] = []
  const unavailable: FailureFactsUnavailable[] = []
  return {
    facts,
    unavailable,
    wiring: (extra) => ({
      expected: { ...CAPTURED, sourceDigest: computeFailureSourceDigest(B) },
      capturedUnder: CAPTURED,
      onFacts: (f) => facts.push(f),
      onUnavailable: (u) => unavailable.push(u),
      ...extra,
    }),
  }
}

describe("deriveLiveFailureFacts — the bundle-live callback adapter", () => {
  test("COMPLETE observation ⇒ onFacts fires with a versioned, counted record", () => {
    const s = sinks()
    deriveLiveFailureFacts(
      B,
      s.wiring({ events: [call("agent", {}), call("request_user_input", {})] }),
    )
    expect(s.unavailable).toHaveLength(0)
    expect(s.facts).toHaveLength(1)
    const facts = s.facts[0]
    expect(facts?.runId).toBe("run-1")
    expect(facts?.attemptId).toBe("att-1")
    expect(facts?.sourceDigest).toBe(computeFailureSourceDigest(B))
    expect(facts?.rawCounts.subagentsSpawned).toBe(1)
    expect(facts?.rawCounts.questionsAsked).toBe(1)
  })

  test("UNAVAILABLE observation (source mismatch) ⇒ onUnavailable fires, no facts", () => {
    const s = sinks()
    deriveLiveFailureFacts(
      B,
      s.wiring({ expected: { ...CAPTURED, sourceDigest: "fnv1a32:deadbeef" } }),
    )
    expect(s.facts).toHaveLength(0)
    expect(s.unavailable).toHaveLength(1)
    expect(s.unavailable[0]?.reason).toBe("identity_mismatch")
    expect(s.unavailable[0]?.mismatch?.axis).toBe("sourceDigest")
  })

  test("NON-VACUOUS: exactly ONE sink fires per invocation (deleting the extractor call silences both)", () => {
    // If the adapter never CALLED extractFailureFacts, neither array would grow —
    // this asserts the total is 1, which fails for a no-op / bare-import adapter.
    const s = sinks()
    deriveLiveFailureFacts(B, s.wiring({ events: [] }))
    expect(s.facts.length + s.unavailable.length).toBe(1)
  })
})

describe("prepareIssueHint — failure-facts wired at the LIVE onObservationBundle seam", () => {
  const fakeLocalize = async (): Promise<AgentlessLocalizeResult> => ({
    files: ["pkg/a.py", "pkg/b.py"],
    rationales: ["r1", "r2"],
    rawResponse: "raw",
  })

  const runSeam = async (
    wiring: FailureFactsWiring,
    onBundle?: (b: Parameters<typeof computeFailureSourceDigest>[0]) => void,
  ): Promise<void> => {
    await prepareIssueHint(mkInstance("bug in pkg/a.py"), "/tmp/sb", "agentless", {
      llm: new StubLLM(),
      issueHintExpectedActual: false,
      fileTree: async () => ["pkg/a.py", "pkg/b.py"],
      localize: fakeLocalize,
      lspPrefetch: false,
      renderObservations: false,
      ...(onBundle !== undefined ? { onObservationBundle: onBundle } : {}),
      failureFacts: wiring,
    })
  }

  test("run mismatch at the real seam ⇒ onUnavailable fires (deterministic wiring proof)", async () => {
    const s = sinks()
    // capturedUnder disagrees with the caller binding ⇒ mismatch regardless of digest.
    await runSeam(s.wiring({ capturedUnder: { runId: "run-OTHER", attemptId: "att-1" } }))
    expect(s.facts).toHaveLength(0)
    expect(s.unavailable).toHaveLength(1)
    expect(s.unavailable[0]?.mismatch?.axis).toBe("runId")
  })

  test("matching identity at the real seam ⇒ onFacts fires with the live bundle's digest", async () => {
    // The production bundle is built INSIDE prepareIssueHint; capture it first to
    // bind the exact expected digest, then re-run so onFacts matches.
    let liveDigest: string | undefined
    await runSeam(sinks().wiring({}), (b) => {
      liveDigest = computeFailureSourceDigest(b)
    })
    expect(liveDigest).toBeDefined()
    const s = sinks()
    await runSeam(s.wiring({ expected: { ...CAPTURED, sourceDigest: liveDigest as string } }))
    expect(s.unavailable).toHaveLength(0)
    expect(s.facts).toHaveLength(1)
    expect(s.facts[0]?.sourceDigest).toBe(liveDigest)
    // No agent-run events at the pre-agent localize seam ⇒ counts ABSENT (per-signal
    // unavailable), NOT a fabricated 0.
    expect(s.facts[0]?.rawCounts).toEqual({})
  })
})
