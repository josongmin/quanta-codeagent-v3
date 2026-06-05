/**
 * Hellgate (Round-5 competitor-differential) for N6 PTY `pty_read` output cap.
 *
 * GAP: `capOutput` head+tail-truncates a model-facing pane snapshot at a FIXED
 * UTF-16 code-unit index. A naive `String.slice` at an arbitrary index can cut a
 * surrogate PAIR (an astral char — emoji / CJK-ext) in half, emitting a LONE
 * surrogate. When the transcript is serialized to the model that re-encodes to a
 * U+FFFD replacement char (or a malformed token) — a real corruption mid-token.
 *
 * COMPETITOR PRECEDENT: Codex decodes child-PTY bytes via Rust
 * `String::from_utf8_lossy`; a Rust `String` is well-formed UTF-8 by construction
 * and can never carry a lone surrogate. We mirror that "the model only ever sees
 * a well-formed string" guarantee by snapping both cut points off a surrogate
 * boundary. These cases drive the EXACT straddle points and assert no lone
 * surrogate survives (`isWellFormed()`), then re-confirm the happy path.
 */

import { describe, expect, test } from "bun:test"
import type { ToolContext, ToolEvent } from "@/tool"
import {
  type AttachResult,
  type PtyChunk,
  type PtyHandle,
  type PtyHandleInfo,
  type PtyResult,
  type PtySessionPort,
  ptyTools,
  type ReadResult,
} from "@/tool/pty"

const ctx = (): ToolContext =>
  ({ cwd: "/repo", signal: new AbortController().signal }) as ToolContext

/** Backend whose `read` returns ONE chunk = the whole supplied string. */
const mkPort = (payload: string): PtySessionPort => ({
  list: async (): Promise<readonly PtyHandleInfo[]> => [],
  attach: async (handle: PtyHandle): Promise<PtyResult<AttachResult>> => ({
    ok: true,
    value: { handle, cursor: 0 },
  }),
  write: async (): Promise<PtyResult<void>> => ({ ok: true, value: undefined }),
  read: async (): Promise<PtyResult<ReadResult>> => ({
    ok: true,
    value: { chunks: [{ seq: 1, data: payload } satisfies PtyChunk], nextSeq: 1 },
  }),
  resize: async (): Promise<PtyResult<void>> => ({ ok: true, value: undefined }),
  detach: async (): Promise<PtyResult<void>> => ({ ok: true, value: undefined }),
  kill: async (): Promise<PtyResult<void>> => ({ ok: true, value: undefined }),
})

const readBody = async (payload: string): Promise<string> => {
  const ptyRead = ptyTools(mkPort(payload)).find((t) => t.name === "pty_read")
  if (ptyRead === undefined) throw new Error("pty_read tool missing")
  let out = ""
  for await (const ev of ptyRead.execute(
    { handle: "tmux:quanta-a" } as never,
    ctx(),
  ) as AsyncIterable<ToolEvent>) {
    if (ev.type === "result") out = ev.result.output
  }
  return out
}

/** Count UTF-16 code units in `out` that are unpaired surrogates. */
const loneSurrogates = (out: string): number => {
  let n = 0
  for (let i = 0; i < out.length; i++) {
    const c = out.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = out.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) n++
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      const prev = out.charCodeAt(i - 1)
      if (!(prev >= 0xd800 && prev <= 0xdbff)) n++
    }
  }
  return n
}

// PTY_MAX_READ_OUTPUT = 32 KiB ⇒ keep = 16384 code units off each end.
const KEEP = 16 * 1024
const EMOJI = "\u{1F600}" // U+1F600 GRINNING FACE — one surrogate PAIR (2 units).

describe("pty_read output cap is UTF-16 surrogate-safe (Round-5 differential)", () => {
  test("a surrogate pair straddling the HEAD cut is not split into a lone surrogate", async () => {
    // Place the emoji so its HIGH half is at index KEEP-1 and LOW half at KEEP:
    // a naive slice(0, KEEP) would emit the high half alone.
    const payload = `${"a".repeat(KEEP - 1)}${EMOJI}${"b".repeat(40_000)}`
    const out = await readBody(payload)
    expect(out.length).toBeGreaterThan(0)
    expect(loneSurrogates(out)).toBe(0)
    expect(out.isWellFormed()).toBe(true)
  })

  test("a surrogate pair straddling the TAIL cut is not split into a lone surrogate", async () => {
    // Build a tail so the emoji's LOW half is the first kept tail unit: a naive
    // slice(length - KEEP) would lead with that lone low half.
    const tail = `${EMOJI}${"b".repeat(KEEP - 1)}` // emoji = 2 units, then KEEP-1 ⇒ low half at start
    const payload = `${"a".repeat(40_000)}${tail}`
    const out = await readBody(payload)
    expect(loneSurrogates(out)).toBe(0)
    expect(out.isWellFormed()).toBe(true)
  })

  test("a dense run of emoji across both cuts yields a fully well-formed payload", async () => {
    const payload = EMOJI.repeat(60_000) // 120k code units, all astral, far over cap
    const out = await readBody(payload)
    expect(loneSurrogates(out)).toBe(0)
    expect(out.isWellFormed()).toBe(true)
    expect(out).toContain("truncated")
  })

  test("happy path: under-cap payload passes through byte-identically (no truncation)", async () => {
    const payload = `hello ${EMOJI} world`
    const out = await readBody(payload)
    expect(out.startsWith(payload)).toBe(true)
    expect(out).not.toContain("truncated")
    expect(out.isWellFormed()).toBe(true)
  })
})
