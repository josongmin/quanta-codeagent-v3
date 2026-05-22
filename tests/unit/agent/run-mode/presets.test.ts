/**
 * MODE_PRESETS matrix coverage — 4 modes × 12 levers = 48 cells all defined.
 *
 * Each lever in `ModePolicy` is a discriminated union with a non-optional
 * `kind` field; we assert that every cell has a non-empty kind string. This
 * makes a missing column / typo a single failing test instead of a runtime
 * surprise.
 */

import { describe, expect, test } from "bun:test"
import {
  ALL_AGENT_MODES,
  BUDGET_PRESETS,
  LEVER_FIELDS,
  MODE_PRESETS,
  type ModePolicy,
} from "@/agent"

describe("MODE_PRESETS 4×12 matrix", () => {
  test("every mode has a preset entry", () => {
    for (const mode of ALL_AGENT_MODES) {
      expect(MODE_PRESETS[mode]).toBeDefined()
      expect(MODE_PRESETS[mode].mode).toBe(mode)
    }
  })

  test("48 cells (4 modes × 12 levers) are all defined with non-empty kind", () => {
    let cellCount = 0
    for (const mode of ALL_AGENT_MODES) {
      const policy = MODE_PRESETS[mode]
      for (const field of LEVER_FIELDS) {
        const cell = policy[field] as { kind: string } | undefined
        expect(cell).toBeDefined()
        expect(typeof cell?.kind).toBe("string")
        expect(cell?.kind.length).toBeGreaterThan(0)
        cellCount += 1
      }
    }
    expect(cellCount).toBe(48)
  })

  test("LEVER_FIELDS contains exactly the 12 documented levers", () => {
    expect(LEVER_FIELDS.length).toBe(12)
    expect(new Set(LEVER_FIELDS).size).toBe(12)
  })

  test("interactive preset matches RFC matrix row", () => {
    const p = MODE_PRESETS.interactive
    expect(p.permission.kind).toBe("reviewer-backed")
    expect(p.termination.kind).toBe("user-stop")
    expect(p.sandbox.kind).toBe("user-cwd")
    expect(p.output.kind).toBe("stdout-chat")
    expect(p.externalDeps.kind).toBe("host")
  })

  test("batch preset matches RFC matrix row", () => {
    const p = MODE_PRESETS.batch
    expect(p.permission.kind).toBe("auto")
    expect(p.termination.kind).toBe("verdict")
    expect(p.sandbox.kind).toBe("per-instance")
    expect(p.output.kind).toBe("structured")
    expect(p.externalDeps.kind).toBe("hermetic")
    expect(p.network.kind).toBe("denied")
  })

  test("headless preset matches RFC matrix row", () => {
    const p = MODE_PRESETS.headless
    expect(p.permission.kind).toBe("auto")
    expect(p.termination.kind).toBe("single-turn")
    expect(p.externalDeps.kind).toBe("hermetic-with-overrides")
  })

  test("ci-bot preset matches RFC matrix row", () => {
    const p = MODE_PRESETS["ci-bot"]
    expect(p.gitWrite.kind).toBe("branch-only")
    expect(p.output.kind).toBe("github-check")
    expect(p.network.kind).toBe("allowlist")
  })

  test("auto-permission modes carry the policy discriminator", () => {
    for (const mode of ["headless", "batch", "ci-bot"] as const) {
      const perm = MODE_PRESETS[mode].permission
      if (perm.kind !== "auto") throw new Error("unexpected non-auto perm")
      expect(["acceptEdits", "denyAll", "askAll"]).toContain(perm.policy)
    }
  })

  test("BUDGET_PRESETS exists for every mode", () => {
    for (const mode of ALL_AGENT_MODES) {
      expect(BUDGET_PRESETS[mode]).toBeDefined()
    }
  })

  test("interactive budget has no wall-clock cap (human-paced)", () => {
    expect(BUDGET_PRESETS.interactive.maxWallClockMs).toBeUndefined()
  })

  test("batch budget enforces wall-clock + cost caps", () => {
    expect(BUDGET_PRESETS.batch.maxWallClockMs).toBeGreaterThan(0)
    expect(BUDGET_PRESETS.batch.maxCostUsd).toBeGreaterThan(0)
  })

  test("ci-bot budget caps files-changed (small diffs)", () => {
    expect(BUDGET_PRESETS["ci-bot"].maxFilesChanged).toBeGreaterThan(0)
    expect(BUDGET_PRESETS["ci-bot"].maxPatchBytes).toBeGreaterThan(0)
  })

  test("policy objects are not aliased (per-mode independent)", () => {
    expect(MODE_PRESETS.interactive).not.toBe(MODE_PRESETS.batch as unknown as ModePolicy)
  })
})
