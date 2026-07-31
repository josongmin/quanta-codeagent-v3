/**
 * ALBB-24 — behavioral hellgate for `createStreamDispatcher`
 * (`src/agent/stream-callbacks.ts`).
 *
 * These two seams RUN today under the full `runAgent → streamConsume` path but
 * have NO direct/named coverage. This gate drives the returned `dispatch`
 * callback directly against a fake `TurnSession`/`TurnState` (the ticket's
 * "or the dispatcher directly" path) and asserts observable EFFECTS — not "it
 * runs" — with a red-on-injection mutation pin per seam.
 *
 *   Seam 1 (DENY short-circuit) — a `skillGate` that DENIES the called tool,
 *   with skill-scope v2 OFF, must short-circuit via `skillScopeDeny` BEFORE
 *   reaching dispatch. Fresh-readback: an injected `dispatchPort` spy counter
 *   stays 0 (the tool never executed) and the returned block is the
 *   `skillScopeDeny` shape (`ok:false`, `is_error:true`, preview "skill-scoped").
 *   MUTATION pin (`stream-callbacks.ts` `scoped ??` at ~L355): if the
 *   short-circuit were removed so a denied tool dispatches anyway, the spy
 *   counter would read > 0 → this test goes RED.
 *
 *   Seam 2 (history back-patch) — with a non-empty `toolHistory` slot carrying
 *   the call id, a resolved dispatch must back-patch `slot.ok` / `slot.output`
 *   (`patchHistoryOutcome`, `stream-callbacks.ts:141-155`). Fresh-readback the
 *   slot after dispatch. Paired control: `toolHistory === undefined` ⇒ no throw,
 *   no mutation. MUTATION pin: revert the two slot writes ⇒ the slot keeps its
 *   pre-dispatch `ok`/`output` → RED.
 *
 * Scope: TEST-ONLY. No production behavior is changed. skillScopeV2 is pinned
 * OFF via env + a runtime-config reset so the deny path is deterministic
 * regardless of the ambient shell.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import type { DispatchPort } from "@/agent/dispatch"
import type { ToolHistoryEntry } from "@/agent/session-resources"
import { createStreamDispatcher } from "@/agent/stream-callbacks"
import type { StreamingCall } from "@/agent/streaming-dispatch"
import type { SkillGate, TurnSession, TurnState } from "@/agent/turn-context"
import type { AgentConfig } from "@/agent/types"
import type { TurnTimingCapture } from "@/observability"
import { __resetRuntimeConfig } from "@/shared"
import type { AgentEvent, StreamPort } from "@/stream"

class NullStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

/** A dispatch-port SPY that HONORS the DispatchResult contract (block+ok+preview)
 *  — no `as unknown as` escape, so a contract violation fails to compile. The
 *  `count` box is the fresh-readback the deny-path assertion reads. */
const spyDispatchPort = (
  box: { count: number },
  outcome: { ok: boolean; preview: string } = { ok: true, preview: "spy-dispatch-ran" },
): DispatchPort => {
  return async (call) => {
    box.count += 1
    return {
      ok: outcome.ok,
      preview: outcome.preview,
      block: { type: "tool_result", tool_use_id: call.id, content: outcome.preview },
    }
  }
}

/** A skill gate whose `allow` verdict is caller-controlled. `denyAll:true`
 *  models "the active skill does not permit this tool" (the ADR-0011 deny). */
const fakeSkillGate = (denyAll: boolean): SkillGate => ({
  allow: () => !denyAll,
  observe: () => {},
  activeOverride: () => undefined,
  activeSkillName: () => "test-skill",
  widenScope: () => {},
})

const noopTimingCapture = (): TurnTimingCapture =>
  ({ markFirstToken: () => {} }) as unknown as TurnTimingCapture

/** Minimal AgentConfig for the dispatch callback. Only the fields the callback
 *  actually reads on the exercised branches are real; the rest are inert. */
const makeConfig = (over: Partial<AgentConfig>): AgentConfig =>
  ({
    stream: new NullStream(),
    permission: { mode: "acceptEdits" },
    ...over,
  }) as unknown as AgentConfig

const makeSession = (config: AgentConfig, skillGate: SkillGate | undefined): TurnSession =>
  ({
    config,
    specs: [],
    ...(skillGate !== undefined ? { skillGate } : {}),
    guards: [],
  }) as unknown as TurnSession

const makeState = (over: Partial<TurnState>): TurnState =>
  ({
    onRedaction: () => {},
    breaker: undefined,
    toolHistory: undefined,
    workingState: undefined,
    collector: undefined,
    ...over,
  }) as unknown as TurnState

const call = (id: string, name: string): StreamingCall => ({ id, name, input: {} })

