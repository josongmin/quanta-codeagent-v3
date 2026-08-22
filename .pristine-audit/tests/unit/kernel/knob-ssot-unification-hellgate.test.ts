/**
 * HELLGATE (RED-first) — knob = schema SINGLE SOURCE unification (Phase 1: bench).
 *
 * End-state the unification must reach (currently RED; GREEN when done):
 *   1. INVENTORY DERIVED — src/config/knob-inventory/bench.ts is NOT a hand-written
 *      literal; it is `ALL_BENCH_SCHEMAS.map(deriveInventoryEntry)`. A derived file
 *      has ZERO inline `describe:` cells (the describe lives in the schema SSOT).
 *   2. BOOTSTRAP DERIVED — src/apps/cli/knobs-bootstrap.ts does NOT hand-import each
 *      knob module; it registers from the schema barrel. So ≤2 hand
 *      `import "@/runner/knobs/knobs/…"` side-effect lines remain.
 *   3. APPLY PRESERVED — `deriveKnob(schema)` must reproduce a real-apply bench
 *      knob's `apply` effect (repo-map mutates `cfg.repoMap`). The pre-unification
 *      `deriveKnob` made apply a NOOP, which would SILENTLY DROP the behavior of
 *      multi-voter / repo-map / network-proxy. The unification MUST carry apply
 *      (provided at the runner registration, since apply needs `AgentConfig`).
 *
 * This is the forcing function: it stays RED until the knob SSOT genuinely
 * REPLACES the hand-written knob/inventory/bootstrap (not duplicates them).
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { AgentConfig } from "@/agent"
import { repoMapSchema } from "@/config/knob-schema/schemas/bench-loop"
import { reproTestSchema } from "@/config/knob-schema/schemas/bench-repro"
import { deriveKnob } from "@/runner/batch/eval/kernel/derive"
import { repoMapKnob } from "@/runner/knobs/knobs/repo-map"
import { reproTestKnob } from "@/runner/knobs/knobs/repro-test"

const REPO = join(import.meta.dir, "..", "..", "..")
const read = (rel: string): string => readFileSync(join(REPO, rel), "utf8")

describe("HELLGATE — knob=schema single-source unification (bench, Phase 1)", () => {
  test("1. inventory bench.ts is DERIVED (no inline describe: cells)", () => {
    const src = read("src/config/knob-inventory/bench.ts")
    expect(src).toContain("deriveInventoryEntry")
    expect(src).toContain("ALL_BENCH_SCHEMAS")
    // A derived inventory holds NO hand-written entries ⇒ no inline `describe:`.
    const describeCount = (src.match(/describe:/g) ?? []).length
    expect(describeCount).toBe(0)
  })

  test("2. bootstrap registers from the schema barrel (no per-knob hand-imports)", () => {
    const src = read("src/apps/cli/knobs-bootstrap.ts")
    const handImports = (src.match(/^import "@\/runner\/knobs\/knobs\//gm) ?? []).length
    expect(handImports).toBeLessThanOrEqual(2)
  })

  test("3. deriveKnob PRESERVES apply when a binding is provided (repo-map)", () => {
    const base = {} as AgentConfig
    const value = repoMapKnob.parse("1")
    expect(value).toBeDefined()
    const ctx = { surface: "bench" } as Parameters<typeof repoMapKnob.apply>[2]
    const real = repoMapKnob.apply(base, value as never, ctx)
    // apply lives at the RUNNER registration (it needs AgentConfig, so it cannot
    // sit on the config-leaf schema). deriveKnob must accept + USE it. The
    // pre-unification deriveKnob ignored apply (NOOP) — that silently dropped the
    // behavior of multi-voter / repo-map / network-proxy.
    const derived = deriveKnob(repoMapSchema, repoMapKnob.apply).apply(base, value as never, ctx)
    expect(real).not.toBe(base) // sanity: the real knob DOES mutate
    expect(derived).toEqual(real)
  })

  test("4. deriveKnob PRESERVES costMultiplier/unit/source (matrix-budget fields)", () => {
    // BLOCKER the pilot surfaced: the registry Knob carries costMultiplier (used
    // at runtime in driver.ts matrix-budget Σ), unit, and source — but KnobSchema
    // does NOT model them, so deriveKnob drops them. Converting the 65 knobs to
    // deriveKnob would silently break the matrix budget. The schema model must
    // capture these (and parity must compare them) BEFORE any conversion.
    const derived = deriveKnob(reproTestSchema)
    expect(derived.costMultiplier).toBe(reproTestKnob.costMultiplier) // 40
    expect(derived.unit).toBe(reproTestKnob.unit)
    expect(derived.source).toBe(reproTestKnob.source)
  })
})
