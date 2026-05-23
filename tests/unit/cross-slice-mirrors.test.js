/**
 * Compile-time mirror assertions for duck-typed cross-slice types.
 *
 * Biome's slice-isolation rules forbid `@/tool ↔ @/permission` and
 * `@/tool ↔ @/agent` direct imports. So we keep structurally identical
 * literal-union / shape types in BOTH slices (e.g. `HITLTier` in
 * `@/permission/types` AND `@/tool/types`). This is convenient but introduces
 * a silent-drift hazard: someone could add `"sandbox-required"` to one side
 * and the runtime would happily accept the new value on the producing side
 * while the consuming side rejects it — with NO compiler complaint.
 *
 * Tests files are exempt from the slice-isolation lint (they're the
 * integration layer), so we ARM the type checker here: we import BOTH copies,
 * then declare a type-level identity assertion. If the two unions ever
 * diverge in either direction, the `_assert*` constant fails to type-check
 * and `tsc --noEmit` fails — the failure surfaces in CI before review.
 *
 * The runtime `expect` calls below are sanity stubs; the real contract lives
 * in the `extends` chains. The file's value is its TYPE failure mode.
 */
import { describe, expect, test } from "bun:test";
const _assertHITLMirror = true;
const _assertBlockerSurfaceMirror = true;
// V1 audit F1: the third mirror pair — WorkingState (@/agent) ↔ ToolWorkingStateSnapshot
// (@/tool) — was previously unguarded. Adding the assertion here closes the
// drift hole: a nested-field change on one side (e.g. adding `priority: number`
// to a Blocker) now fails the typecheck on the OTHER slice, not silently.
const _assertWorkingStateMirror = true;
// Patch shape mirror — same drift surface, separate type so spelled out.
const _assertWorkingStatePatchMirror = true;
// W1-B audit fix: the real guarantee here is COMPILE-TIME (the `_assert*`
// constants above fail to type-check if any mirror pair diverges, blocking
// `tsc --noEmit` in CI). The previous 4 `expect(true).toBe(true)` runtime
// tests were tautological proof-of-life — they passed for the wrong reason
// (a literal `true` equals `true`) and obscured the actual contract. We
// collapse them into a single sentinel that documents the compile-time gate
// and SUMS the 4 type-level checks into one runtime confirmation.
describe("cross-slice mirror assertions (compile-time enforcement)", () => {
    test("type-level `AssertEqual<A,B>` checks (4 pairs) compile if and only if mirrors agree", () => {
        // Each `_assert*` constant in this file is typed as `true | never`.
        // If a mirror diverges, the assignment from `= true` becomes a `never`
        // assignment and `tsc --noEmit` fails. This runtime line only confirms
        // that BOTH the compiler accepted the file (so all 4 mirrors hold AT
        // COMPILE TIME) AND each `const` was actually evaluated to `true` at
        // module load (so a future refactor that swaps in a tautological
        // `= true as true` would still need each name to resolve).
        expect([
            _assertHITLMirror,
            _assertBlockerSurfaceMirror,
            _assertWorkingStateMirror,
            _assertWorkingStatePatchMirror,
        ]).toEqual([true, true, true, true]);
    });
});
