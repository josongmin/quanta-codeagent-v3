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
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolContext, ToolResult } from "@/tool"
import { globTool } from "@/tool/glob"
import { canExecute, capability } from "../../../tools/dev/capability-receipt-consumer"

// TVH-11: this whole fixture — `mkdtempSync`, five `writeFileSync`, a real
// `git init` child process and a `symlinkSync` — used to run at MODULE LOAD.
// Importing this file created a git repository on disk. It is now built in
// `beforeAll`, and the `git` answer comes from the tier capability receipt
// instead of from an unguarded `execFileSync` that throws at import time on a
// host without git.
const git = capability("git")

// jailRoot = <root>/work (a git repo so .gitignore is honored). A sibling
// <root>/outside holds a secret the jail must never list; a symlink inside work
// points at it (the `**`/symlink escape attempt). work/node_modules is
// gitignored — its content must never surface either.
let root: string
let work: string
let outside: string
let symlinkOk = true

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
})

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "glob-gimtime-hell-"))
  work = join(root, "work")
  outside = join(root, "outside")
  mkdirSync(join(work, "src"), { recursive: true })
  mkdirSync(join(work, "node_modules", "pkg"), { recursive: true })
  mkdirSync(outside, { recursive: true })
  // node_modules/ is a DIRECTORY ignore; secret.env.ts is a FILE-NAME ignore (the
  // F1 case — ripgrep's `-g <pattern>` force-include would RE-ADMIT this individual
  // file, which is why the tool now filters the glob IN-PROCESS over the
  // gitignore-pruned `rg --files` list instead of via `-g`).
  writeFileSync(join(work, ".gitignore"), "node_modules/\nsecret.env.ts\n")
  writeFileSync(join(work, "src", "in.ts"), "1")
  writeFileSync(join(work, "src", "secret.env.ts"), "FILELEVELSECRET")
  writeFileSync(join(work, "node_modules", "pkg", "secret-dep.ts"), "DEP")
  writeFileSync(join(outside, "secret.ts"), "TOPSECRET")
  execFileSync("git", ["init", "-q"], { cwd: work })
  try {
    symlinkSync(outside, join(work, "link"))
  } catch {
    symlinkOk = false
  }
})

const ctx = (): ToolContext => ({ cwd: work, signal: new AbortController().signal })
const run = async (input: unknown): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of globTool.execute(input as never, ctx())) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

// A `describe`/`describe.skip` binding rather than `describe.skipIf(...)` so the
// suite body keeps its indentation and this stays a reviewable diff.
const D = canExecute(git) ? describe : describe.skip

D(`glob ripgrep engine cannot leak gitignored or out-of-jail paths [${git.verdict}]`, () => {
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

  test("(a2) a FILE-NAME .gitignore (secret.env.ts) is NOT returned under **/*.ts — F1", async () => {
    // The F1 regression: `rg --files -g '**/*.ts'` RE-ADMITS an individually
    // gitignored file (`-g` is a force-include override). The in-process filter
    // over plain `rg --files` keeps the gitignore prune authoritative, so a
    // gitignored file can NEVER surface regardless of the matching pattern.
    const r = await run({ pattern: "**/*.ts" })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.output).not.toContain("secret.env.ts")
      expect(r.output).not.toContain("FILELEVELSECRET")
      expect(r.output).toContain(join("src", "in.ts"))
    }
  })

  test("(a2b) the gitignored file is NOT reachable even by an EXACT-name pattern", async () => {
    // Even when the model targets the ignored file by name, the gitignore prune
    // wins (the file was never in the `rg --files` list to match against).
    const r = await run({ pattern: "src/secret.env.ts" })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.output).toBe("(no files matched)")
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

  test("a single-quote / shell metachar in the pattern is inert (no argv exposure)", async () => {
    // Pattern-injection is now structurally impossible: the pattern NEVER enters
    // the rg argv (rg runs `--files` with no pattern); it is only matched
    // in-process by `Bun.Glob`. A `'`/metachar therefore cannot reach the shell
    // at all. We still require the jail/contract holds (no crash, no leak). No
    // file matches this literal pattern, so the friendly empty message results.
    const r = await run({ pattern: "weird'name*.ts" })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.output).not.toContain("secret.ts")
      expect(r.output).not.toContain("TOPSECRET")
    }
  })
})
