/**
 * P2 (jul-10, UUX-4-18) — web context-warning parity. Threshold is the CLI's
 * DEFAULT_WINDOW_WARN_RATIO (0.8) — lock-step pinned against the CLI source so
 * the two surfaces can never drift silently.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { CONTEXT_WARN_RATIO, contextWarningLabel } from "./context-warning"

describe("contextWarningLabel", () => {
  it("null below the threshold", () => {
    expect(contextWarningLabel({ total: 79, max: 100 })).toBeNull()
  })

  it("warns at/above the CLI ratio with the percentage", () => {
    expect(contextWarningLabel({ total: 84, max: 100 })).toContain("84%")
  })

  it("unknown window (max<=0) NEVER fires (S4 unknown-window posture)", () => {
    expect(contextWarningLabel({ total: 999999, max: 0 })).toBeNull()
    expect(contextWarningLabel({ total: 5, max: -1 })).toBeNull()
  })

  it("null usage ⇒ null", () => {
    expect(contextWarningLabel(null)).toBeNull()
  })

  it("LOCK-STEP: the ratio equals the CLI's DEFAULT_WINDOW_WARN_RATIO", () => {
    const cli = readFileSync(join(__dirname, "../../../../src/apps/cli/context-warning.ts"), "utf8")
    const m = cli.match(/DEFAULT_WINDOW_WARN_RATIO = ([0-9.]+)/)
    expect(m).not.toBeNull()
    expect(Number(m?.[1])).toBe(CONTEXT_WARN_RATIO)
  })
})
