/**
 * Hellgate — byte-identical invariant pin.
 *
 * The framework MUST preserve "no env → no surface mutation" so that turning
 * the knob system on without setting any flags is a pure no-op. Each test
 * pins a specific path:
 *
 *   - resolve() over an empty input set produces an empty map.
 *   - apply() over an empty value map returns the same cfg reference.
 *   - resolving with unrelated env keys never adds anything to the output.
 *   - the side-effect bundle import (registering 12 knobs) does not alter
 *     a baseline AgentConfig until resolve+apply is called with real input.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import {
  allKnobs,
  applyKnobs,
  asAnyKnob,
  knobsForSurface,
  registerKnob,
  resolveKnobs,
} from "@/runner/knobs"
import { advisorKnob } from "@/runner/knobs/knobs/advisor"

// Import the side-effect bundle ONCE so the registry is fully populated. This
// matches the production assembly path. Side-effects register once per process
// (cached); after a sibling suite's `__resetRegistry()` a cached re-import does
// NOT re-fire registerKnob, so we ALSO re-register from the imported object,
// guarded by presence so we never collide.
beforeAll(async () => {
  await import("@/runner/knobs/knobs/advisor")
  await import("@/runner/knobs/knobs/branch-search")
  await import("@/runner/knobs/knobs/closeout-guard")
  await import("@/runner/knobs/knobs/hooks")
  await import("@/runner/knobs/knobs/issue-hint")
  await import("@/runner/knobs/knobs/localize-phase")
  await import("@/runner/knobs/knobs/lsp")
  await import("@/runner/knobs/knobs/must-pass")
  await import("@/runner/knobs/knobs/persona")
  await import("@/runner/knobs/knobs/repro-test")
  await import("@/runner/knobs/knobs/skills")
  await import("@/runner/knobs/knobs/subagent")
  await import("@/runner/knobs/knobs/working-state")
  if (!allKnobs().has(advisorKnob.id)) registerKnob(asAnyKnob(advisorKnob))
})

afterAll(() => {
  // Intentionally DO NOT reset — other tests may rely on the populated
  // registry; persistence across the file is the production posture.
})

describe("hellgate / byte-identical — empty environment", () => {
  test("resolve() with empty inputs over 12-knob registry → empty value map", () => {
    // Cleanly DROP all unrelated env keys (we only pass an empty bag).
    const knobs = knobsForSurface("bench")
    expect(knobs.size).toBeGreaterThanOrEqual(1)
    const r = resolveKnobs({ surface: "bench", knobs })
    expect(r.size).toBe(0)
  })

  test("resolve() for cli surface over full registry → empty value map (no defaults set)", () => {
    const r = resolveKnobs({ surface: "cli", knobs: knobsForSurface("cli") })
    expect(r.size).toBe(0)
  })

  test("resolve() for agent-batch → empty", () => {
    const r = resolveKnobs({
      surface: "agent-batch",
      knobs: knobsForSurface("agent-batch"),
    })
    expect(r.size).toBe(0)
  })

  test("resolve() for agent-interactive → empty", () => {
    const r = resolveKnobs({
      surface: "agent-interactive",
      knobs: knobsForSurface("agent-interactive"),
    })
    expect(r.size).toBe(0)
  })

  test("resolve() for ide → empty (no knobs are on ide surface)", () => {
    const r = resolveKnobs({ surface: "ide", knobs: knobsForSurface("ide") })
    expect(r.size).toBe(0)
  })
})

describe("hellgate / byte-identical — apply over empty values", () => {
  test("apply(base, anyKnobs, emptyValues, ctx) === base (reference identity)", () => {
    const base = {} as AgentConfig
    const out = applyKnobs(base, allKnobs(), new Map(), { surface: "bench" })
    expect(out).toBe(base)
  })

  test("apply for every surface returns base reference", () => {
    const base = {} as AgentConfig
    for (const s of ["bench", "cli", "agent-batch", "agent-interactive", "ide"] as const) {
      expect(applyKnobs(base, allKnobs(), new Map(), { surface: s })).toBe(base)
    }
  })
})

describe("hellgate / byte-identical — unrelated env noise rejected", () => {
  test("100 random unrelated env keys do not pollute resolve output", () => {
    const env: NodeJS.ProcessEnv = {}
    for (let i = 0; i < 100; i++) env[`UNRELATED_${i}`] = String(i)
    env.NODE_ENV = "test"
    env.PATH = "/usr/bin"
    env.HOME = "/tmp"
    const r = resolveKnobs({
      surface: "bench",
      knobs: knobsForSurface("bench"),
      envVars: env,
    })
    expect(r.size).toBe(0)
  })

  test("env key that LOOKS like a knob envKey but for wrong knob is ignored", () => {
    // QUANTA_BENCH_LSP_EXTRA is similar to QUANTA_BENCH_LSP but not equal.
    const env: NodeJS.ProcessEnv = {
      QUANTA_BENCH_LSP_EXTRA: "1",
      QUANTA_BENCH_LSPX: "1",
      Q_QUANTA_BENCH_LSP: "1",
    }
    const r = resolveKnobs({
      surface: "bench",
      knobs: knobsForSurface("bench"),
      envVars: env,
    })
    expect(r.size).toBe(0)
  })
})

describe("hellgate / byte-identical — registry import is side-effect-only on cfg", () => {
  test("Re-importing the bundle does not register duplicates (cached)", async () => {
    const before = allKnobs().size
    await import("@/runner/knobs/knobs/lsp")
    await import("@/runner/knobs/knobs/branch-search")
    expect(allKnobs().size).toBe(before)
  })

  test("Registry has at least the 13 documented knob ids", () => {
    const r = allKnobs()
    const required = [
      "advisor",
      "lsp",
      "subagent",
      "skills",
      "localize-phase",
      "branch-search",
      "issue-hint",
      "repro-test",
      "must-pass",
      "persona",
      "working-state",
      "closeout-guard",
      "hooks",
    ]
    for (const id of required) {
      expect(r.has(id)).toBe(true)
    }
  })
})

describe("hellgate / byte-identical — resolve+apply with empty layers is identity", () => {
  test("Full pipeline with empty inputs over full registry → cfg reference unchanged", () => {
    const base = {} as AgentConfig
    const knobs = knobsForSurface("bench")
    const values = resolveKnobs({ surface: "bench", knobs })
    const out = applyKnobs(base, knobs, values, { surface: "bench" })
    expect(out).toBe(base)
  })

  test("Pipeline with ALL unrelated env keys → cfg reference unchanged", () => {
    const base = {} as AgentConfig
    const knobs = knobsForSurface("cli")
    const env: NodeJS.ProcessEnv = { UNRELATED: "1", FOO: "bar", PATH: "/usr/bin" }
    const values = resolveKnobs({ surface: "cli", knobs, envVars: env })
    const out = applyKnobs(base, knobs, values, { surface: "cli" })
    expect(out).toBe(base)
  })
})
