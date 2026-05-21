/**
 * ADR-0076 Gap-1 — `decideOnAssembled` refusal-branch HELL-GATE.
 *
 * Adversarial pinning for the one-line branch landed at `loop.ts:739`:
 *
 *   if (stopReason === "refusal") return { do: "error", reason: "Model refused …" }
 *
 * Negative invariants this file pins (matches ADR-0076 §Negative invariants):
 *
 *   NI-1  Refusal MUST surface as `do: "error"` — never `proceed` / `completed`.
 *         The pre-ADR fall-through bug disguised refusals as completed turns.
 *   NI-2  `pause_turn` / `content_filtered` / `guardrail_intervened` stay
 *         UN-BRANCHED until the relevant provider integration ADR lands —
 *         they must `proceed` exactly like every other unrecognized stop.
 *   NI-x  Refusal MUST consume NO recovery budget (outputContinues /
 *         malformedRetries / consecutiveEmpties stay at 0): the branch is
 *         terminal, not a retry — the caller closes the turn with `error`.
 *   NI-x  Exact match only — `Refusal` / `REFUSAL` / `refused` / `blocked`
 *         MUST fall through to `proceed`. False positives are an attack
 *         vector (a provider quirk that capitalizes the literal would
 *         silently start failing every turn if we case-insensitive-matched).
 *
 * Tests are PURE — no LLM, no IO. They drive `decideOnAssembled` directly.
 */
import { describe, expect, test } from "bun:test"
import { decideOnAssembled, freshRecovery } from "@/agent/loop"
import type { Message } from "@/llm"

const assistant = (...content: Message["content"]): Message => ({ role: "assistant", content })
const textMsg = (text: string): Message => assistant({ type: "text", text })
const toolMsg = (id: string): Message =>
  assistant({ type: "tool_use", id, name: "read", input: { path: "/x" } })
const thinkingMsg = (think: string): Message => assistant({ type: "thinking", thinking: think })
const empty = (): Message => assistant()

// ─── 1. Refusal × content-shape cross-product ─────────────────────────────

describe("ADR-0076 NI-1 — refusal terminal across every assistant content shape", () => {
  test("refusal + plain text content ⇒ error (the canonical case)", () => {
    const rec = freshRecovery()
    const a = decideOnAssembled("refusal", textMsg("I can't help with that."), rec)
    expect(a.do).toBe("error")
    if (a.do === "error") expect(a.reason).toContain("refused")
  })

  test("refusal + tool_use block ⇒ error (tool MUST NOT execute, refusal precedence)", () => {
    // Critical attack vector: provider returns refusal stop_reason but the
    // assembled message also carries a tool_use block. If the branch order
    // were wrong (tool_use checked first), the tool would dispatch despite
    // the refusal. The refusal branch sits BEFORE the tool-shape branches
    // exactly to prevent this.
    const rec = freshRecovery()
    const a = decideOnAssembled("refusal", toolMsg("t1"), rec)
    expect(a.do).toBe("error")
    if (a.do === "error") expect(a.reason).toContain("refused")
  })

  test("refusal + ThinkingBlock content ⇒ error (thinking is NOT carried back as a turn answer)", () => {
    const rec = freshRecovery()
    const a = decideOnAssembled("refusal", thinkingMsg("I shouldn't continue."), rec)
    expect(a.do).toBe("error")
  })

  test("refusal + empty message content ⇒ error (refusal branch beats the empty-turn branch)", () => {
    const rec = freshRecovery()
    const a = decideOnAssembled("refusal", empty(), rec)
    // The branch order in loop.ts:739 places refusal BEFORE the empty-turn
    // check (loop.ts:771). An empty refusal message must NOT be nudged.
    expect(a.do).toBe("error")
  })

  test("refusal + multi-block (text + tool_use + thinking) ⇒ error (catches every block kind)", () => {
    const rec = freshRecovery()
    const msg = assistant(
      { type: "thinking", thinking: "deliberation" },
      { type: "text", text: "I cannot." },
      { type: "tool_use", id: "t1", name: "read", input: {} },
    )
    const a = decideOnAssembled("refusal", msg, rec)
    expect(a.do).toBe("error")
  })
})

