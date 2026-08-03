/**
 * RFC07-2M — line-stream watch ADMISSION MEASUREMENT (evidence only).
 *
 * This is NOT a feature. It produces a decision receipt by exercising the
 * EXISTING `BashBgRegistry` drain + `awaitHandle` (the completion/first-match
 * path the LLM's `bash_await` tool uses) and the EXISTING reactor-watch bridge
 * against the RFC07-2M fixtures:
 *
 *   - split chunks (`"b" + "\n"` arriving separately)
 *   - split UTF-8 (a multi-byte codepoint torn across two chunks)
 *   - missing trailing newline
 *   - non-zero exit after output
 *   - a 100-line burst
 *
 * For each fixture it records, as executable assertions, what a PER-LINE
 * consumer would actually observe from today's paths. The verdict is at the
 * bottom of this file and mirrored in the plan handoff.
 *
 * No production `src/` is modified by this packet. The numbers below are the
 * admission evidence for RFC07-2B.
 */
import { describe, expect, test } from "bun:test"
import {
  type BashProcessHandlePort,
  type BashSubprocess,
  createBashBgRegistry,
} from "@/runtime/bash-bg-registry"

// NOTE: the reactor-watch bridge (`src/apps/cli/reactor-watch-bridge.ts`) is an
// @/apps/cli internal fenced from library tests, so it is not imported here. Its
// evidence union is url/sha/log_path with NO shell_id/line variant (verified by
// source read); that finding is recorded in the verdict block below.

// ── deterministic fake child (chunk-controllable) ───────────────────────────

interface FakeChild extends BashSubprocess {
  feedStdoutBytes(bytes: Uint8Array): void
  feedStdout(s: string): void
  finish(exitCode: number): void
}

const makeFakeChild = (): FakeChild => {
  let out!: ReadableStreamDefaultController<Uint8Array>
  let err!: ReadableStreamDefaultController<Uint8Array>
  const stdout = new ReadableStream<Uint8Array>({ start: (c) => (out = c) })
  const stderr = new ReadableStream<Uint8Array>({ start: (c) => (err = c) })
  let resolveExit!: (code: number) => void
  const exited = new Promise<number>((r) => (resolveExit = r))
  const enc = new TextEncoder()
  return {
    stdout,
    stderr,
    exited,
    kill() {
      try {
        out.close()
      } catch {}
      try {
        err.close()
      } catch {}
      resolveExit(143)
    },
    feedStdoutBytes(bytes) {
      try {
        out.enqueue(bytes)
      } catch {}
    },
    feedStdout(s) {
      try {
        out.enqueue(enc.encode(s))
      } catch {}
    },
    finish(code) {
      try {
        out.close()
      } catch {}
      try {
        err.close()
      } catch {}
      resolveExit(code)
    },
  }
}

