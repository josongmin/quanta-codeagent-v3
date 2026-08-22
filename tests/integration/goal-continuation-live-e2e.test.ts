import { describe, expect, test } from "bun:test"
import { runAgent } from "@/agent"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import {
  buildPursuitContinuationPrompt,
  type ContinuationDeps,
  ContinuationSemaphore,
  createObjectiveStore,
  type ObjectivePort,
  runIdleContinuation,
} from "@/objective"
import { defaultTools, ToolRegistry } from "@/tool"
import { cfg, RecordingStream, text, toolUse, withTimeout } from "./_harness"

/**
 * Integration coverage for `objective-goal-continuation-live` (ADR-0394 / Codex
 * `core/src/goals.rs` parity): the DECISION LOGIC of `runIdleContinuation` — the
 * pure orchestrator the goal-continuation ticker fires on each idle tick — over a
 * REAL shared `createObjectiveStore()`, plus the REAL `objective_*` tool
 * registration path exercised by the `resume` re-drive.
 *
 * WHAT THIS COVERS (accurately):
 *
 *   1. `runIdleContinuation`'s orchestration/decision matrix over the shared
 *      store: an `active` goal ⇒ launch; a `completed` goal ⇒ STOP
 *      (`skipReason: "goal-not-active"`, the Codex auto-stop); a `paused` goal ⇒
 *      skip (`goal-not-active`); the feature gate OFF (`enabled:false`) ⇒ skip
 *      (`disabled`) with ZERO passes.
 *
 *   2. The shared-store COMPLETION FLIP: the scripted LLM marks the success
 *      criterion met via the REAL `objective_update` tool on the SAME
 *      `createObjectiveStore()` the ticker reads, so the store DERIVES
 *      `completed` mid-run — after which the orchestrator refuses further passes.
 *
 *   3. The REAL objective-tool REGISTRATION seam (Defect-A fix): the `resume`
 *      sink builds the `runAgent` config with `objective: store` and a registry
 *      of JUST `defaultTools` — NO manual `objectiveTools(store)` push. The
 *      `objective_update` tool reaches the registry ONLY because `runAgent` →
 *      `createRunAgentContext` → `buildSessionFeatures` → `buildObjectiveBlock`
 *      (`src/agent/features.ts`, `src/agent/tier1/objective.ts`) materializes
 *      `objectiveTools(config.objective)` and `buildEffectiveConfig` merges them.
 *      So a `buildObjectiveBlock` regression to `[]` breaks the scripted tool
 *      call ⇒ this test goes RED (red-on-injection proof, see the neuter test).
 *
 * WHAT THIS DOES **NOT** COVER (honest scoping — Defect-B):
 *
 *   The `resume` sink here calls `runAgent(...)` INLINE as a test STAND-IN. That
 *   is NOT the production resume seam. In prod (`src/apps/cli/repl/session-loop.ts`
 *   ~L790-796) `resume` does `enqueueWithHeartbeat(buildPursuitContinuationPrompt(
 *   goal), {})` — it ENQUEUES a prompt onto the REPL's `externalPromptQueue`, which
 *   is REPL-loop-only and is NOT `runAgent`-drivable. This suite therefore does NOT
 *   exercise the real REPL enqueue/heartbeat wiring; it substitutes an inline
 *   `runAgent` pass so the continuation's decision + the objective-tool registration
 *   are observable. The REPL enqueue path is covered elsewhere (session-loop tests).
 *
 * GROUND TRUTH: the scripted LLM's `calls` counter + the derived store status.
 * `runIdleContinuation` launches (re-drives the stand-in) while `active`, and
 * refuses once `completed`. Non-vacuity: the OFF gate (`enabled:false`) and the
 * `paused`/`completed` statuses each drive ZERO passes.
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
    for (const e of rule?.events ?? this.fallback) yield e
  }
}

/** Wire the REAL `runIdleContinuation` deps: every probe passes (idle + no
 *  pending work), the semaphore is REAL, and `resume` is a TEST STAND-IN that
 *  drives a `runAgent` pass over the shared store. (In prod `resume` enqueues a
 *  REPL prompt via `enqueueWithHeartbeat`, NOT a `runAgent` call — see the file
 *  docstring; the inline `runAgent` is what makes the continuation + the objective
 *  tool registration observable here.) `launches` records each pass. */
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
  // Test STAND-IN for the resume seam. Prod's session-loop wire is
  // `enqueueWithHeartbeat(buildPursuitContinuationPrompt(goal), {})` — a REPL
  // enqueue that is NOT `runAgent`-drivable. We substitute an inline `runAgent`
  // pass here so the continuation DECISION (launch vs. stop) and the REAL
  // objective-tool registration are both observable; we do NOT claim to cover
  // the REPL enqueue/heartbeat path itself.
  resume: async (tid) => {
    const goal = args.store.get(tid)?.goal
    args.launches.push(goal ?? "")
    await runAgent(
      cfg({
        llm: args.llm,
        stream: new RecordingStream(),
        // RFC-03 C1: the objective tools bind their thread from the SESSION id
        // (ctx.ownerId ← AgentConfig.sessionId), never the model's `thread_id`
        // argument. In production sessionId IS the objective thread; mirror that
        // here so the scripted `objective_update` targets the same TID the ticker
        // reads (the continuation prod wire uses the session id identically).
        sessionId: tid,
        // REAL registration seam: the registry starts as JUST `defaultTools`, and
        // the `objective` port below is what drives the `objective_*` trio into it
        // — through the SAME production path a live session uses. `runAgent` →
        // `createRunAgentContext` → `buildSessionFeatures` runs `buildObjectiveBlock`
        // (features.ts, SESSION_FEATURE_BLOCKS), which returns `objectiveTools(port)`
        // for a wired `config.objective`, then `buildEffectiveConfig` rebuilds the
        // registry with those tools. NO manual `objectiveTools(store)` push here — so
        // a `buildObjectiveBlock`/`buildSessionFeatures` regression to `[]` makes the
        // scripted `objective_update` call unresolvable and this test go RED (non-vacuity).
        registry: new ToolRegistry(defaultTools),
        objective: args.store,
        messages: [
          { role: "user", content: [{ type: "text", text: buildPursuitContinuationPrompt(goal) }] },
        ],
        maxTurns: 5,
      }),
    )
  },
})

