/**
 * Type-safe attribute builder over the canonical vocabulary.
 *
 * Emitters should never compose raw `Record<string, unknown>` attribute
 * objects: typos and stray keys would slip past review. Instead, call
 * `attrs({ [QUANTA_ATTRS.turn.id]: id, ... })` (or one of the named helpers
 * below) to obtain a frozen, validated `Attrs` payload.
 *
 * Guarantees:
 *   - **Compile-time**: keys are restricted to `AttrKey` via the parameter
 *     type. A typo'd key fails `tsc`.
 *   - **Runtime safety net**: unknown keys and disallowed value shapes throw
 *     a named error (no silent drop). This protects against `as any` casts
 *     and prototype-pollution-style attempts.
 *   - **Immutability**: the returned object is `Object.freeze`d.
 *
 * Related: ADR-0032.
 */

import type { AttrKey, AttrValue } from "./vocabulary"
import { isAttrKey, QUANTA_ATTRS } from "./vocabulary"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Frozen attribute bag, keyed by canonical attribute keys only. */
export type Attrs = Readonly<Partial<Record<AttrKey, AttrValue>>>

/**
 * Input shape for `attrs()` — partial because every span uses a subset.
 *
 * Note: each entry's value type includes `undefined` so that callers under
 * `exactOptionalPropertyTypes: true` can pass through optional fields
 * (`maybeNumber: x ?? undefined`). `attrs()` skips explicit-undefined
 * entries rather than emitting them as null.
 */
export type AttrsInput = { [K in AttrKey]?: AttrValue | undefined }

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when an attribute value is missing, the wrong shape, or a key is
 *  not in the canonical vocabulary. Carries the offending key/value/reason
 *  so callers can log structured context. */
export class InvalidAttrValueError extends Error {
  readonly code = "invalid_attr_value"
  constructor(
    readonly key: string,
    readonly value: unknown,
    readonly reason: string,
  ) {
    super(`invalid attribute value for "${key}": ${reason}`)
    this.name = "InvalidAttrValueError"
  }
}

// ---------------------------------------------------------------------------
// Value validation
// ---------------------------------------------------------------------------

const isPrimitiveAttrValue = (v: unknown): v is string | number | boolean => {
  const t = typeof v
  if (t === "string") return true
  if (t === "boolean") return true
  if (t === "number") {
    // OTel does not allow NaN or non-finite numbers on the wire.
    return Number.isFinite(v as number)
  }
  return false
}

const isHomogeneousArray = (a: readonly unknown[]): boolean => {
  if (a.length === 0) return true
  const first = typeof a[0]
  if (first !== "string" && first !== "number" && first !== "boolean") return false
  for (const v of a) {
    if (typeof v !== first) return false
    if (first === "number" && !Number.isFinite(v as number)) return false
  }
  return true
}

const validateValue = (key: string, value: unknown): AttrValue => {
  if (value === null || value === undefined) {
    throw new InvalidAttrValueError(key, value, "null/undefined not allowed — omit the key")
  }
  if (Array.isArray(value)) {
    if (!isHomogeneousArray(value)) {
      throw new InvalidAttrValueError(
        key,
        value,
        "array must be non-empty homogeneous string/number/boolean (and numbers finite)",
      )
    }
    return value as AttrValue
  }
  if (!isPrimitiveAttrValue(value)) {
    throw new InvalidAttrValueError(
      key,
      value,
      "value must be string | number | boolean | array of one of those",
    )
  }
  return value
}

// ---------------------------------------------------------------------------
// Core builder
// ---------------------------------------------------------------------------

/**
 * Build a frozen `Attrs` object from a partial vocabulary map.
 *
 * Compile-time:
 *   - `record` is `Partial<Record<AttrKey, AttrValue>>`, so unknown keys fail
 *     `tsc`.
 *
 * Runtime safety nets (defense in depth against `as any`):
 *   - Unknown key (escaped via cast) → `InvalidAttrValueError`.
 *   - Disallowed value shape (object, function, NaN, mixed array) →
 *     `InvalidAttrValueError`.
 *   - Empty input is allowed and yields a frozen empty object.
 */
