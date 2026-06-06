/**
 * jun-7 TLS-MITM — STREAMING body-cap DoS hellgate (cycle-2 adversarial audit).
 *
 * FINDING (fixed): the MITM decrypted-request parse path (`parseTlsRequest`)
 * buffered the ENTIRE decrypted HTTPS body into memory BEFORE consulting
 * `maxBodyBytes`, while the plaintext path (`bufferBody`) had a STREAMING cap.
 * A hostile huge HTTPS body could therefore OOM the proxy under MITM — a
 * memory-DoS the plaintext path never had. The fix hoists ONE streaming-cap
 * reader (`readCappedBody`) shared by BOTH paths.
 *
 * This battery proves the streaming cap directly (runtime-agnostic — no TLS):
 *   - over-cap ⇒ the overflow is NEVER retained (body released, `overCap` flag),
 *   - at/under cap ⇒ buffered fully,
 *   - a flood of chunks past the cap leaves a BOUNDED (empty) buffer — the DoS
 *     guard — regardless of how much was streamed.
 */

import { describe, expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import { readCappedBody } from "@/runtime/network-proxy"

/** Drive a PassThrough as the byte stream `readCappedBody` reads. */
const feed = async (cap: number, chunks: string[]): Promise<{ len: number; overCap: boolean }> => {
  const s = new PassThrough()
  const p = readCappedBody(s, cap)
  for (const c of chunks) s.write(Buffer.from(c))
  s.end()
  const { body, overCap } = await p
  return { len: body.length, overCap }
}

describe("readCappedBody — streaming DoS cap", () => {
  test("under the cap ⇒ buffered fully, not over-cap", async () => {
    const r = await feed(1024, ["hello", "=world"])
    expect(r.overCap).toBe(false)
    expect(r.len).toBe(11)
  })

  test("exactly at the cap ⇒ buffered, not over-cap (boundary inclusive)", async () => {
    const r = await feed(8, ["abcd", "efgh"]) // 8 bytes == cap
    expect(r.overCap).toBe(false)
    expect(r.len).toBe(8)
  })

  test("one byte over the cap ⇒ over-cap, overflow RELEASED (body empty)", async () => {
    const r = await feed(8, ["abcd", "efghi"]) // 9 bytes > 8
    expect(r.overCap).toBe(true)
    expect(r.len).toBe(0) // the partial body is NOT retained
  })

  test("FLOOD past the cap ⇒ bounded memory (body empty), never the full payload", async () => {
    // 1000 chunks of 1 KiB each = ~1 MB streamed; with a 64-byte cap the resolved
    // buffer is EMPTY — the proxy never holds the megabyte (the DoS guard).
    const chunks = Array.from({ length: 1000 }, () => "x".repeat(1024))
    const r = await feed(64, chunks)
    expect(r.overCap).toBe(true)
    expect(r.len).toBe(0)
  })

  test("over-cap on the FIRST chunk ⇒ over-cap immediately (no accumulation)", async () => {
    const r = await feed(4, ["this-single-chunk-is-already-too-big"])
    expect(r.overCap).toBe(true)
    expect(r.len).toBe(0)
  })
})