describe("objective-goal-continuation-live — runIdleContinuation decision logic + real objective-tool registration (resume is a REPL-enqueue stand-in)", () => {
  test("an ACTIVE unmet goal ⇒ each idle tick launches a continuation pass; a met goal (shared-store flip) ⇒ STOPS", async () => {
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
    const finishWithoutMeetingGoal = new PursuitLLM(
      [],
      text("made some progress, stopping for now"),
    )
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
    // Phase A — the goal is ACTIVE + unmet. `runIdleContinuation` MUST DECIDE to
    // launch on each idle tick (its `resume` stand-in drives one `runAgent` pass),
    // and the goal MUST stay `active` because the criterion is never met.
    const depsA = makeContinuationDeps({ store, llm: finishWithoutMeetingGoal, launches })

    const tick1 = await withTimeout(runIdleContinuation(TID, depsA), 10_000, "goal-live-tick1")
    expect(tick1.launched).toBe(true) // orchestrator DECIDED to launch (active goal)
    expect(finishWithoutMeetingGoal.calls).toBe(1) // the resume stand-in ran runAgent once
    expect(store.get(TID)?.status).toBe("active") // goal NOT met ⇒ still active

    const tick2 = await withTimeout(runIdleContinuation(TID, depsA), 10_000, "goal-live-tick2")
    expect(tick2.launched).toBe(true) // launches AGAIN — still active, not one-shot
    expect(finishWithoutMeetingGoal.calls).toBe(2) // a SECOND runAgent pass
    expect(store.get(TID)?.status).toBe("active")

    // The continuation carried the REAL pursuit prompt (goal text fenced as data
    // + the verify-before-complete discipline) into the pass — proof it is the
    // production `buildPursuitContinuationPrompt`, not a bare re-run.
    const firstPassText = finishWithoutMeetingGoal.inputs[0]?.messages
      .flatMap((m) => m.content.map((b) => (b.type === "text" ? b.text : "")))
      .join(" ")
    expect(firstPassText).toContain("ship the migration")
    expect(firstPassText).toContain("verify completion against the")

    // Phase B — the agent now VERIFIES + marks the criterion met via the REAL
    // `objective_update` tool (registered through `buildObjectiveBlock`, NOT a
    // manual push) on the SHARED store during a pass. The store derives `completed`.
    const depsB = makeContinuationDeps({ store, llm: markGoalMet, launches })
    const tickMet = await withTimeout(runIdleContinuation(TID, depsB), 10_000, "goal-live-tick-met")
    expect(tickMet.launched).toBe(true)
    expect(markGoalMet.calls).toBeGreaterThanOrEqual(1)
    expect(store.get(TID)?.status).toBe("completed") // goal is now MET

    // Phase C — the goal is `completed`. `runIdleContinuation` MUST refuse to
    // launch further passes (Codex auto-stop): no infinite continuation. Use a
    // fresh LLM double so any spurious pass is unmistakable (its call count > 0).
    const afterDoneLlm = new PursuitLLM([], text("should never run"))
    const depsC = makeContinuationDeps({ store, llm: afterDoneLlm, launches })
    const tickA = await withTimeout(runIdleContinuation(TID, depsC), 10_000, "goal-live-done-a")
    const tickB = await withTimeout(runIdleContinuation(TID, depsC), 10_000, "goal-live-done-b")
    expect(tickA.launched).toBe(false)
    expect(tickB.launched).toBe(false)
    expect(tickA.skipReason).toBe("goal-not-active") // completed ⇒ not active ⇒ skip
    expect(afterDoneLlm.calls).toBe(0) // the resume stand-in was NEVER driven after completion
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
