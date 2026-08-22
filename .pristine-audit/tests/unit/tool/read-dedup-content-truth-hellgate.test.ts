/**
 * HELLGATE — H9 read-dedup: mtime-trust → content-truth (UUX-6-07 correctness).
 *
 * BUG (pre-fix): a dedup hit trusted mtime alone — an mtime-preserving content
 * change (write different bytes, `utimesSync` back to the old mtime) served the
 * model a STALE `file_unchanged` verdict. The dedup saves TOKENS, not disk IO:
 * the read tool ALREADY reads the whole file before the dedup check, so keying
 * the verdict on a CONTENT HASH of the just-read text costs one local hash and
 * can never lie.
 *
 * CORE RED (pre-fix fails): mtime-preserving content mutation ⇒ fresh content.
 * Paired controls: genuine-unchanged still dedups; changed-content path serves
 * fresh content; gate OFF is byte-identical full content.
 * Adversarial: size-equal different bytes @ same mtime; empty file; symlink
 * retarget @ same mtime; touch-only (mtime advanced, bytes identical) now
 * TRUTHFULLY dedups (content-hash upgrade — the sentinel's claim "content
 * identical to your prior read" is exactly true).
 *
 * All FS is tmp; no network; knob reset after each test.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test"
import {
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { __resetRuntimeConfig } from "@/shared"
import { readTool } from "@/tool/read"
import { ReadFileState } from "@/tool/stale-read-guard"
import type { ToolContext, ToolResult } from "@/tool/types"

const dir = mkdtempSync(join(tmpdir(), "read-dedup-content-truth-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const ctx = (cwd: string, readFileState: ReadFileState): ToolContext => ({
  cwd,
  signal: new AbortController().signal,
  readFileState,
})

const drain = async (input: unknown, c: ToolContext): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of readTool.execute(input as never, c)) {
    if (ev.type === "result" && ev.result !== undefined) result = ev.result
  }
  if (result === undefined) throw new Error("no result yielded")
  return result
}

/** Rewrite `path` with `content`, then force its mtime back to `mtimeMs` —
 *  the adversarial "content changed, mtime preserved" mutation. */
const rewritePreservingMtime = (path: string, content: string, mtimeMs: number): void => {
  writeFileSync(path, content)
  const sec = mtimeMs / 1000
  utimesSync(path, sec, sec)
}

