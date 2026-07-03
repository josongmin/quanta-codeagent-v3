/**
 * H4-F1 — the execution-mode surface SSOT drift guard. `SurfaceMirror` (@/stream), `Surface`
 * (@/runner/knobs), `Surface` (@/config/knob-schema) were three copy-pasted identical unions that
 * silently drift. Now all three ALIAS `@/shared/execution-surface`. This pins that they remain
 * type-identical to the canonical list.
 *
 * ── jul-4 audit R3 (was VACUOUS) ─────────────────────────────────────────────
 * The old guard used `const a: ExecutionSurface = "bench"; const back: ExecutionSurface = toKnobs`.
 * That is BLIND to drift: only the single literal `"bench"` flows through control-flow narrowing, so
 * `back` sees `"bench"`, never the full alias domain — adding/removing a member of an alias did NOT
 * fail it. The fix below routes the WHOLE union (via function parameters, whose type is the opaque
 * union, not a narrowed literal) in BOTH directions, so any drift breaks compilation.
 *
 * NB these assignability arms are COMPILE-TIME (tsc / `typecheck:all` in CI), NOT runtime: `bun test`
 * does not type-check test files (`tsconfig.typecheck.src.json` excludes `*.test.ts`). Running this
 * file only exercises the runtime membership assertion; the bidirectional guard is enforced when the
 * tree is type-checked. The two guard functions are defined-but-not-called on purpose (their bodies
 * are the assertion); a runtime `typeof` reference keeps them from being dead-code-eliminated.
 */
import { describe, expect, test } from "bun:test"
import type { Surface as ContractsSurface } from "@/config/knob-schema/contracts"
import type { Surface as KnobsSurface } from "@/runner/knobs/types"
import type { SurfaceMirror } from "@/stream/types"
import { EXECUTION_SURFACES, type ExecutionSurface } from "./execution-surface"

/** alias ⊆ canonical — a member ADDED to any alias is not in `ExecutionSurface` ⇒ TS2322 here.
 *  Parameters carry the FULL union domain (not a narrowed literal), so the whole set is checked. */
const _aliasesIntoCanonical = (
  m: SurfaceMirror,
  k: KnobsSurface,
  c: ContractsSurface,
): readonly ExecutionSurface[] => [m, k, c]

/** canonical ⊆ alias — a member DROPPED from any alias means `ExecutionSurface` (which still has it)
 *  is no longer assignable to that alias ⇒ TS2322 here. Together with the above, the aliases are
 *  pinned EQUAL to the canonical union, both directions, over their full domains. */
const _canonicalIntoAliases = (
  x: ExecutionSurface,
): readonly [SurfaceMirror, KnobsSurface, ContractsSurface] => [x, x, x]

describe("execution-mode surface SSOT (H4-F1)", () => {
  test("canonical membership is the single source (exactly the five execution surfaces)", () => {
    // Widen to `string[]` so `.sort()` + `toEqual` type cleanly under `typecheck:all` (no TS2769):
    // this arm pins the CANONICAL list; the compile-time functions above pin the three aliases to it.
    const canonical: readonly string[] = EXECUTION_SURFACES
    expect([...canonical].sort()).toEqual(["agent-batch", "agent-interactive", "bench", "cli", "ide"])
  })

  test("the bidirectional compile-time drift guards are wired (both directions present)", () => {
    // The guards' VALUE is their compilation (see file header); this asserts they weren't deleted.
    expect(typeof _aliasesIntoCanonical).toBe("function")
    expect(typeof _canonicalIntoAliases).toBe("function")
  })
})
