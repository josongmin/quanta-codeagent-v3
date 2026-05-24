/**
 * W3C Trace Context propagator (ADR-0186).
 *
 * Implements the `traceparent` header per https://www.w3.org/TR/trace-context/.
 *
 *   traceparent = ${version}-${trace-id}-${parent-id}-${trace-flags}
 *
 *   - version    : 2 hex chars (only "00" recognized today; future versions
 *                  per the spec are forward-compatible — receivers MUST NOT
 *                  reject unknown versions outright, but MAY ignore them.
 *                  We implement strict "00" — the only one ever shipped).
 *   - trace-id   : 32 hex chars (16 bytes / 128 bits). All-zero is invalid
 *                  per spec (reserved as the "no trace" sentinel).
 *   - parent-id  : 16 hex chars (8 bytes / 64 bits). All-zero is invalid.
 *   - trace-flags: 2 hex chars (1 byte). Bit 0 = sampled.
 *
 * `tracestate` is a separate header (vendor-specific extensions, list of
 * key=value pairs). This adapter does NOT carry it — our `SpanContext` is a
 * 3-field struct and tracestate would require expanding the surface. Future
 * follow-up if vendor integrations need it.
 *
 * No-throw: malformed input always returns `null` rather than throwing. A
 * misbehaving upstream that sends garbage in `traceparent` should not crash
 * the receiving process — they just don't get parent-child trace continuity.
 *
 * Plane-clean: imports ONLY `./port`.
 */

import type { SpanContext, TraceContextPropagator } from "./port"

/** W3C spec version we implement. */
const VERSION = "00"

/** Lowercase hex regex — `[0-9a-f]+`. Tracecontext spec says lowercase only
 *  for emission; we accept either case on parse and lowercase before storage
 *  (some upstreams emit mixed case despite the spec, and rejecting them
 *  loses traces unnecessarily). */
const HEX_RE = /^[0-9a-f]+$/i

/** Check a string is `byteCount * 2` hex chars AND not all zeros (W3C
 *  reserves all-zero IDs as "invalid"). */
const isValidHex = (s: string, expectedChars: number): boolean => {
  if (s.length !== expectedChars) return false
  if (!HEX_RE.test(s)) return false
  // All-zero rejection (W3C "invalid" sentinel).
  if (/^0+$/.test(s)) return false
  return true
}

/** Validated W3C traceparent emitter. */
const formatTraceparent = (ctx: SpanContext): string => {
  // padStart guards against a caller handing us a single-digit flag value
  // (e.g. 1 instead of "01"); the spec mandates 2 hex chars exactly.
  // & 0xff clamps to one byte per spec ("only bits 0..7 are defined").
  const flagsHex = (ctx.traceFlags & 0xff).toString(16).padStart(2, "0")
  return `${VERSION}-${ctx.traceId}-${ctx.spanId}-${flagsHex}`
}

/** Parse a `traceparent` header string. Returns null on any shape mismatch
 *  per the no-throw contract. */
const parseTraceparent = (raw: string): SpanContext | null => {
  // W3C says: split on `-` and require exactly 4 segments.
  const parts = raw.trim().split("-")
  if (parts.length !== 4) return null
  const [versionRaw, traceIdRaw, spanIdRaw, flagsRaw] = parts
  if (
    versionRaw === undefined ||
    traceIdRaw === undefined ||
    spanIdRaw === undefined ||
    flagsRaw === undefined
  ) {
    return null
  }
  // Version: strictly "00" today. Unknown versions per spec MAY be ignored
  // — we choose to reject so callers get clear null rather than a partial
  // parse against an unrelated future format.
  if (versionRaw.toLowerCase() !== VERSION) return null
  // Trace ID: 32 hex chars, not all zero.
  if (!isValidHex(traceIdRaw, 32)) return null
  // Span ID: 16 hex chars, not all zero.
  if (!isValidHex(spanIdRaw, 16)) return null
  // Flags: 2 hex chars (full hex check is fine — flags CAN be "00" since
  // un-sampled is a valid state, unlike trace/span IDs).
  if (flagsRaw.length !== 2 || !HEX_RE.test(flagsRaw)) return null
  const flags = Number.parseInt(flagsRaw, 16)
  if (!Number.isFinite(flags) || flags < 0 || flags > 0xff) return null
  return {
    traceId: traceIdRaw.toLowerCase(),
    spanId: spanIdRaw.toLowerCase(),
    traceFlags: flags,
  }
}

/** Public W3C `TraceContextPropagator`. */
export const w3cTraceContextPropagator: TraceContextPropagator = {
  inject(ctx, carrier) {
    try {
      carrier.traceparent = formatTraceparent(ctx)
    } catch {
      // No-throw — defensive against frozen / hostile carrier objects.
    }
  },
  extract(carrier) {
    try {
      // Header names are case-insensitive per HTTP semantics; common
      // upstreams emit lowercase. We check both shapes a caller might
      // hand us (lowercase + capitalized) without iterating all keys
      // (cheap defensive read, not a full case-fold scan).
      const raw = carrier.traceparent ?? carrier.Traceparent ?? carrier.TraceParent
      if (typeof raw !== "string" || raw.length === 0) return null
      return parseTraceparent(raw)
    } catch {
      return null
    }
  },
}