describe("ALBB-24 — createStreamDispatcher behavioral seams", () => {
  // skill-scope v2 must be OFF so the deny branch is the flat ADR-0011
  // `skillScopeDeny` (deterministic, independent of the ambient shell env).
  const priorEnv = process.env.QUANTA_SKILL_SCOPE_V2
  beforeAll(() => {
    delete process.env.QUANTA_SKILL_SCOPE_V2
    __resetRuntimeConfig()
  })
  afterAll(() => {
    if (priorEnv === undefined) delete process.env.QUANTA_SKILL_SCOPE_V2
    else process.env.QUANTA_SKILL_SCOPE_V2 = priorEnv
    __resetRuntimeConfig()
  })
  beforeEach(() => __resetRuntimeConfig())
  afterEach(() => __resetRuntimeConfig())

  describe("DENY seam (handleSkillScope → skillScopeDeny short-circuits dispatch)", () => {
    test("denied tool ⇒ dispatch port NEVER invoked (counter stays 0) + skillScopeDeny block", async () => {
      const box = { count: 0 }
      const config = makeConfig({ dispatchPort: spyDispatchPort(box) })
      const session = makeSession(config, fakeSkillGate(true)) // deny the tool
      const state = makeState({})
      const { dispatch } = createStreamDispatcher(session, state, {
        turnTimingCapture: noopTimingCapture(),
      })

      const out = await dispatch(call("c1", "bash"))

      // Load-bearing mutation pin: the `scoped ??` short-circuit means the tool
      // NEVER executes. Remove it ⇒ this reads 1 ⇒ RED.
      expect(box.count).toBe(0)
      // The returned block is the skillScopeDeny shape.
      expect(out.ok).toBe(false)
      expect(out.preview).toBe("skill-scoped")
      expect(out.block.type).toBe("tool_result")
      // `is_error` lives on the tool_result variant; narrow before reading.
      expect(out.block.type === "tool_result" && out.block.is_error).toBe(true)
    })

    test("PAIRED CONTROL — gate that ALLOWS the tool falls through to dispatch (counter == 1)", async () => {
      const box = { count: 0 }
      const config = makeConfig({ dispatchPort: spyDispatchPort(box) })
      const session = makeSession(config, fakeSkillGate(false)) // allow the tool
      const state = makeState({})
      const { dispatch } = createStreamDispatcher(session, state, {
        turnTimingCapture: noopTimingCapture(),
      })

      const out = await dispatch(call("c1", "bash"))

      // Control: an allowed tool DOES reach the injected port exactly once,
      // proving the deny-path 0 above is the short-circuit — not a dead spy.
      expect(box.count).toBe(1)
      expect(out.ok).toBe(true)
      expect(out.preview).toBe("spy-dispatch-ran")
    })

    test("PAIRED CONTROL — no skill gate at all ⇒ dispatch runs (counter == 1)", async () => {
      const box = { count: 0 }
      const config = makeConfig({ dispatchPort: spyDispatchPort(box) })
      const session = makeSession(config, undefined) // no gate ⇒ never denied
      const state = makeState({})
      const { dispatch } = createStreamDispatcher(session, state, {
        turnTimingCapture: noopTimingCapture(),
      })

      await dispatch(call("c1", "read"))
      expect(box.count).toBe(1)
    })
  })

  describe("HISTORY-PATCH seam (patchHistoryOutcome back-patches the slot)", () => {
    test("non-empty toolHistory slot ⇒ slot.ok + slot.output back-patched after dispatch", async () => {
      const box = { count: 0 }
      const config = makeConfig({
        dispatchPort: spyDispatchPort(box, { ok: true, preview: "patched-output" }),
      })
      const session = makeSession(config, undefined)
      // Pre-dispatch: the slot pushed at onToolStart carries name+id but NO
      // outcome yet (ok/output absent). Absent ⇒ what the mutation pin leaves.
      const toolHistory: ToolHistoryEntry[] = [{ name: "bash", id: "c9" }]
      const state = makeState({ toolHistory })
      const { dispatch } = createStreamDispatcher(session, state, {
        turnTimingCapture: noopTimingCapture(),
      })

      await dispatch(call("c9", "bash"))

      // Fresh-readback the SAME slot object. Mutation pin: revert the two writes
      // in patchHistoryOutcome ⇒ these stay undefined ⇒ RED.
      const slot = toolHistory[0]
      expect(slot?.ok).toBe(true)
      expect(slot?.output).toBe("patched-output")
    })

    test("matches by id — an unrelated slot is left untouched", async () => {
      const box = { count: 0 }
      const config = makeConfig({
        dispatchPort: spyDispatchPort(box, { ok: false, preview: "c2-out" }),
      })
      const session = makeSession(config, undefined)
      const toolHistory: ToolHistoryEntry[] = [
        { name: "read", id: "other", ok: true, output: "keep-me" },
        { name: "bash", id: "c2" },
      ]
      const state = makeState({ toolHistory })
      const { dispatch } = createStreamDispatcher(session, state, {
        turnTimingCapture: noopTimingCapture(),
      })

      await dispatch(call("c2", "bash"))

      // The matching slot is patched with the dispatch outcome…
      expect(toolHistory[1]?.ok).toBe(false)
      expect(toolHistory[1]?.output).toBe("c2-out")
      // …and the unrelated slot is preserved (id match, not blind overwrite).
      expect(toolHistory[0]?.ok).toBe(true)
      expect(toolHistory[0]?.output).toBe("keep-me")
    })

    test("PAIRED CONTROL — toolHistory undefined ⇒ no throw, dispatch still resolves", async () => {
      const box = { count: 0 }
      const config = makeConfig({ dispatchPort: spyDispatchPort(box) })
      const session = makeSession(config, undefined)
      const state = makeState({ toolHistory: undefined })
      const { dispatch } = createStreamDispatcher(session, state, {
        turnTimingCapture: noopTimingCapture(),
      })

      // The default-OFF path: patchHistoryOutcome short-circuits at its first
      // line. Must not throw and the dispatch outcome flows through unchanged.
      const out = await dispatch(call("c1", "read"))
      expect(out.ok).toBe(true)
      expect(box.count).toBe(1)
    })
  })
})
