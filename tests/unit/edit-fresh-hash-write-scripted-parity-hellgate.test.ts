/** jul-13 hellgate — edit-fresh-hash PARITY across write + scripted_replace, and
 *  CROSS-TOOL chaining under the DEFAULT-ON mtime stale-read guard.
 *
 *  The fresh-hash feature is not edit-only: any single-flat-file mutation should
 *  hand the model a fresh content hash on success AND refresh the stale-read guard
 *  baseline, so the model can chain a NEXT edit to that file without a re-read
 *  regardless of which tool wrote it. All three (`edit`/`write`/`scripted_replace`)
 *  share ONE implementation (`_shared/fresh-hash.ts`). This suite pins write +
 *  scripted parity and the cross-tool chain (write→edit, scripted→edit) surviving
 *  the DEFAULT-ON guard. (apply_patch = multi-file and notebook_edit = cell-JSON
 *  do NOT fit the single-flat-file fresh-hash contract and are deliberately out.)
 *
 *  RED-ON-INJECTION: removing `refreshStaleReadBaseline`/`freshHashNote` from the
 *  shared helper flips the emit + cross-tool-chain tests RED. */

import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultFileSystemPort, sha256Hex } from "@/storage"
import type { ToolContext, ToolResult } from "@/tool"
import { makeEditTool } from "@/tool/edit"
import { makeScriptedReplaceTool } from "@/tool/scripted-replace"
import { ReadFileState } from "@/tool/stale-read-guard"
import { makeWriteTool } from "@/tool/write"

const FRESH_RE = /fresh sha256: ([0-9a-f]{64})/

const drive = async (
  tool: {
    execute: (i: never, c: ToolContext) => AsyncIterable<{ type: string; result?: ToolResult }>
  },
  input: unknown,
  ctx: ToolContext,
): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input as never, ctx)) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

describe("jul-13 fresh-hash parity — write", () => {
  const dir = mkdtempSync(join(tmpdir(), "fresh-hash-write-"))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test("ON: write success advertises sha256 of the written content", async () => {
    const path = join(dir, "w-on.txt")
    const content = "const a = 1\nconst b = 2\n"
    const r = await drive(
      makeWriteTool(defaultFileSystemPort),
      { path, content },
      { cwd: dir, signal: new AbortController().signal, editFreshHash: true },
    )
    expect(r.ok).toBe(true)
    const advertised = r.output?.match(FRESH_RE)?.[1]
    expect(advertised).toBe(sha256Hex(content))
    expect(advertised).toBe(sha256Hex(readFileSync(path, "utf8")))
    // red-on-injection: hashing anything other than the written content is caught.
    expect(advertised).not.toBe(sha256Hex("const a = 1\n"))
  })

  test("OFF: write success output byte-identical (no fresh-hash line)", async () => {
    const path = join(dir, "w-off.txt")
    const r = await drive(
      makeWriteTool(defaultFileSystemPort),
      { path, content: "x" },
      { cwd: dir, signal: new AbortController().signal },
    )
    expect(r.ok).toBe(true)
    expect(r.output).not.toContain("fresh sha256")
    expect(r.output).toBe(`Created ${path} (1 bytes)`)
  })
})

describe("jul-13 fresh-hash parity — scripted_replace", () => {
  const dir = mkdtempSync(join(tmpdir(), "fresh-hash-scripted-"))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test("ON: scripted_replace success advertises sha256 of the RESULT bytes", async () => {
    const file = join(dir, "s-on.txt")
    writeFileSync(file, "alpha beta alpha\n", "utf8")
    const r = await drive(
      makeScriptedReplaceTool(defaultFileSystemPort),
      { file, pattern: "alpha", replacement: "ALPHA" },
      { cwd: dir, signal: new AbortController().signal, editFreshHash: true },
    )
    expect(r.ok).toBe(true)
    const advertised = r.output?.match(FRESH_RE)?.[1]
    expect(advertised).toBe(sha256Hex(readFileSync(file, "utf8")))
    expect(advertised).not.toBe(sha256Hex("alpha beta alpha\n")) // not the pre-replace bytes
  })

  test("OFF: scripted_replace output byte-identical (no fresh-hash line)", async () => {
    const file = join(dir, "s-off.txt")
    writeFileSync(file, "alpha\n", "utf8")
    const r = await drive(
      makeScriptedReplaceTool(defaultFileSystemPort),
      { file, pattern: "alpha", replacement: "beta" },
      { cwd: dir, signal: new AbortController().signal },
    )
    expect(r.ok).toBe(true)
    expect(r.output).not.toContain("fresh sha256")
  })
})

