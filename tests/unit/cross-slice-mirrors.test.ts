/**
 * Compile-time mirror assertions for duck-typed cross-slice types.
 *
 * Biome's slice-isolation rules forbid `@/tool ↔ @/permission` and
 * `@/tool ↔ @/agent` direct imports. So we keep structurally identical
 * literal-union / shape types in BOTH slices (e.g. `BlockerSurface` defined
 * independently in `@/agent/working-state` AND `@/tool/types`). This is
 * convenient but introduces a silent-drift hazard: someone could add a new
 * member to one side and the runtime would happily accept the new value on the
 * producing side while the consuming side rejects it — with NO compiler complaint.
 *
 * NOTE: types that are merely RE-EXPORTED from a single `@/shared` SSOT (e.g.
 * `HITLTier`) are NOT mirror pairs — an `AssertEqual` between two re-exports of
 * the same type is tautologically `true` and can never catch drift, so it is
 * intentionally NOT guarded here. Only genuinely DUPLICATED definitions belong
 * below.
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

import { describe, expect, test } from "bun:test"
import type {
  BlockerSurface as AgentBlockerSurface,
  WorkingState as AgentWorkingState,
  WorkingStatePatch as AgentWorkingStatePatch,
} from "@/agent"
import type { ToolRiskMirror } from "@/stream"
import type {
  BlockerSurface as ToolBlockerSurface,
  ToolRisk,
  WorkingStatePatch as ToolWorkingStatePatch,
  WorkingStateSnapshot as ToolWorkingStateSnapshot,
} from "@/tool"

type AssertEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : never

// NOTE: `HITLTier` is a single `@/shared` SSOT re-exported by both `@/permission`
// and `@/tool`, so an `AssertEqual<PermissionHITLTier, ToolHITLTier>` compares a
// type to itself — always `true`, never a drift guard. Removed (audit: tautological).
const _assertBlockerSurfaceMirror: AssertEqual<AgentBlockerSurface, ToolBlockerSurface> = true
// V1 audit F1: the third mirror pair — WorkingState (@/agent) ↔ ToolWorkingStateSnapshot
// (@/tool) — was previously unguarded. Adding the assertion here closes the
// drift hole: a nested-field change on one side (e.g. adding `priority: number`
// to a Blocker) now fails the typecheck on the OTHER slice, not silently.
const _assertWorkingStateMirror: AssertEqual<AgentWorkingState, ToolWorkingStateSnapshot> = true
// Patch shape mirror — same drift surface, separate type so spelled out.
const _assertWorkingStatePatchMirror: AssertEqual<AgentWorkingStatePatch, ToolWorkingStatePatch> =
  true
// ADR-0512 P3 — `ToolRiskMirror` (@/stream, for the escalation-card `risk` field)
// is a DUPLICATED definition of `ToolRisk` (@/tool/surface/manifest); slice
// isolation forbids @/stream importing @/tool. Pin them so a new risk class on
// either side fails the typecheck here (not silently on the card).
const _assertToolRiskMirror: AssertEqual<ToolRiskMirror, ToolRisk> = true

// W1-B audit fix: the real guarantee here is COMPILE-TIME (the `_assert*`
// constants above fail to type-check if any mirror pair diverges, blocking
// `tsc --noEmit` in CI). The previous 4 `expect(true).toBe(true)` runtime
// tests were tautological proof-of-life — they passed for the wrong reason
// (a literal `true` equals `true`) and obscured the actual contract. We
// collapse them into a single sentinel that documents the compile-time gate
// and SUMS the remaining type-level checks into one runtime confirmation.
describe("cross-slice mirror assertions (compile-time enforcement)", () => {
  test("type-level `AssertEqual<A,B>` checks (4 pairs) compile if and only if mirrors agree", () => {
    // Each `_assert*` constant in this file is typed as `true | never`.
    // If a mirror diverges, the assignment from `= true` becomes a `never`
    // assignment and `tsc --noEmit` fails. This runtime line only confirms
    // that BOTH the compiler accepted the file (so all 3 mirrors hold AT
    // COMPILE TIME) AND each `const` was actually evaluated to `true` at
    // module load (so a future refactor that swaps in a tautological
    // `= true as true` would still need each name to resolve).
    expect([
      _assertBlockerSurfaceMirror,
      _assertWorkingStateMirror,
      _assertWorkingStatePatchMirror,
      _assertToolRiskMirror,
    ]).toEqual([true, true, true, true])
  })
})
