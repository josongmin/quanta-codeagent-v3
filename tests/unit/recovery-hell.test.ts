/**
 * ADR-0076 Gap-1 SOTA++ — `decideOnAssembled` refusal-branch HELL-GATE.
 *
 * Adversarial pinning for the typed-refusal branch in `recovery.ts`:
 *
 *   if (stopReason === "refusal")
 *     return { do: "refusal", rationale: extractRefusalRationale(message) }
 *
 * Negative invariants this file pins (matches ADR-0076 §Negative invariants):
 *
 *   NI-1  Refusal MUST surface as `do: "refusal"` — never `proceed` /
 *         `completed` / `error`. The pre-SOTA++ generic-error contract
 *         (which itself replaced the pre-ADR fall-through bug) lost the
 *         "model declined vs loop failed" distinction; SOTA++ restores it.
 *   NI-2  `pause_turn` / `content_filtered` / `guardrail_intervened` stay
 *         UN-BRANCHED until the relevant provider integration ADR lands —
 *         they must `proceed` exactly like every other unrecognized stop.
 *   NI-x  Refusal MUST consume NO recovery budget (outputContinues /
 *         malformedRetries / consecutiveEmpties stay at 0): the branch is
 *         terminal, not a retry — the loop closes the turn with reason
 *         `refusal` and `AgentOutcome.refusal.rationale = <text>`.
 *   NI-x  Exact match only — `Refusal` / `REFUSAL` / `refused` / `blocked`
 *         MUST fall through to `proceed`. False positives are an attack
 *         vector (a provider quirk that capitalizes the literal would
 *         silently start failing every turn if we case-insensitive-matched).
 *
 * Tests are PURE — no LLM, no IO. They drive `decideOnAssembled` directly.
 * Rationale-shape coverage (multi-text-block / unicode / very-long / mixed
 * tool_use+text) lives in `tests/unit/refusal-handling.test.ts` (SOTA++
 * companion battery).
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
  test("refusal + plain text content ⇒ typed refusal carrying the text (the canonical case)", () => {
    const rec = freshRecovery()
    const a = decideOnAssembled("refusal", textMsg("I can't help with that."), rec)
    expect(a.do).toBe("refusal")
    if (a.do === "refusal") expect(a.rationale).toBe("I can't help with that.")
  })

  test("refusal + tool_use block ⇒ refusal (tool MUST NOT execute; rationale='' since no text block)", () => {
    // Critical attack vector: provider returns refusal stop_reason but the
    // assembled message also carries a tool_use block. If the branch order
    // were wrong (tool_use checked first), the tool would dispatch despite
    // the refusal. The refusal branch sits BEFORE the tool-shape branches
    // exactly to prevent this.
    const rec = freshRecovery()
    const a = decideOnAssembled("refusal", toolMsg("t1"), rec)
    expect(a.do).toBe("refusal")
    if (a.do === "refusal") expect(a.rationale).toBe("")
  })

  test("refusal + ThinkingBlock content ⇒ refusal with rationale='' (thinking is NOT a public SAY)", () => {
    const rec = freshRecovery()
    const a = decideOnAssembled("refusal", thinkingMsg("I shouldn't continue."), rec)
    expect(a.do).toBe("refusal")
    if (a.do === "refusal") expect(a.rationale).toBe("")
  })

  test("refusal + empty message content ⇒ refusal with rationale='' (beats the empty-turn branch)", () => {
    const rec = freshRecovery()
    const a = decideOnAssembled("refusal", empty(), rec)
    // The branch order in recovery.ts places refusal BEFORE the empty-turn
    // check. An empty refusal message must NOT be nudged.
    expect(a.do).toBe("refusal")
    if (a.do === "refusal") expect(a.rationale).toBe("")
  })

  test("refusal + multi-block (text + tool_use + thinking) ⇒ refusal carrying ONLY the text block", () => {
    const rec = freshRecovery()
    const msg = assistant(
      { type: "thinking", thinking: "deliberation" },
      { type: "text", text: "I cannot." },
      { type: "tool_use", id: "t1", name: "read", input: {} },
    )
    const a = decideOnAssembled("refusal", msg, rec)
    expect(a.do).toBe("refusal")
    if (a.do === "refusal") expect(a.rationale).toBe("I cannot.")
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

describe("ADR-0076 SOTA++ — refusal rationale (surface contract)", () => {
  test("rationale carries the assistant's visible text verbatim (parse-able by host UIs)", () => {
    const rec = freshRecovery()
    const a = decideOnAssembled("refusal", textMsg("I will not help with that."), rec)
    if (a.do !== "refusal") throw new Error("expected refusal")
    expect(a.rationale).toBe("I will not help with that.")
  })

  test("rationale is empty string when the refusing message had no visible text", () => {
    // Surface contract: an empty string (NOT `undefined`, NOT absent) means
    // "refusal carried no rationale" — a host can render a fixed "Refused
    // without rationale" copy without inspecting `undefined`.
    const rec = freshRecovery()
    const a = decideOnAssembled("refusal", empty(), rec)
    if (a.do !== "refusal") throw new Error("expected refusal")
    expect(a.rationale).toBe("")
    expect(typeof a.rationale).toBe("string")
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
    // an empty turn to `completed`), refusal still terminates with `refusal`.
    const rec = freshRecovery()
    rec.consecutiveEmpties = 99
    const a = decideOnAssembled("refusal", empty(), rec)
    expect(a.do).toBe("refusal")
  })

  test("refusal precedence holds even after a prior `max_tokens` nudge consumed budget", () => {
    const rec = freshRecovery()
    rec.outputContinues = 2
    const a = decideOnAssembled("refusal", textMsg("no"), rec)
    expect(a.do).toBe("refusal")
  })

  test("refusal precedence holds even after a prior malformed-tool nudge consumed budget", () => {
    const rec = freshRecovery()
    rec.malformedRetries = 1
    const a = decideOnAssembled("refusal", toolMsg("t1"), rec)
    expect(a.do).toBe("refusal")
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
