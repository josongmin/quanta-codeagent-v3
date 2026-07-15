import { describe, expect, test } from "bun:test"
import { runAgent } from "@/agent"
import {
  buildPursuitContinuationPrompt,
  ContinuationSemaphore,
  createObjectiveStore,
  type ContinuationDeps,
  type ObjectivePort,
  runIdleContinuation,
} from "@/agent/objective"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { objectiveTools } from "@/tool/objective"
import { defaultTools, ToolRegistry } from "@/tool"
import { cfg, RecordingStream, text, toolUse, withTimeout } from "./_harness"

/**
 * TRUE end-to-end for `objective-goal-continuation-live` (ADR-0394 / Codex
 * `core/src/goals.rs` parity), driven by a FAKE LLM through the REAL agent loop
 * (`runAgent`) — NOT the isolated `startGoalContinuationTicker` /
 * `runIdleContinuation` unit doubles. This closes the `runAgent × scripted == 0`
 * gap the catalog records (`goal-pursuit-chain-hellgate` drives the chain but
 * its `resume` sink is a STUB that only `enqueued.push(goal)` — it never re-runs
 * the loop, so the "wake → bounded pass → re-evaluate" behavior was never
 * exercised through a real `runAgent`).
 *
 * The production seam under test: the idle continuation ticker's `resume` sink
 * re-drives the agent loop when an `active` goal is unmet, and STOPS once the
 * goal is met (the shared objective store derives `completed`). We wire the REAL
 * `runIdleContinuation` (the pure orchestrator the ticker fires each tick) with:
 *
 *   - a REAL shared `createObjectiveStore()` (the SAME store `/goal` writes and
 *     the LLM's `objective_*` tools mutate — the Codex auto-stop SSOT),
 *   - a `resume` sink that invokes the REAL `runAgent`, handing it the REAL
 *     `buildPursuitContinuationPrompt(goal)` and the REAL `objectiveTools(store)`
 *     so the scripted LLM can mark the goal done ON the shared store mid-pass,
 *   - a scripted LLM that first "completes" its turn WITHOUT meeting the goal
 *     (criterion still unmet ⇒ status stays `active`), and only on a LATER pass
 *     marks the success criterion met ⇒ the store derives `completed`.
 *
 * GROUND TRUTH: the scripted LLM's `calls` counter + the store status. A single
 * `runIdleContinuation` per simulated idle tick MUST re-drive `runAgent` (the
 * LLM is called again) while the goal is `active`, and MUST NOT re-drive it once
 * the goal is `completed` (no infinite continuation). Non-vacuity: the OFF gate
 * (`enabled:false`) drives ZERO passes — byte-identical to a never-armed session.
 */

const TID = "thread-goal-live"

/** Route each `runAgent` pass by the conversation text so distinct passes can
 *  script distinct behaviour. Records every `StreamInput` (so we can assert the
 *  pursuit prompt actually reached the loop) and counts calls (ground truth). */
class PursuitLLM implements LLMPort {
  readonly model = "pursuit-test-model"
  readonly inputs: StreamInput[] = []
  calls = 0
  private readonly rules: { match: string; events: StreamEvent[] }[]
  private readonly fallback: StreamEvent[]
  constructor(rules: { match: string; events: StreamEvent[] }[], fallback: StreamEvent[]) {
    this.rules = rules
    this.fallback = fallback
  }
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.inputs.push(input)
    this.calls += 1
    const txt = input.messages
      .flatMap((m) => m.content.map((b) => (b.type === "text" ? b.text : "")))
      .join(" ")
    const rule = this.rules.find((r) => txt.includes(r.match))
    for (const e of (rule?.events ?? this.fallback)) yield e
  }
}

/** Wire the REAL `runIdleContinuation` deps: every probe passes (idle + no
 *  pending work), the semaphore is REAL, and `resume` invokes the REAL
 *  `runAgent` over the shared store + the objective tools. `launches` records
 *  each pass so we can prove the loop actually re-drove. */
