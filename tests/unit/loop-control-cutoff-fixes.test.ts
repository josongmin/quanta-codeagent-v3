/**
 * Loop-control cutoff fixes (jun-25) — focused unit battery.
 *
 * Closes the test gap on `decideOnAssembled` (previously had NO direct unit
 * test — only the refusal branch was exercised via recovery-hell.test.ts) plus
 * the FIX-1 turn-budget reminder seam. Three product-loop cutoff bugs:
 *
 *   FIX-1  the turn budget is INVISIBLE to the model → the outer loop hard-cuts
 *          at `maxTurns` with no chance to finalize. `turnBudgetReminderText`
 *          must surface a one-line reminder in the tail (and ONLY in the tail,
 *          and NEVER for unbounded maxTurns).
 *   FIX-2  a malformed tool_use (model INTENDED to act, emitted no valid call)
 *          was sealed as `completed`/success after the retry cap → misclassified
 *          a fumble as success. It must now seal as a NON-success terminal.
 *   FIX-3  a `max_tokens`-truncated turn sealed after the continuation cap had
 *          NO marker → a mid-sentence answer read as a clean completion. The
 *          surfaced text must now carry a visible truncation marker.
 *
 * PURE — no LLM, no IO. Drives `decideOnAssembled` / `turnBudgetReminderText`
 * directly. Teeth are called out per-block (the assertion the PRE-fix code
 * would FAIL).
 */
import { describe, expect, test } from "bun:test"
import { decideOnAssembled, freshRecovery } from "@/agent/loop"
import { injectTurnBudgetReminder, turnBudgetReminderText } from "@/agent/loop/turn-iteration"
import {
  EMPTY_TURN_EXHAUSTED_REASON,
  MALFORMED_TOOL_USE_REASON,
  OUTPUT_TRUNCATED_MARKER,
  RECOVERY_CAPS,
} from "@/agent/recovery"
import { classifyErrorReason, STOP_REASON_CODE } from "@/agent/stop-category"
import type { AgentConfig } from "@/agent/types"
import type { Message } from "@/llm"
import { createWorkingMemory } from "@/memory"

const assistant = (...content: Message["content"]): Message => ({ role: "assistant", content })
const textMsg = (text: string): Message => assistant({ type: "text", text })
const toolMsg = (id: string): Message =>
  assistant({ type: "tool_use", id, name: "read", input: { path: "/x" } })
const thinkingMsg = (think: string): Message => assistant({ type: "thinking", thinking: think })
const empty = (): Message => assistant()

// ─── (a) empty-turn — nudge under cap, NON-success terminal at cap ─────────
// jul-3: the empty-exhaustion path now seals NON-success (was `completed`), the
// twin of FIX-2. The dedicated hell-gate lives in
// tests/unit/agent/empty-turn-exhaustion-hellgate.test.ts; this block keeps the
// under-cap nudge control and the flipped at-cap seal in the FIX battery.

describe("decideOnAssembled — empty-turn nudge/exhaustion", () => {
  test("first empty turn ⇒ nudge (consumes one empty slot), NOT completed", () => {
    const rec = freshRecovery()
    const a = decideOnAssembled("end_turn", empty(), rec)
    expect(a.do).toBe("nudge")
    expect(rec.consecutiveEmpties).toBe(1)
  })

  test("empty×(cap) then one more empty ⇒ NON-success terminal, NOT completed", () => {
    const rec = freshRecovery()
    // Drive the empty counter to the cap via repeated empties.
    for (let i = 0; i < RECOVERY_CAPS.consecutiveEmpties; i++) {
      const a = decideOnAssembled("end_turn", empty(), rec)
      expect(a.do).toBe("nudge")
    }
    const sealed = decideOnAssembled("end_turn", empty(), rec)
    // TEETH: pre-fix (jul-3) this returned { do: "completed" } — a produced-
    // NOTHING stall sealed as SUCCESS. It must now be a non-success terminal.
    expect(sealed.do).not.toBe("completed")
    expect(sealed.do).toBe("error")
    if (sealed.do === "error") expect(sealed.reason).toBe(EMPTY_TURN_EXHAUSTED_REASON)
  })

  test("a turn with text ⇒ proceed and resets the empty counter (unchanged)", () => {
    const rec = freshRecovery()
    rec.consecutiveEmpties = 1
    const a = decideOnAssembled("end_turn", textMsg("here is my answer"), rec)
    expect(a.do).toBe("proceed")
    expect(rec.consecutiveEmpties).toBe(0)
  })
})