describe("H9 read-dedup content-truth hellgate", () => {
  afterEach(() => {
    delete process.env.QUANTA_READ_DEDUP
    __resetRuntimeConfig()
  })

  const on = (): void => {
    process.env.QUANTA_READ_DEDUP = "1"
    __resetRuntimeConfig()
  }

  test("CORE RED: mtime-preserving content mutation ⇒ FRESH content, never the stale sentinel", async () => {
    on()
    const f = join(dir, "core.txt")
    writeFileSync(f, "original-secret-A")
    const st = new ReadFileState()
    const c = ctx(dir, st)
    const first = await drain({ path: f }, c)
    expect(first.output).toBe("1\toriginal-secret-A")
    const recorded = statSync(f).mtimeMs
    rewritePreservingMtime(f, "TAMPERED-DIFFERENT-B", recorded)
    // Prove the trap is armed: mtime really is unchanged on disk.
    expect(statSync(f).mtimeMs).toBe(recorded)
    const second = await drain({ path: f }, c)
    expect(second.ok).toBe(true)
    expect(second.output).not.toContain("file_unchanged")
    expect(second.output).toContain("TAMPERED-DIFFERENT-B")
  })

  test("PAIRED CONTROL: genuinely unchanged file still dedups (sentinel text byte-identical)", async () => {
    on()
    const f = join(dir, "control.txt")
    writeFileSync(f, "alpha\nbeta")
    const st = new ReadFileState()
    const c = ctx(dir, st)
    const first = await drain({ path: f }, c)
    expect(first.output).toBe("1\talpha\n2\tbeta")
    const second = await drain({ path: f }, c)
    expect(second.ok).toBe(true)
    // The user-visible hit message is pinned byte-for-byte (offset/limit are the
    // resolved effective values: 1 / 2000).
    expect(second.output).toBe(
      `file_unchanged: ${f} (offset 1, limit 2000) — ` +
        "content identical to your prior read of this exact range; re-using it.",
    )
  })

  test("PAIRED CONTROL: mtime advanced + content changed ⇒ fresh content (unchanged behavior)", async () => {
    on()
    const f = join(dir, "advanced.txt")
    writeFileSync(f, "v1")
    const st = new ReadFileState()
    const c = ctx(dir, st)
    await drain({ path: f }, c)
    const future = (statSync(f).mtimeMs + 5000) / 1000
    writeFileSync(f, "v2-new-content")
    utimesSync(f, future, future)
    const second = await drain({ path: f }, c)
    expect(second.output).not.toContain("file_unchanged")
    expect(second.output).toContain("v2-new-content")
  })

  test("PAIRED CONTROL: gate OFF ⇒ full content byte-identical, even after the mutation", async () => {
    delete process.env.QUANTA_READ_DEDUP
    __resetRuntimeConfig()
    const f = join(dir, "off.txt")
    writeFileSync(f, "one\ntwo")
    const st = new ReadFileState()
    const c = ctx(dir, st)
    const a = await drain({ path: f }, c)
    const recorded = statSync(f).mtimeMs
    rewritePreservingMtime(f, "one\ntwo", recorded) // same bytes back
    const b = await drain({ path: f }, c)
    expect(a.output).toBe("1\tone\n2\ttwo")
    expect(b.output).toBe(a.output)
    expect(b.output).not.toContain("file_unchanged")
  })

  test("ADVERSARIAL: size-equal different bytes at the same mtime ⇒ fresh content", async () => {
    on()
    const f = join(dir, "size-equal.txt")
    writeFileSync(f, "AAAAAAAA")
    const st = new ReadFileState()
    const c = ctx(dir, st)
    await drain({ path: f }, c)
    const recorded = statSync(f).mtimeMs
    rewritePreservingMtime(f, "BBBBBBBB", recorded) // same length, same mtime
    expect(statSync(f).size).toBe(8)
    const second = await drain({ path: f }, c)
    expect(second.output).not.toContain("file_unchanged")
    expect(second.output).toContain("BBBBBBBB")
  })

  test("ADVERSARIAL: empty file dedups on identical re-read (and un-dedups when bytes appear @ same mtime)", async () => {
    on()
    const f = join(dir, "empty.txt")
    writeFileSync(f, "")
    const st = new ReadFileState()
    const c = ctx(dir, st)
    const first = await drain({ path: f }, c)
    // An empty file renders as one numbered empty line ("" splits to [""]).
    expect(first.ok).toBe(true)
    expect(first.output).toBe("1\t")
    const second = await drain({ path: f }, c)
    expect(second.output).toContain("file_unchanged")
    // Now grow it while pinning the mtime — must serve the new bytes.
    const recorded = statSync(f).mtimeMs
    rewritePreservingMtime(f, "not-empty-anymore", recorded)
    const third = await drain({ path: f }, c)
    expect(third.output).not.toContain("file_unchanged")
    expect(third.output).toContain("not-empty-anymore")
  })

  test("ADVERSARIAL: symlink retargeted to different content at the same mtime ⇒ fresh content", async () => {
    on()
    const a = join(dir, "target-a.txt")
    const b = join(dir, "target-b.txt")
    writeFileSync(a, "contents-of-A")
    writeFileSync(b, "contents-of-B")
    const link = join(dir, "the-link.txt")
    symlinkSync(a, link)
    // Equalize the two targets' mtimes so a stat through the link is identical.
    const sec = statSync(a).mtimeMs / 1000
    utimesSync(b, sec, sec)
    const st = new ReadFileState()
    const c = ctx(dir, st)
    const first = await drain({ path: link }, c)
    expect(first.output).toContain("contents-of-A")
    unlinkSync(link)
    symlinkSync(b, link)
    const second = await drain({ path: link }, c)
    expect(second.output).not.toContain("contents-of-A")
    // Whether the dedup keys on the link path or the resolved target path, the
    // verdict must be truthful: B's bytes, never a stale "unchanged" claim.
    expect(second.output).toContain("contents-of-B")
  })

  test("touch-only (mtime advanced, bytes identical) TRUTHFULLY dedups — content-hash upgrade", async () => {
    // Pre-fix, a bare `touch` forced a full re-render even though the sentinel's
    // claim would have been true. Content-truth keys on the bytes, so this now
    // dedups — strictly MORE token savings, never a lie. Pinned as intended.
    on()
    const f = join(dir, "touch-only.txt")
    writeFileSync(f, "stable-bytes")
    const st = new ReadFileState()
    const c = ctx(dir, st)
    await drain({ path: f }, c)
    const future = (statSync(f).mtimeMs + 60_000) / 1000
    utimesSync(f, future, future)
    const second = await drain({ path: f }, c)
    expect(second.ok).toBe(true)
    expect(second.output).toContain("file_unchanged")
  })

  test("ADVERSARIAL: different range is still NOT deduped against a prior range", async () => {
    on()
    const f = join(dir, "range.txt")
    writeFileSync(f, "L1\nL2\nL3\nL4\nL5")
    const st = new ReadFileState()
    const c = ctx(dir, st)
    await drain({ path: f }, c)
    const ranged = await drain({ path: f, offset: 2, limit: 2 }, c)
    expect(ranged.output).not.toContain("file_unchanged")
    expect(ranged.output).toContain("L2")
  })
})
