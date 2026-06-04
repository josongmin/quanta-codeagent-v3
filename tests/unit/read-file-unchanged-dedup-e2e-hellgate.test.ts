import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { __resetRuntimeConfig } from "@/shared"
import { readTool } from "@/tool/read"
import { ReadFileState } from "@/tool/stale-read-guard"
import type { ToolContext, ToolResult } from "@/tool/types"

// H9 e2e hellgate — the REAL `read` tool (default @/storage port) against a REAL
// tmp file, with a real dedup state wired on ctx.readFileState. Proves the
// short-circuit end-to-end: read twice (knob on) → content then `file_unchanged`;
// modify the file to advance its mtime → full content again; knob off → both
// reads full content. mtime is advanced via `utimesSync` to a KNOWN-future stamp
// so the "file changed" signal is deterministic (no ms-floor flakiness).

const dir = mkdtempSync(join(tmpdir(), "read-dedup-e2e-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
afterEach(() => {
  delete process.env.QUANTA_READ_DEDUP
  __resetRuntimeConfig()
})

const setKnob = (on: boolean): void => {
  if (on) process.env.QUANTA_READ_DEDUP = "1"
  else delete process.env.QUANTA_READ_DEDUP
  __resetRuntimeConfig()
}

const ctxWith = (state?: ReadFileState): ToolContext => ({
  cwd: dir,
  signal: new AbortController().signal,
  ...(state !== undefined ? { readFileState: state } : {}),
})

const run = async (input: unknown, ctx: ToolContext): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of readTool.execute(input as never, ctx)) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

const SENTINEL_MARK = "file_unchanged:"

describe("read file_unchanged dedup (H9) — e2e real file + real tool", () => {
  test("knob ON: read twice → content, then file_unchanged; modify (mtime++) → full content", async () => {
    setKnob(true)
    const f = join(dir, "loop.ts")
    writeFileSync(f, "export const a = 1\nexport const b = 2")
    const state = new ReadFileState()
    const ctx = ctxWith(state)

    const first = await run({ path: f }, ctx)
    expect(first.ok).toBe(true)
    expect(first.output).toBe("1\texport const a = 1\n2\texport const b = 2")
    expect(first.output).not.toContain(SENTINEL_MARK)

    const second = await run({ path: f }, ctx)
    expect(second.ok).toBe(true)
    expect(second.output).toContain(SENTINEL_MARK)
    expect(second.output).toContain(f)
    expect(second.output).not.toContain("export const a")

    // Modify the file AND advance its mtime to a known-future second.
    writeFileSync(f, "export const a = 99\nexport const b = 2\nexport const c = 3")
    const future = Date.now() / 1000 + 5
    utimesSync(f, future, future)

    const third = await run({ path: f }, ctx)
    expect(third.ok).toBe(true)
    expect(third.output).not.toContain(SENTINEL_MARK)
    expect(third.output).toContain("export const a = 99")
    expect(third.output).toContain("export const c = 3")

    // And an immediate identical re-read (mtime now stable) dedups again.
    const fourth = await run({ path: f }, ctx)
    expect(fourth.output).toContain(SENTINEL_MARK)
  })

  test("knob OFF: both reads return full content (byte-identical, never a sentinel)", async () => {
    setKnob(false)
    const f = join(dir, "off.ts")
    writeFileSync(f, "const off = true")
    const state = new ReadFileState()
    const ctx = ctxWith(state)

    const first = await run({ path: f }, ctx)
    const second = await run({ path: f }, ctx)
    expect(first.output).toBe("1\tconst off = true")
    expect(second.output).toBe("1\tconst off = true")
    expect(second.output).not.toContain(SENTINEL_MARK)
    // Dedup map untouched; freshness baseline (ADR-0474) still recorded.
    expect(state.recordedRangeMtime(f, 1, 2000)).toBeUndefined()
    expect(state.recordedMtime(f)).toBeGreaterThan(0)
  })

  test("knob ON but different range on the real file → not deduped", async () => {
    setKnob(true)
    const f = join(dir, "range.ts")
    writeFileSync(f, "l1\nl2\nl3\nl4\nl5")
    const state = new ReadFileState()
    const ctx = ctxWith(state)
    await run({ path: f }, ctx)
    const windowed = await run({ path: f, offset: 3, limit: 2 }, ctx)
    expect(windowed.output).not.toContain(SENTINEL_MARK)
    expect(windowed.output).toContain("3\tl3")
  })
})