// ─── (b) FIX-2 — malformed tool_use ⇒ NON-success terminal after cap ───────

describe("decideOnAssembled — FIX-2 malformed tool_use seals NON-success", () => {
  test("first malformed (tool_use stop, no tool block) ⇒ nudge re-issue", () => {
    const rec = freshRecovery()
    const a = decideOnAssembled("tool_use", textMsg("(no valid tool call emitted)"), rec)
    expect(a.do).toBe("nudge")
    expect(rec.malformedRetries).toBe(1)
  })

  test("after the malformed retry cap ⇒ NON-success terminal, NOT completed", () => {
    const rec = freshRecovery()
    // Exhaust the malformed retry budget.
    for (let i = 0; i < RECOVERY_CAPS.malformedRetries; i++) {
      decideOnAssembled("tool_use", textMsg("(still no valid tool call)"), rec)
    }
    const sealed = decideOnAssembled("tool_use", textMsg("(still no valid tool call)"), rec)
    // TEETH: pre-fix this returned { do: "completed" } — a fumbled tool call
    // sealed as SUCCESS. It must now be a non-success error-class terminal.
    expect(sealed.do).not.toBe("completed")
    expect(sealed.do).toBe("error")
    if (sealed.do === "error") {
      expect(sealed.reason).toBe(MALFORMED_TOOL_USE_REASON)
    }
  })

  test("the malformed terminal reason classifies to a distinct NON-success bucket", () => {
    // The outer resolver routes { do: "error", reason } through classifyErrorReason.
    const cat = classifyErrorReason(MALFORMED_TOOL_USE_REASON)
    expect(cat.kind).toBe("failed")
    expect(cat.kind).not.toBe("completed")
    expect(cat.reasonCode).toBe(STOP_REASON_CODE.MODEL_MALFORMED_TOOL_USE)
  })
})

// ─── (c) FIX-3 — max_tokens after cap carries the truncation marker ────────

describe("decideOnAssembled — FIX-3 truncated output is marked", () => {
  test("under the continuation cap ⇒ nudge to continue (no marker yet)", () => {
    const rec = freshRecovery()
    const msg = textMsg("partial answer that ran out of room")
    const a = decideOnAssembled("max_tokens", msg, rec)
    expect(a.do).toBe("nudge")
    expect(msg.content[0]).toMatchObject({ type: "text" })
    // No marker while we are still continuing.
    if (msg.content[0]?.type === "text") {
      expect(msg.content[0].text.includes(OUTPUT_TRUNCATED_MARKER.trim())).toBe(false)
    }
  })

  test("still max_tokens after the continuation cap ⇒ sealed text carries the marker", () => {
    const rec = freshRecovery()
    let msg = textMsg("partial answer cut")
    // Spend the continuation budget.
    for (let i = 0; i < RECOVERY_CAPS.outputContinues; i++) {
      msg = textMsg("partial answer cut")
      const a = decideOnAssembled("max_tokens", msg, rec)
      expect(a.do).toBe("nudge")
    }
    const finalMsg = textMsg("the final mid-sentence text that got")
    const sealed = decideOnAssembled("max_tokens", finalMsg, rec)
    // The turn seals via the text-completion path (proceed → completed downstream).
    expect(sealed.do).toBe("proceed")
    const tail = finalMsg.content.find((b) => b.type === "text")
    // TEETH: pre-fix the text was UNMARKED — a mid-sentence answer read clean.
    expect(tail?.type === "text" && tail.text.endsWith(OUTPUT_TRUNCATED_MARKER)).toBe(true)
  })

  test("marker is idempotent — re-deciding the same sealed message never doubles it", () => {
    const rec = freshRecovery()
    for (let i = 0; i < RECOVERY_CAPS.outputContinues; i++) {
      decideOnAssembled("max_tokens", textMsg("x"), rec)
    }
    const msg = textMsg("once-cut")
    decideOnAssembled("max_tokens", msg, rec)
    // A second decide on the SAME message (e.g. guard re-entry) must not re-append.
    decideOnAssembled("max_tokens", msg, rec)
    const tail = msg.content.find((b) => b.type === "text")
    const occurrences =
      tail?.type === "text" ? tail.text.split(OUTPUT_TRUNCATED_MARKER.trim()).length - 1 : -1
    expect(occurrences).toBe(1)
  })

  test("thinking-only truncated turn ⇒ a fresh text block carries the marker", () => {
    const rec = freshRecovery()
    for (let i = 0; i < RECOVERY_CAPS.outputContinues; i++) {
      decideOnAssembled("max_tokens", thinkingMsg("thinking"), rec)
    }
    const msg = thinkingMsg("more private thinking, no visible text")
    decideOnAssembled("max_tokens", msg, rec)
    const tail = msg.content.find((b) => b.type === "text")
    expect(tail?.type === "text" && tail.text.includes(OUTPUT_TRUNCATED_MARKER.trim())).toBe(true)
  })
})

