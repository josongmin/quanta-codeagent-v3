/**
 * ALBB-20 #13 REGRESSION (P1) — an abort that lands while the REACTIVE (PTL)
 * summarizer LLM stream is in-flight must settle the run as an ABORTED turn
 * (reason:"aborted", interrupted/user), NOT reject/mis-record as a hard 'error'.
 *
 * Background
 * ──────────
 * ALBB-20 #13 threaded `config.signal` into the reactive summarizer
 * (`reactiveCompact`/`summarizeWith`, wired in `recovery-executor.ts`). A user
 * Ctrl+C / deadline that fires while that summarizer stream is running now
 * throws an `AbortError` out of `summarizeWith` → `applyNonSuccessRecoveryAction`
 * (unguarded) → `applyAction` → `runTurn`. Before the fix the loop's
 * `executeTurnWithObservability` catch RE-THREW it (only
 * `isSessionApprovalRequiredError` was special-cased), so the AbortError
 * propagated past `resolveTurnLoopOutcome` and `ctx.finish` entirely and
 * REJECTED the run promise — the run never settled `reason:"aborted"`.
 *
 * The genuine abort in these tests is produced by the REAL reactive path: a
 * `summarizerLlm` whose `stream()` aborts the shared signal and then throws a
 * real `AbortError` (the exact product of ALBB-20 #13's wiring). We drive it
 * through the REAL `applyAction({do:"compact"})` so the throw is authentic, then
 * through the REAL `executeTurnWithObservability` catch (the fix's home) and the
 * REAL `resolveTurnLoopOutcome` (the settlement that mints `reason:"aborted"`).
 *
 *   §1  abort in the in-flight reactive summarizer ⇒ the loop SETTLES the run as
 *       reason:"aborted" (interrupted/USER), never rejects.  RED before the fix:
 *       `executeTurnWithObservability` rejects with the AbortError.
 *   §2  MUTATION / RED-on-injection: reverting the abort arm ⇒ §1 red again
 *       (documented — the abort arm is the load-bearing branch).
 *   §3  PAIRED CONTROL: a NON-abort summarizer throw (signal NOT aborted) still
 *       propagates as a hard 'error' (classifyTurnThrow → error, rethrown) — the
 *       fix must NOT swallow real errors.
 */

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import type { LLMPort, StreamEvent, StreamInput, SystemPromptInput } from "@/llm"
import { createWorkingMemory } from "@/memory"
import { AbortError } from "@/shared"
import { applyAction } from "../recovery-executor"
import { createToolChoiceTurnState } from "../../tool-choice"
import type { RecoveryAction } from "../../recovery"
import { freshRecovery } from "../../recovery"
import { interruptedCategory } from "../../stop-category"
import type { TurnSession, TurnState } from "../../turn-context"
import type { AgentConfig } from "../../types"
import { resolveTurnLoopOutcome } from "../turn-outcome"
import * as sameTurnEngine from "../same-turn-engine"
import { executeTurnWithObservability } from "../turn-loop"
import type { RunAgentContext } from "../types"

/** A summarizer LLM whose stream aborts the shared signal mid-flight and throws.
 *  `mode:"abort"` throws a genuine {@link AbortError} AFTER firing the signal
 *  (models a Ctrl+C/deadline landing during the in-flight reactive summarizer);
 *  `mode:"error"` throws a plain Error and leaves the signal LIVE (the paired
 *  non-abort control). */
const summarizerLlm = (
  controller: AbortController,
  mode: "abort" | "error" | "interrupt",
): LLMPort => ({
  model: "reactive-summarizer",
  stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    async function* gen(): AsyncIterable<StreamEvent> {
      if (mode === "abort") {
        controller.abort()
        throw new AbortError("abort")
      }
      if (mode === "interrupt") {
        // A subagent gate INTERRUPT fired the per-turn controller (which the
        // armed stream signal is derived from) WITHOUT aborting the LIFETIME
        // signal — so the summarizer throws an AbortError while `controller`
        // (the lifetime signal) stays live.
        // `AbortReasonKind` represents transport cancellation, not the higher
        // level gate cause; the interrupted gate still tears down the stream as
        // an ordinary abort.
        throw new AbortError("abort", "interrupt")
      }
      throw new Error("transient-summarizer-boom")
      // biome-ignore lint/correctness/noUnreachable: generator shape only.
      yield { type: "text_delta", delta: "" }
    }
    return gen()
  },
})

