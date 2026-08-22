/**
 * Loop-control fix (jul-3) — empty-turn EXHAUSTION seals NON-success HELL-GATE.
 *
 * Before this fix `decideOnAssembled` sealed a model that produced ONLY empty
 * turns for the whole same-turn empty-retry budget as `{ do: "completed" }` —
 * a produced-NOTHING stall misclassified as a clean finish (the exact twin of
 * the FIX-2 malformed-tool-use bug, which was already fixed but left the empty
 * path blessing `completed`).
 *
 * This battery pins the new contract:
 *   1. empty×cap then one more empty ⇒ `{ do: "error", reason:
 *      EMPTY_TURN_EXHAUSTED_REASON }` (NOT `completed`).
 *   2. `EMPTY_TURN_EXHAUSTED_REASON` carries the `[empty-turn]` prefix.
 *   3. `classifyErrorReason(EMPTY_TURN_EXHAUSTED_REASON)` buckets it as a
 *      DISTINCT `failed`/`MODEL_EMPTY_EXHAUSTED` category — never `completed`,
 *      never a generic `runtime.unknown_error` fall-through.
 *   4. Below the cap the behaviour is UNCHANGED (nudge + budget accounting).
 *
 * PURE — no LLM, no IO. Drives `decideOnAssembled` / `classifyErrorReason`
 * directly. Teeth are the assertions the PRE-fix code would FAIL.
 */
import { describe, expect, test } from "bun:test"
import { decideOnAssembled, freshRecovery } from "@/agent/loop"
import { EMPTY_TURN_EXHAUSTED_REASON, RECOVERY_CAPS } from "@/agent/recovery"
import { classifyErrorReason, STOP_REASON_CODE } from "@/agent/stop-category"
import type { Message } from "@/llm"

const assistant = (...content: Message["content"]): Message => ({ role: "assistant", content })
const textMsg = (text: string): Message => assistant({ type: "text", text })
const empty = (): Message => assistant()
const thinkingMsg = (t: string): Message => assistant({ type: "thinking", thinking: t })

describe("decideOnAssembled — empty-turn exhaustion seals NON-success", () => {
  test("below the cap ⇒ nudge (budget accounting unchanged)", () => {
    const rec = freshRecovery()
    const a = decideOnAssembled("end_turn", empty(), rec)
    expect(a.do).toBe("nudge")
    expect(rec.consecutiveEmpties).toBe(1)
  })

  test("empty×cap then one more empty ⇒ error terminal, NOT completed (TEETH)", () => {
    const rec = freshRecovery()
    for (let i = 0; i < RECOVERY_CAPS.consecutiveEmpties; i++) {
      expect(decideOnAssembled("end_turn", empty(), rec).do).toBe("nudge")
    }
    const sealed = decideOnAssembled("end_turn", empty(), rec)
    // TEETH: pre-fix this returned { do: "completed" } — a produced-NOTHING
    // stall sealed as SUCCESS. It must now be a non-success error terminal.
    expect(sealed.do).not.toBe("completed")
    expect(sealed.do).toBe("error")
    if (sealed.do === "error") expect(sealed.reason).toBe(EMPTY_TURN_EXHAUSTED_REASON)
  })

  test("a thinking-only turn counts as empty and exhausts to the error terminal", () => {
    const rec = freshRecovery()
    for (let i = 0; i < RECOVERY_CAPS.consecutiveEmpties; i++) {
      expect(decideOnAssembled("end_turn", thinkingMsg("hmm"), rec).do).toBe("nudge")
    }
    const sealed = decideOnAssembled("end_turn", thinkingMsg("still thinking"), rec)
    expect(sealed.do).toBe("error")
    if (sealed.do === "error") expect(sealed.reason).toBe(EMPTY_TURN_EXHAUSTED_REASON)
  })

  test("EMPTY_TURN_EXHAUSTED_REASON carries the `[empty-turn]` classifier prefix", () => {
    expect(EMPTY_TURN_EXHAUSTED_REASON.startsWith("[empty-turn]")).toBe(true)
  })

  test("the empty-exhausted reason classifies to a distinct NON-success bucket (TEETH)", () => {
    const cat = classifyErrorReason(EMPTY_TURN_EXHAUSTED_REASON)
    expect(cat.kind).toBe("failed")
    expect(cat.kind).not.toBe("completed")
    // TEETH: without the dedicated arm this would fall through to
    // runtime.unknown_error — pin the distinct code.
    expect(cat.reasonCode).toBe(STOP_REASON_CODE.MODEL_EMPTY_EXHAUSTED)
    expect(cat.reasonCode).not.toBe(STOP_REASON_CODE.RUNTIME_UNKNOWN_ERROR)
  })

  test("a text turn still proceeds and resets the empty counter (no over-reach)", () => {
    const rec = freshRecovery()
    rec.consecutiveEmpties = 1
    const a = decideOnAssembled("end_turn", textMsg("here is my answer"), rec)
    expect(a.do).toBe("proceed")
    expect(rec.consecutiveEmpties).toBe(0)
  })
})
