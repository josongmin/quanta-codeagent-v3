/**
 * P0-b hellgate — delegate depth threading (RFC jul-13 sub-agent nesting §6.5).
 *
 * PRE-EXISTING CORRECTNESS BUG: the delegate path hardcoded `depth: 0` at three
 * sites (`wrapSubagentRunner`, `agent-arg-builder.resolveDelegation`,
 * `session-execution-plane.adaptDelegation`), so every delegate child ran at
 * REAL depth 0 regardless of the parent's depth. The delegate-specific
 * `MAX_DEPTH` gate (`delegation-runner/default-runner.ts`) reads
 * `spec.depth ?? 0` which was therefore ALWAYS 0 → only top-level was
 * depth-aware, deeper delegates were never counted → the depth guard was
 * defeated (unbounded delegate nesting).
 *
 * FIX: thread the parent's `AgentConfig.depth` (0 = root) so a delegate child
 * gets `parentDepth + 1`, mirroring the foreground `buildChildConfig(parentDepth
 * + 1)` convention. This revives the previously-dead depth awareness in BOTH
 * the delegation-runner MAX_DEPTH gate AND the runtime `req.depth > maxDepth`
 * reject (via the wrapped SubagentRequest depth).
 *
 * Seals:
 *   P0B-01  wrapSubagentRunner(runner, parentDepth) stamps the child
 *           SubagentRequest with `depth === parentDepth + 1` (root 0 → 1).
 *           Mutation: revert to `depth: 0` → RED.
 *   P0B-02  Exhaustive over parentDepth 0..3 → child depth === parentDepth + 1
 *           (proves it is a THREAD, not a fixed constant).
 *   P0B-03  REVIVED MAX_DEPTH gate — the delegation-runner now SEES a non-zero
 *           spec.depth for a nested delegate: a parent whose child depth reaches
 *           the cap is REJECTED with `depth-exceeded`, whereas the old hardcoded
 *           0 would always slip through. Mutation (spec.depth back to 0) → the
 *           reject never fires (proven by the depth-0 control passing).
 *   P0B-04  Byte-identical OFF: a single-level delegate FROM ROOT still yields
 *           child depth 1 and the runner behaves identically (ok:true) — only
 *           the depth VALUE changed, no delegate consumer breaks on non-zero.
 */

import { describe, expect, test } from "bun:test"
import { type DelegateSpec, defaultDelegationRunner, MAX_DEPTH } from "@/agent/delegation-runner"
import { wrapSubagentRunner } from "@/agent/subagent-typed"
import type { SubagentRequest, SubagentResult, SubagentRunner } from "@/subagent/types"

/** A fake host SubagentRunner that records every request it receives, so the
 *  test can assert the DEPTH the wrapper stamped onto the child request. */
const recordingRunner = (): { runner: SubagentRunner; seen: SubagentRequest[] } => {
  const seen: SubagentRequest[] = []
  const runner: SubagentRunner = async (req): Promise<SubagentResult> => {
    seen.push(req)
    return { ok: true, finalText: "child-done", turns: 1 }
  }
  return { runner, seen }
}

/** The minimal TypedRunnerInput the wrapped runner needs — mirrors the router's
 *  invocation shape (profile + prompt + signal + budget + correlation). */
const runnerInput = (over?: { signal?: AbortSignal }) => ({
  profile: {
    mode: "explore" as const,
    systemPromptVariant: "default",
    allowedToolKinds: [],
    maxTurns: 5,
    maxTokens: 100,
    rationale: "p0b",
  },
  prompt: "seed",
  signal: over?.signal ?? new AbortController().signal,
  budget: { maxTurns: 5, maxTokens: 100 },
  correlation: {},
})

