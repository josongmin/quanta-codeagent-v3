/**
 * Deterministic NDJSON line encoder (ADR-0468).
 *
 * Turns an {@link NdjsonEvent} into ONE newline-delimited-JSON line:
 *   - keys sorted lexicographically at every nesting level → byte-stable output
 *     across calls and across processes (two monitors diffing the stream see
 *     identical bytes for identical events; deterministic = testable + cacheable).
 *   - every control character is JSON-escaped, so an embedded `"\n"` in a string
 *     value becomes the two characters `\` `n` — it can NEVER split one logical
 *     event into two NDJSON records. This is THE correctness property of an
 *     NDJSON framing: the line separator must not appear raw inside a line.
 *   - no trailing newline — the writer/adapter owns the `\n` framing so the
 *     same encoder feeds a socket, a file tail, or an in-memory capture without
 *     double-framing.
 *
 * NO-THROW: values JSON cannot represent (`BigInt`, `function`, `symbol`, or a
 * circular reference) return `Err({kind:"encode-failed"})` rather than throwing.
 * `undefined` fields are dropped (JSON semantics); a top-level value that
 * collapses to `undefined` is itself an error (an event must encode to an
 * object).
 *
 * Plane-clean: imports ONLY `@/shared`. Pure — no clock, no IO, no randomness.
 */

import { err, errMessage, ok, type Result } from "@/shared"
import type { NdjsonEncoder, NdjsonEvent, NdjsonSinkError } from "./types"

/** Recursively rebuild `value` with object keys sorted, so `JSON.stringify`
 *  emits a byte-stable line. Arrays preserve order (their order is semantic).
 *  Returns the canonicalized value; throws only the sentinel below on a
 *  non-serializable leaf so the single outer try/catch can convert it to Err.
 *
 *  `seen` tracks the ancestor chain to detect circular references — a cycle is
 *  a programmer bug encoded as Err, never an infinite recursion. */
const NON_SERIALIZABLE = Symbol("ndjson-non-serializable")

class EncodeReject extends Error {
  constructor(readonly detail: string) {
    super(detail)
    this.name = "EncodeReject"
  }
}

/** A non-object marker the leaf handler returns to say "I produced a final
 *  value (or sentinel)". `null` is wrapped because it is itself a valid leaf. */
type LeafResult = { readonly done: true; readonly value: unknown } | { readonly done: false }

/** Handle every NON-object value (primitive / undefined / non-representable).
 *  Throws `EncodeReject` for values JSON cannot represent. Returns
 *  `{done:false}` when `value` is an object the caller must recurse into. */
const canonicalizeLeaf = (value: unknown): LeafResult => {
  if (value === null) return { done: true, value: null }
  const t = typeof value
  if (t === "string" || t === "boolean") return { done: true, value }
  if (t === "number") {
    // NaN / ±Infinity stringify to `null` silently — that is lossy and would
    // make the line ambiguous. Reject so the producer learns its number is
    // non-finite rather than shipping a `null` that looks like a real value.
    if (!Number.isFinite(value as number)) {
      throw new EncodeReject(`non-finite number: ${String(value)}`)
    }
    return { done: true, value }
  }
  // BigInt / function / symbol → not representable as a JSON value.
  if (t === "bigint" || t === "function" || t === "symbol") {
    throw new EncodeReject(`non-serializable ${t}`)
  }
  // Undefined leaves are dropped by JSON; the caller (object/array walker)
  // handles omission. Signal via the sentinel so callers can skip the key.
  if (value === undefined) return { done: true, value: NON_SERIALIZABLE }
  return { done: false }
}

const canonicalize = (value: unknown, seen: Set<object>): unknown => {
  const leaf = canonicalizeLeaf(value)
  if (leaf.done) return leaf.value

  // From here `value` is a non-null object.
  const obj = value as object
  if (seen.has(obj)) {
    throw new EncodeReject("circular reference")
  }
  seen.add(obj)
  try {
    if (Array.isArray(value)) {
      // Array order is semantic — preserve it. Undefined / non-serializable
      // elements stringify to `null` in JS arrays, so mirror that to stay
      // faithful to the value's own JSON shape.
      const out: unknown[] = []
      for (const el of value) {
        const c = canonicalize(el, seen)
        out.push(c === NON_SERIALIZABLE ? null : c)
      }
      return out
    }
    // Plain object (or class instance with a toJSON we deliberately do NOT
    // honor — toJSON could be non-deterministic; we canonicalize own
    // enumerable keys only). Sort keys for stable output.
    const rec = value as Record<string, unknown>
    const keys = Object.keys(rec).sort()
    const out: Record<string, unknown> = {}
    for (const k of keys) {
      const c = canonicalize(rec[k], seen)
      if (c === NON_SERIALIZABLE) continue // drop undefined fields (JSON semantics)
      out[k] = c
    }
    return out
  } finally {
    seen.delete(obj)
  }
}

/** The default deterministic encoder. Stateless + reusable across producers. */
export const defaultNdjsonEncoder: NdjsonEncoder = {
  encode(event: NdjsonEvent): Result<string, NdjsonSinkError> {
    try {
      const canonical = canonicalize(event, new Set<object>())
      if (
        canonical === NON_SERIALIZABLE ||
        typeof canonical !== "object" ||
        canonical === null ||
        Array.isArray(canonical)
      ) {
        // An event must encode to a JSON OBJECT (a routable record), not a
        // primitive, `null`, or a bare array. A monitor routes on the `type`
        // discriminator, so `[1,2]` or `"x"` is not a valid event — reject it
        // rather than ship a line no consumer can route. (canonicalize returns
        // the sentinel only for a top-level `undefined`. `typeof [] === "object"`,
        // so the explicit Array check is load-bearing — without it a top-level
        // array would silently pass.)
        return err({ kind: "encode-failed", reason: "event did not encode to an object" })
      }
      // JSON.stringify on the already-canonicalized tree cannot hit a cycle or
      // a non-serializable leaf (we converted/rejected them above); any
      // residual throw is still caught below.
      const line = JSON.stringify(canonical)
      // line is single-line by JSON spec: stringify escapes \n, \r, \t, and all
      // other control chars inside strings, so no raw newline survives. Assert
      // the framing invariant defensively (a non-throwing guard).
      if (line.includes("\n") || line.includes("\r")) {
        return err({ kind: "encode-failed", reason: "encoded line contained a raw newline" })
      }
      return ok(line)
    } catch (e) {
      const reason = e instanceof EncodeReject ? e.detail : errMessage(e)
      return err({ kind: "encode-failed", reason })
    }
  },
}

/** Construct an encoder. Returns the shared stateless default (there is no
 *  per-instance state); kept as a factory so a future variant — e.g. one that
 *  enforces a max line length — can swap in without call-site churn. */
export const createNdjsonEncoder = (): NdjsonEncoder => defaultNdjsonEncoder