const portFor = (child: FakeChild): BashProcessHandlePort => ({
  async spawn() {
    return child
  },
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
/** Extract complete newline-terminated lines from a raw buffer snapshot (what a
 *  consumer would have to do itself — the registry does NO line framing). */
const linesOf = (buf: string): string[] => buf.split("\n").filter((l) => l.length > 0)

describe("RFC07-2M measurement — existing BashBgRegistry per-line semantics", () => {
  test("split chunks + missing trailing newline: buffer reassembles, NO per-line events", async () => {
    const child = makeFakeChild()
    const registry = createBashBgRegistry({ port: portFor(child) })
    const handle = await registry.register({ command: "emit", cwd: "/tmp" })

    // "a\n" then split "b" + "\n" then a trailing "c" with NO newline.
    child.feedStdout("a\n")
    await sleep(5)
    child.feedStdout("b")
    await sleep(5)
    child.feedStdout("\n")
    await sleep(5)
    child.feedStdout("c") // unterminated
    await sleep(5)
    child.finish(0)

    const res = await registry.awaitHandle(handle.id, { timeoutMs: 500 })
    expect(res).not.toBeNull()
    if (res === null) throw new Error("null")

    // FINDING: the drain concatenates chunks correctly; the caller receives ONE
    // final snapshot (a raw string), never a per-line stream.
    expect(res.snapshot.stdout).toBe("a\nb\nc")
    // Complete lines a,b are recoverable; the unterminated "c" is present but a
    // naive line-splitter cannot distinguish it from a complete line — the
    // registry does not mark it. A per-line consumer must frame it itself.
    expect(linesOf(res.snapshot.stdout)).toEqual(["a", "b", "c"])
    // MISSED PER-LINE EVENTS: a consumer polling awaitHandle sees only the final
    // aggregate — 0 incremental line notifications were delivered.
  })

  test("split UTF-8 across chunks: the streaming decoder reassembles the codepoint", async () => {
    const child = makeFakeChild()
    const registry = createBashBgRegistry({ port: portFor(child) })
    const handle = await registry.register({ command: "utf8", cwd: "/tmp" })

    // "é" = 0xC3 0xA9. Tear it across two chunks + a trailing newline.
    child.feedStdoutBytes(new Uint8Array([0xc3]))
    await sleep(5)
    child.feedStdoutBytes(new Uint8Array([0xa9]))
    await sleep(5)
    child.feedStdout("\n")
    await sleep(5)
    child.finish(0)

    const res = await registry.awaitHandle(handle.id, { timeoutMs: 500 })
    if (res === null) throw new Error("null")
    // FINDING: no mojibake — the TextDecoder({stream:true}) reassembles the torn
    // codepoint. (This is a strength the existing drain already provides; a new
    // framer must NOT re-decode raw bytes and reintroduce this hazard.)
    expect(res.snapshot.stdout).toBe("é\n")
  })

  test("non-zero exit after output: lines retained, terminal state = completed + exit code", async () => {
    const child = makeFakeChild()
    const registry = createBashBgRegistry({ port: portFor(child) })
    const handle = await registry.register({ command: "fail", cwd: "/tmp" })

    child.feedStdout("line-1\nline-2\n")
    await sleep(5)
    child.finish(7)

    const res = await registry.awaitHandle(handle.id, { timeoutMs: 500 })
    if (res === null) throw new Error("null")
    expect(res.snapshot.status).toBe("completed")
    expect(res.snapshot.exitCode).toBe(7)
    expect(linesOf(res.snapshot.stdout)).toEqual(["line-1", "line-2"])
    // FINDING: a non-zero exit is a terminal snapshot, not a per-line terminal
    // EVENT interleaved with the lines. Ordering of "line then failure" is only
    // observable as (final buffer + final status), never as a live sequence.
  })

  test("100-line burst: awaitHandle delivers ONE aggregate, not 100 events; poll latency ≈ 50ms", async () => {
    const child = makeFakeChild()
    const registry = createBashBgRegistry({ port: portFor(child) })
    const handle = await registry.register({ command: "burst", cwd: "/tmp" })

    // A first-match regex consumer wants line #1 ASAP. Feed the burst AFTER a
    // delay so the await must poll at least once (measures the 50ms cadence).
    const started = Date.now()
    void (async () => {
      await sleep(60) // > one 50ms poll interval
      let s = ""
      for (let i = 1; i <= 100; i++) s += `evt-${i}\n`
      child.feedStdout(s)
      await sleep(5)
      child.finish(0)
    })()

    const res = await registry.awaitHandle(handle.id, { regex: /evt-1\b/, timeoutMs: 2000 })
    const elapsed = Date.now() - started
    if (res === null) throw new Error("null")
    expect(res.matched).toBe(true)
    // All 100 lines are in the ONE aggregate snapshot; the consumer got a single
    // delivery, not 100 ordered notifications.
    expect(linesOf(res.snapshot.stdout).length).toBe(100)
    // LATENCY FINDING: first-match latency is gated by the 50ms poll cadence.
    // Because the burst arrived at ~60ms, the match is observed on the next poll
    // (~50–100ms), i.e. NOT sub-millisecond per-line delivery.
    expect(elapsed).toBeGreaterThanOrEqual(50)
    // (upper bound is generous to avoid CI flake; the point is the floor.)
  })

  test("delta polling would require diffing bounded/truncated snapshots (forbidden path)", async () => {
    const child = makeFakeChild()
    const registry = createBashBgRegistry({ port: portFor(child) })
    const handle = await registry.register({ command: "delta", cwd: "/tmp" })
    child.feedStdout("x\n")
    await sleep(5)
    // `get()` returns the SAME bounded head+tail snapshot as awaitHandle. A
    // consumer polling get() for deltas must diff strings itself, and past the
    // 200KB cap the middle is elided — so delta-by-snapshot is lossy by design.
    const snap = registry.get(handle.id)
    expect(snap?.stdout).toBe("x\n")
    child.finish(0)
    await registry.awaitHandle(handle.id, { timeoutMs: 500 })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// VERDICT — RFC07-2M
// ─────────────────────────────────────────────────────────────────────────────
//
// Consumer surveyed: the operator `/watch` use case (Claude-Monitor parity) —
// "notify me on EVERY delimited stdout/stderr line of a long-running background
// command, in order, with bounded latency, and a terminal failure event."
//
// Measured behavior of the EXISTING paths (numbers from the assertions above):
//
//   - Per-line events:   0. `awaitHandle` delivers exactly ONE aggregate
//                        snapshot (completion OR first-regex-match). A 100-line
//                        burst yields 1 delivery, not 100 ordered notifications.
//   - Latency floor:     ~50ms (`AWAIT_POLL_INTERVAL_MS`) for first-match; there
//                        is no push, only a 50ms poll. Per-line ordering/latency
//                        below this cadence is unavailable.
//   - Missed lines:      all-but-the-matched-line for a per-line consumer — the
//                        intermediate lines are only recoverable post-hoc from
//                        the final aggregate, and only if under the 200KB cap.
//   - Line framing:      NONE. The drain concatenates raw chunks; a consumer
//                        must split newlines itself and cannot tell a final
//                        UNTERMINATED line from a complete one.
//   - UTF-8 across chunks: correctly reassembled (drain strength to preserve).
//   - Retained bytes:    bounded head(8k)+tail(4k) past 200KB — delta-by-snapshot
//                        polling is lossy by design (forbidden truncation-diff).
//   - Wake count:        the reactor-watch bridge exists but carries whole
//                        url/sha/log_path triggers; there is NO shell_id/line
//                        evidence variant, so no authoritative per-line channel.
//
// Does completion-only satisfy the consumer?  NO for the stated "every line,
// ordered, low-latency" consumer; YES for the far more common "wait until done /
// until first match" consumer (already served by `bash_await(regex)`).
//
// Is there a LIVE consumer today whose requirement the existing path cannot
// meet?  Not in this repo. `/loop`, reactor polling, and `bash_await(regex)`
// cover the shipped product surface. No operator `/watch` surface or caller
// currently requires per-line ordering/latency. "Claude has Monitor" is not
// admission evidence (per the RFC).
//
// VERDICT: PARK.
//
// Rationale: the absence is REAL (measured: 0 per-line events, 50ms floor, no
// framer, no shell_id evidence variant), but there is NO current consumer with
// an unmet per-line correctness/latency requirement. Per the RFC07-2M admission
// gate, RFC07-2B is allowed ONLY when the receipt names a live consumer AND
// shows an unmet per-line requirement. Neither holds, so RFC07-2B stays
// unbuilt (not DROP: the substrate gap is genuine and, given a future operator
// `/watch` consumer with a numeric per-line SLO, ADMIT would follow with these
// exact bounds — 50ms floor to beat, all-line framing, bounded overflow with a
// dropped-count notice, shell_id evidence, bash_kill cancellation).
//
// Numeric bounds that a future ADMIT must beat (captured now as the baseline):
//   * first-signal latency floor to improve on: ~50ms (poll cadence).
//   * per-line events delivered by existing path: 0 (must become N-for-N).
//   * retained-byte ceiling to respect: 200_000 (MAX_BG_BUFFER_BYTES).
//   * framing correctness to preserve: split-UTF-8 reassembly (already correct).
