/**
 * jun-6 exfil-rail (b) — glob-in-write guard hellgate (TDD red→green).
 *
 * Per RFC jun-6-exfil-egress-rails.md §6 (b):
 *  - a glob path → typed `rejected` (reason `glob_in_write_path`) + verbatim msg
 *  - an exact path → ALLOWED (proceeds to the existing fs path)
 *  - a literal-bracket filename (`file[1].txt`) → NO false positive (documented)
 *  - guard OFF (flag absent) ⇒ byte-identical (a glob path is a literal filename)
 *  Covers BOTH `write` and `edit`.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  GLOB_IN_WRITE_MESSAGE,
  GLOB_IN_WRITE_REASON,
  pathLooksLikeGlob,
} from "@/tool/_shared/glob-in-path"
import { editTool } from "@/tool/edit"
import type { ToolContext, ToolResult } from "@/tool/types"
import { writeTool } from "@/tool/write"

const dir = mkdtempSync(join(tmpdir(), "exfil-glob-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const ctx = (over?: Partial<ToolContext>): ToolContext => ({
  cwd: dir,
  signal: new AbortController().signal,
  ...over,
})

const runWrite = async (input: unknown, c: ToolContext): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of writeTool.execute(input as never, c)) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

const runEdit = async (input: unknown, c: ToolContext): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of editTool.execute(input as never, c)) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

describe("pathLooksLikeGlob — pure detector", () => {
  test("fires on `*`, `**`, `?`, and brace expansion", () => {
    expect(pathLooksLikeGlob("src/**/*.ts")).toBe(true)
    expect(pathLooksLikeGlob("a/*.js")).toBe(true)
    expect(pathLooksLikeGlob("file?.txt")).toBe(true)
    expect(pathLooksLikeGlob("{a,b}.txt")).toBe(true)
    expect(pathLooksLikeGlob("src/{foo,bar}/x.ts")).toBe(true)
  })

  test("NO false positive on exact paths and literal brackets/braces", () => {
    expect(pathLooksLikeGlob("src/foo.ts")).toBe(false)
    expect(pathLooksLikeGlob("/abs/path/to/file.json")).toBe(false)
    // Documented decision (RFC §6 (b)): a literal-bracket filename is a real
    // filename, not a fan-out glob — a `[…]` class can match only one char.
    expect(pathLooksLikeGlob("file[1].txt")).toBe(false)
    expect(pathLooksLikeGlob("arr[0].json")).toBe(false)
    // A brace group WITHOUT a comma is not an expansion (some real paths use {}).
    expect(pathLooksLikeGlob("weird{}name.txt")).toBe(false)
    expect(pathLooksLikeGlob("ts{x}.ts")).toBe(false)
  })

  test("total / no-throw on empty + odd input", () => {
    expect(pathLooksLikeGlob("")).toBe(false)
    expect(pathLooksLikeGlob("}{")).toBe(false)
  })
})

describe("write — glob guard (enabled)", () => {
  const on = ctx({ globWriteGuard: true })

  test("rejects a glob target with verbatim message + typed reason", async () => {
    const r = await runWrite({ path: join(dir, "x/**/*.ts"), content: "x" }, on)
    expect(r.ok).toBe(false)
    expect(r.output).toBe(GLOB_IN_WRITE_MESSAGE)
    expect(r.failure).toEqual({ mode: "rejected", reason: GLOB_IN_WRITE_REASON })
  })

  test("ALLOWS an exact path (proceeds to fs write)", async () => {
    const f = join(dir, "exact.txt")
    const r = await runWrite({ path: f, content: "hello" }, on)
    expect(r.ok).toBe(true)
    expect(readFileSync(f, "utf8")).toBe("hello")
  })

  test("ALLOWS a literal-bracket filename (no false positive)", async () => {
    const f = join(dir, "file[1].txt")
    const r = await runWrite({ path: f, content: "ok" }, on)
    expect(r.ok).toBe(true)
    expect(readFileSync(f, "utf8")).toBe("ok")
  })
})

describe("write — glob guard (OFF ⇒ byte-identical)", () => {
  test("flag absent ⇒ a glob path is treated as a literal filename", async () => {
    const f = join(dir, "literal-star.txt")
    // Use a path with no real glob char on disk but assert OFF path doesn't reject
    // a `?`-bearing name: it writes a literal file (the legacy behavior).
    const globby = join(dir, "lit?name.txt")
    const r = await runWrite({ path: globby, content: "legacy" }, ctx())
    expect(r.ok).toBe(true)
    // The exact non-glob path still works identically.
    const r2 = await runWrite({ path: f, content: "z" }, ctx())
    expect(r2.ok).toBe(true)
  })
})

describe("edit — glob guard", () => {
  test("rejects a glob target when enabled", async () => {
    const r = await runEdit(
      { path: join(dir, "**/*.ts"), old_string: "a", new_string: "b" },
      ctx({ globWriteGuard: true }),
    )
    expect(r.ok).toBe(false)
    expect(r.output).toBe(GLOB_IN_WRITE_MESSAGE)
    expect(r.failure).toEqual({ mode: "rejected", reason: GLOB_IN_WRITE_REASON })
  })

  test("OFF ⇒ a glob path falls through to the LEGACY read path (no glob rejection)", async () => {
    // No file at this glob-shaped path ⇒ the legacy read throws "File not found"
    // exactly as before — the glob guard did NOT intercept with a typed
    // `rejected` result (byte-identical behavior with the flag off).
    await expect(
      runEdit({ path: join(dir, "nope-*.ts"), old_string: "a", new_string: "b" }, ctx()),
    ).rejects.toThrow(/File not found/)
  })

  test("ALLOWS a real edit on an exact path when enabled", async () => {
    const f = join(dir, "edit-exact.txt")
    writeFileSync(f, "alpha")
    const r = await runEdit(
      { path: f, old_string: "alpha", new_string: "beta" },
      ctx({ globWriteGuard: true }),
    )
    expect(r.ok).toBe(true)
    expect(readFileSync(f, "utf8")).toBe("beta")
  })
})