// ─── 2. Refusal must NOT consume recovery budget ───────────────────────────

describe("ADR-0076 — refusal does not consume same-turn recovery budget", () => {
  test("rec.outputContinues unchanged (refusal is not a `max_tokens` style nudge)", () => {
    const rec = freshRecovery()
    decideOnAssembled("refusal", textMsg("no"), rec)
    expect(rec.outputContinues).toBe(0)
  })

  test("rec.malformedRetries unchanged (refusal is not a malformed-tool retry)", () => {
    const rec = freshRecovery()
    decideOnAssembled("refusal", toolMsg("t1"), rec)
    expect(rec.malformedRetries).toBe(0)
  })

  test("rec.consecutiveEmpties unchanged (refusal is not an empty-turn nudge)", () => {
    const rec = freshRecovery()
    decideOnAssembled("refusal", empty(), rec)
    expect(rec.consecutiveEmpties).toBe(0)
  })

  test("after 10 consecutive refusals, recovery state is byte-identical to fresh", () => {
    // Stress: even repeated refusal evaluation on the same rec object must not
    // drift any counter. The branch is terminal — the caller closes the turn
    // — but the policy function itself stays idempotent across re-invocations.
    const rec = freshRecovery()
    for (let i = 0; i < 10; i++) decideOnAssembled("refusal", textMsg("no"), rec)
    expect(rec).toEqual(freshRecovery())
  })

  test("refusal is idempotent: same input ⇒ same output (no hidden state in policy)", () => {
    const rec = freshRecovery()
    const a1 = decideOnAssembled("refusal", textMsg("no"), rec)
    const a2 = decideOnAssembled("refusal", textMsg("no"), rec)
    expect(a1).toEqual(a2)
  })
})

// ─── 3. Refusal error message contract (surface parse-ability) ────────────

describe("ADR-0076 — refusal error message rationale (surface contract)", () => {
  test("error reason contains the keyword `refused` (parse-able by host UIs)", () => {
    const rec = freshRecovery()
    const a = decideOnAssembled("refusal", textMsg("no"), rec)
    if (a.do !== "error") throw new Error("expected error")
    expect(a.reason.toLowerCase()).toContain("refused")
  })

  test("error reason mentions `refusal` so a log scanner can trace the cause", () => {
    const rec = freshRecovery()
    const a = decideOnAssembled("refusal", textMsg("no"), rec)
    if (a.do !== "error") throw new Error("expected error")
    expect(a.reason.toLowerCase()).toContain("refusal")
  })
})

// ─── 4. Exact-match invariant — case variants MUST fall through ───────────

describe("ADR-0076 — exact-match: false-positive variants stay un-branched", () => {
  test("`Refusal` (capitalized) ⇒ proceed (no case folding)", () => {
    const rec = freshRecovery()
    const a = decideOnAssembled("Refusal", textMsg("hi"), rec)
    expect(a.do).toBe("proceed")
  })

  test("`REFUSAL` (upper) ⇒ proceed", () => {
    const rec = freshRecovery()
    const a = decideOnAssembled("REFUSAL", textMsg("hi"), rec)
    expect(a.do).toBe("proceed")
  })

  test("`refused` (past tense, sibling) ⇒ proceed (not the canonical literal)", () => {
    const rec = freshRecovery()
    const a = decideOnAssembled("refused", textMsg("hi"), rec)
    expect(a.do).toBe("proceed")
  })

  test("`blocked` (a different stop word) ⇒ proceed", () => {
    const rec = freshRecovery()
    const a = decideOnAssembled("blocked", textMsg("hi"), rec)
    expect(a.do).toBe("proceed")
  })

  test("leading/trailing whitespace `' refusal '` ⇒ proceed (no trim)", () => {
    const rec = freshRecovery()
    const a = decideOnAssembled(" refusal ", textMsg("hi"), rec)
    expect(a.do).toBe("proceed")
  })

  test("empty string stop_reason ⇒ proceed (defensive fall-through)", () => {
    const rec = freshRecovery()
    const a = decideOnAssembled("", textMsg("hi"), rec)
    expect(a.do).toBe("proceed")
  })

  test("`refusal` substring inside a longer reason ⇒ proceed (no substring match)", () => {
    const rec = freshRecovery()
    const a = decideOnAssembled("user-refusal-override", textMsg("hi"), rec)
    expect(a.do).toBe("proceed")
  })
})

