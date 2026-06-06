/**
 * jun-6/jun-7 — STREAMING body-cap reader, shared by the plaintext-HTTP path,
 * the node:tls MITM channel, and (indirectly) the Bun MITM bridge.
 *
 * Hoisted out of `loopback-proxy.ts` so the node:tls MITM channel adapter can
 * reuse the SAME cap discipline without importing the proxy (which would create
 * a cycle: channel ← proxy ← channel).
 */

/** A readable byte stream just wide enough for {@link readCappedBody} (both
 *  `http.IncomingMessage` and a TLS socket satisfy it). */
export interface ByteReadable {
  on(event: "data", cb: (chunk: Buffer) => void): unknown
  on(event: "end", cb: () => void): unknown
  on(event: "error", cb: (err: unknown) => void): unknown
}

/** The outcome of a STREAMING-capped body read: the buffered bytes (capped) +
 *  whether the stream went over the cap (the overflow is NOT retained). */
export interface CappedBody {
  readonly body: Buffer
  readonly overCap: boolean
}

/**
 * Read a request body with a STREAMING byte cap. Once the accumulated size
 * exceeds `cap`, we STOP accumulating (releasing what we held) and flag
 * `overCap` — so a hostile huge body can NEVER be fully buffered in memory
 * (the DoS guard). Resolves on `end` OR `error` (a truncated read is still
 * capped). Pure aside from the stream it drains; never throws.
 */
export const readCappedBody = (stream: ByteReadable, cap: number): Promise<CappedBody> =>
  new Promise((resolve) => {
    let chunks: Buffer[] = []
    let size = 0
    let overCap = false
    const finish = (): void =>
      resolve({ body: overCap ? Buffer.alloc(0) : Buffer.concat(chunks), overCap })
    stream.on("data", (c: Buffer) => {
      if (overCap) return
      size += c.length
      if (size > cap) {
        overCap = true
        chunks = [] // release what we held; the overflow is never scanned/forwarded
        return
      }
      chunks.push(c)
    })
    stream.on("end", finish)
    stream.on("error", finish)
  })