// ─── (d) FIX-1 — turn-budget tail reminder ────────────────────────────────

describe("turnBudgetReminderText — FIX-1 makes the approaching limit visible", () => {
  const MAX = 20 // headless budget
  const K = 3

  test("early turns (turn < maxTurns - K) ⇒ NO reminder", () => {
    // TEETH: a reminder injected too early would spam every turn.
    expect(turnBudgetReminderText(1, MAX, K)).toBeNull()
    expect(turnBudgetReminderText(MAX - K - 1, MAX, K)).toBeNull()
  })

  test("first tail turn (turn === maxTurns - K) ⇒ reminder with remaining count", () => {
    const text = turnBudgetReminderText(MAX - K, MAX, K)
    expect(text).not.toBeNull()
    expect(text).toContain(`${K} turns remain`)
    expect(text?.toLowerCase()).toContain("finalize")
  })

  test("the LAST turn (turn === maxTurns) ⇒ a distinct LAST-turn message", () => {
    const text = turnBudgetReminderText(MAX, MAX, K)
    expect(text).not.toBeNull()
    expect(text?.toUpperCase()).toContain("LAST TURN")
  })

  test("singular grammar at exactly one turn remaining", () => {
    const text = turnBudgetReminderText(MAX - 1, MAX, K)
    expect(text).toContain("1 turn remains")
    expect(text).not.toContain("turns remain ")
  })

  test("UNBOUNDED maxTurns (Infinity) ⇒ NEVER a reminder (byte-identical default)", () => {
    // TEETH: the byte-identical guarantee for unbounded/interactive-unbounded.
    expect(turnBudgetReminderText(1, Number.POSITIVE_INFINITY, K)).toBeNull()
    expect(turnBudgetReminderText(10_000, Number.POSITIVE_INFINITY, K)).toBeNull()
    expect(turnBudgetReminderText(5, Number.NaN, K)).toBeNull()
  })

  test("degenerate maxTurns <= 0 ⇒ no reminder", () => {
    expect(turnBudgetReminderText(1, 0, K)).toBeNull()
    expect(turnBudgetReminderText(1, -5, K)).toBeNull()
  })
})

// ─── (d') FIX-1 WIRING — injectTurnBudgetReminder appends to working memory ─

describe("injectTurnBudgetReminder — FIX-1 wiring proof", () => {
  const cfgWith = (maxTurns: number): AgentConfig => ({ maxTurns }) as unknown as AgentConfig

  test("a tail turn appends ONE out-of-band user reminder to working memory", () => {
    const wm = createWorkingMemory<Message>([])
    injectTurnBudgetReminder(cfgWith(20), wm, 18 /* maxTurns-K = 17, so in tail */)
    const snap = wm.snapshot()
    expect(snap.length).toBe(1)
    expect(snap[0]?.role).toBe("user")
    const block = snap[0]?.content[0]
    expect(block?.type === "text" && block.text.toLowerCase().includes("finalize")).toBe(true)
  })

  test("an early turn appends NOTHING (no-op)", () => {
    const wm = createWorkingMemory<Message>([])
    injectTurnBudgetReminder(cfgWith(20), wm, 1)
    expect(wm.snapshot().length).toBe(0)
  })

  test("UNBOUNDED maxTurns appends NOTHING — byte-identical default", () => {
    // TEETH: the seam must be inert for unbounded modes (no extra wm message).
    const wm = createWorkingMemory<Message>([])
    injectTurnBudgetReminder(cfgWith(Number.POSITIVE_INFINITY), wm, 9_999)
    expect(wm.snapshot().length).toBe(0)
  })
})
