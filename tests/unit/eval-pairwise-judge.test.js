/**
 * Pairwise judge — bias-swap resolution pins.
 *
 *   1. forward picks A AND swapped picks B (= original A again) ⇒ winner=0.
 *   2. forward picks A AND swapped picks A (= original B) ⇒ tie (-1).
 *   3. either side ties ⇒ overall tie.
 *
 * We don't drive the full LLM here; the resolver is pure and isolated for
 * exactly this kind of test. The full judge is covered by an integration
 * smoke test (requires API keys) and not part of this unit suite.
 */
import { describe, expect, test } from "bun:test";
import { resolveWinner } from "@/../src/apps/eval/compare/pairwise-judge";
describe("pairwise resolveWinner", () => {
    test("A then B (after swap) ⇒ original participant 0 wins", () => {
        expect(resolveWinner("A", "B")).toBe(0);
    });
    test("B then A (after swap) ⇒ original participant 1 wins", () => {
        expect(resolveWinner("B", "A")).toBe(1);
    });
    test("forward A, swapped A ⇒ position bias ⇒ tie", () => {
        expect(resolveWinner("A", "A")).toBe(-1);
    });
    test("forward B, swapped B ⇒ position bias ⇒ tie", () => {
        expect(resolveWinner("B", "B")).toBe(-1);
    });
    test("any tie input ⇒ tie", () => {
        expect(resolveWinner("tie", "A")).toBe(-1);
        expect(resolveWinner("A", "tie")).toBe(-1);
        expect(resolveWinner("tie", "tie")).toBe(-1);
    });
});
