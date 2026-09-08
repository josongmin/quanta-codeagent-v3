/**
 * Durable codec for the cross-run budget ledger (serialize / hydrate).
 *
 * Provenance is part of the event wire. A missing stamp is NOT known (W0.6).
 */
import type { UsageCost } from "@/observability/usage-accounting"
import type { UsageEvent } from "../budget-ledger"

export interface SerializedLedger {
  readonly v: 1
  readonly events: ReadonlyArray<UsageEvent>
  readonly firedBreaches: ReadonlyArray<string>
}

const parseUsageCost = (raw: unknown): UsageCost | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined
  const c = raw as Partial<UsageCost>
  if (typeof c.totalUsd !== "number") return undefined
  if (typeof c.freshInputUsd !== "number") return undefined
  if (typeof c.cacheReadUsd !== "number") return undefined
  if (typeof c.cacheWriteUsd !== "number") return undefined
  if (typeof c.outputUsd !== "number") return undefined
  if (typeof c.pricingKnown !== "boolean") return undefined
  if (typeof c.pricingModel !== "string") return undefined
  if (typeof c.pricingVersion !== "string") return undefined
  return {
    totalUsd: c.totalUsd,
    freshInputUsd: c.freshInputUsd,
    cacheReadUsd: c.cacheReadUsd,
    cacheWriteUsd: c.cacheWriteUsd,
    outputUsd: c.outputUsd,
    pricingKnown: c.pricingKnown,
    pricingModel: c.pricingModel,
    pricingVersion: c.pricingVersion,
  }
}

/** Parse one raw event object out of a hydrated JSON payload. Returns
 *  `undefined` when the shape is invalid (caller skips). Pure — no I/O. */
export const parseHydratedEvent = (raw: unknown): UsageEvent | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined
  const r = raw as Partial<UsageEvent> & { cost?: unknown; pricingProvenance?: unknown }
  if (typeof r.model !== "string") return undefined
  if (typeof r.sessionId !== "string") return undefined
  if (typeof r.inputTokens !== "number") return undefined
  if (typeof r.outputTokens !== "number") return undefined
  if (typeof r.at !== "number") return undefined
  const cost = parseUsageCost(r.cost)
  const provenance =
    r.pricingProvenance === "known" ||
    r.pricingProvenance === "unknown" ||
    r.pricingProvenance === "estimated"
      ? r.pricingProvenance
      : undefined
  const base: UsageEvent = {
    model: r.model,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    sessionId: r.sessionId,
    at: r.at,
  }
  return {
    ...base,
    ...(typeof r.cacheReadTokens === "number" ? { cacheReadTokens: r.cacheReadTokens } : {}),
    ...(typeof r.cacheWriteTokens === "number" ? { cacheWriteTokens: r.cacheWriteTokens } : {}),
    ...(typeof r.turnId === "string" ? { turnId: r.turnId } : {}),
    ...(cost !== undefined ? { cost } : {}),
    ...(provenance !== undefined ? { pricingProvenance: provenance } : {}),
  }
}

/** Validate the outer shape of a hydrated payload. Returns the raw events
 *  array on success; `undefined` on any shape mismatch. */
export const validateHydratedPayload = (parsed: unknown): Partial<SerializedLedger> | undefined => {
  if (typeof parsed !== "object" || parsed === null) return undefined
  const obj = parsed as Partial<SerializedLedger>
  if (obj.v !== 1) return undefined
  if (!Array.isArray(obj.events)) return undefined
  return obj
}

/** Try to parse JSON; return `undefined` on failure (callers branch). */
export const safeJsonParse = (s: string): unknown => {
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}

/** Helper: rebuild the (events, fired) state from a serialized JSON string.
 *  Always mutates in-place — caller resets state first. */
export const rehydrate = (
  jsonl: string,
  events: UsageEvent[],
  fired: Set<string>,
  maxEvents: number,
): void => {
  const parsed = safeJsonParse(jsonl)
  if (parsed === undefined) return
  const obj = validateHydratedPayload(parsed)
  if (obj === undefined) return
  const rawEvents = obj.events ?? []
  const retained =
    rawEvents.length > maxEvents ? rawEvents.slice(rawEvents.length - maxEvents) : rawEvents
  for (const raw of retained) {
    const ev = parseHydratedEvent(raw)
    if (ev !== undefined) events.push(ev)
  }
  if (Array.isArray(obj.firedBreaches)) {
    for (const k of obj.firedBreaches) {
      if (typeof k === "string") fired.add(k)
    }
  }
}