/** A transcript with a real summarizable boundary so `reactiveCompact` reaches
 *  `summarizeWith` (which then aborts/throws) rather than short-circuiting on an
 *  empty boundary. */
const seedMessages = () =>
  Array.from({ length: 6 }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: [{ type: "text" as const, text: `turn ${i} ${"x".repeat(400)}` }],
  }))

/** A minimal real `TurnSession` whose reactive compaction runs the given
 *  summarizer. Only the fields the `{do:"compact"}` path reads are populated. */
const makeSession = (
  controller: AbortController,
  mode: "abort" | "error" | "interrupt",
  gate?: unknown,
): TurnSession =>
  ({
    config: {
      llm: summarizerLlm(controller, mode),
      compaction: { summarizerLlm: summarizerLlm(controller, mode), keepRecentTurns: 2 },
      signal: controller.signal,
      stream: { emit: () => {} },
      ...(gate !== undefined ? { subagentTurnGate: gate } : {}),
    } as unknown as AgentConfig,
    specs: [] as unknown as TurnSession["specs"],
    guards: [],
  }) as unknown as TurnSession

const makeState = (): TurnState =>
  ({
    wm: createWorkingMemory(seedMessages()),
    rec: freshRecovery(),
    breaker: undefined,
    toolHistory: undefined,
    workingState: undefined,
    collector: undefined,
    toolChoiceState: createToolChoiceTurnState(),
    citations: [],
    onRedaction: () => {},
    onTurnTiming: undefined,
  }) as unknown as TurnState

const COMPACT: RecoveryAction = { do: "compact" }
const CTX_SYSTEM: SystemPromptInput = "sys"

/** Run the REAL reactive `applyAction({do:"compact"})`; the summarizer aborts +
 *  throws. This is the genuine AbortError `runTurn` would propagate. */
const reactiveCompactThatAborts = (session: TurnSession, state: TurnState): Promise<never> =>
  applyAction(session, state, COMPACT, { error: {}, message: "PTL" }, CTX_SYSTEM, [], "m").then(
    () => {
      throw new Error("expected the reactive summarizer to throw")
    },
  )

