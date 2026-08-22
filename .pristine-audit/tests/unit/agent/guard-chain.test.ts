import { describe, expect, test } from "bun:test"
import { createCloseoutGuardState } from "@/agent/closeout-guard"
import {
  buildGuardChain,
  createCloseoutGuard,
  createVerifyGuard,
  guardBlocked,
  isFinishAttempt,
  metaUser,
  runGuardChain,
  type TurnGuard,
  type TurnGuardContext,
} from "@/agent/guards"
import type { AssembledMessage, RecoveryAction } from "@/agent/recovery"
import type { ToolHistoryEntry } from "@/agent/session-resources"
import { createToolChoiceTurnState } from "@/agent/tool-choice"
import type { AgentConfig } from "@/agent/types"
import { createVerifyGuardState } from "@/agent/verify-guard"
import type { Message } from "@/llm"
import { createWorkingMemory } from "@/memory"

/**
 * Turn-exit guard chain (refactor 2026-05-23). The chain framework unifies
 * `verify-guard` + `closeout-guard` behind a single `TurnGuard[]` pipeline,
 * replacing the prior `verifyGuardStep` + `closeoutGuardStep` ladder in
 * `applyAction`. These tests pin the framework invariants — adapter bodies
 * are tested byte-identically by the existing `verify-guard.test.ts` /
 * `closeout-guard.test.ts` (the bodies are NOT re-tested here, only the
 * chain wiring + ordering + default-OFF guarantees).
 *
 * Invariants under test:
 *  1. empty chain ⇒ `undefined` (default-OFF byte-identical: no allocation,
 *     no work, falls through to the legacy completed/nudge/proceed path).
 *  2. single guard that PASSES ⇒ `undefined`.
 *  3. single guard that BLOCKS ⇒ `{ continue: true }` AND its side-effects
 *     ran (wm.append + toolChoice arm + emit invocation).
 *  4. two-guard chain: precedence — VerifyGuard before CloseoutGuard — the
 *     SECOND guard never runs when the first blocks.
 *  5. `buildGuardChain` is config-gated: absent / disabled ⇒ empty array.
 *  6. `runGuardChain` does not allocate per-call beyond the for…of variable
 *     (verified by passing a Object.frozen([]) — chain must not mutate).
 */

const textMessage = (text: string): AssembledMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
})

const proceedAction: RecoveryAction = { do: "proceed" }
const completedAction: RecoveryAction = { do: "completed" }

const minimalCtx = (overrides: Partial<TurnGuardContext> = {}): TurnGuardContext => {
  const action = overrides.action ?? proceedAction
  const message = overrides.message ?? textMessage("done")
  return {
    action,
    message,
    wm: overrides.wm ?? createWorkingMemory<Message>(),
    history: overrides.history ?? [],
    toolChoiceState: overrides.toolChoiceState ?? createToolChoiceTurnState(),
    emit: overrides.emit ?? (() => {}),
  }
}

