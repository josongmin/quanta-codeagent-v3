import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { GATES } from "../../tools/dev/gate-manifest"
import { expandTestFiles } from "../../tools/dev/sandboxed-test"
import { assertScanPopulation } from "./_shared/scan-population"

const ROOT = join(import.meta.dir, "..", "..")
const AUDIT_PATH = "docs/bugbash/sep-05-duplicate-development.md"
const REGISTER_PATH =
  "docs/plans/sep-5-duplicate-audit/tickets/SEP5-11-deferred-and-closed-register.md"
const EXECUTION_INDEX_PATH = "docs/plans/sep-5-duplicate-development/tickets/README.md"
const PROMPT_PACK_PATH = "docs/plans/sep-5-duplicate-development/prompts/README.md"
const AUDIT_IDS = Array.from({ length: 31 }, (_, index) => `D${index}`)

// Findings closed by a landed implementation ticket. The remaining closed
// false-positive/intentional findings belong in SEP5-11 so they cannot return
// as unscoped cleanup.
const IMPLEMENTED_FINDINGS = [
  "D0",
  "D1",
  "D2",
  "D3",
  "D4",
  "D5",
  "D6",
  "D10",
  "D11",
  "D19",
  "D27",
  "D28",
] as const

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

type AuditDisposition = "execute" | "conditional" | "intentional" | "closed"

const auditDispositionIds = (
  markdown: string,
): Readonly<Record<AuditDisposition, readonly string[]>> => {
  const result: Record<AuditDisposition, string[]> = {
    execute: [],
    conditional: [],
    intentional: [],
    closed: [],
  }
  for (const match of markdown.matchAll(
    /^\| \[D(\d+)\]\(#d\d+\) \| (execute|conditional|intentional|closed) \|/gm,
  )) {
    result[match[2] as AuditDisposition].push(`D${match[1]}`)
  }
  for (const ids of Object.values(result)) ids.sort()
  return result
}

const auditHeadingIds = (markdown: string): readonly string[] =>
  [...markdown.matchAll(/^## (D\d+)\./gm)].map((match) => match[1] ?? "").sort()

const allDispositionIds = (
  dispositions: Readonly<Record<AuditDisposition, readonly string[]>>,
): readonly string[] => Object.values(dispositions).flat().sort()

const registerIds = (markdown: string, heading: string): readonly string[] => {
  const start = markdown.indexOf(`## ${heading}`)
  if (start < 0) throw new Error(`missing register heading: ${heading}`)
  const next = markdown.indexOf("\n## ", start + 4)
  const section = markdown.slice(start, next < 0 ? undefined : next)
  return [...section.matchAll(/^\| (D\d+) \|/gm)].map((m) => m[1] ?? "").sort()
}

const isTracked = (path: string): boolean => {
  const result = Bun.spawnSync(["git", "ls-files", "--error-unmatch", path], {
    cwd: ROOT,
    stdout: "ignore",
    stderr: "ignore",
  })
  return result.exitCode === 0
}

describe("SEP5 ratchet enrollment", () => {
  test("expected primary-file list is frozen and every path exists", () => {
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

  test("audit dispositions and SEP5-11 register are a closed, exact universe", () => {
    const auditMarkdown = readFileSync(join(ROOT, AUDIT_PATH), "utf8")
    const audit = auditDispositionIds(auditMarkdown)
    const register = readFileSync(join(ROOT, REGISTER_PATH), "utf8")

    expect(allDispositionIds(audit)).toEqual([...AUDIT_IDS].sort())
    expect(auditHeadingIds(auditMarkdown)).toEqual([...AUDIT_IDS].sort())
    expect(audit.execute).toEqual([])
    expect(audit.closed).toHaveLength(19)
    expect(audit.conditional).toHaveLength(11)
    expect(audit.intentional).toEqual(["D29"])
    expect(registerIds(register, "Conditional items")).toEqual(audit.conditional)
    expect(registerIds(register, "Closed items")).toEqual(
      [...audit.closed, ...audit.intentional]
        .filter((id) => !IMPLEMENTED_FINDINGS.includes(id as (typeof IMPLEMENTED_FINDINGS)[number]))
        .sort(),
    )
  })

  test("governance packet tracking and terminal copy cannot regress", () => {
    const index = readFileSync(join(ROOT, EXECUTION_INDEX_PATH), "utf8")
    const promptPack = readFileSync(join(ROOT, PROMPT_PACK_PATH), "utf8")
    expect(isTracked(PROMPT_PACK_PATH)).toBe(true)
    expect(isTracked(REGISTER_PATH)).toBe(true)
    for (const markdown of [index, promptPack]) {
      expect(markdown).not.toContain("currently untracked")
      expect(markdown).not.toContain("commit pending")
      expect(markdown).not.toContain("delivery remains pending")
    }
    expect(promptPack).toContain("historical truth snapshot")
    expect(promptPack).toContain("freeze the current")
    expect(promptPack).toContain("Do not dispatch these historical implementation")
  })

  test("mutation: omitting one conditional item breaks exact register parity", () => {
    const audit = auditDispositionIds(readFileSync(join(ROOT, AUDIT_PATH), "utf8"))
    const register = readFileSync(join(ROOT, REGISTER_PATH), "utf8")
    const mutated = register.replace(/^\| D15 \|.*\n/m, "")
    expect(registerIds(mutated, "Conditional items")).not.toEqual(audit.conditional)
  })

  test("mutation: a duplicate disposition ID cannot hide a missing audit finding", () => {
    const auditMarkdown = readFileSync(join(ROOT, AUDIT_PATH), "utf8")
    const mutated = auditMarkdown.replace("| [D15](#d15) |", "| [D14](#d14) |")
    expect(allDispositionIds(auditDispositionIds(mutated))).not.toEqual([...AUDIT_IDS].sort())
  })
})
