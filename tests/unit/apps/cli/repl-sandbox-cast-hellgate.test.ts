/**
 * `parseSandboxMode` hellgate — closes the silent-UI-lie path where an
 * arbitrary `QUANTA_SANDBOX=<garbage>` value would propagate as a literal
 * label into the status pill via an unchecked `as SandboxMode` cast.
 */

import { describe, expect, test } from "bun:test"
import {
  parseSandboxMode,
  VALID_SANDBOX_MODES,
} from "../../../../src/apps/cli/sandbox-mode-parse"

describe("parseSandboxMode — valid values pass through", () => {
  test("'read-only' → 'read-only'", () => {
    expect(parseSandboxMode("read-only")).toBe("read-only")
  })

  test("'workspace' → 'workspace'", () => {
    expect(parseSandboxMode("workspace")).toBe("workspace")
  })

  test("'danger' → 'danger'", () => {
    expect(parseSandboxMode("danger")).toBe("danger")
  })

  test("'default' → 'default'", () => {
    expect(parseSandboxMode("default")).toBe("default")
  })
})

describe("parseSandboxMode — invalid values fall back to 'default' (no silent UI lie)", () => {
  test("'badvalue' → 'default'", () => {
    expect(parseSandboxMode("badvalue")).toBe("default")
  })

  test("'workspace-write' → 'default' (close to a valid name but not in the union)", () => {
    expect(parseSandboxMode("workspace-write")).toBe("default")
  })

  test("empty string → 'default'", () => {
    expect(parseSandboxMode("")).toBe("default")
  })

  test("undefined env → 'default'", () => {
    expect(parseSandboxMode(undefined)).toBe("default")
  })

  test("case mismatch is REJECTED (the union is case-sensitive)", () => {
    expect(parseSandboxMode("READ-ONLY")).toBe("default")
    expect(parseSandboxMode("Default")).toBe("default")
  })
})

describe("VALID_SANDBOX_MODES — completeness", () => {
  test("contains exactly the 4 union members", () => {
    expect(VALID_SANDBOX_MODES.size).toBe(4)
    expect(VALID_SANDBOX_MODES.has("read-only")).toBe(true)
    expect(VALID_SANDBOX_MODES.has("workspace")).toBe(true)
    expect(VALID_SANDBOX_MODES.has("danger")).toBe(true)
    expect(VALID_SANDBOX_MODES.has("default")).toBe(true)
  })
})