describe("jul-13 fresh-hash CROSS-TOOL chain survives the DEFAULT-ON mtime guard (real fs)", () => {
  const dir = mkdtempSync(join(tmpdir(), "fresh-hash-xtool-"))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const prodCtx = (readFileState: ReadFileState): ToolContext => ({
    cwd: dir,
    signal: new AbortController().signal,
    readFileState,
    editFreshHash: true,
  })

  test("write → edit: an edit chained on write's advertised hash survives (write refreshed the baseline)", async () => {
    const path = join(dir, "w2e.txt")
    writeFileSync(path, "let a = 1\nlet b = 1\n", "utf8")
    const state = new ReadFileState()
    state.record(path, statSync(path).mtimeMs) // model read it once

    // Overwrite the whole file via `write` — advances mtime; write refreshes baseline.
    const w = await drive(
      makeWriteTool(defaultFileSystemPort),
      { path, content: "let a = 2\nlet b = 1\n" },
      prodCtx(state),
    )
    expect(w.ok).toBe(true)
    const advertised = w.output?.match(FRESH_RE)?.[1]
    expect(advertised).toBe(sha256Hex(readFileSync(path, "utf8")))

    // Chain an EDIT to the just-written file, NO re-read, precondition = advertised.
    // Before the write-side fix this failed `stale_read`; now it survives.
    const e = await drive(
      makeEditTool(defaultFileSystemPort),
      { path, old_string: "b = 1", new_string: "b = 2", expected_hash: advertised },
      prodCtx(state),
    )
    expect(e.ok).toBe(true)
    expect(e.failure).toBeUndefined()
    expect(readFileSync(path, "utf8")).toBe("let a = 2\nlet b = 2\n")
  })

  test("scripted_replace → edit: chained edit on scripted's advertised hash survives", async () => {
    const path = join(dir, "s2e.txt")
    writeFileSync(path, "p = 1\nq = 1\n", "utf8")
    const state = new ReadFileState()
    state.record(path, statSync(path).mtimeMs)

    const s = await drive(
      makeScriptedReplaceTool(defaultFileSystemPort),
      { file: path, pattern: "p = 1", replacement: "p = 2" },
      prodCtx(state),
    )
    expect(s.ok).toBe(true)
    const advertised = s.output?.match(FRESH_RE)?.[1]

    const e = await drive(
      makeEditTool(defaultFileSystemPort),
      { path, old_string: "q = 1", new_string: "q = 2", expected_hash: advertised },
      prodCtx(state),
    )
    expect(e.ok).toBe(true)
    expect(readFileSync(path, "utf8")).toBe("p = 2\nq = 2\n")
  })

  test("SAFETY: an external modification after write still trips stale_read on a chained edit", async () => {
    const path = join(dir, "w-clobber.txt")
    writeFileSync(path, "m = 1\nn = 1\n", "utf8")
    const state = new ReadFileState()
    state.record(path, statSync(path).mtimeMs)

    const w = await drive(
      makeWriteTool(defaultFileSystemPort),
      { path, content: "m = 2\nn = 1\n" },
      prodCtx(state),
    )
    const advertised = w.output?.match(FRESH_RE)?.[1]

    // External writer touches the file to a definitively-later mtime.
    const future = new Date(Date.now() + 60_000)
    utimesSync(path, future, future)

    const e = await drive(
      makeEditTool(defaultFileSystemPort),
      { path, old_string: "n = 1", new_string: "n = 2", expected_hash: advertised },
      prodCtx(state),
    )
    expect(e.ok).toBe(false)
    expect((e.failure as { reason?: string } | undefined)?.reason).toBe("stale_read")
    expect(readFileSync(path, "utf8")).toBe("m = 2\nn = 1\n") // edit rejected
  })
})
