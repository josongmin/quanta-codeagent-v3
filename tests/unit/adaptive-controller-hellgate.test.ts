/**
 * Hellgate for the v5 adaptive-escalation CONTROLLER orchestrator (jun-22 Wave-1).
 * Proves the bounded run loop composes the three skeletons correctly with FAKE
 * ports (no LLM, no driver): fail-closed on bad output, bounded against loops,
 * correct action→posture-module mapping, packet re-route, typed stop reasons.
 */

import { describe, expect, test } from "bun:test"
import {
  type AdaptiveExecutorInput,
  type AdaptiveRouterInput,
  DEFAULT_ADAPTIVE_LIMITS,
  runAdaptiveEscalation,
} from "@/runner/batch/eval/adaptive-escalation"
import { PHASE_MODULES } from "@/runner/batch/eval/posture"

/** Minimal packet: just the citable evidence ids the router may reference. */
interface FakePacket {
  readonly evidenceIds: ReadonlySet<string>
}
const packet = (...ids: string[]): FakePacket => ({ evidenceIds: new Set(ids) })

const decision = (action: string, citedEvidenceIds: string[] = []) => ({
  action,
  evidenceGaps: [],
  citedEvidenceIds,
  why: "x",
})

/** Scripted router: pops one raw output per call; records what it saw. */
const scriptedRouter = (script: readonly unknown[]) => {
  const seen: AdaptiveRouterInput<FakePacket>[] = []
  let i = 0
  const router = (input: AdaptiveRouterInput<FakePacket>): Promise<unknown> => {
    seen.push(input)
    return Promise.resolve(script[Math.min(i++, script.length - 1)])
  }
  return { router, seen }
}

/** Executor that records calls and hands back a fresh packet per step. */
const recordingExecutor = (nextPacket: (n: number) => FakePacket = () => packet("ev:1")) => {
  const calls: AdaptiveExecutorInput<FakePacket>[] = []
  const executor = (input: AdaptiveExecutorInput<FakePacket>): Promise<{ packet: FakePacket }> => {
    calls.push(input)
    return Promise.resolve({ packet: nextPacket(calls.length) })
  }
  return { executor, calls }
}

const run = (script: readonly unknown[], initial: FakePacket, exec = recordingExecutor()) => {
  const { router, seen } = scriptedRouter(script)
  return runAdaptiveEscalation({
    initialPacket: initial,
    citableIds: (p) => p.evidenceIds,
    router,
    executor: exec.executor,
  }).then((result) => ({ result, seen, calls: exec.calls }))
}

describe("adaptive-escalation controller", () => {
  test("CTRL-1: accept_thin finalizes WITHOUT executing a phase", async () => {
    const exec = recordingExecutor()
    const { result, calls } = await run([decision("accept_thin")], packet("ev:1"), exec)
    expect(result.outcome).toBe("finalize")
    expect(result.reason).toBe("terminal_action")
    expect(calls.length).toBe(0)
  })

  test("CTRL-2: a finalize_after action executes ONCE with the mapped modules", async () => {
    const exec = recordingExecutor()
    const { result, calls } = await run([decision("run_proof_clean")], packet("ev:1"), exec)
    expect(result.outcome).toBe("finalize")
    expect(calls.length).toBe(1)
    expect(calls[0]?.modules).toBe(PHASE_MODULES.run_proof_clean)
    expect(result.steps).toEqual(["run_proof_clean"])
  })

  test("CTRL-3: invalid router output FAILS CLOSED (escalate, never finalize, no exec)", async () => {
    const exec = recordingExecutor()
    const { result, calls } = await run([decision("run_everything")], packet("ev:1"), exec)
    expect(result.outcome).toBe("escalate_needs_human")
    expect(result.reason).toContain("unknown_action")
    expect(calls.length).toBe(0)
  })

  test("CTRL-4: a cited id outside the packet FAILS CLOSED", async () => {
    const { result } = await run([decision("run_proof_clean", ["ev:ghost"])], packet("ev:1"))
    expect(result.outcome).toBe("escalate_needs_human")
    expect(result.reason).toContain("uncited_evidence_id")
  })

  test("CTRL-5: a re-route loop is BOUNDED by the per-action cap (typed stop)", async () => {
    // Router always asks to deepen localization (cheap reroute). Must terminate.
    const exec = recordingExecutor()
    const { result, calls } = await run([decision("deeper_localize")], packet("ev:1"), exec)
    expect(result.outcome).toBe("stop")
    expect(result.reason).toBe("max_per_action_exhausted")
    expect(calls.length).toBe(DEFAULT_ADAPTIVE_LIMITS.maxPerAction)
  })

  test("CTRL-6: expensive escalations are capped (typed stop)", async () => {
    // run_public_repro is expensive AND reroute → loops until maxExpensive.
    const exec = recordingExecutor()
    const { result, calls } = await run([decision("run_public_repro")], packet("ev:1"), exec)
    expect(result.outcome).toBe("stop")
    expect(result.reason).toBe("max_expensive_exhausted")
    expect(calls.length).toBe(DEFAULT_ADAPTIVE_LIMITS.maxExpensive)
  })

  test("CTRL-7: stop_infra_or_budget stops with the typed reason, no exec", async () => {
    const exec = recordingExecutor()
    const { result, calls } = await run([decision("stop_infra_or_budget")], packet("ev:1"), exec)
    expect(result.outcome).toBe("stop")
    expect(result.reason).toBe("infra_or_budget")
    expect(calls.length).toBe(0)
  })

  test("CTRL-8: re-route feeds the FRESH packet to the next route", async () => {
    // step1: deeper_localize (reroute) → executor returns packet(ev:new);
    // step2: router must now see ev:new and can cite it.
    const exec = recordingExecutor(() => packet("ev:new"))
    const { router, seen } = scriptedRouter([
      decision("deeper_localize"),
      decision("accept_thin", ["ev:new"]),
    ])
    const result = await runAdaptiveEscalation({
      initialPacket: packet("ev:orig"),
      citableIds: (p) => p.evidenceIds,
      router,
      executor: exec.executor,
    })
    expect(result.outcome).toBe("finalize")
    expect(seen[0]?.citableIds.has("ev:orig")).toBe(true)
    expect(seen[1]?.citableIds.has("ev:new")).toBe(true)
    expect(result.steps).toEqual(["deeper_localize"])
  })
})
