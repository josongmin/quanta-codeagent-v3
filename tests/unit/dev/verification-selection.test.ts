import { describe, expect, test } from "bun:test"
import {
  deriveVerificationSelection,
  fallbackReasonForPath,
  parseNameStatusZ,
} from "../../../tools/dev/verification-selection"
import { parseSelectionArgv } from "../../../tools/dev/verification-selection-argv"

describe("NUL name-status parser", () => {
  test("captures both sides of a rename", () => {
    const records = parseNameStatusZ("R100\0src/old.ts\0src/new.ts\0M\0src/keep.ts\0")
    expect(records).toEqual([
      { status: "R100", paths: ["src/old.ts", "src/new.ts"] },
      { status: "M", paths: ["src/keep.ts"] },
    ])
  })

  test("rejects a truncated rename instead of returning empty success", () => {
    expect(() => parseNameStatusZ("R100\0src/old.ts\0")).toThrow("truncated")
  })
})

describe("selection flags", () => {
  test("base/head, working, and staged are mutually exclusive", () => {
    const clash = parseSelectionArgv(["--working", "--staged"])
    expect(clash.ok).toBe(false)
    if (!clash.ok) expect(clash.error.kind).toBe("exclusive")
  })

  test("unpaired --base is missing, not an empty selected set", () => {
    const missing = parseSelectionArgv(["--base=abc"])
    expect(missing.ok).toBe(false)
  })
})

describe("full fallback", () => {
  test("package.json forces full, never an empty selected set", () => {
    expect(fallbackReasonForPath("package.json")).toBe("package-or-lock")
    const plan = deriveVerificationSelection({
      tier: "prepush",
      mode: "base-head",
      baseSha: "aaa",
      headSha: "bbb",
      population: ["tests/unit/a.test.ts", "tests/unit/b.test.ts"],
      changedPaths: ["package.json"],
    })
    expect(plan.fallback.scope).toBe("full")
    expect(plan.selected.map((row) => row.id).sort()).toEqual([
      "tests/unit/a.test.ts",
      "tests/unit/b.test.ts",
    ])
    expect(plan.notSelected).toEqual([])
  })

  test("missing base is full-required, not passed-empty", () => {
    const plan = deriveVerificationSelection({
      tier: "prepush",
      mode: "base-head",
      baseSha: "",
      headSha: "bbb",
      population: ["tests/unit/a.test.ts"],
      changedPaths: [],
    })
    expect(plan.fallback).toEqual({ scope: "full", reasons: ["missing-base"] })
    expect(plan.notSelected).toEqual([{ id: "tests/unit/a.test.ts", reason: "full-required" }])
  })
})
