/**
 * H4-F1 — the execution-mode surface SSOT drift guard. `SurfaceMirror` (@/stream), `Surface`
 * (@/runner/knobs), `Surface` (@/config/knob-schema) were three copy-pasted identical unions that
 * silently drift. Now all three ALIAS `@/shared/execution-surface`. This pins that they remain
 * type-identical to the canonical list — a compile assertion (assignable both ways) + the runtime
 * membership, so adding a surface in ONE place is the only edit.
 */
import { describe, expect, test } from "bun:test"
import type { Surface as ContractsSurface } from "@/config/knob-schema/contracts"
import type { Surface as KnobsSurface } from "@/runner/knobs/types"
import type { SurfaceMirror } from "@/stream/types"
import { EXECUTION_SURFACES, type ExecutionSurface } from "./execution-surface"

describe("execution-mode surface SSOT (H4-F1)", () => {
  test("all three aliases are type-identical to the canonical ExecutionSurface (compile assertion)", () => {
    // Two-way assignability ⇒ the unions are exactly equal. If any alias drifts, this fails to compile.
    const a: ExecutionSurface = "bench"
    const toMirror: SurfaceMirror = a
    const toKnobs: KnobsSurface = a
    const toContracts: ContractsSurface = a
    const backA: ExecutionSurface = toMirror
    const backB: ExecutionSurface = toKnobs
    const backC: ExecutionSurface = toContracts
    expect([toMirror, toKnobs, toContracts, backA, backB, backC].every((s) => s === "bench")).toBe(true)
  })

  test("canonical membership is the single source (exactly the five execution surfaces)", () => {
    expect([...EXECUTION_SURFACES].sort()).toEqual(
      ["agent-batch", "agent-interactive", "bench", "cli", "ide"].sort(),
    )
  })
})
