/**
 * W5 DAP — Debug Adapter Protocol wire codec.
 *
 * DAP (like LSP) frames each JSON message as:
 *
 *     Content-Length: <N>\r\n\r\n<body>
 *
 * where N is the **UTF-8 byte length** of the body (NOT its character count).
 * The transport is a raw byte stream (a debug adapter's stdout), so a single
 * read can deliver a partial frame, several frames, or a frame split mid-header
 * or mid-multibyte-character. The decoder below is the single hardened place
 * that turns that byte soup into whole parsed messages — pure, stateful, and
 * NEVER-throwing (a malformed header/body is skipped, the stream recovers).
 */

const SEP = "\r\n\r\n"
const SEP_BYTES = Buffer.from(SEP, "utf8")

/** Encode a DAP message to its on-wire framed form. */
export const encodeDapMessage = (msg: unknown): string => {
  const body = JSON.stringify(msg)
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`
}

/**
 * Incremental, byte-accurate DAP frame decoder. Feed it raw chunks
 * (`string | Buffer`) as they arrive; each `push` returns the messages that
 * became COMPLETE on that chunk (0, 1, or many), in arrival order.
 */
export class DapFrameDecoder {
  /** Accumulated, not-yet-consumed bytes. */
  private buf: Buffer = Buffer.alloc(0)

  push(chunk: string | Buffer): unknown[] {
    const incoming = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk
    if (incoming.length > 0) this.buf = Buffer.concat([this.buf, incoming])
    const out: unknown[] = []
    // Drain every complete frame currently buffered.
    for (;;) {
      const sepIdx = this.buf.indexOf(SEP_BYTES)
      if (sepIdx === -1) return out // header not fully arrived yet
      const headerText = this.buf.subarray(0, sepIdx).toString("utf8")
      const len = parseContentLength(headerText)
      if (len === undefined) {
        // Malformed/absent Content-Length. RESYNC: drop to the next
        // `Content-Length:` marker (skipping any leftover body bytes that would
        // otherwise corrupt the following header); if there is no later marker,
        // discard through this separator. Either way the buffer shrinks ⇒ no
        // infinite loop, and a subsequent valid frame decodes.
        const next = nextHeaderMarker(this.buf)
        this.buf = next > 0 ? this.buf.subarray(next) : this.buf.subarray(sepIdx + SEP_BYTES.length)
        continue
      }
      const bodyStart = sepIdx + SEP_BYTES.length
      if (this.buf.length - bodyStart < len) return out // body still incomplete
      const bodyBytes = this.buf.subarray(bodyStart, bodyStart + len)
      this.buf = this.buf.subarray(bodyStart + len)
      try {
        out.push(JSON.parse(bodyBytes.toString("utf8")))
      } catch {
        // Non-JSON body — drop this frame, keep draining the rest of the buffer.
      }
    }
  }
}

/** Index of the next `Content-Length:` header marker at offset > 0, or -1. Used
 *  to resync the stream after a malformed frame. */
const CL_MARKER = Buffer.from("Content-Length:", "utf8")
const nextHeaderMarker = (buf: Buffer): number => {
  // Case-sensitive is fine: every real adapter emits the canonical casing, and
  // resync only needs to find a fresh frame boundary, not validate it.
  const idx = buf.indexOf(CL_MARKER, 1)
  return idx
}

/** Parse the integer Content-Length from a header block, or `undefined` if it
 *  is absent / non-numeric. Header lines are `Key: Value`, CRLF-separated. */
const parseContentLength = (header: string): number | undefined => {
  for (const line of header.split(/\r?\n/)) {
    const m = /^content-length:\s*(.*)$/i.exec(line.trim())
    if (m === null) continue
    const n = Number(m[1]?.trim())
    if (Number.isInteger(n) && n >= 0) return n
    return undefined // present but non-numeric ⇒ malformed
  }
  return undefined
}
