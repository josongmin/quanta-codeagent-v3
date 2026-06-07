import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const repoRoot = process.cwd()

const readJson = <T>(relativePath: string): T =>
  JSON.parse(readFileSync(join(repoRoot, relativePath), "utf8")) as T

const readText = (relativePath: string): string =>
  readFileSync(join(repoRoot, relativePath), "utf8")

describe("typecheck contract", () => {
  test("package scripts split fast and full typecheck lanes", () => {
    const pkg = readJson<{ scripts: Record<string, string> }>("package.json")
    expect(pkg.scripts["typecheck"]).toBe("bun run tools/dev/typecheck.ts src")
    expect(pkg.scripts["typecheck:tests"]).toBe("bun run tools/dev/typecheck.ts tests")
    expect(pkg.scripts["typecheck:all"]).toBe("bun run tools/dev/typecheck.ts all")
    expect(pkg.scripts["test"]).toContain("bun run typecheck")
    expect(pkg.scripts["test:unit"]).toContain("bun run typecheck")
    expect(pkg.scripts["test:fast"]).toContain("bun run typecheck")
    expect(pkg.scripts["test:ci"]).toContain("bun run typecheck:all")
  })

  test("split tsconfig targets keep tests out of the fast lane", () => {
    const srcConfig = readJson<{ include: string[]; exclude: string[] }>(
      "tsconfig.typecheck.src.json",
    )
    const testsConfig = readJson<{ include: string[]; exclude: string[] }>(
      "tsconfig.typecheck.tests.json",
    )
    expect(srcConfig.include).toEqual(["src", "tools"])
    expect(srcConfig.exclude).toContain("tests")
    expect(srcConfig.exclude).toContain("src/**/__tests__")
    expect(testsConfig.include).toContain("tests")
    expect(testsConfig.include).toContain("src/**/*.d.ts")
    expect(testsConfig.include).toContain("tools/**/*.d.ts")
    expect(testsConfig.include).toContain("src/**/__tests__/**/*.ts")
    expect(testsConfig.exclude).toContain("tests/smoke/fixtures")
  })

  test("just gates use full typecheck while default recipe stays fast", () => {
    const justfile = readText("justfile")
    expect(justfile).toContain("typecheck:\n    {{BUN}} run typecheck")
    expect(justfile).toContain("typecheck-all:\n    {{BUN}} run typecheck:all")
    expect(justfile).toContain("gates: typecheck-all lint test smoke")
  })

  test("ci pyramid uses the full typecheck lane", () => {
    const workflow = readText(".github/workflows/ci.yml")
    expect(workflow).toContain("name: typecheck")
    expect(workflow).toContain("run: bun run typecheck:all")
  })

  test("ci caches portable tsc buildinfo but never the local content-hash skip stamps", () => {
    const workflow = readText(".github/workflows/ci.yml")
    expect(workflow).toContain("name: restore typecheck incremental cache")
    expect(workflow).toContain("uses: actions/cache@v4")
    expect(workflow).toContain(".cache/typescript/typecheck-src.tsbuildinfo")
    expect(workflow).toContain(".cache/typescript/typecheck-tests.tsbuildinfo")
    expect(workflow).toContain(".cache/typescript/typecheck-all.tsbuildinfo")
    expect(workflow).not.toContain(".cache/typescript/typecheck-src.stamp.json")
    expect(workflow).not.toContain(".cache/typescript/typecheck-tests.stamp.json")
    expect(workflow).not.toContain(".cache/typescript/typecheck-all.stamp.json")
  })
})
