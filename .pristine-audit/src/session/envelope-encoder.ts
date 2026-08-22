/**
 * Session JSONL envelope — encode / decode / stream.
 *
 * Determinism contract:
 *   - `encodeSessionLine` emits ONE JSON object terminated by exactly one `\n`.
 *   - Object keys are sorted alphabetically at every nesting level so two
 *     semantically-equal records produce byte-identical wire forms (cf.
 *     ADR-0023 byte-identical replay invariant).
 *   - No trailing whitespace, no pretty-print, no BOM.
 *
 * Failure contract:
 *   - `decodeSessionLine` NEVER throws. Bad JSON, schema failures, blank
 *     lines, BOM, CRLF, all surface as `err(...)`.
 *   - `iterateSessionFile` yields one `Result` per logical line. The CALLER
 *     decides whether to stop, log, or skip on a bad line — we do NOT
 *     silently swallow.
 */
import { open } from "node:fs/promises"
import { errMessage } from "@/shared"
import { err, ok, type Result } from "@/shared/types"
import { type SessionEnvelopeRecord, SessionEnvelopeRecordSchema } from "./envelope"

export type EnvelopeDecodeErrorKind = "parse_json" | "schema" | "empty_line"

export class EnvelopeDecodeError extends Error {
  readonly kind: EnvelopeDecodeErrorKind
  readonly issues: readonly string[]
  readonly raw: string
  constructor(
    kind: EnvelopeDecodeErrorKind,
    message: string,
    raw: string,
    issues: readonly string[] = [],
  ) {
    super(message)
    this.name = "EnvelopeDecodeError"
    this.kind = kind
    this.raw = raw
    this.issues = issues
  }
}

/* ------------------------------------------------------------------ */
/* canonical JSON                                                      */
/* ------------------------------------------------------------------ */

/** Stringify with alphabetically-sorted keys at every depth. Arrays preserve
 *  their original element order (positional semantics). Re-implements the
 *  subset of JSON.stringify we need; uses JSON.stringify for primitives so
 *  string escaping is spec-correct. */
const stringifyCanonical = (value: unknown): string => {
  if (value === null) return "null"
  const t = typeof value
  if (t === "number") {
    if (!Number.isFinite(value as number)) {
      throw new TypeError("envelope-encoder: non-finite number cannot be serialised to JSON")
    }
    return JSON.stringify(value)
  }
  if (t === "string" || t === "boolean") return JSON.stringify(value)
  if (t === "bigint") {
    throw new TypeError("envelope-encoder: bigint is not JSON-serialisable")
  }
  if (t === "undefined" || t === "function" || t === "symbol") {
    // Same as JSON.stringify behavior: these are not legal JSON values. We
    // throw rather than silently elide so a programmer error fails loud.
    throw new TypeError(`envelope-encoder: value of type ${t} is not JSON-serialisable`)
  }
  if (Array.isArray(value)) {
    return `[${value.map(stringifyCanonical).join(",")}]`
  }
  // plain object — sort keys alphabetically
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  const parts: string[] = []
  for (const k of keys) {
    const v = obj[k]
    if (v === undefined) continue // mirror JSON.stringify: drop undefined object props
    parts.push(`${JSON.stringify(k)}:${stringifyCanonical(v)}`)
  }
  return `{${parts.join(",")}}`
}

/* ------------------------------------------------------------------ */
/* encode / decode                                                     */
/* ------------------------------------------------------------------ */

export const encodeSessionLine = (record: SessionEnvelopeRecord): string => {
  // Strict re-validate to catch any caller passing a partially-built record.
  const v = SessionEnvelopeRecordSchema.safeParse(record)
  if (!v.success) {
    throw new TypeError(
      `encodeSessionLine: record failed schema validation — ${v.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
    )
  }
  return `${stringifyCanonical(v.data)}\n`
}

const stripBom = (s: string): string => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s)
const stripCr = (s: string): string => (s.endsWith("\r") ? s.slice(0, -1) : s)

export const decodeSessionLine = (
  line: string,
): Result<SessionEnvelopeRecord, EnvelopeDecodeError> => {
  const raw = stripCr(stripBom(line))
  if (raw.length === 0) {
    return err(new EnvelopeDecodeError("empty_line", "envelope line is empty", line))
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    const msg = errMessage(e)
    return err(new EnvelopeDecodeError("parse_json", `invalid JSON: ${msg}`, line))
  }
  const v = SessionEnvelopeRecordSchema.safeParse(parsed)
  if (!v.success) {
    return err(
      new EnvelopeDecodeError(
        "schema",
        "envelope failed schema validation",
        line,
        v.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
      ),
    )
  }
  return ok(v.data)
}

/* ------------------------------------------------------------------ */
/* streaming iterator                                                  */
/* ------------------------------------------------------------------ */

/** Read `path` line-by-line and yield one `Result<Record, …>` per non-empty
 *  line. A final line without a trailing newline is still yielded (real
 *  truncated logs frequently end mid-write). Empty lines (just `\n`) are
 *  silently elided — they are not user data, they are JSONL separators.
 *
 *  Caller chooses the behavior on a bad line by inspecting the `Result`. */
export async function* iterateSessionFile(
  path: string,
): AsyncIterable<Result<SessionEnvelopeRecord, EnvelopeDecodeError>> {
  const file = Bun.file(path)
  if (!(await file.exists())) {
    throw new Error(`iterateSessionFile: file not found: ${path}`)
  }
  // Use Bun's streaming reader (chunks of bytes) and split on \n manually so
  // CR/BOM normalisation lives in one place (decodeSessionLine).
  const stream = file.stream()
  const decoder = new TextDecoder("utf-8", { fatal: false })
  let buffer = ""
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true })
    let nl = buffer.indexOf("\n")
    while (nl !== -1) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      if (line.length > 0 && stripCr(line).length > 0) {
        yield decodeSessionLine(line)
      }
      nl = buffer.indexOf("\n")
    }
  }
  buffer += decoder.decode()
  if (buffer.length > 0 && stripCr(buffer).length > 0) {
    yield decodeSessionLine(buffer)
  }
}

/* ------------------------------------------------------------------ */
/* atomic append (used by store.ts seam)                               */
/* ------------------------------------------------------------------ */

/** Append one already-encoded line to `path`. Uses POSIX `O_APPEND` for
 *  atomicity on a single write — multiple processes appending concurrently
 *  do not interleave their lines (cf. POSIX.1-2017 `write()` semantics on
 *  files opened with O_APPEND). */
export const appendSessionLine = async (path: string, encoded: string): Promise<void> => {
  if (!encoded.endsWith("\n")) {
    throw new TypeError("appendSessionLine: encoded line must end with a newline")
  }
  const fh = await open(path, "a")
  try {
    await fh.write(encoded)
  } finally {
    await fh.close()
  }
}
