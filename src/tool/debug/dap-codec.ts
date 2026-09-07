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
/** Bound retained protocol state from a buggy or hostile debug adapter. */
export const DAP_MAX_FRAME_BYTES = 32 * 1024 * 1024
export const DAP_MAX_HEADER_BYTES = 64 * 1024

/** Encode a DAP message to its on-wire framed form. */
export const encodeDapMessage = (msg: unknown): string => {
  const body = JSON.stringify(msg)
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`
}

type FrameProbe =
  | { readonly kind: "wait"; readonly buffer: Buffer }
  | { readonly kind: "skip"; readonly buffer: Buffer }
  | { readonly kind: "frame"; readonly body: Buffer; readonly buffer: Buffer }

/** Inspect one frame boundary without mutating decoder state. */
const probeFrame = (buf: Buffer): FrameProbe => {
  const sepIdx = buf.indexOf(SEP_BYTES)
  if (sepIdx === -1) {
    if (buf.length <= DAP_MAX_HEADER_BYTES) return { kind: "wait", buffer: buf }
    const recovered = resyncToNextHeader(buf, 1)
    return {
      kind: "wait",
      buffer: recovered.length <= DAP_MAX_HEADER_BYTES ? recovered : Buffer.alloc(0),
    }
  }
  if (sepIdx > DAP_MAX_HEADER_BYTES) {
    return { kind: "skip", buffer: resyncToNextHeader(buf, 1) }
  }
  const len = parseContentLength(buf.subarray(0, sepIdx).toString("utf8"))
  if (len === undefined) {
    return { kind: "skip", buffer: resyncToNextHeader(buf, 1) }
  }
  const bodyStart = sepIdx + SEP_BYTES.length
  if (len > DAP_MAX_FRAME_BYTES) {
    return { kind: "skip", buffer: resyncToNextHeader(buf, bodyStart) }
  }
  if (buf.length - bodyStart < len) return { kind: "wait", buffer: buf }
  return {
    kind: "frame",
    body: buf.subarray(bodyStart, bodyStart + len),
    buffer: buf.subarray(bodyStart + len),
  }
}

type JsonDecode = { readonly ok: true; readonly value: unknown } | { readonly ok: false }

const decodeJson = (body: Buffer): JsonDecode => {
  try {
    return { ok: true, value: JSON.parse(body.toString("utf8")) }
  } catch {
    return { ok: false }
  }
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
      const probe = probeFrame(this.buf)
      this.buf = probe.buffer
      if (probe.kind === "wait") return out
      if (probe.kind === "skip") continue
      const decoded = decodeJson(probe.body)
      if (decoded.ok) out.push(decoded.value)
    }
  }
}

/** Canonical header marker used only as a recovery boundary. */
const CL_MARKER = Buffer.from("Content-Length:", "utf8")

/** Retain bytes from the next canonical header marker, or clear the buffer. */
const resyncToNextHeader = (buf: Buffer, from: number): Buffer => {
  // Case-sensitive is fine: every real adapter emits canonical casing. This is
  // recovery, not validation; a false marker is bounded and rejected next pass.
  const idx = buf.indexOf(CL_MARKER, from)
  return idx >= 0 ? buf.subarray(idx) : Buffer.alloc(0)
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
