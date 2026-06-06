import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolContext, ToolResult } from "@/tool"
import { readTool } from "@/tool/read"

const dir = mkdtempSync(join(tmpdir(), "read-test-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const ctx = (cwd: string): ToolContext => ({
  cwd,
  signal: new AbortController().signal,
})

const run = async (input: unknown): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of readTool.execute(input as never, ctx(dir))) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

describe("readTool", () => {
  test("metadata: read-only and concurrency-safe", () => {
    expect(readTool.name).toBe("read")
    expect(readTool.isReadOnly()).toBe(true)
    expect(readTool.isConcurrencySafe({ path: "x" })).toBe(true)
  })

  test("reads a file with 1-based line numbers", async () => {
    const f = join(dir, "lines.txt")
    writeFileSync(f, "alpha\nbeta\ngamma")
    const r = await run({ path: f })
    expect(r.ok).toBe(true)
    expect(r.output).toBe("1\talpha\n2\tbeta\n3\tgamma")
  })

  test("empty file yields a single numbered blank line", async () => {
    const f = join(dir, "empty.txt")
    writeFileSync(f, "")
    const r = await run({ path: f })
    expect(r.ok).toBe(true)
    expect(r.output).toBe("1\t")
  })

  test("offset past EOF produces the (empty file) sentinel", async () => {
    const f = join(dir, "past-eof.txt")
    writeFileSync(f, "only\n")
    const r = await run({ path: f, offset: 99 })
    expect(r.ok).toBe(true)
    expect(r.output).toBe("(empty file)")
  })

  test("offset starts from the given 1-based line", async () => {
    const f = join(dir, "offset.txt")
    writeFileSync(f, "l1\nl2\nl3\nl4")
    const r = await run({ path: f, offset: 3 })
    expect(r.ok).toBe(true)
    expect(r.output).toBe("3\tl3\n4\tl4")
  })

  test("limit caps lines and appends a more-lines note", async () => {
    const f = join(dir, "limit.txt")
    writeFileSync(f, "a\nb\nc\nd\ne")
    const r = await run({ path: f, limit: 2 })
    expect(r.ok).toBe(true)
    expect(r.output).toBe("1\ta\n2\tb\n… (3 more lines, use offset)")
  })

  test("offset + limit windows the file without a note when reaching EOF", async () => {
    const f = join(dir, "window.txt")
    writeFileSync(f, "x1\nx2\nx3\nx4")
    const r = await run({ path: f, offset: 3, limit: 10 })
    expect(r.ok).toBe(true)
    expect(r.output).toBe("3\tx3\n4\tx4")
  })

  test("directory path returns ok:false", async () => {
    const sub = join(dir, "adir")
    mkdirSync(sub)
    const r = await run({ path: sub })
    expect(r.ok).toBe(false)
    expect(r.output).toContain("is a directory")
  })

  test("directory path → failure.mode not_found with path (absorb #2)", async () => {
    const sub = join(dir, "adir-typed")
    mkdirSync(sub)
    const r = await run({ path: sub })
    expect(r.ok).toBe(false)
    expect(r.failure).toEqual({ mode: "not_found", path: sub })
    // Human-readable output preserved.
    expect(r.output).toContain("is a directory")
  })

  test("FS jail escape → failure.mode permission_denied isReadonly:false (absorb #2)", async () => {
    const jail = mkdtempSync(join(tmpdir(), "read-jail-typed-"))
    const outside = mkdtempSync(join(tmpdir(), "read-outside-typed-"))
    const victim = join(outside, "secret.txt")
    writeFileSync(victim, "top-secret")
    try {
      const prev = process.env.QUANTA_FS_JAIL
      delete process.env.QUANTA_FS_JAIL
      let result: ToolResult | undefined
      for await (const ev of readTool.execute({ path: victim } as never, ctx(jail))) {
        if (ev.type === "result") result = ev.result
      }
      expect(result?.ok).toBe(false)
      expect(result?.failure).toEqual({
        mode: "permission_denied",
        path: victim,
        isReadonly: false,
      })
      if (prev !== undefined) process.env.QUANTA_FS_JAIL = prev
    } finally {
      rmSync(jail, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test("missing file ⇒ typed not_found (gap closure, absorb #2 extension)", async () => {
    // statFile() runs first and surfaces the OS ENOENT for a missing path.
    // Pre-fix `read` re-threw past the loop; now the tool catches ENOENT
    // (and the inner `File not found:` shape) and produces a typed
    // `not_found` failure with the requested path verbatim.
    const ghost = join(dir, "ghost.txt")
    const r = await run({ path: ghost })
    expect(r.ok).toBe(false)
    expect(r.failure).toEqual({ mode: "not_found", path: ghost })
    expect(r.output).toContain("File not found")
  })

  test("schema rejects a non-string path", () => {
    expect(readTool.inputSchema.safeParse({ path: 123 }).success).toBe(false)
  })

  test("schema rejects limit:0 / negative / non-int (avoids misleading empty read)", () => {
    // A `limit:0` or negative value previously sliced to empty and surfaced the
    // "(empty file)" sentinel on a NON-empty file. The tightened schema rejects
    // these at the boundary with a clear validation error instead.
    expect(readTool.inputSchema.safeParse({ path: "x", limit: 0 }).success).toBe(false)
    expect(readTool.inputSchema.safeParse({ path: "x", limit: -5 }).success).toBe(false)
    expect(readTool.inputSchema.safeParse({ path: "x", limit: 1.5 }).success).toBe(false)
    // A positive integer limit is still accepted.
    expect(readTool.inputSchema.safeParse({ path: "x", limit: 1 }).success).toBe(true)
  })

  test("schema rejects a negative / non-int offset, accepts 0 and positive ints", () => {
    expect(readTool.inputSchema.safeParse({ path: "x", offset: -1 }).success).toBe(false)
    expect(readTool.inputSchema.safeParse({ path: "x", offset: 2.5 }).success).toBe(false)
    expect(readTool.inputSchema.safeParse({ path: "x", offset: 0 }).success).toBe(true)
    expect(readTool.inputSchema.safeParse({ path: "x", offset: 3 }).success).toBe(true)
  })

  // -------------------------------------------------------------------------
  // D8 — per-line char cap + oversized nudge (RFC jun-7 §3.3).
  // Red-on-injection: removing the per-line cap dumps the whole 200k line, so
  // the rendered line length assertion goes RED.
  // -------------------------------------------------------------------------

  test("a single oversized line is truncated with an elision marker (D8)", async () => {
    const f = join(dir, "minified.js")
    // One physical line, 200k chars — a minified bundle shape.
    const oneLine = "x".repeat(200_000)
    writeFileSync(f, oneLine)
    const r = await run({ path: f })
    expect(r.ok).toBe(true)
    const out = r.output ?? ""
    // The rendered content line (after the `1\t` prefix) must be capped well
    // under the original 200k; assert the whole output is far smaller and the
    // in-band elision marker is present.
    expect(out.length).toBeLessThan(10_000)
    expect(out).toContain("chars elided")
  })

  test("oversized line truncation is surrogate-safe (no split pair) (D8)", async () => {
    const f = join(dir, "emoji.txt")
    // Pad with single-unit chars up to one unit BEFORE the cap, then place an
    // astral emoji (a surrogate pair) straddling the cap boundary. The cap must
    // not slice between the high and low surrogate.
    // We don't assume the exact cap here; instead build a line that is mostly a
    // run of a 2-unit emoji so SOME pair lands on whatever boundary the cap
    // chooses, then assert the rendered prefix contains no lone surrogate.
    const emoji = "😀" // U+1F600, one surrogate pair (2 UTF-16 units)
    // ODD single-unit prefix so the surrogate pairs sit at ODD start indices.
    // With an even MAX_LINE_CHARS the raw cut then lands BETWEEN a pair's two
    // units (charCodeAt(cut-1) is a HIGH surrogate) — forcing the backoff branch
    // to fire. Without the prefix every pair is on an even boundary and the cut
    // is always clean, so the backoff is never exercised (the old tautology).
    const line = `a${emoji.repeat(50_000)}` // 1 + 100k UTF-16 units
    writeFileSync(f, line)
    const r = await run({ path: f })
    expect(r.ok).toBe(true)
    const out = r.output ?? ""
    // No lone surrogate anywhere in the rendered output.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out)).toBe(
      false,
    )
    expect(out).toContain("chars elided")
  })

  test("a large file prepends a one-line advisory nudge (D8, non-blocking)", async () => {
    const f = join(dir, "big.txt")
    // Many normal lines whose total size exceeds the token budget.
    const big = `${"line of text here\n".repeat(120_000)}`
    writeFileSync(f, big)
    const r = await run({ path: f })
    // Still returns content (nudge, not refuse).
    expect(r.ok).toBe(true)
    const out = r.output ?? ""
    expect(out).toMatch(/large file/i)
    // Content still present (first line numbered).
    expect(out).toContain("1\tline of text here")
  })

  test("oversized nudge is SUPPRESSED when the caller is already paging (offset set) (D8)", async () => {
    const f = join(dir, "big-paged.txt")
    const big = "line of text here\n".repeat(60_000) // > nudge threshold
    writeFileSync(f, big)
    const r = await run({ path: f, offset: 5000, limit: 10 })
    expect(r.ok).toBe(true)
    const out = r.output ?? ""
    // The caller IS paging — advising "prefer offset/limit" would be a false
    // positive, so the nudge must NOT appear.
    expect(out).not.toMatch(/large file/i)
  })

  test("normal small files are byte-identical (no cap, no nudge) (D8)", async () => {
    const f = join(dir, "small-d8.txt")
    writeFileSync(f, "alpha\nbeta\ngamma")
    const r = await run({ path: f })
    expect(r.ok).toBe(true)
    expect(r.output).toBe("1\talpha\n2\tbeta\n3\tgamma")
  })

  test("a relative path resolves against ctx.cwd, not process.cwd()", async () => {
    // The file lives only under the session cwd (dir); a bare name must hit it.
    writeFileSync(join(dir, "relative-read.txt"), "from-ctx-cwd")
    const r = await run({ path: "relative-read.txt" })
    expect(r.ok).toBe(true)
    expect(r.output).toBe("1\tfrom-ctx-cwd")
  })
})