const makeContinuationDeps = (args: {
  store: ObjectivePort
  llm: LLMPort
  launches: string[]
}): ContinuationDeps => ({
  enabled: true,
  objective: args.store,
  semaphore: new ContinuationSemaphore(),
  now: () => Date.now(),
  threadIdle: () => true,
  planModeActive: () => false,
  turnActive: () => false,
  queuedInputPending: () => false,
  mailboxInputPending: () => false,
  isEphemeral: () => false,
  // This is the SEAM the gap was about: the ticker's `resume` actually
  // re-drives the loop. Mirrors the session-loop wire
  // (`enqueueWithHeartbeat(buildPursuitContinuationPrompt(goal))`) but with the
  // enqueue realised as a REAL `runAgent` pass so the continuation is observable.
  resume: async (tid) => {
    const goal = args.store.get(tid)?.goal
    args.launches.push(goal ?? "")
    await runAgent(
      cfg({
        llm: args.llm,
        stream: new RecordingStream(),
        registry: new ToolRegistry([...defaultTools, ...objectiveTools(args.store)]),
        objective: args.store,
        messages: [
          { role: "user", content: [{ type: "text", text: buildPursuitContinuationPrompt(goal) }] },
        ],
        maxTurns: 5,
      }),
    )
  },
})

describe("objective-goal-continuation-live — real loop (runAgent) + fake LLM end-to-end", () => {
  test("an ACTIVE unmet goal ⇒ each idle tick re-drives runAgent (another pass); met goal ⇒ STOPS", async () => {
    const store = createObjectiveStore()
    // A goal with ONE success criterion — the store derives `completed` ONLY
    // once the criterion is marked met, so "the turn finished" is NOT itself
    // completion (the anti-scope-shrink discipline made concrete).
    const obj = store.set(TID, { goal: "ship the migration", successCriteria: ["migrated"] })
    store.updateStatus(TID, "active")
    expect(store.get(TID)?.status).toBe("active")
    const criterionId = obj.successCriteria[0]?.id ?? ""

    // The scripted LLM: while the goal is unmet it "completes" the turn but does
    // NOT mark the criterion (a plausible-but-unverified finish — exactly what
    // the pursuit discipline guards against). Once we (below) flip it to the
    // "verify" script, it marks the criterion met via the REAL objective tool.
    const finishWithoutMeetingGoal = new PursuitLLM([], text("made some progress, stopping for now"))
    const markGoalMet = new PursuitLLM(
      [
        {
          match: "pursue",
          events: [
            ...toolUse("m1", "objective_update", {
              thread_id: TID,
              op: { kind: "markCriterion", criterion_id: criterionId, met: true },
            }),
          ],
        },
      ],
      text("goal verified and complete"),
    )

    const launches: string[] = []
    // Phase A — the goal is ACTIVE + unmet. Two idle ticks MUST each re-drive a
    // real `runAgent` pass (the continuation), and the goal MUST stay `active`
    // because the criterion is never met.
    const depsA = makeContinuationDeps({ store, llm: finishWithoutMeetingGoal, launches })

    const tick1 = await withTimeout(runIdleContinuation(TID, depsA), 10_000, "goal-live-tick1")
    expect(tick1.launched).toBe(true) // the ticker WOKE the loop
    expect(finishWithoutMeetingGoal.calls).toBe(1) // runAgent really ran once
    expect(store.get(TID)?.status).toBe("active") // goal NOT met ⇒ still active

    const tick2 = await withTimeout(runIdleContinuation(TID, depsA), 10_000, "goal-live-tick2")
    expect(tick2.launched).toBe(true) // re-driven AGAIN (the bug this gap targets)
    expect(finishWithoutMeetingGoal.calls).toBe(2) // a SECOND real pass
    expect(store.get(TID)?.status).toBe("active")

    // The continuation carried the REAL pursuit prompt (goal text fenced as data
    // + the verify-before-complete discipline) into the loop — proof it is the
    // production `buildPursuitContinuationPrompt`, not a bare re-run.
    const firstPassText = finishWithoutMeetingGoal.inputs[0]?.messages
      .flatMap((m) => m.content.map((b) => (b.type === "text" ? b.text : "")))
      .join(" ")
    expect(firstPassText).toContain("ship the migration")
    expect(firstPassText).toContain("verify completion against the")

    // Phase B — the agent now VERIFIES + marks the criterion met (via the REAL
    // objective_update tool, on the SHARED store) during a real pass. The store
    // derives `completed`.
    const depsB = makeContinuationDeps({ store, llm: markGoalMet, launches })
    const tickMet = await withTimeout(runIdleContinuation(TID, depsB), 10_000, "goal-live-tick-met")
    expect(tickMet.launched).toBe(true)
    expect(markGoalMet.calls).toBeGreaterThanOrEqual(1)
    expect(store.get(TID)?.status).toBe("completed") // goal is now MET

    // Phase C — the goal is `completed`. Further idle ticks MUST NOT re-drive the
    // loop (Codex auto-stop): no infinite continuation. Use a fresh LLM double so
    // any spurious pass is unmistakable (its call count would go > 0).
    const afterDoneLlm = new PursuitLLM([], text("should never run"))
    const depsC = makeContinuationDeps({ store, llm: afterDoneLlm, launches })
    const tickA = await withTimeout(runIdleContinuation(TID, depsC), 10_000, "goal-live-done-a")
    const tickB = await withTimeout(runIdleContinuation(TID, depsC), 10_000, "goal-live-done-b")
    expect(tickA.launched).toBe(false)
    expect(tickB.launched).toBe(false)
    expect(tickA.skipReason).toBe("goal-not-active") // completed ⇒ not active ⇒ skip
    expect(afterDoneLlm.calls).toBe(0) // the loop was NEVER re-driven after completion
  })

  test("NON-VACUITY: enabled:false (goal-continuation OFF) ⇒ ZERO runAgent passes even with an active goal", async () => {
    // The mutation that proves the assertions above are load-bearing: with the
    // gate OFF the ticker arms nothing and `resume` is never called, so an active
    // goal drives ZERO passes. If the "re-drive" assertions matched on something
    // always-true, this control would ALSO drive a pass and fail.
    const store = createObjectiveStore()
    store.set(TID, { goal: "ship the migration", successCriteria: ["migrated"] })
    store.updateStatus(TID, "active")
    expect(store.get(TID)?.status).toBe("active")

    const llm = new PursuitLLM([], text("must not run — gate is off"))
    const launches: string[] = []
    const deps: ContinuationDeps = {
      ...makeContinuationDeps({ store, llm, launches }),
      enabled: false, // the QUANTA_GOAL_ENFORCE-derived gate is OFF
    }

    const tick1 = await withTimeout(runIdleContinuation(TID, deps), 10_000, "goal-off-tick1")
    const tick2 = await withTimeout(runIdleContinuation(TID, deps), 10_000, "goal-off-tick2")
    expect(tick1.launched).toBe(false)
    expect(tick1.skipReason).toBe("disabled")
    expect(tick2.launched).toBe(false)
    expect(llm.calls).toBe(0) // runAgent was NEVER driven
    expect(launches.length).toBe(0) // resume was never invoked
  })

  test("a PAUSED goal (/goal clear) ⇒ no continuation pass (manual suspend suppresses pursuit)", async () => {
    // Codex: a paused goal does NOT auto-resume on idle. Prove the OFF-by-status
    // path through the real orchestrator drives zero passes even when the gate
    // itself is ON — the skip reason is the STATUS, not the feature gate.
    const store = createObjectiveStore()
    store.set(TID, { goal: "ship the migration", successCriteria: ["migrated"] })
    store.updateStatus(TID, "active")
    store.updateStatus(TID, "paused")
    expect(store.get(TID)?.status).toBe("paused")

    const llm = new PursuitLLM([], text("must not run — goal is paused"))
    const launches: string[] = []
    const deps = makeContinuationDeps({ store, llm, launches })

    const tick = await withTimeout(runIdleContinuation(TID, deps), 10_000, "goal-paused-tick")
    expect(tick.launched).toBe(false)
    expect(tick.skipReason).toBe("goal-not-active")
    expect(llm.calls).toBe(0)
    expect(launches.length).toBe(0)
  })
})
