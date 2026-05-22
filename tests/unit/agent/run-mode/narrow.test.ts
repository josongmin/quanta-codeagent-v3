/**
 * narrowMode + assertModeMatrix tests — type narrow happy path + the matrix
 * invariants from RFC §6.2.
 */

import { describe, expect, test } from "bun:test"
import {
  assertModeMatrix,
  MODE_PRESETS,
  type ModePolicy,
  narrowMode,
} from "@/agent"

describe("narrowMode (assertion function)", () => {
  test("interactive policy narrows successfully", () => {
    const policy: ModePolicy = MODE_PRESETS.interactive
    narrowMode("interactive", policy)
    // After narrow, policy.permission is reviewer-backed (compile-time check).
    expect(policy.permission.kind).toBe("reviewer-backed")
  })

  test("batch policy narrows successfully", () => {
    const policy: ModePolicy = MODE_PRESETS.batch
    narrowMode("batch", policy)
    expect(policy.permission.kind).toBe("auto")
  })

  test("mismatched narrow throws at runtime (defense-in-depth)", () => {
    const policy: ModePolicy = MODE_PRESETS.batch
    expect(() => narrowMode("interactive", policy)).toThrow(/expected policy\.mode/)
  })
})

describe("assertModeMatrix (runtime invariants)", () => {
  test("all 4 preset policies pass the matrix assert", () => {
    for (const mode of ["interactive", "headless", "batch", "ci-bot"] as const) {
      expect(() => assertModeMatrix(MODE_PRESETS[mode])).not.toThrow()
    }
  })

  test("batch + reviewer-backed permission throws", () => {
    const bad: ModePolicy = {
      ...MODE_PRESETS.batch,
      permission: { kind: "reviewer-backed" },
    }
    expect(() => assertModeMatrix(bad)).toThrow(/batch mode requires permission/)
  })

  test("batch + host externalDeps throws", () => {
    const bad: ModePolicy = {
      ...MODE_PRESETS.batch,
      externalDeps: { kind: "host" },
    }
    expect(() => assertModeMatrix(bad)).toThrow(/externalDeps/)
  })

  test("batch + user-cwd sandbox throws", () => {
    const bad: ModePolicy = {
      ...MODE_PRESETS.batch,
      sandbox: { kind: "user-cwd" },
    }
    expect(() => assertModeMatrix(bad)).toThrow(/sandbox/)
  })

  test("interactive + auto permission throws", () => {
    const bad: ModePolicy = {
      ...MODE_PRESETS.interactive,
      permission: { kind: "auto", policy: "acceptEdits" },
    }
    expect(() => assertModeMatrix(bad)).toThrow(/interactive mode requires permission/)
  })

  test("interactive + hermetic externalDeps throws", () => {
    const bad: ModePolicy = {
      ...MODE_PRESETS.interactive,
      externalDeps: { kind: "hermetic" },
    }
    expect(() => assertModeMatrix(bad)).toThrow(/externalDeps/)
  })

  test("headless + reviewer-backed permission throws", () => {
    const bad: ModePolicy = {
      ...MODE_PRESETS.headless,
      permission: { kind: "reviewer-backed" },
    }
    expect(() => assertModeMatrix(bad)).toThrow(/headless mode requires permission/)
  })

  test("headless + verdict termination throws", () => {
    const bad: ModePolicy = {
      ...MODE_PRESETS.headless,
      termination: { kind: "verdict" },
    }
    expect(() => assertModeMatrix(bad)).toThrow(/termination/)
  })

  test("ci-bot + free gitWrite throws", () => {
    const bad: ModePolicy = {
      ...MODE_PRESETS["ci-bot"],
      gitWrite: { kind: "free" },
    }
    expect(() => assertModeMatrix(bad)).toThrow(/gitWrite/)
  })

  test("ci-bot + structured output throws", () => {
    const bad: ModePolicy = {
      ...MODE_PRESETS["ci-bot"],
      output: { kind: "structured" },
    }
    expect(() => assertModeMatrix(bad)).toThrow(/output/)
  })

  test("ci-bot + open network throws", () => {
    const bad: ModePolicy = {
      ...MODE_PRESETS["ci-bot"],
      network: { kind: "open" },
    }
    expect(() => assertModeMatrix(bad)).toThrow(/network/)
  })
})
