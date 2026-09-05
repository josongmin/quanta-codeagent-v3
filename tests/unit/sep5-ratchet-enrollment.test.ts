import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..", "..")

const EXPECTED = [
  "tests/unit/cli/gh-exec-policy-hellgate.test.ts",
  "tests/unit/tool/gh-pr-comment-outbound-policy.test.ts",
  "tests/unit/apps/agent/ci-bot-pr-comment-safety.test.ts",
  "tests/unit/secret-sink-parity-hellgate.test.ts",
  "tests/unit/auth/private-file-atomic.test.ts",
  "tests/unit/auth/chatgpt-refresh-transaction.test.ts",
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

describe("SEP5 ratchet enrollment", () => {
  test("expected file list length equals landed implementation tickets", () => {
    expect(EXPECTED.length).toBe(12)
    for (const path of EXPECTED) {
      expect(existsSync(join(ROOT, path))).toBe(true)
    }
  })

  test("resolved bun unit/integration selection includes every primary file", () => {
    const selected = walkTests(join(ROOT, "tests"))
    expect(selected.length).toBeGreaterThan(0)
    expect(assertSelected(selected, EXPECTED)).toEqual({ ok: true })
  })

  test("synthetic missing path is rejected", () => {
    const selected = walkTests(join(ROOT, "tests"))
    expect(assertSelected(selected, ["tests/unit/does-not-exist.test.ts"]).ok).toBe(false)
  })

  test("removing one expected path from a cloned selection fails for that path", () => {
    const selected = walkTests(join(ROOT, "tests")).filter((p) => p !== EXPECTED[0])
    const r = assertSelected(selected, EXPECTED)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.missing).toBe(EXPECTED[0])
  })
})
