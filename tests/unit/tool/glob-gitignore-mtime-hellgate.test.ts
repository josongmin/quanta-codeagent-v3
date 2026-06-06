/**
 * ★ HELLGATE — glob engine swap (P25): ripgrep enumeration must NOT weaken the
 * FS jail, and must honor `.gitignore`.
 *
 * The glob tool swapped its enumerator from `Bun.Glob.scan` to `rg --files`
 * (so `.gitignore`/`.ignore` junk is excluded and results are mtime-ordered).
 * An engine swap is a SEMANTIC RISK: the jail that the old path enforced
 * (reject absolute / "../" patterns up front; re-jail and DROP every emitted
 * hit that resolves outside ctx.cwd via a `**` cross or symlink) MUST hold
 * IDENTICALLY on the new path. These tests pin all three guarantees and are
 * RED on any injection that:
 *   (a) lets a gitignored path (node_modules/x.ts) leak into the result,
 *   (b) lets a symlink/`**` hit that resolves OUTSIDE the jail survive, or
 *   (c) accepts an absolute / "../" escaping pattern instead of rejecting it.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolContext, ToolResult } from "@/tool"
import { globTool } from "@/tool/glob"

// jailRoot = <root>/work (a git repo so .gitignore is honored). A sibling
// <root>/outside holds a secret the jail must never list; a symlink inside work
// points at it (the `**`/symlink escape attempt). work/node_modules is
// gitignored — its content must never surface either.
const root = mkdtempSync(join(tmpdir(), "glob-gimtime-hell-"))
const work = join(root, "work")
const outside = join(root, "outside")
afterAll(() => rmSync(root, { recursive: true, force: true }))
mkdirSync(join(work, "src"), { recursive: true })
mkdirSync(join(work, "node_modules", "pkg"), { recursive: true })
mkdirSync(outside, { recursive: true })
writeFileSync(join(work, ".gitignore"), "node_modules/\n")
writeFileSync(join(work, "src", "in.ts"), "1")
writeFileSync(join(work, "node_modules", "pkg", "secret-dep.ts"), "DEP")
writeFileSync(join(outside, "secret.ts"), "TOPSECRET")
execFileSync("git", ["init", "-q"], { cwd: work })
let symlinkOk = true
try {
  symlinkSync(outside, join(work, "link"))
} catch {
  symlinkOk = false
}

const ctx = (): ToolContext => ({ cwd: work, signal: new AbortController().signal })
const run = async (input: unknown): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of globTool.execute(input as never, ctx())) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

describe("glob ripgrep engine cannot leak gitignored or out-of-jail paths", () => {
  test("(a) a .gitignored path (node_modules/secret-dep.ts) is NOT returned", async () => {
    const r = await run({ pattern: "**/*.ts" })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.output).not.toContain("secret-dep.ts")
      expect(r.output).not.toContain("node_modules")
      // ...while the in-tree file IS still there (only the gitignored diff).
      expect(r.output).toContain(join("src", "in.ts"))
    }
  })

  test("(b) a symlink/** to OUTSIDE the jail never surfaces the secret", async () => {
    if (!symlinkOk) return // symlink unsupported in this sandbox; skip
    const r = await run({ pattern: "**/*.ts" })
    expect(r.ok).toBe(true)
    // The broad glob crosses the `link` symlink toward <root>/outside. The
    // out-of-jail secret MUST NOT surface — guaranteed by BOTH layers: rg does
    // not follow symlinks by default (we pass no `--follow`), AND the per-hit
    // re-jail (`resolveJailed`, realpath-based) drops any escaper defense-in-
    // depth. The engine swap did not weaken this end-to-end guarantee.
    if (r.ok) expect(r.output).not.toContain("secret.ts")
  })

  test("(c) an absolute pattern (/etc/*) is REJECTED up front (not enumerated)", async () => {
    const r = await run({ pattern: "/etc/*" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.output).toContain("escapes the workspace")
  })

  test("(c) a '../' traversal pattern is REJECTED up front", async () => {
    const r = await run({ pattern: "../outside/*.ts" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.output).toContain("escapes the workspace")
  })

  test("(c) a deep '../../' traversal pattern is REJECTED", async () => {
    const r = await run({ pattern: "../../**/*.ts" })
    expect(r.ok).toBe(false)
  })

  test("a single-quote in the pattern cannot break out of the rg argv", async () => {
    // Pattern-injection: a `'` must be safely escaped by `sq()`. A broken quote
    // would either error the shell or change the command; we just require the
    // jail/contract holds (no crash, no out-of-jail leak). No file matches this
    // literal pattern, so the friendly empty message is the expected outcome.
    const r = await run({ pattern: "weird'name*.ts" })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.output).not.toContain("secret.ts")
      expect(r.output).not.toContain("TOPSECRET")
    }
  })
})