describe("ALBB-20 #13 — abort during in-flight reactive summarizer settles aborted", () => {
  // mock.module leaks process-globally in bun; restore the spied runTurn after
  // each test so it never bleeds into sibling suites (e.g. same-turn-engine.test).
  afterEach(() => {
    mock.restore()
  })

  test("§1 abort in reactive compaction ⇒ run settles reason:aborted (NOT reject)", async () => {
    const controller = new AbortController()
    const session = makeSession(controller, "abort")
    const state = makeState()

    // `runTurn` (mocked) reproduces the REAL abort: it drives the real reactive
    // compaction whose summarizer aborts the signal + throws an AbortError. The
    // loop's `executeTurnWithObservability` catch is what must convert that
    // escaping throw into a clean aborted TurnResult.
    const ctx = {
      cfg: session.config,
      session,
      turnStateSeed: {},
    } as unknown as RunAgentContext

    // Patch `runTurn` so `executeTurnWithObservability` sees the genuine abort
    // throw exactly as the real engine would surface it out of `applyAction`.
    // Spy (NOT mock.module — which leaks process-globally in bun and would
    // corrupt sibling suites like same-turn-engine.test): replace the real
    // `runTurn` on the module namespace so the loop sees the genuine abort throw
    // out of the REAL reactive `applyAction`. Restored by afterEach.
    spyOn(sameTurnEngine, "runTurn").mockImplementation(() =>
      reactiveCompactThatAborts(session, state),
    )

    // Before the fix this REJECTS with the AbortError (the P1 hole). After the
    // fix it resolves a `{kind:"aborted"}` TurnResult.
    const { result } = await executeTurnWithObservability({ ctx, turn: 1 })
    expect(result.kind).toBe("aborted")

    // The REAL settlement maps that aborted TurnResult to reason:"aborted"
    // (interrupted / USER) — the resolved AgentOutcome.reason.
    const resolution = await resolveTurnLoopOutcome({
      cfg: session.config,
      stream: session.config.stream,
      wm: state.wm,
      breaker: undefined,
      recorder: undefined,
      turn: 1,
      result,
      pendingPlanExitRef: { current: [] },
      pendingPlanEntryRef: { current: [] },
      hookPromptPending: [],
    })
    expect(resolution.kind).toBe("finish")
    if (resolution.kind !== "finish") throw new Error("unreachable")
    expect(resolution.reason).toBe("aborted")
    // discriminating: it is the USER interrupt category (a cooperative Ctrl+C),
    // NOT a hard error stopCategory.
    expect(resolution.stopCategory?.kind).toBe("interrupted")
    expect(resolution.stopCategory?.reasonCode).toBe(
      interruptedCategory("user").reasonCode,
    )
    expect(controller.signal.aborted).toBe(true)
  })

  test("§3 PAIRED CONTROL: a NON-abort summarizer throw still propagates as 'error'", async () => {
    const controller = new AbortController()
    const session = makeSession(controller, "error")
    const state = makeState()
    const ctx = {
      cfg: session.config,
      session,
      turnStateSeed: {},
    } as unknown as RunAgentContext

    spyOn(sameTurnEngine, "runTurn").mockImplementation(() =>
      reactiveCompactThatAborts(session, state),
    )

    // Signal is NOT aborted; the throw is a plain Error ⇒ the fix must NOT
    // swallow it. It must still surface as a hard turn error (rethrown), so the
    // run is recorded as a failure, not a clean abort.
    let threw = false
    try {
      await executeTurnWithObservability({ ctx, turn: 1 })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    expect(controller.signal.aborted).toBe(false)
  })

  test("§4 INTERRUPT sub-case: gate interrupt (lifetime signal NOT aborted) settles INTERRUPTED → park, not aborted/finish", async () => {
    const controller = new AbortController() // lifetime signal — stays LIVE
    // A subagent gate whose per-turn controller fired this turn (wake("interrupt")),
    // without the lifetime signal being aborted — the ADR-0437 interrupt case.
    const gate = { wasInterrupted: () => true }
    const session = makeSession(controller, "interrupt", gate)
    const state = makeState()
    const ctx = {
      cfg: session.config,
      session,
      turnStateSeed: {},
    } as unknown as RunAgentContext

    spyOn(sameTurnEngine, "runTurn").mockImplementation(() =>
      reactiveCompactThatAborts(session, state),
    )

    const { result } = await executeTurnWithObservability({ ctx, turn: 1 })
    // The catch must route through the SSOT `classifyTurnAbort(gate, lifetime)`:
    // gate.wasInterrupted() && !lifetime.aborted ⇒ INTERRUPTED (not aborted).
    // MUTATION pin: reverting the fix to a hand-rolled `{kind:"aborted"}` makes
    // this RED (it would settle aborted → finish, terminating the child run and
    // defeating the collapse-then-resume interrupt contract).
    expect(result.kind).toBe("interrupted")
    expect(controller.signal.aborted).toBe(false)

    // Interrupted settles to PARK (resume into a fresh turn), NOT finish/aborted.
    const resolution = await resolveTurnLoopOutcome({
      cfg: session.config,
      stream: session.config.stream,
      wm: state.wm,
      breaker: undefined,
      recorder: undefined,
      turn: 1,
      result,
      pendingPlanExitRef: { current: [] },
      pendingPlanEntryRef: { current: [] },
      hookPromptPending: [],
    })
    expect(resolution.kind).toBe("park")
  })
})
