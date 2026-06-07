import { describe, expect, test } from "bun:test"
import { createStdioTransport, type WireEnvelope } from "@/ipc"
import type { SessionTransportMessage } from "@/ipc/session"
import { createSessionStdioTransport, encodeSessionTransportMessage } from "@/ipc/session"

/**
 * U5-ipc-framing hellgate — unbounded line-buffer OOM (PROTOCOL_IPC).
 *
 * The stdio line-framing accumulates bytes until a `\n`. A peer that NEVER
 * sends a newline (malicious, wedged, or a half-written frame from a crashed
 * writer) would otherwise grow the buffer without bound → daemon OOM. The fix
 * adds a SAFETY ceiling (`MAX_FRAME_CHARS`, 32 MiB mirroring the LSP reader):
 * when the un-terminated trailing partial exceeds the cap, the transport tears
 * itself down and drops the buffer.
 *
 * These tests prove BOTH directions:
 *   - the adversarial case: an over-cap frame with no newline tears down (the
 *     transport stops accepting data, drops the buffer, and — for the bridge
 *     variant — notifies `onClose("error", ...)`); and
 *   - the happy path: a normal multi-chunk frame UNDER the cap still assembles.
 *
 * To exercise the 32 MiB ceiling without allocating ~32 MiB per assertion many
 * times, the over-cap chunk is built once and reused.
 */

const MAX_FRAME_CHARS = 32 * 1024 * 1024

/** A stream-pair fixture mirroring the production `StdioReader`/`StdioWriter`
 *  ports, with an `error` lifecycle channel and a `push` to feed `'data'`. */
const makeStreamPair = () => {
  let dataHandler: ((chunk: Buffer | string) => void) | undefined
  const errorHandlers = new Set<(arg?: unknown) => void>()
  const reader = {
    on(event: string, handler: (...args: never[]) => void) {
      if (event === "data") dataHandler = handler as (chunk: Buffer | string) => void
      else if (event === "error") errorHandlers.add(handler as (arg?: unknown) => void)
    },
    off(event: string, handler: (...args: never[]) => void) {
      if (event === "data" && dataHandler === handler) dataHandler = undefined
      else if (event === "error") errorHandlers.delete(handler as (arg?: unknown) => void)
    },
  }
  const written: string[] = []
  return {
    reader,
    writer: {
      write(chunk: string) {
        written.push(chunk)
        return true
      },
    },
    push(chunk: string) {
      dataHandler?.(chunk)
    },
    /** True once the transport detached its `'data'` listener (teardown ran). */
    get attached() {
      return dataHandler !== undefined
    },
    written,
  }
}

const overCapChunk = `${"x".repeat(MAX_FRAME_CHARS + 1)}` // no newline, one past the cap

describe("U5 stdio bridge transport: unbounded-frame DoS guard", () => {
  test("over-cap frame with no newline tears the transport down via onClose('error')", () => {
    const pair = makeStreamPair()
    const closes: Array<{ reason: string; detail?: unknown }> = []
    const t = createStdioTransport({
      reader: pair.reader,
      writer: pair.writer,
      onClose: (reason, detail) => closes.push({ reason, detail }),
    })
    const received: WireEnvelope[] = []
    t.onMessage((e) => received.push(e))

    expect(pair.attached).toBe(true)
    pair.push(overCapChunk)

    // Teardown fired: reaped exactly once as an error, listener detached.
    expect(closes).toHaveLength(1)
    expect(closes[0]?.reason).toBe("error")
    expect(closes[0]?.detail).toBeInstanceOf(Error)
    expect((closes[0]?.detail as Error).message).toBe("frame too large")
    expect(pair.attached).toBe(false)
    expect(received).toHaveLength(0)

    // Buffer was dropped: a subsequent newline-terminated valid frame is
    // ignored because the transport is closed (no leftover bytes resurface).
    const env: WireEnvelope = {
      protocol: "quanta.ipc.v1",
      source: "cli",
      sessionId: "s",
      payload: { type: "user_input", prompt: "after-teardown" },
      timestamp: "2026-06-03T00:00:00Z",
    }
    pair.push(`${JSON.stringify(env)}\n`)
    expect(received).toHaveLength(0)
    expect(closes).toHaveLength(1) // idempotent — no second close
  })

  test("normal multi-chunk frame UNDER the cap still re-assembles (happy path intact)", async () => {
    const pair = makeStreamPair()
    const t = createStdioTransport({ reader: pair.reader, writer: pair.writer })
    const received: WireEnvelope[] = []
    t.onMessage((e) => received.push(e))

    const env: WireEnvelope = {
      protocol: "quanta.ipc.v1",
      source: "cli",
      sessionId: "s",
      payload: { type: "user_input", prompt: "hi" },
      timestamp: "2026-06-03T00:00:00Z",
    }
    const wire = `${JSON.stringify(env)}\n`
    // Split mid-string across multiple data events.
    pair.push(wire.slice(0, 4))
    pair.push(wire.slice(4, 9))
    pair.push(wire.slice(9))

    expect(received).toEqual([env])
    expect(pair.attached).toBe(true) // still alive
    await t.close()
  })

  test("a large-but-under-cap partial does NOT trip the guard", () => {
    const pair = makeStreamPair()
    const closes: string[] = []
    const t = createStdioTransport({
      reader: pair.reader,
      writer: pair.writer,
      onClose: (reason) => closes.push(reason),
    })
    t.onMessage(() => undefined)

    // One byte under the cap, no newline yet — legitimate in-flight large frame.
    pair.push("y".repeat(MAX_FRAME_CHARS - 1))
    expect(closes).toHaveLength(0)
    expect(pair.attached).toBe(true)
  })
})

describe("U5 session stdio transport: unbounded-frame DoS guard", () => {
  test("over-cap frame with no newline tears the transport down and drops the buffer", () => {
    const pair = makeStreamPair()
    const t = createSessionStdioTransport({ reader: pair.reader, writer: pair.writer })
    const seen: SessionTransportMessage[] = []
    t.onMessage((m) => {
      seen.push(m)
    })

    expect(pair.attached).toBe(true)
    pair.push(overCapChunk)

    // Teardown ran: data listener detached, buffer dropped.
    expect(pair.attached).toBe(false)
    expect(seen).toHaveLength(0)

    // A subsequent valid frame is ignored (transport closed, no resurfacing).
    const wire = `${encodeSessionTransportMessage({
      kind: "connect",
      sessionId: "session-1",
    })}\n`
    pair.push(wire)
    expect(seen).toHaveLength(0)
  })

  test("normal multi-chunk frame UNDER the cap still assembles (happy path intact)", async () => {
    const pair = makeStreamPair()
    const t = createSessionStdioTransport({ reader: pair.reader, writer: pair.writer })
    const seen: SessionTransportMessage[] = []
    t.onMessage((m) => {
      seen.push(m)
    })

    const message: SessionTransportMessage = { kind: "connect", sessionId: "session-1" }
    const wire = `${encodeSessionTransportMessage(message)}\n`
    pair.push(wire.slice(0, 6))
    pair.push(wire.slice(6))

    expect(seen).toEqual([message])
    expect(pair.attached).toBe(true)
    await t.close()
  })
})
