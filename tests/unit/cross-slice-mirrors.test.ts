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

import { describe, expect, test } from "bun:test"
import type { BlockerSurface as AgentBlockerSurface } from "@/agent"
import type { HITLTier as PermissionHITLTier } from "@/permission"
import type { BlockerSurface as ToolBlockerSurface, HITLTier as ToolHITLTier } from "@/tool"

type AssertEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : never

const _assertHITLMirror: AssertEqual<PermissionHITLTier, ToolHITLTier> = true
const _assertBlockerSurfaceMirror: AssertEqual<AgentBlockerSurface, ToolBlockerSurface> = true

describe("cross-slice mirror assertions (compile-time)", () => {
  test("HITLTier in @/permission and @/tool are structurally identical", () => {
    // If this file type-checks, the unions match. The runtime assert is a
    // no-op proof-of-life — the real failure mode is `tsc --noEmit` blocking
    // CI when someone diverges the two declarations.
    expect(_assertHITLMirror).toBe(true)
  })

  test("BlockerSurface in @/agent and @/tool are structurally identical", () => {
    expect(_assertBlockerSurfaceMirror).toBe(true)
  })
})
