import { describe, expect, test } from "bun:test"
import { join } from "node:path"
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
    expect(plan.policyDigest.length).toBe(64)
  })

  test("selected union notSelected equals the population with no overlap", () => {
    const population = [
      "tests/unit/a.test.ts",
      "tests/unit/b.test.ts",
      "apps/web-frontend/x.test.ts",
    ]
    const plan = deriveVerificationSelection({
      tier: "prepush",
      mode: "working",
      baseSha: "aaa",
      headSha: "aaa",
      population,
      changedPaths: ["src/keep.ts"],
      selectedIds: ["tests/unit/a.test.ts"],
    })
    const selected = plan.selected.map((row) => row.id)
    const notSelected = plan.notSelected.map((row) => row.id)
    expect([...selected, ...notSelected].sort()).toEqual([...population].sort())
    expect(new Set(selected).size + new Set(notSelected).size).toBe(population.length)
    expect(plan.selected.find((row) => row.id === "apps/web-frontend/x.test.ts")).toBeUndefined()
    expect(plan.notSelected.find((row) => row.id === "apps/web-frontend/x.test.ts")?.reason).toBe(
      "vitest-not-affected",
    )
  })

  test("alwaysRun overrides keep a test selected even when it is not reachable", () => {
    const plan = deriveVerificationSelection({
      tier: "prepush",
      mode: "working",
      baseSha: "aaa",
      headSha: "aaa",
      population: ["tests/unit/a.test.ts", "tests/unit/scanner.test.ts"],
      changedPaths: ["src/keep.ts"],
      selectedIds: ["tests/unit/a.test.ts"],
      overrides: [
        {
          id: "tests/unit/scanner.test.ts",
          owner: "tv",
          reason: "scanner",
          alwaysRun: true,
        },
      ],
    })
    expect(plan.selected.map((row) => row.id).sort()).toEqual([
      "tests/unit/a.test.ts",
      "tests/unit/scanner.test.ts",
    ])
    expect(plan.selected.find((row) => row.id === "tests/unit/scanner.test.ts")?.reasons).toContain(
      "always-run",
    )
  })

  test("unsupported native artifacts force full, never an empty selected set", () => {
    const plan = deriveVerificationSelection({
      tier: "prepush",
      mode: "working",
      baseSha: "aaa",
      headSha: "aaa",
      population: ["tests/unit/a.test.ts"],
      changedPaths: ["native/addon.node"],
    })
    expect(plan.fallback.scope).toBe("full")
    expect(plan.fallback.reasons).toContain("unsupported-edge")
    expect(plan.selected.map((row) => row.id)).toEqual(["tests/unit/a.test.ts"])
  })

  test("CLI exclusive flags exit 2 with JSON full-required, not empty success", () => {
    const proc = Bun.spawnSync(
      ["bun", "run", "tools/dev/verify-scope.ts", "--json", "--working", "--staged"],
      { cwd: join(import.meta.dir, "../../.."), stdout: "pipe", stderr: "pipe" },
    )
    expect(proc.exitCode).toBe(2)
    const plan = JSON.parse(new TextDecoder().decode(proc.stdout)) as {
      fallback: { scope: string; reasons: string[] }
      selected: unknown[]
    }
    expect(plan.fallback.scope).toBe("full")
    expect(plan.fallback.reasons).toContain("git-failure")
    expect(plan.selected).toEqual([])
  }, 60_000)
})