describe("runGuardChain — framework invariants", () => {
  test("(1) empty chain ⇒ undefined (default-OFF byte-identical)", () => {
    // The whole point of default-OFF: no guards registered ⇒ the chain never
    // touches wm / toolChoiceState / emits, and returns undefined so the
    // caller's `if (blocked)` branch falls through to legacy semantics.
    const wm = createWorkingMemory<Message>()
    const tcs = createToolChoiceTurnState()
    const emits: string[] = []
    const result = runGuardChain(
      [],
      minimalCtx({ wm, toolChoiceState: tcs, emit: (r) => emits.push(r) }),
    )
    expect(result).toBeUndefined()
    expect(wm.snapshot()).toHaveLength(0)
    expect(tcs.verifyGuardViolated).toBe(false)
    expect(tcs.closeoutAttempted).toBe(false)
    expect(emits).toEqual([])
  })

  test("(2) single guard that passes ⇒ undefined, no side-effects", () => {
    const guard: TurnGuard = {
      name: "verify",
      decide: () => undefined,
    }
    const wm = createWorkingMemory<Message>()
    const tcs = createToolChoiceTurnState()
    const result = runGuardChain([guard], minimalCtx({ wm, toolChoiceState: tcs }))
    expect(result).toBeUndefined()
    expect(wm.snapshot()).toHaveLength(0)
  })

  test("(3) single guard that blocks ⇒ continue:true (sentinel)", () => {
    const calls: TurnGuardContext[] = []
    const guard: TurnGuard = {
      name: "verify",
      decide: (ctx) => {
        calls.push(ctx)
        // Mirror the adapter shape so the test also pins the side-effect
        // contract the real adapters obey.
        ctx.wm.append(ctx.message as Message)
        ctx.wm.append(metaUser("nudge"))
        ctx.toolChoiceState.verifyGuardViolated = true
        ctx.emit("unverified")
        return guardBlocked()
      },
    }
    const wm = createWorkingMemory<Message>()
    const tcs = createToolChoiceTurnState()
    const emits: string[] = []
    const result = runGuardChain(
      [guard],
      minimalCtx({ wm, toolChoiceState: tcs, emit: (r) => emits.push(r) }),
    )
    expect(result).toEqual({ continue: true })
    expect(calls).toHaveLength(1)
    expect(wm.snapshot()).toHaveLength(2)
    expect(tcs.verifyGuardViolated).toBe(true)
    expect(emits).toEqual(["unverified"])
  })

  test("(4) precedence: first guard wins, second never invoked", () => {
    // The same-turn co-fire scenario: verify trips first, closeout MUST NOT
    // run on the same finish (it fires the NEXT finish-intent, per
    // closeout-guard.ts header). The chain encodes this purely via array
    // order — buildGuardChain registers verify before closeout.
    let closeoutInvoked = false
    const verifyGuard: TurnGuard = {
      name: "verify",
      decide: (ctx) => {
        ctx.emit("unverified")
        return guardBlocked()
      },
    }
    const closeoutGuard: TurnGuard = {
      name: "closeout",
      decide: () => {
        closeoutInvoked = true
        return guardBlocked()
      },
    }
    const emits: string[] = []
    const result = runGuardChain(
      [verifyGuard, closeoutGuard],
      minimalCtx({ emit: (r) => emits.push(r) }),
    )
    expect(result).toEqual({ continue: true })
    expect(closeoutInvoked).toBe(false)
    expect(emits).toEqual(["unverified"])
  })

  test("(5) precedence: first passes, second blocks ⇒ second wins", () => {
    let verifyInvoked = false
    let closeoutInvoked = false
    const verifyGuard: TurnGuard = {
      name: "verify",
      decide: () => {
        verifyInvoked = true
        return undefined
      },
    }
    const closeoutGuard: TurnGuard = {
      name: "closeout",
      decide: (ctx) => {
        closeoutInvoked = true
        ctx.emit("closeout")
        return guardBlocked()
      },
    }
    const emits: string[] = []
    const result = runGuardChain(
      [verifyGuard, closeoutGuard],
      minimalCtx({ emit: (r) => emits.push(r) }),
    )
    expect(result).toEqual({ continue: true })
    expect(verifyInvoked).toBe(true)
    expect(closeoutInvoked).toBe(true)
    expect(emits).toEqual(["closeout"])
  })

  test("(6) frozen empty array input ⇒ no mutation attempts (chain is read-only)", () => {
    const frozen = Object.freeze([] as readonly TurnGuard[])
    // Must not throw; chain iteration is read-only over the array.
    expect(() => runGuardChain(frozen, minimalCtx())).not.toThrow()
  })
})

describe("buildGuardChain — config gating", () => {
  const baseConfig = {} as AgentConfig

  test("neither verifyGuard nor closeoutGuard ⇒ empty array (default-OFF)", () => {
    // No guard config + no state ⇒ chain is empty. `runGuardChain([])`
    // returns undefined immediately so the loop is byte-for-byte identical
    // to the pre-refactor path.
    const chain = buildGuardChain({
      config: baseConfig,
      verifyGuardState: undefined,
      closeoutGuardState: undefined,
    })
    expect(chain).toEqual([])
  })

  test("verifyGuard config + state ⇒ chain has 1 verify entry", () => {
    const chain = buildGuardChain({
      config: { ...baseConfig, verifyGuard: {} } as AgentConfig,
      verifyGuardState: createVerifyGuardState(),
      closeoutGuardState: undefined,
    })
    expect(chain).toHaveLength(1)
    expect(chain[0]?.name).toBe("verify")
  })

  test("closeoutGuard enabled + state ⇒ chain has 1 closeout entry", () => {
    const chain = buildGuardChain({
      config: { ...baseConfig, closeoutGuard: { enabled: true } } as AgentConfig,
      verifyGuardState: undefined,
      closeoutGuardState: createCloseoutGuardState(),
    })
    expect(chain).toHaveLength(1)
    expect(chain[0]?.name).toBe("closeout")
  })

  test("both configured ⇒ order is [verify, closeout] (precedence load-bearing)", () => {
    // This pins the documented invariant — VerifyGuard MUST come first so
    // verify trips on the co-fire turn and closeout fires the next attempt.
    const chain = buildGuardChain({
      config: {
        ...baseConfig,
        verifyGuard: {},
        closeoutGuard: { enabled: true },
      } as AgentConfig,
      verifyGuardState: createVerifyGuardState(),
      closeoutGuardState: createCloseoutGuardState(),
    })
    expect(chain.map((g) => g.name)).toEqual(["verify", "closeout"])
  })

  test("verifyGuard cfg present but state missing ⇒ guard NOT added (robust to stale args)", () => {
    // Mirrors `buildVerifyGuard`'s gate: state creation requires the cfg, so
    // a caller hand-constructing the args bag with cfg + no state is treated
    // as guard-off (defensive — never decide() on undefined state).
    const chain = buildGuardChain({
      config: { ...baseConfig, verifyGuard: {} } as AgentConfig,
      verifyGuardState: undefined,
      closeoutGuardState: undefined,
    })
    expect(chain).toEqual([])
  })
})

