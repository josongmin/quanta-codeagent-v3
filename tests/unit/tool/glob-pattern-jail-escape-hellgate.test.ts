/**
 * ★ HELLGATE — glob `pattern`-channel FS-jail escape (wave-4 INJECTION).
 *
 * The glob tool jail-validated `input.path` (S14) but passed `input.pattern`
 * verbatim to Bun.Glob.scan, so a model-supplied absolute pattern ("/etc/*") or
 * a "../" pattern enumerated files OUTSIDE the workspace jail — the exact
 * read-scope the tool's own comment + the S14 path tests promise it cannot.
 * FIX (fail-closed): reject an absolute / ".."-segment pattern up front, and
 * re-jail every emitted hit (symlink defense-in-depth), dropping out-of-jail
 * paths. These tests pin both channels.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolContext, ToolResult } from "@/tool"
import { globTool } from "@/tool/glob"

// jailRoot = <root>/work ; a sibling <root>/outside holds a secret the jail
// must never list. A symlink inside work points at outside (escape attempt).
const root = mkdtempSync(join(tmpdir(), "glob-jail-"))
const work = join(root, "work")
const outside = join(root, "outside")
afterAll(() => rmSync(root, { recursive: true, force: true }))
mkdirSync(join(work, "src"), { recursive: true })
mkdirSync(outside, { recursive: true })
writeFileSync(join(work, "src", "in.ts"), "1")
writeFileSync(join(outside, "secret.ts"), "TOPSECRET")
try {
  symlinkSync(outside, join(work, "link"))
} catch {
  // symlink may be unsupported in some sandboxes; the symlink test guards on it.
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

describe("glob pattern channel cannot escape the FS jail", () => {
  test("absolute pattern (/etc/*) is REJECTED (not scanned)", async () => {
    const r = await run({ pattern: "/etc/*" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.output).toContain("escapes the workspace")
  })

  test("relative '../' traversal pattern is REJECTED", async () => {
    const r = await run({ pattern: "../outside/*.ts" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.output).toContain("escapes the workspace")
  })

  test("deep '../../' traversal pattern is REJECTED", async () => {
    const r = await run({ pattern: "../../**/*.ts" })
    expect(r.ok).toBe(false)
  })

  test("an in-jail pattern still works (no false reject)", async () => {
    const r = await run({ pattern: "src/*.ts" })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.output).toContain("src/in.ts")
  })

  test("the secret OUTSIDE the jail is never listed by any accepted pattern", async () => {
    const r = await run({ pattern: "**/*.ts" })
    expect(r.ok).toBe(true)
    // Even a broad in-jail glob that crosses the symlink must not surface the
    // out-of-jail secret (re-jail drops the symlinked hit).
    if (r.ok) expect(r.output).not.toContain("secret.ts")
  })
})