export const attrs = (record: AttrsInput): Attrs => {
  const out: Record<string, AttrValue> = {}
  for (const [k, v] of Object.entries(record)) {
    if (v === undefined) continue // skip explicit-undefined; treat like omitted
    if (!isAttrKey(k)) {
      throw new InvalidAttrValueError(k, v, "key is not in canonical vocabulary")
    }
    out[k] = validateValue(k, v)
  }
  return Object.freeze(out) as Attrs
}

/**
 * Merge attribute bags left-to-right. Later inputs override earlier ones on
 * key collision. Returned object is frozen and independently validated, so
 * passing already-`attrs()`-built bags is cheap (each entry re-validated, but
 * the cost is negligible relative to span emission).
 */
export const mergeAttrs = (...sets: readonly Attrs[]): Attrs => {
  const out: Record<string, AttrValue> = {}
  for (const s of sets) {
    for (const [k, v] of Object.entries(s)) {
      if (v === undefined) continue
      if (!isAttrKey(k)) {
        throw new InvalidAttrValueError(k, v, "key is not in canonical vocabulary")
      }
      out[k] = validateValue(k, v)
    }
  }
  return Object.freeze(out) as Attrs
}

// ---------------------------------------------------------------------------
// Named builders for common span shapes
// ---------------------------------------------------------------------------

/** Status of a single tool invocation. */
export type ToolStatus = "success" | "error" | "blocked"

/** Risk classification used by the permission layer. */
export type RiskLevel = "low" | "medium" | "high"

/**
 * Build the attribute bag for a turn span. `durationMs` is optional — emit on
 * span close, not on open.
 */
export const turnAttrs = (args: { turnId: string; kind: string; durationMs?: number }): Attrs => {
  const base: AttrsInput = {
    [QUANTA_ATTRS.turn.id]: args.turnId,
    [QUANTA_ATTRS.turn.kind]: args.kind,
  }
  if (args.durationMs !== undefined) {
    base[QUANTA_ATTRS.turn.durationMs] = args.durationMs
  }
  return attrs(base)
}

/** Build the attribute bag for a tool-call span. */
export const toolAttrs = (args: {
  name: string
  callId: string
  status: ToolStatus
  durationMs?: number
}): Attrs => {
  const base: AttrsInput = {
    [QUANTA_ATTRS.tool.name]: args.name,
    [QUANTA_ATTRS.tool.callId]: args.callId,
    [QUANTA_ATTRS.tool.status]: args.status,
  }
  if (args.durationMs !== undefined) {
    base[QUANTA_ATTRS.tool.durationMs] = args.durationMs
  }
  return attrs(base)
}

/**
 * Build the attribute bag for a work-metrics span/event (absorb #6, v0.dev
 * `workMetrics`). Per-file diff stats are aggregated into scalar totals
 * (filesChanged / linesAdded / linesRemoved) because OTel attributes are flat
 * scalars/arrays — the full per-file breakdown lives in {@link WorkMetrics}
 * itself, not on the span. `costUsd` is emitted only when present.
 */
export const workMetricsAttrs = (m: {
  filesChanged: number
  linesAdded: number
  linesRemoved: number
  actions: number
  linesRead: number
  costUsd?: number
}): Attrs => {
  const base: AttrsInput = {
    [QUANTA_ATTRS.work.filesChanged]: m.filesChanged,
    [QUANTA_ATTRS.work.linesAdded]: m.linesAdded,
    [QUANTA_ATTRS.work.linesRemoved]: m.linesRemoved,
    [QUANTA_ATTRS.work.actions]: m.actions,
    [QUANTA_ATTRS.work.linesRead]: m.linesRead,
  }
  if (m.costUsd !== undefined) base[QUANTA_ATTRS.work.costUsd] = m.costUsd
  return attrs(base)
}

/** Build the attribute bag for a permission-review span (ADR-0029). */
export const permissionAttrs = (args: {
  reviewerTier: string
  outcome: string
  riskLevel: RiskLevel
}): Attrs =>
  attrs({
    [QUANTA_ATTRS.permission.reviewerTier]: args.reviewerTier,
    [QUANTA_ATTRS.permission.outcome]: args.outcome,
    [QUANTA_ATTRS.permission.riskLevel]: args.riskLevel,
  })
