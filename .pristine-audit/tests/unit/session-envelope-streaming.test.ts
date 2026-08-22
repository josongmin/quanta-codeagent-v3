import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionMetaRecord } from "@/session"
import { encodeSessionLine, iterateSessionFile, SESSION_ENVELOPE_VERSION } from "@/session"

const dir = mkdtempSync(join(tmpdir(), "session-stream-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const meta = (id: string): SessionMetaRecord => ({
  type: "session_meta",
  schema_version: SESSION_ENVELOPE_VERSION,
  session_id: id,
  started_at: "2026-05-21T00:00:00.000Z",
  cwd: "/tmp",
  cli_version: "0.1.0",
  model: "gpt-5",
})

const writeLines = (lines: string[]): string => {
  const p = join(dir, `${Math.random().toString(36).slice(2)}.jsonl`)
  writeFileSync(p, lines.join(""))
  return p
}

describe("iterateSessionFile", () => {
  test("yields one Result per non-empty line, in order", async () => {
    const a = encodeSessionLine(meta("a"))
    const b = encodeSessionLine(meta("b"))
    const c = encodeSessionLine(meta("c"))
    const p = writeLines([a, b, c])
    const out: string[] = []
    for await (const r of iterateSessionFile(p)) {
      expect(r.ok).toBe(true)
      if (!r.ok) throw new Error("unreachable")
      out.push((r.value as SessionMetaRecord).session_id)
    }
    expect(out).toEqual(["a", "b", "c"])
  })

  test("handles a final line without a trailing newline", async () => {
    const a = encodeSessionLine(meta("a"))
    const bNoNl = encodeSessionLine(meta("b")).slice(0, -1)
    const p = writeLines([a, bNoNl])
    const out: string[] = []
    for await (const r of iterateSessionFile(p)) {
      expect(r.ok).toBe(true)
      if (!r.ok) throw new Error("unreachable")
      out.push((r.value as SessionMetaRecord).session_id)
    }
    expect(out).toEqual(["a", "b"])
  })

  test("skips blank separator lines but surfaces a malformed line as a Result", async () => {
    const good = encodeSessionLine(meta("ok"))
    const p = writeLines([good, "\n", "{not json}\n", good])
    let goodCount = 0
    let badCount = 0
    for await (const r of iterateSessionFile(p)) {
      if (r.ok) goodCount += 1
      else badCount += 1
    }
    expect(goodCount).toBe(2)
    expect(badCount).toBe(1)
  })

  test("throws on missing file", async () => {
    const p = join(dir, "does-not-exist.jsonl")
    let threw = false
    try {
      for await (const _ of iterateSessionFile(p)) {
        // unreachable
      }
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  test("handles CRLF line endings", async () => {
    const a = encodeSessionLine(meta("a")).slice(0, -1) // strip LF
    const b = encodeSessionLine(meta("b")).slice(0, -1)
    const p = writeLines([`${a}\r\n${b}\r\n`])
    const out: string[] = []
    for await (const r of iterateSessionFile(p)) {
      if (!r.ok) throw new Error(`unexpected bad line: ${r.error.message}`)
      out.push((r.value as SessionMetaRecord).session_id)
    }
    expect(out).toEqual(["a", "b"])
  })

  test("an empty file yields nothing", async () => {
    const p = writeLines([])
    let any = false
    for await (const _ of iterateSessionFile(p)) any = true
    expect(any).toBe(false)
  })
})
