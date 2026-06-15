/**
 * HELLGATE — grep tool: working-directory JAIL ESCAPE via the `path` input.
 *
 * `grepTool` jail-validates the model-supplied `path` (S14) through the
 * `resolveJailed` storage seam BEFORE building the ripgrep argv — otherwise
 * `path: "/etc/passwd"` (or `../../`) would let the model read secrets outside
 * the workspace via the rg subprocess. `glob.test.ts` already pins this for
 * glob ("explicit path OUTSIDE ctx.cwd is REFUSED"); grep had the guard but NO
 * test — an asymmetric hole where reverting the S14 block re-opens an
 * info-disclosure boundary silently.
 *
 * RED-ON-INJECTION (teeth, verified in-session): removing the `resolveJailed`
 * guard block in grepTool.execute makes the out-of-jail cases fall through to
 * ripgrep instead of being refused with the jail message.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolContext, ToolResult } from "@/tool"
import { grepTool } from "@/tool/grep"

const dir = mkdtempSync(join(tmpdir(), "grep-jail-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

mkdirSync(join(dir, "sub"), { recursive: true })
writeFileSync(join(dir, "sub", "in.ts"), "const needle = 1\n")

const ctx = (cwd: string): ToolContext => ({ cwd, signal: new AbortController().signal })

const run = async (input: unknown): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of grepTool.execute(input as never, ctx(dir))) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

describe("HELLGATE: grep — out-of-jail `path` is refused before spawning ripgrep", () => {
  test("an ABSOLUTE path outside the jail (`/etc/passwd`) is REFUSED", async () => {
    const r = await run({ pattern: "root", path: "/etc/passwd" })
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/escapes the working-directory jail/i)
    // and it must NOT have leaked any /etc/passwd content
    expect(r.output).not.toMatch(/root:.*:0:0:/)
  })

  test("a `..` traversal climbing out of the jail is REFUSED", async () => {
    const r = await run({ pattern: "root", path: "../../../../../../etc/passwd" })
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/escapes the working-directory jail/i)
  })

  test("an absolute path to a sensitive home dir (`~/.ssh` expanded) is REFUSED", async () => {
    const r = await run({ pattern: "PRIVATE KEY", path: join(process.env.HOME ?? "/root", ".ssh") })
    expect(r.ok).toBe(false)
    // either jail-escape (outside cwd) — the security refusal, never a search
    expect(r.output).toMatch(/escapes the working-directory jail|must name one existing/i)
  })

  test("NO over-correction: a legitimate IN-jail subdir path still searches", async () => {
    const r = await run({ pattern: "needle", path: "sub" })
    expect(r.ok).toBe(true)
    expect(r.output).toContain("needle")
  })

  test("an IN-jail but non-existent path is rejected with a clear message (not a jail error)", async () => {
    const r = await run({ pattern: "x", path: "does-not-exist" })
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/must name one existing file or directory/i)
  })
})