// ─── 5. ADR-0076 NI-2: deliberately-dead branches MUST stay un-branched ────

describe("ADR-0076 NI-2 — `pause_turn` / `content_filtered` / `guardrail_intervened` stay un-branched", () => {
  test("`pause_turn` ⇒ proceed (server-tool resume; we ship no server tools)", () => {
    const rec = freshRecovery()
    const a = decideOnAssembled("pause_turn", textMsg("ack"), rec)
    expect(a.do).toBe("proceed")
  })

  test("`content_filtered` ⇒ proceed (no Bedrock guardrail integration)", () => {
    const rec = freshRecovery()
    const a = decideOnAssembled("content_filtered", textMsg("ack"), rec)
    expect(a.do).toBe("proceed")
  })

  test("`guardrail_intervened` ⇒ proceed (NI-2 — adding a branch is cargo)", () => {
    const rec = freshRecovery()
    const a = decideOnAssembled("guardrail_intervened", textMsg("ack"), rec)
    expect(a.do).toBe("proceed")
  })

  test("ADDING any of these to a branch later would break this test — that's the point", () => {
    // Defense-in-depth: the three literals are checked together so a future
    // hand-roll of a dead branch (cargo-culted from an absorption ADR that
    // does not actually wire the integration) lights up here, not in prod.
    const rec = freshRecovery()
    expect(decideOnAssembled("pause_turn", textMsg("x"), rec).do).toBe("proceed")
    expect(decideOnAssembled("content_filtered", textMsg("x"), rec).do).toBe("proceed")
    expect(decideOnAssembled("guardrail_intervened", textMsg("x"), rec).do).toBe("proceed")
  })
})

// ─── 6. Refusal vs other branches — precedence ────────────────────────────

describe("ADR-0076 — refusal precedence over other branches", () => {
  test("refusal precedence is structural, not budget-driven", () => {
    // Even when the same-turn budget is fully exhausted (would normally route
    // an empty turn to `completed`), refusal still terminates with `error`.
    const rec = freshRecovery()
    rec.consecutiveEmpties = 99
    const a = decideOnAssembled("refusal", empty(), rec)
    expect(a.do).toBe("error")
  })

  test("refusal precedence holds even after a prior `max_tokens` nudge consumed budget", () => {
    const rec = freshRecovery()
    rec.outputContinues = 2
    const a = decideOnAssembled("refusal", textMsg("no"), rec)
    expect(a.do).toBe("error")
  })

  test("refusal precedence holds even after a prior malformed-tool nudge consumed budget", () => {
    const rec = freshRecovery()
    rec.malformedRetries = 1
    const a = decideOnAssembled("refusal", toolMsg("t1"), rec)
    expect(a.do).toBe("error")
  })
})

// ─── 7. Adjacent stop_reason values stay correct (regression baseline) ─────

describe("ADR-0076 — baseline non-refusal stops continue to route correctly", () => {
  test("`end_turn` + text content ⇒ proceed (normal completion path)", () => {
    const rec = freshRecovery()
    expect(decideOnAssembled("end_turn", textMsg("done"), rec).do).toBe("proceed")
  })

  test("`tool_use` + tool blocks ⇒ proceed (normal dispatch path)", () => {
    const rec = freshRecovery()
    expect(decideOnAssembled("tool_use", toolMsg("t1"), rec).do).toBe("proceed")
  })

  test("`stop` (OpenAI literal) + text content ⇒ proceed (fall-through is the contract)", () => {
    const rec = freshRecovery()
    expect(decideOnAssembled("stop", textMsg("ok"), rec).do).toBe("proceed")
  })

  test("arbitrary novel stop_reason + text content ⇒ proceed (open-set tolerance)", () => {
    const rec = freshRecovery()
    expect(decideOnAssembled("future_unknown_stop_2030", textMsg("ok"), rec).do).toBe("proceed")
  })
})