describe("createVerifyGuard adapter — byte-identical to decideVerifyGuard", () => {
  test("non-finish action ⇒ pass-through (undefined)", () => {
    const guard = createVerifyGuard({ cfg: {}, state: createVerifyGuardState() })
    // backoff is NOT a finish attempt; the chain must short-circuit cheap.
    const r = guard.decide(minimalCtx({ action: { do: "backoff", attempt: 0 } as RecoveryAction }))
    expect(r).toBeUndefined()
  })

  test("finish without prior mutating tool ⇒ pass-through", () => {
    const guard = createVerifyGuard({ cfg: {}, state: createVerifyGuardState() })
    const r = guard.decide(minimalCtx({ action: completedAction, history: [] }))
    expect(r).toBeUndefined()
  })

  test("finish after edit with no verify ⇒ blocks AND arms tool_choice + appends wm", () => {
    const state = createVerifyGuardState()
    const guard = createVerifyGuard({ cfg: { maxTrips: 1 }, state })
    const wm = createWorkingMemory<Message>()
    const tcs = createToolChoiceTurnState()
    const emits: string[] = []
    const history: ToolHistoryEntry[] = [{ name: "edit" }]
    const r = guard.decide(
      minimalCtx({
        action: completedAction,
        history,
        wm,
        toolChoiceState: tcs,
        emit: (reason) => emits.push(reason),
      }),
    )
    expect(r).toEqual({ continue: true })
    expect(state.trips).toBe(1)
    expect(tcs.verifyGuardViolated).toBe(true)
    expect(wm.snapshot()).toHaveLength(2) // message + metaUser
    expect(emits).toEqual(["unverified"])
  })
})

describe("createCloseoutGuard adapter — byte-identical to decideCloseoutGuard", () => {
  test("non-finish action ⇒ pass-through", () => {
    const guard = createCloseoutGuard({
      cfg: { enabled: true },
      state: createCloseoutGuardState(),
    })
    const r = guard.decide(minimalCtx({ action: { do: "backoff", attempt: 0 } as RecoveryAction }))
    expect(r).toBeUndefined()
  })

  test("first finish ⇒ blocks AND arms tool_choice + appends wm", () => {
    const state = createCloseoutGuardState()
    const guard = createCloseoutGuard({ cfg: { enabled: true }, state })
    const wm = createWorkingMemory<Message>()
    const tcs = createToolChoiceTurnState()
    const emits: string[] = []
    const r = guard.decide(
      minimalCtx({
        action: completedAction,
        wm,
        toolChoiceState: tcs,
        emit: (reason) => emits.push(reason),
      }),
    )
    expect(r).toEqual({ continue: true })
    expect(state.trips).toBe(1)
    expect(tcs.closeoutAttempted).toBe(true)
    expect(wm.snapshot()).toHaveLength(2)
    expect(emits).toEqual(["closeout"])
  })

  test("second finish ⇒ pass-through (single-shot cap)", () => {
    const state = createCloseoutGuardState()
    state.trips = 1 // simulate prior trip
    const guard = createCloseoutGuard({ cfg: { enabled: true }, state })
    const r = guard.decide(minimalCtx({ action: completedAction }))
    expect(r).toBeUndefined()
  })
})

describe("isFinishAttempt — shared predicate (verbatim from loop.ts)", () => {
  test("completed action ⇒ true regardless of message content", () => {
    expect(isFinishAttempt(completedAction, textMessage("anything"))).toBe(true)
  })

  test("proceed with no tool_use ⇒ true", () => {
    expect(isFinishAttempt(proceedAction, textMessage("done"))).toBe(true)
  })

  test("proceed with tool_use ⇒ false (model is calling a tool)", () => {
    const msg: AssembledMessage = {
      role: "assistant",
      content: [{ type: "tool_use", id: "1", name: "edit", input: {} }],
    }
    expect(isFinishAttempt(proceedAction, msg)).toBe(false)
  })

  test("non-completed/non-proceed actions ⇒ false (backoff/compact/error/nudge)", () => {
    const cases: RecoveryAction[] = [
      { do: "backoff", attempt: 0 },
      { do: "compact" },
      { do: "error", reason: "x" },
      { do: "nudge", keepMessage: true, text: "x", reason: "nudge" },
    ]
    for (const a of cases) {
      expect(isFinishAttempt(a, textMessage("x"))).toBe(false)
    }
  })
})
