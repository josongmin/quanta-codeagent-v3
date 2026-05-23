import { describe, expect, test } from "bun:test";
import { consumeTurnSignals, createToolChoiceTurnState, resolveToolChoice, } from "@/agent/tool-choice";
/**
 * ADR-0079 — `resolveToolChoice(signals)` is a pure function over a closed
 * signal struct. Five tests pin the four-way precedence ladder plus the
 * 1-turn-TTL consume/clear discipline of the loop-owned turn state.
 *
 * Precedence (exhaustive):
 *   1. explicit !== undefined      → explicit
 *   2. verifyGuardViolated === true → {kind:"any"}
 *   3. closeoutAttempted === true   → {kind:"none"}
 *   4. otherwise                    → {kind:"auto"}
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
        expect(resolveToolChoice({})).toEqual({ kind: "auto" });
    });
    test("verifyGuardViolated:true ⇒ {kind:'any'} — force model to call a tool", () => {
        // The verify-guard arms this AFTER a finish-intent right after an
        // unverified mutating tool. The next LLM stream must FORCE the model to
        // emit a tool_use (typically a verify) — `any` is the closed-union variant
        // that maps to Anthropic `tool_choice:{type:"any"}` and OpenAI
        // `tool_choice:"required"`. No name pinning: the verify-guard does not
        // dictate WHICH tool, only that ONE must be called.
        expect(resolveToolChoice({ verifyGuardViolated: true })).toEqual({ kind: "any" });
    });
    test("closeoutAttempted:true ⇒ {kind:'none'} — forbid any tool call", () => {
        // The closeout-guard arms this when the 4-truth-surface closeout reminder
        // was injected; the next LLM stream MUST be a terminal text turn — the
        // model cannot keep calling tools to delay the closeout. `none` maps to
        // Anthropic `tool_choice:{type:"none"}` and OpenAI `tool_choice:"none"`.
        expect(resolveToolChoice({ closeoutAttempted: true })).toEqual({ kind: "none" });
    });
    test("verifyGuardViolated + closeoutAttempted ⇒ verify wins (any) — verify > closeout precedence", () => {
        // Precedence is documented order: verifyGuardViolated checked BEFORE
        // closeoutAttempted. A session that simultaneously sets both should
        // emit `any` (verify forced) — the model still has to verify before
        // it gets to the closeout-text-only branch. Loop-level ordering also
        // ensures verify-guard fires first (its check runs strictly before
        // closeoutGuardStep in applyAction), so a concurrent ARM is rare in
        // practice — but the policy MUST still be deterministic.
        expect(resolveToolChoice({ verifyGuardViolated: true, closeoutAttempted: true })).toEqual({
            kind: "any",
        });
    });
    test("explicit override wins over every implicit signal", () => {
        // An explicit override (host-supplied, e.g. test injection, retry
        // strategy, runbook) MUST beat every implicit trigger. Verify ARM +
        // closeout ARM + a host-supplied `{kind:"tool", name:"read"}` ⇒ tool.
        // Why: explicit-over-implicit is the standard Codex/Cursor principle;
        // a host that pinned the choice gets exactly what it asked for.
        const explicit = { kind: "tool", name: "read" };
        const signals = {
            verifyGuardViolated: true,
            closeoutAttempted: true,
            explicit,
        };
        expect(resolveToolChoice(signals)).toEqual({ kind: "tool", name: "read" });
    });
});
describe("consumeTurnSignals — 1-turn-TTL clear discipline", () => {
    test("flags are READ once then CLEARED — never carry across two consumes", () => {
        // The whole point of 1-turn-TTL: the loop's consumeTurnSignals is the
        // SINGLE canonical clear point. A flag set by verify-/closeout-guard at
        // finish-intent MUST be visible to exactly ONE next consume, never two.
        // A second consume on the same state ⇒ empty signals ⇒ resolves to auto.
        const state = createToolChoiceTurnState();
        state.verifyGuardViolated = true;
        state.closeoutAttempted = true;
        const first = consumeTurnSignals(state);
        expect(first.verifyGuardViolated).toBe(true);
        expect(first.closeoutAttempted).toBe(true);
        // After consume the underlying mutable state is cleared in place.
        expect(state.verifyGuardViolated).toBe(false);
        expect(state.closeoutAttempted).toBe(false);
        // A second consume on the same state ⇒ no signals ⇒ resolves to auto.
        const second = consumeTurnSignals(state);
        expect(resolveToolChoice(second)).toEqual({ kind: "auto" });
    });
});
