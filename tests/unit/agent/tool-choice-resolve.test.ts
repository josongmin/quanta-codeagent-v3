import { describe, expect, test } from "bun:test"
import {
  consumeTurnSignals,
  createToolChoiceTurnState,
  resolveToolChoice,
  type ToolChoice,
  type ToolChoiceSignals,
} from "@/agent/tool-choice"

/**
 * ADR-0079 — `resolveToolChoice(signals)` is a pure function over a closed
 * signal struct. These tests pin the precedence ladder plus the 1-turn-TTL
 * consume/clear discipline of the loop-owned turn state.
 *
 * Precedence (exhaustive):
 *   1. explicit !== undefined      → explicit
 *   2. closeoutAttempted === true   → {kind:"none"}
 *   3. otherwise                    → {kind:"auto"}
 *
 * `verifyGuardViolated` is DELIBERATELY NOT a tool_choice trigger: it falls
 * through to `auto`. The verify-guard's injected nudge is evidential and
 * invites a TEXT answer ("if you already verified, say HOW and proceed"), which
 * `{kind:"any"}` would mechanically ban. Forcing a tool there is a
 * self-contradicting force (and strands a read-only-scoped turn on a useless
 * tool). The tests below GO RED if the old `verifyGuardViolated → {kind:"any"}`
 * branch is restored.
 *
 * Every test must construct ONLY the closed `ToolChoiceSignals` struct — no
 * heuristic side-channel — to assert the policy is structural, not advisory.
 */

describe("resolveToolChoice — pure 4-way precedence", () => {
  test("default (no signals) ⇒ {kind:'auto'} — byte-identical wire payload", () => {
    // The whole point of the default case: with zero signals fire,
    // resolveToolChoice MUST return auto so the adapter omits the
    // tool_choice field on the wire and the request is byte-for-byte
    // identical to the pre-feature path.
    expect(resolveToolChoice({})).toEqual({ kind: "auto" })
  })

  test("verifyGuardViolated:true ⇒ {kind:'auto'} — NO forced tool; model may answer in text", () => {
    // TEETH: the verify-guard arms this AFTER a finish-intent right after an
    // unverified mutating tool, but it MUST NOT force a tool call. The guard's
    // injected nudge is evidential and explicitly invites the model to answer
    // in TEXT how it already verified ("say HOW … and proceed") OR run a test.
    // `{kind:"any"}` would mechanically ban that text answer and strand a
    // read-only-scoped turn on a useless tool. So this resolves to `auto`: the
    // model is free to call a verify tool OR answer in text. Restoring the old
    // `verifyGuardViolated → {kind:"any"}` branch FAILS this assertion.
    expect(resolveToolChoice({ verifyGuardViolated: true })).toEqual({ kind: "auto" })
    // Explicitly NOT the old forced shape.
    expect(resolveToolChoice({ verifyGuardViolated: true })).not.toEqual({ kind: "any" })
  })

  test("closeoutAttempted:true ⇒ {kind:'none'} — forbid any tool call", () => {
    // The closeout-guard arms this when the 4-truth-surface closeout reminder
    // was injected; the next LLM stream MUST be a terminal text turn — the
    // model cannot keep calling tools to delay the closeout. `none` maps to
    // Anthropic `tool_choice:{type:"none"}` and OpenAI `tool_choice:"none"`.
    expect(resolveToolChoice({ closeoutAttempted: true })).toEqual({ kind: "none" })
  })

  test("verifyGuardViolated + closeoutAttempted ⇒ closeout {none} wins — verify no longer forces", () => {
    // PAIRED CONTROL: verifyGuardViolated is now a no-op for tool_choice, so
    // when both are set the only remaining trigger is closeout, which forces a
    // terminal text turn `{kind:"none"}`. (Concurrent ARM is rare in practice —
    // verify-guard fires strictly before closeoutGuardStep — but the policy
    // MUST still be deterministic.) The closeout force is UNCHANGED by this fix.
    expect(resolveToolChoice({ verifyGuardViolated: true, closeoutAttempted: true })).toEqual({
      kind: "none",
    })
  })

  test("explicit override wins over every implicit signal", () => {
    // An explicit override (host-supplied, e.g. test injection, retry
    // strategy, runbook) MUST beat every implicit trigger. Verify ARM +
    // closeout ARM + a host-supplied `{kind:"tool", name:"read"}` ⇒ tool.
    // Why: explicit-over-implicit is the standard Codex/Cursor principle;
    // a host that pinned the choice gets exactly what it asked for.
    const explicit: ToolChoice = { kind: "tool", name: "read" }
    const signals: ToolChoiceSignals = {
      verifyGuardViolated: true,
      closeoutAttempted: true,
      explicit,
    }
    expect(resolveToolChoice(signals)).toEqual({ kind: "tool", name: "read" })
  })
})

describe("consumeTurnSignals — 1-turn-TTL clear discipline", () => {
  test("flags are READ once then CLEARED — never carry across two consumes", () => {
    // The whole point of 1-turn-TTL: the loop's consumeTurnSignals is the
    // SINGLE canonical clear point. A flag set by verify-/closeout-guard at
    // finish-intent MUST be visible to exactly ONE next consume, never two.
    // A second consume on the same state ⇒ empty signals ⇒ resolves to auto.
    const state = createToolChoiceTurnState()
    state.verifyGuardViolated = true
    state.closeoutAttempted = true

    const first = consumeTurnSignals(state)
    expect(first.verifyGuardViolated).toBe(true)
    expect(first.closeoutAttempted).toBe(true)
    // After consume the underlying mutable state is cleared in place.
    expect(state.verifyGuardViolated).toBe(false)
    expect(state.closeoutAttempted).toBe(false)
    // A second consume on the same state ⇒ no signals ⇒ resolves to auto.
    const second = consumeTurnSignals(state)
    expect(resolveToolChoice(second)).toEqual({ kind: "auto" })
  })
})
