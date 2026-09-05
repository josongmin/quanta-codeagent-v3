import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { GATES } from "../../tools/dev/gate-manifest"
import { expandTestFiles } from "../../tools/dev/sandboxed-test"
import { assertScanPopulation } from "./_shared/scan-population"

const ROOT = join(import.meta.dir, "..", "..")

const EXPECTED = [
  "tests/unit/cli/gh-exec-policy-hellgate.test.ts",
  "tests/unit/tool/gh-pr-comment-outbound-policy.test.ts",
  "tests/unit/apps/agent/ci-bot-pr-comment-safety.test.ts",
  "tests/unit/secret-sink-parity-hellgate.test.ts",
  "tests/unit/auth/private-file-atomic.test.ts",
  "tests/unit/auth/chatgpt-refresh-transaction.test.ts",
  "tests/integration/chatgpt-refresh-cross-process.test.ts",
  "tests/unit/migration/claude-config-entrypoint-parity.test.ts",
  "tests/unit/cli/mcp-name-surface-parity.test.ts",
  "tests/unit/permission/thread-permission-entrypoint-parity.test.ts",
  "tests/unit/shared/jsonrpc-envelope.test.ts",
  "tests/unit/retrieval-authority-manifest.test.ts",
  "tests/unit/knob-read-authority-parity.test.ts",
] as const

const walkTests = (dir: string, acc: string[] = []): string[] => {
  for (const ent of readdirSync(dir)) {
    const p = join(dir, ent)
    const st = statSync(p)
    if (st.isDirectory()) walkTests(p, acc)
    else if (ent.endsWith(".test.ts")) acc.push(p.slice(ROOT.length + 1))
  }
  return acc
}

const assertSelected = (
  selected: readonly string[],
  expected: readonly string[],
): { ok: true } | { ok: false; missing: string } => {
  for (const path of expected) {
    if (!selected.includes(path)) return { ok: false, missing: path }
  }
  return { ok: true }
}

const parseFullSuiteRoots = (shardsSrc: string): string[] => {
  const block = shardsSrc.match(/full:\s*\[([\s\S]*?)\],\s*core:/)
  if (block?.[1] === undefined) {
    throw new Error("SUITE_ROOTS.full array not found in run-test-shards.ts")
  }
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "").filter((r) => r !== "")
}

const resolvedFullSuiteSelection = (roots: readonly string[]): string[] => {
  const abs = roots.map((root) => resolve(ROOT, root)).filter((dir) => existsSync(dir))
  return expandTestFiles(abs).map((file) => relative(ROOT, file))
}

describe("SEP5 ratchet enrollment", () => {
  test("expected file list length equals landed implementation tickets", () => {
    expect(EXPECTED.length).toBe(13)
    for (const path of EXPECTED) {
      expect(existsSync(join(ROOT, path))).toBe(true)
    }
  })

  test("prepush full-suite selection includes every primary file", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts["test:ci"]).toBe("bun run prepush")
    const fullGate = GATES.find((g) => g.id === "full-suite")
    expect(fullGate?.run.includes("test:full:ci")).toBe(true)
    expect(pkg.scripts["test:full:ci"] ?? "").toContain("--suite=full")

    const shardsSrc = readFileSync(join(ROOT, "tools/dev/run-test-shards.ts"), "utf8")
    const roots = parseFullSuiteRoots(shardsSrc)
    expect(roots).toContain("tests/unit")
    expect(roots).toContain("tests/integration")

    const selected = resolvedFullSuiteSelection(roots)
    const testsRoot = join(ROOT, "tests")
    assertScanPopulation(
      walkTests(testsRoot).map((p) => join(ROOT, p)),
      testsRoot,
      {
        id: "tests/unit/sep5-ratchet-enrollment.test.ts#TESTS",
        collectable: (name) => name.endsWith(".test.ts"),
      },
    )
    expect(selected.length).toBeGreaterThan(0)
    expect(assertSelected(selected, EXPECTED)).toEqual({ ok: true })
  })

  test("synthetic missing path is rejected", () => {
    const selected = walkTests(join(ROOT, "tests"))
    expect(assertSelected(selected, ["tests/unit/does-not-exist.test.ts"]).ok).toBe(false)
  })

  test("removing one expected path from a cloned selection fails for that path", () => {
    const shardsSrc = readFileSync(join(ROOT, "tools/dev/run-test-shards.ts"), "utf8")
    const selected = resolvedFullSuiteSelection(parseFullSuiteRoots(shardsSrc)).filter(
      (p) => p !== EXPECTED[0],
    )
    const r = assertSelected(selected, EXPECTED)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.missing).toBe(EXPECTED[0])
  })

  test("mutation: dropping tests/unit from parsed full roots misses a primary", () => {
    const selected = resolvedFullSuiteSelection(["tests/integration", "tests/meta"])
    const r = assertSelected(selected, EXPECTED)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.missing).toBe(EXPECTED[0])
  })
})
