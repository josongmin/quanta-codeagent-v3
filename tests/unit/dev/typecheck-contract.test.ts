import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// Repo root anchored on this file, not the ambient cwd — every read below is a
// repo-relative config file in the checkout.
const repoRoot = join(import.meta.dir, "..", "..", "..")

const readJson = <T>(relativePath: string): T =>
  JSON.parse(readFileSync(join(repoRoot, relativePath), "utf8")) as T

const readText = (relativePath: string): string =>
  readFileSync(join(repoRoot, relativePath), "utf8")

describe("typecheck contract", () => {
  test("package scripts split fast and full typecheck lanes", () => {
    const pkg = readJson<{ scripts: Record<string, string> }>("package.json")
    expect(pkg.scripts.typecheck).toBe("bun run tools/dev/typecheck.ts src")
    expect(pkg.scripts["typecheck:tests"]).toBe("bun run tools/dev/typecheck.ts tests")
    expect(pkg.scripts["typecheck:all"]).toBe("bun run tools/dev/typecheck.ts all")
    expect(pkg.scripts.test).toContain("bun run typecheck")
    expect(pkg.scripts["test:unit"]).toContain("bun run typecheck")
    expect(pkg.scripts["test:fast"]).toContain("bun run typecheck")
    // test:ci delegates to the manifest executor; the full-typecheck invariant
    // now lives in the gate manifest (its `typecheck` gate) and the clean-js +
    // full-runner invariant in the one script the `full-suite` gate runs.
    expect(pkg.scripts["test:ci"]).toBe("bun run prepush")
    const manifest = readText("tools/dev/gate-manifest.ts")
    expect(manifest).toContain('run: "bun run typecheck:all"')
    const full = pkg.scripts["test:full:ci"] ?? ""
    expect(full).toContain("bun run test:clean-js")
    expect(full).toContain(
      "bun run tools/dev/run-test-shards.ts --suite=full --junit-out=.cache/full-junit.xml --parallel=1",
    )
    // `typecheck:all` already covers src+tests+tools. Routing through the public
    // `test` script here would immediately repeat the src+tools typecheck.
    expect(full).not.toMatch(/\bbun run test(?:\s|$)/)
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

  test("ci advances the full-tree tsc buildinfo but never caches split targets or skip stamps", () => {
    const workflow = readText(".github/workflows/ci.yml")
    const githubRefName = ["$", "{{ github.ref_name }}"].join("")
    const githubSha = ["$", "{{ github.sha }}"].join("")
    const cacheStart = workflow.indexOf("- name: restore typecheck incremental cache")
    const cacheEnd = workflow.indexOf("- name: typecheck", cacheStart + 1)
    expect(cacheStart).toBeGreaterThanOrEqual(0)
    expect(cacheEnd).toBeGreaterThan(cacheStart)
    const cacheStep = workflow.slice(cacheStart, cacheEnd)
    const keyLine = cacheStep.split("\n").find((line) => line.trimStart().startsWith("key:")) ?? ""
    const restoreBlock = cacheStep.slice(cacheStep.indexOf("restore-keys:"))
    const restoreKeys = restoreBlock
      .split("\n")
      .filter((line) => line.includes("runner.os") && line.includes("typecheck-"))

    expect(cacheStep).toContain("uses: actions/cache@v4")
    expect(cacheStep).toContain("path: .cache/typescript/typecheck-all.tsbuildinfo")
    expect(cacheStep).not.toContain(".cache/typescript/typecheck-src.tsbuildinfo")
    expect(cacheStep).not.toContain(".cache/typescript/typecheck-tests.tsbuildinfo")
    expect(keyLine).toContain(`${githubRefName}-${githubSha}`)
    expect(restoreKeys).toHaveLength(2)
    expect(restoreKeys[0]).toContain(`${githubRefName}-`)
    expect(restoreKeys[0]).not.toContain(githubSha)
    expect(restoreKeys[1]).not.toContain(githubRefName)
    expect(cacheStep).not.toContain(".stamp.json")
  })
})