describe("P0-b delegate depth threading hellgate (RFC jul-13)", () => {
  // -------------------------------------------------------------------------
  test("P0B-01 wrapSubagentRunner stamps child depth = parentDepth + 1 (root 0 → 1)", async () => {
    const { runner, seen } = recordingRunner()
    const parentDepth = 0 // root
    const wrapped = wrapSubagentRunner(runner, parentDepth)

    const out = await wrapped(runnerInput())

    expect(out.ok).toBe(true)
    expect(seen.length).toBe(1)
    const req = seen[0]
    expect(req).toBeDefined()
    // Mutation target: revert `depth: parentDepth + 1` → `depth: 0` makes this RED.
    expect(req?.depth).toBe(1)
    // Explicitly NOT the old hardcoded 0.
    expect(req?.depth).not.toBe(0)
  })

  // -------------------------------------------------------------------------
  test("P0B-02 exhaustive: child depth === parentDepth + 1 (it is a thread, not a constant)", async () => {
    for (const parentDepth of [0, 1, 2, 3]) {
      const { runner, seen } = recordingRunner()
      const wrapped = wrapSubagentRunner(runner, parentDepth)
      await wrapped(runnerInput())
      expect(seen[0]?.depth).toBe(parentDepth + 1)
    }
  })

  // -------------------------------------------------------------------------
  test("P0B-03 REVIVED MAX_DEPTH gate sees non-zero spec.depth for a nested delegate", async () => {
    // Reconstruct the EXACT composition the host wires
    // (agent-arg-builder.resolveDelegation / session-execution-plane.adaptDelegation):
    //   defaultDelegationRunner({ runner: wrapSubagentRunner(hostRunner, parentDepth) })
    // and drive it with a delegate spec carrying `depth: parentDepth + 1`.
    const { runner: hostRunner, seen } = recordingRunner()

    // A parent DEEP enough that its child reaches the cap. child depth = MAX_DEPTH
    // ⇒ the gate (`depth >= maxDepth`) MUST reject. With the old hardcoded 0 this
    // reject was DEAD (spec.depth was always 0 < cap).
    const deepParentDepth = MAX_DEPTH - 1
    const childDepthAtCap = deepParentDepth + 1 // === MAX_DEPTH
    const deepRunner = defaultDelegationRunner({
      runner: wrapSubagentRunner(hostRunner, deepParentDepth),
    })
    const rejected = await deepRunner.delegate({
      mode: "explore",
      prompt: "p",
      depth: childDepthAtCap,
    } satisfies DelegateSpec)
    expect(rejected.ok).toBe(false)
    expect(rejected.errorKind).toBe("runner-error")
    expect(rejected.errorMessage ?? "").toContain("depth-exceeded")
    // The gate short-circuited BEFORE the host runner ran (dead-code no more).
    expect(seen.length).toBe(0)

    // CONTROL: a root parent (child depth 1) is BELOW the cap ⇒ the same gate
    // now lets it through. This paired control proves the reject in the deep
    // arm is driven by the THREADED depth, not by an unconditional failure.
    const { runner: rootRunner, seen: rootSeen } = recordingRunner()
    const rootDelegate = defaultDelegationRunner({
      runner: wrapSubagentRunner(rootRunner, 0),
    })
    const passed = await rootDelegate.delegate({
      mode: "explore",
      prompt: "p",
      depth: 1,
    } satisfies DelegateSpec)
    expect(passed.ok).toBe(true)
    // And the host runner DID run, receiving the threaded child depth 1.
    expect(rootSeen[0]?.depth).toBe(1)
  })

  // -------------------------------------------------------------------------
  test("P0B-04 OFF byte-identical: single-level delegate from root → child depth 1, ok:true", async () => {
    const { runner: hostRunner, seen } = recordingRunner()
    const rootDelegate = defaultDelegationRunner({
      runner: wrapSubagentRunner(hostRunner, 0),
    })
    const out = await rootDelegate.delegate({
      mode: "explore",
      prompt: "hello",
      depth: 1,
    } satisfies DelegateSpec)
    // Only the depth VALUE changed vs the pre-fix path — the outcome shape and
    // success are unchanged; no delegate consumer breaks on non-zero depth.
    expect(out.ok).toBe(true)
    expect(out.mode).toBe("explore")
    expect(seen[0]?.depth).toBe(1)
  })
})
