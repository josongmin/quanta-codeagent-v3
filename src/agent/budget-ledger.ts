/**
 * Token budget ledger (ADR-0136).
 *
 * Pure in-memory primitive that multiplies provider-reported token usage by a
 * per-model price table to produce a cumulative USD cost ledger, then fires
 * typed `BudgetBreach` events when configured soft/hard limits are crossed at
 * session or daily scope. The structural counterpart to `/cost` (which renders
 * a session panel) — this slice exposes a PROGRAMMATIC budget primitive a
 * surface can wire to abort runaway loops (Cline `$50 in one afternoon`
 * cautionary tale).
 *
 * SOTA reference: every LLM SDK returns `usage:{input_tokens, output_tokens,
 * cache_creation_input_tokens, cache_read_input_tokens}` per message. Anthropic
 * / OpenAI / Codex all expose this; Claude Code shows session totals; NO modern
 * agent exposes a typed `BudgetBreach` event with soft/hard × session/daily
 * granularity + DI pricing table.
 *
 * Default-OFF: nothing in the loop instantiates this ledger today. Callers
 * (apps/agent bootstrap, future dispatch.ts auto-record from stream usage,
 * future surfaces) opt in by constructing `defaultBudgetLedger()` and routing
 * each completion's usage block through `record(...)`. With NO `policy` set,
 * `record` always returns `{cost, breaches: []}` — pure accountant mode
 * (cost still observable for the per-event histogram, ADR-0162).
 *
 * Plane-clean: imports ONLY `node:crypto` (for nothing — we do not need an id
 * here; the comment is forward-looking). No `@/agent/loop`, `@/agent/dispatch`,
 * `@/permission`, `@/tool`, `@/llm` — those are consumers, never collaborators
 * of this primitive (RFC §3.1 slice fence).
 *
 * Contract (8):
 *   1. PURE STORE: in-memory only; 0 I/O, 0 SQLite. Persistence is the
 *      caller's responsibility — we expose `serialize()` / `hydrate()` so the
 *      surface can pipe to disk (e.g. `~/.quanta/budget.json`).
 *   2. NO-THROW on the public surface. `record` always returns a
 *      `{cost, breaches}` object (cost finite & >= 0; breaches possibly
 *      empty) — see ADR-0162 for the 2-field shape rationale; `snapshot`
 *      always returns a populated object; `serialize` always returns a
 *      JSON string; `hydrate` swallows garbage and resets to empty
 *      (documented in clause #7).
 *   3. exactOptionalPropertyTypes strict — `UsageEvent.turnId`,
 *      `ModelPricing.cacheReadPerM`, `BudgetPolicy.*Limit` are OMITTED on
 *      the wire when absent, never `undefined`.
 *   4. PRICING FALLBACK: an event for a model not in the price table records
 *      its tokens but bills at the `claude-sonnet-4-6` rate (documented in
 *      clause #4 of the ADR). This is a deliberate "fail safe-LOUD" — the
 *      ledger still reflects the event so the operator notices the unknown
 *      model in the breakdown, instead of silently billing $0.
 *   5. BREACH DEBOUNCE: each `(scope, kind)` pair fires AT MOST ONCE within
 *      the ledger's lifetime. The ledger keeps a `Set<string>` of already-
 *      fired keys (`session-soft:abc-123`, `daily-hard:2026-05-24`). `clear`
 *      with a matching scope evicts the relevant keys so a freshly-cleared
 *      session can re-fire breaches. Documented in the ADR's "Alternatives
 *      rejected" — repeating-on-every-record was rejected (noise; the loop
 *      decides whether to re-emit).
 *   6. LRU eviction: when the retained event count exceeds `maxEvents`, the
 *      OLDEST events drop. Aggregates (`perModel`, `perSession`, `perDay`)
 *      are recomputed from the RETAINED slice — they DECREASE as events
 *      drop. This is intentional: a long-running session that wraps past
 *      `maxEvents` reflects only the live window. Callers that need
 *      lifetime totals must either raise the cap or persist via
 *      `serialize()` BEFORE eviction (documented in clause #7).
 *   7. HYDRATE SAFETY: `hydrate` with non-JSON / wrong-shape input resets
 *      the ledger to empty and SILENTLY returns. Document the trade-off:
 *      we prefer a known-empty state to a thrown error on a corrupt disk
 *      snapshot, because the ledger is observational — losing history is
 *      preferable to crashing the surface that hydrates at startup.
 *   8. DETERMINISTIC TIME: every wall-clock read goes through the injected
 *      `now()` so tests can pin daily-boundary cases. Day key is
 *      `YYYY-MM-DD` in UTC (not the local TZ) so the boundary is
 *      reproducible across machines and matches typical billing windows.
 */

/** Per-model pricing. All values in USD per 1 million tokens. */
export interface ModelPricing {
  /** Standard input tokens (per 1M). */
  readonly inputPerM: number
  /** Standard output tokens (per 1M). */
  readonly outputPerM: number
  /** Cached input tokens (Anthropic prompt caching read). Usually << inputPerM. */
  readonly cacheReadPerM?: number
  /** Cache-creation input tokens (one-time write). Usually slightly > inputPerM. */
  readonly cacheWritePerM?: number
}

/** A single LLM completion's usage event. Caller forwards these from the
 *  stream's `usage` field as soon as the completion settles. */
export interface UsageEvent {
  /** Model id, e.g. `"claude-opus-4-7"`. Used to look up `ModelPricing`. */
  readonly model: string
  /** Standard input tokens consumed. */
  readonly inputTokens: number
  /** Standard output tokens produced. */
  readonly outputTokens: number
  /** Cache-read tokens (Anthropic disjoint bucket — NOT a subset of input). */
  readonly cacheReadTokens?: number
  /** Cache-write / cache-creation tokens. */
  readonly cacheWriteTokens?: number
  /** Optional turn id for future per-turn rollup. Omitted when absent. */
  readonly turnId?: string
  /** Owning session id (per-session rollup key). */
  readonly sessionId: string
  /** Epoch ms when the event was recorded (typically caller-supplied clock). */
  readonly at: number
}

/** Per-model / per-session / per-day cost roll-up. All amounts in USD. */
export interface CostBreakdown {
  readonly model: string
  readonly inputCost: number
  readonly outputCost: number
  readonly cacheReadCost: number
  readonly cacheWriteCost: number
  readonly totalCost: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

/** Read-only snapshot of the ledger. */
export interface BudgetSnapshot {
  /** Total USD across every retained event. */
  readonly totalCost: number
  /** Per-model breakdown; key is the `model` string. */
  readonly perModel: ReadonlyMap<string, CostBreakdown>
  /** Per-session breakdown; key is the `sessionId`. */
  readonly perSession: ReadonlyMap<string, CostBreakdown>
  /** Per-day breakdown; key is `YYYY-MM-DD` (UTC). */
  readonly perDay: ReadonlyMap<string, CostBreakdown>
  /** Total events retained (may be < total recorded after LRU eviction). */
  readonly events: number
}

/** Closed 4-arm union: `<scope>-<severity>`. Adding a 5th arm requires an
 *  ADR amendment + compile-error update at every exhaustive switch site. */
export type BudgetLimitKind = "session-soft" | "session-hard" | "daily-soft" | "daily-hard"

export interface BudgetBreach {
  readonly kind: BudgetLimitKind
  /** The configured limit in USD that was crossed. */
  readonly limit: number
  /** Observed cumulative cost in USD at the time of crossing. */
  readonly observed: number
  /** Either the sessionId (for `session-*`) or the day key (for `daily-*`). */
  readonly scope: string
}

export interface BudgetPolicy {
  /** Emit `session-soft` breach when a session crosses this USD cap. */
  readonly sessionSoftLimit?: number
  /** Emit `session-hard` breach when a session crosses this USD cap. */
  readonly sessionHardLimit?: number
  /** Emit `daily-soft` breach when a UTC day crosses this USD cap. */
  readonly dailySoftLimit?: number
  /** Emit `daily-hard` breach when a UTC day crosses this USD cap. */
  readonly dailyHardLimit?: number
}

/** Record-result shape (ADR-0162). `cost` is the USD billed by THIS single
 *  event (same calculation that flows into perModel aggregation); `breaches`
 *  is the deterministic-order breach list (0..4 entries). Both are required
 *  on every call — `cost` is 0 on a malformed event (defensive swallow) and
 *  `breaches` is `[]` when no policy is configured or no limit was crossed. */
export interface RecordResult {
  readonly cost: number
  readonly breaches: ReadonlyArray<BudgetBreach>
}

/** Public ledger surface. */
export interface BudgetLedger {
  /** Record one usage event. Returns `{cost, breaches}` (ADR-0162).
   *  - `cost`: USD billed by this single event (pricing × token counts).
   *  - `breaches`: 0..4 breaches that fired, in deterministic order:
   *    `session-soft`, `session-hard`, `daily-soft`, `daily-hard`. Each
   *    `(scope, kind)` pair fires AT MOST ONCE (debounce per contract #5). */
  record(event: UsageEvent): RecordResult
  /** Read-only snapshot. */
  snapshot(): BudgetSnapshot
  /** Reset state. With no args: clear EVERYTHING (events + breach memory).
   *  With `{session}`: drop events for that session + reset its breach memory.
   *  With `{day}`: drop events whose day key matches + reset that day's
   *  breach memory. Returns evicted event count. */
  clear(scope?: { session?: string; day?: string }): number
  /** Serialize the entire state for persistence. JSON string. */
  serialize(): string
  /** Re-hydrate from a prior `serialize()` output. On parse failure or
   *  shape mismatch, resets to empty + returns silently (contract #7). */
  hydrate(jsonl: string): void
}

export interface BudgetLedgerOpts {
  /** Limit policy. Absent ⇒ `record` never emits a breach (pure accountant). */
  readonly policy?: BudgetPolicy
  /** Per-model pricing override. Merged with `DEFAULT_MODEL_PRICING`; caller
   *  entries WIN on a name collision. Absent ⇒ defaults only. */
  readonly pricing?: Readonly<Record<string, ModelPricing>>
  /** Max retained events (LRU). Default 10_000. Clamped to >= 1. */
  readonly maxEvents?: number
  /** Injected clock — used by `dayKey` / `hydrate`'s timestamp normalization.
   *  Tests pin it to assert deterministic day boundaries. Default `Date.now`. */
  readonly now?: () => number
}

/**
 * Sensible 2026-05 estimates for the most-used model families. Confirm against
 * vendor rate cards (anthropic.com/pricing, openai.com/api/pricing) before
 * relying on these for billing-critical decisions — the ledger is a guard
 * rail, not an invoice.
 */
export const DEFAULT_MODEL_PRICING: Readonly<Record<string, ModelPricing>> = Object.freeze({
  // 2026-05 estimate; confirm against vendor rate card before billing-critical use.
  "claude-opus-4-7": { inputPerM: 15, outputPerM: 75, cacheReadPerM: 1.5, cacheWritePerM: 18.75 },
  // 2026-05 estimate; confirm against vendor rate card before billing-critical use.
  "claude-sonnet-4-6": { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheWritePerM: 3.75 },
  // 2026-05 estimate; confirm against vendor rate card before billing-critical use.
  "claude-haiku-4-5": { inputPerM: 1, outputPerM: 5, cacheReadPerM: 0.1, cacheWritePerM: 1.25 },
  // 2026-05 estimate; confirm against vendor rate card before billing-critical use.
  "gpt-5": { inputPerM: 10, outputPerM: 30 },
  // 2026-05 estimate; confirm against vendor rate card before billing-critical use.
  "gpt-4o": { inputPerM: 2.5, outputPerM: 10 },
})

/** Pricing used when an event references an unknown model. Picked deliberately:
 *  sonnet is the safe middle ground (not the cheapest haiku that would under-
 *  count, not the most expensive opus that would over-count by 5×). */
const FALLBACK_PRICING_KEY = "claude-sonnet-4-6"

const DEFAULT_MAX_EVENTS = 10_000

/** Convert tokens to USD given a per-million rate. Tokens × rate / 1M.
 *  Defensive: non-finite or negative tokens contribute 0 (a poisoned
 *  provider report cannot poison the ledger — same posture as
 *  `BudgetMeter.tick` in `@/agent/budget/meter.ts`). */
const tokensToUsd = (tokens: number | undefined, perMillion: number | undefined): number => {
  if (tokens === undefined || perMillion === undefined) return 0
  if (!Number.isFinite(tokens) || tokens <= 0) return 0
  if (!Number.isFinite(perMillion) || perMillion <= 0) return 0
  return (tokens * perMillion) / 1_000_000
}

/** UTC `YYYY-MM-DD` from epoch ms. Pure — no Intl, no locale, no TZ. */
const dayKeyFor = (epochMs: number): string => {
  if (!Number.isFinite(epochMs)) return "1970-01-01"
  const d = new Date(epochMs)
  const yyyy = String(d.getUTCFullYear()).padStart(4, "0")
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0")
  const dd = String(d.getUTCDate()).padStart(2, "0")
  return `${yyyy}-${mm}-${dd}`
}

/** Internal: shape stored on disk via `serialize()`. */
interface SerializedLedger {
  readonly v: 1
  readonly events: ReadonlyArray<UsageEvent>
  readonly firedBreaches: ReadonlyArray<string>
}

/** Internal: empty cost line for the running aggregator. Mutable so the
 *  aggregator can `+=` into it; we freeze before exposing externally. */
type MutableCost = {
  model: string
  inputCost: number
  outputCost: number
  cacheReadCost: number
  cacheWriteCost: number
  totalCost: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

type RetainedEvent = {
  event: UsageEvent
  cost: MutableCost
  dayKey: string
}

const emptyCost = (model: string): MutableCost => ({
  model,
  inputCost: 0,
  outputCost: 0,
  cacheReadCost: 0,
  cacheWriteCost: 0,
  totalCost: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
})

/** Compute the per-event cost using the resolved pricing (with fallback). */
const computeEventCost = (event: UsageEvent, pricing: ModelPricing): MutableCost => {
  const c = emptyCost(event.model)
  c.inputTokens =
    Number.isFinite(event.inputTokens) && event.inputTokens > 0 ? event.inputTokens : 0
  c.outputTokens =
    Number.isFinite(event.outputTokens) && event.outputTokens > 0 ? event.outputTokens : 0
  c.cacheReadTokens =
    event.cacheReadTokens !== undefined &&
    Number.isFinite(event.cacheReadTokens) &&
    event.cacheReadTokens > 0
      ? event.cacheReadTokens
      : 0
  c.cacheWriteTokens =
    event.cacheWriteTokens !== undefined &&
    Number.isFinite(event.cacheWriteTokens) &&
    event.cacheWriteTokens > 0
      ? event.cacheWriteTokens
      : 0
  c.inputCost = tokensToUsd(c.inputTokens, pricing.inputPerM)
  c.outputCost = tokensToUsd(c.outputTokens, pricing.outputPerM)
  c.cacheReadCost = tokensToUsd(c.cacheReadTokens, pricing.cacheReadPerM)
  c.cacheWriteCost = tokensToUsd(c.cacheWriteTokens, pricing.cacheWritePerM)
  c.totalCost = c.inputCost + c.outputCost + c.cacheReadCost + c.cacheWriteCost
  return c
}

/** Fold one event's cost into a running aggregate keyed by model. */
const foldInto = (agg: MutableCost, cost: MutableCost): void => {
  agg.inputCost += cost.inputCost
  agg.outputCost += cost.outputCost
  agg.cacheReadCost += cost.cacheReadCost
  agg.cacheWriteCost += cost.cacheWriteCost
  agg.totalCost += cost.totalCost
  agg.inputTokens += cost.inputTokens
  agg.outputTokens += cost.outputTokens
  agg.cacheReadTokens += cost.cacheReadTokens
  agg.cacheWriteTokens += cost.cacheWriteTokens
}

const unfoldFrom = (agg: MutableCost, cost: MutableCost): void => {
  agg.inputCost -= cost.inputCost
  agg.outputCost -= cost.outputCost
  agg.cacheReadCost -= cost.cacheReadCost
  agg.cacheWriteCost -= cost.cacheWriteCost
  agg.totalCost -= cost.totalCost
  agg.inputTokens -= cost.inputTokens
  agg.outputTokens -= cost.outputTokens
  agg.cacheReadTokens -= cost.cacheReadTokens
  agg.cacheWriteTokens -= cost.cacheWriteTokens
}

const AGGREGATE_EPSILON = 1e-12

const isZeroish = (n: number): boolean => Math.abs(n) <= AGGREGATE_EPSILON

const isEmptyAggregate = (agg: MutableCost): boolean =>
  isZeroish(agg.inputCost) &&
  isZeroish(agg.outputCost) &&
  isZeroish(agg.cacheReadCost) &&
  isZeroish(agg.cacheWriteCost) &&
  isZeroish(agg.totalCost) &&
  agg.inputTokens === 0 &&
  agg.outputTokens === 0 &&
  agg.cacheReadTokens === 0 &&
  agg.cacheWriteTokens === 0

/** Freeze a MutableCost into the public read-only shape. */
const freezeCost = (c: MutableCost): CostBreakdown => Object.freeze({ ...c })

/** Parse one raw event object out of a hydrated JSON payload. Returns
 *  `undefined` when the shape is invalid (caller skips). Pure — no I/O.
 *  Extracted from `hydrate` to keep that method below the cognitive-
 *  complexity budget. */
const parseHydratedEvent = (raw: unknown): UsageEvent | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined
  const r = raw as Partial<UsageEvent>
  if (typeof r.model !== "string") return undefined
  if (typeof r.sessionId !== "string") return undefined
  if (typeof r.inputTokens !== "number") return undefined
  if (typeof r.outputTokens !== "number") return undefined
  if (typeof r.at !== "number") return undefined
  const base: UsageEvent = {
    model: r.model,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    sessionId: r.sessionId,
    at: r.at,
  }
  // exactOptionalPropertyTypes — only copy optional fields that were actually
  // present (and the right type).
  return {
    ...base,
    ...(typeof r.cacheReadTokens === "number" ? { cacheReadTokens: r.cacheReadTokens } : {}),
    ...(typeof r.cacheWriteTokens === "number" ? { cacheWriteTokens: r.cacheWriteTokens } : {}),
    ...(typeof r.turnId === "string" ? { turnId: r.turnId } : {}),
  }
}

/** Validate the outer shape of a hydrated payload. Returns the raw events
 *  array on success; `undefined` on any shape mismatch. */
const validateHydratedPayload = (parsed: unknown): Partial<SerializedLedger> | undefined => {
  if (typeof parsed !== "object" || parsed === null) return undefined
  const obj = parsed as Partial<SerializedLedger>
  if (obj.v !== 1) return undefined
  if (!Array.isArray(obj.events)) return undefined
  return obj
}

/** Try to parse JSON; return `undefined` on failure (callers branch). */
const safeJsonParse = (s: string): unknown => {
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}

/** Helper: rebuild the (events, fired) state from a serialized JSON string.
 *  Extracted from `hydrate` to keep that method below the cognitive-complexity
 *  budget. Always mutates in-place — caller resets state first. */
const rehydrate = (
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

/** Helper: drop events matching the scope filter; evict matching breach
 *  keys so a re-cleared scope can re-fire. Returns the count evicted. */
const clearScoped = (
  events: ReadonlyArray<RetainedEvent>,
  fired: Set<string>,
  scope: { session?: string; day?: string },
): RetainedEvent[] => {
  const matches = (e: RetainedEvent): boolean => {
    if (scope.session !== undefined && e.event.sessionId === scope.session) return true
    if (scope.day !== undefined && e.dayKey === scope.day) return true
    return false
  }
  const survivors = events.filter((e) => !matches(e))
  // Evict matching breach keys.
  for (const key of [...fired]) {
    if (
      scope.session !== undefined &&
      key.startsWith("session-") &&
      key.endsWith(`:${scope.session}`)
    ) {
      fired.delete(key)
      continue
    }
    if (scope.day !== undefined && key.startsWith("daily-") && key.endsWith(`:${scope.day}`)) {
      fired.delete(key)
    }
  }
  return survivors
}

/** Helper: attempt to emit one breach. Pushes onto `breaches` and records the
 *  fired key when the limit is configured, finite, positive, exceeded, and
 *  not already fired. Extracted from the closure-bound `tryEmit` inside
 *  `checkBreaches` to keep that function below the cognitive-complexity
 *  budget. */
const tryEmitBreach = (
  breaches: BudgetBreach[],
  fired: Set<string>,
  kind: BudgetLimitKind,
  limit: number | undefined,
  observed: number,
  scope: string,
): void => {
  if (limit === undefined) return
  if (!Number.isFinite(limit) || limit <= 0) return
  if (observed <= limit) return
  const key = `${kind}:${scope}`
  if (fired.has(key)) return
  fired.add(key)
  breaches.push({ kind, limit, observed, scope })
}

/** Construct the default ledger. Caller wires `policy`, `pricing`, `maxEvents`,
 *  `now`. */
export const defaultBudgetLedger = (opts?: BudgetLedgerOpts): BudgetLedger => {
  const policy = opts?.policy ?? {}
  const pricingOverride = opts?.pricing ?? {}
  const maxEvents = Math.max(1, Math.floor(opts?.maxEvents ?? DEFAULT_MAX_EVENTS))
  // Merged pricing: caller entries WIN on collision.
  const pricing: Record<string, ModelPricing> = { ...DEFAULT_MODEL_PRICING, ...pricingOverride }
  const fallback = pricing[FALLBACK_PRICING_KEY] ?? DEFAULT_MODEL_PRICING[FALLBACK_PRICING_KEY]
  // Defense in depth: if the caller overrode FALLBACK_PRICING_KEY with bad
  // input, we still need a real pricing object.
  const safeFallback: ModelPricing = fallback ?? { inputPerM: 0, outputPerM: 0 }

  // Retained event queue. `start` advances as older entries are evicted; we
  // compact the prefix opportunistically so record() never pays `shift()`.
  const events: RetainedEvent[] = []
  let start = 0
  // Debounce: keys of breaches already fired. `<kind>:<scope>` (e.g.
  // `session-soft:abc-123`).
  const fired = new Set<string>()
  let totalCost = 0
  const perModel = new Map<string, MutableCost>()
  const perSession = new Map<string, MutableCost>()
  const perDay = new Map<string, MutableCost>()

  const resolvePricing = (model: string): ModelPricing => pricing[model] ?? safeFallback

  const activeLength = (): number => events.length - start

  const ensureBucket = (map: Map<string, MutableCost>, key: string, model: string): MutableCost => {
    const existing = map.get(key)
    if (existing !== undefined) return existing
    const created = emptyCost(model)
    map.set(key, created)
    return created
  }

  const maybeDropBucket = (map: Map<string, MutableCost>, key: string, agg: MutableCost | undefined): void => {
    if (agg === undefined) return
    if (isEmptyAggregate(agg)) map.delete(key)
  }

  const applyEntry = (entry: RetainedEvent): void => {
    totalCost += entry.cost.totalCost
    foldInto(ensureBucket(perModel, entry.event.model, entry.event.model), entry.cost)
    foldInto(ensureBucket(perSession, entry.event.sessionId, entry.event.model), entry.cost)
    foldInto(ensureBucket(perDay, entry.dayKey, entry.event.model), entry.cost)
  }

  const removeEntry = (entry: RetainedEvent): void => {
    totalCost -= entry.cost.totalCost
    const modelAgg = perModel.get(entry.event.model)
    if (modelAgg !== undefined) {
      unfoldFrom(modelAgg, entry.cost)
      maybeDropBucket(perModel, entry.event.model, modelAgg)
    }
    const sessionAgg = perSession.get(entry.event.sessionId)
    if (sessionAgg !== undefined) {
      unfoldFrom(sessionAgg, entry.cost)
      maybeDropBucket(perSession, entry.event.sessionId, sessionAgg)
    }
    const dayAgg = perDay.get(entry.dayKey)
    if (dayAgg !== undefined) {
      unfoldFrom(dayAgg, entry.cost)
      maybeDropBucket(perDay, entry.dayKey, dayAgg)
    }
  }

  const compactPrefixIfNeeded = (): void => {
    if (start === 0) return
    if (start < 1024 && start * 2 < events.length) return
    events.splice(0, start)
    start = 0
  }

  const pushEvent = (event: UsageEvent): MutableCost => {
    const entry: RetainedEvent = {
      event,
      cost: computeEventCost(event, resolvePricing(event.model)),
      dayKey: dayKeyFor(event.at),
    }
    events.push(entry)
    applyEntry(entry)
    return entry.cost
  }

  const resetState = (): void => {
    events.length = 0
    start = 0
    totalCost = 0
    perModel.clear()
    perSession.clear()
    perDay.clear()
  }

  /** Build the snapshot's three breakdown maps + total. */
  const buildSnapshot = (): BudgetSnapshot => {
    const freezeMap = (m: Map<string, MutableCost>): ReadonlyMap<string, CostBreakdown> => {
      const out = new Map<string, CostBreakdown>()
      for (const [k, v] of m.entries()) out.set(k, freezeCost(v))
      return out
    }
    return Object.freeze({
      totalCost,
      perModel: freezeMap(perModel),
      perSession: freezeMap(perSession),
      perDay: freezeMap(perDay),
      events: activeLength(),
    })
  }

  const evictIfOver = (): void => {
    while (activeLength() > maxEvents) {
      const evicted = events[start]
      if (evicted === undefined) break
      removeEntry(evicted)
      start += 1
    }
    compactPrefixIfNeeded()
  }

  /** Check policy after `event` was recorded; emit at most one breach per
   *  `(scope, kind)` lifetime pair. Deterministic emission order:
   *  session-soft, session-hard, daily-soft, daily-hard. */
  const checkBreaches = (event: UsageEvent): ReadonlyArray<BudgetBreach> => {
    const breaches: BudgetBreach[] = []
    const day = dayKeyFor(event.at)
    const session = perSession.get(event.sessionId)?.totalCost ?? 0
    const daily = perDay.get(day)?.totalCost ?? 0
    tryEmitBreach(
      breaches,
      fired,
      "session-soft",
      policy.sessionSoftLimit,
      session,
      event.sessionId,
    )
    tryEmitBreach(
      breaches,
      fired,
      "session-hard",
      policy.sessionHardLimit,
      session,
      event.sessionId,
    )
    tryEmitBreach(breaches, fired, "daily-soft", policy.dailySoftLimit, daily, day)
    tryEmitBreach(breaches, fired, "daily-hard", policy.dailyHardLimit, daily, day)
    return breaches
  }

  return {
    record(event): RecordResult {
      // Defensive: a malformed event (missing required string fields) is a
      // programmer error in the caller. We swallow rather than throw — the
      // ledger is observational, not authoritative. `cost: 0` on swallow
      // matches the no-op `breaches: []` posture (ADR-0162 contract: the
      // 2-field shape is REQUIRED on every return, even the swallow path).
      if (typeof event?.model !== "string" || typeof event?.sessionId !== "string") {
        return { cost: 0, breaches: [] }
      }
      // Compute cost BEFORE pushing so the per-event histogram label is
      // the event's own model (same pricing resolution path the aggregator
      // takes, including the safe-LOUD unknown-model fallback).
      const cost = pushEvent(event).totalCost
      evictIfOver()
      return { cost, breaches: checkBreaches(event) }
    },

    snapshot() {
      return buildSnapshot()
    },

    clear(scope) {
      if (scope === undefined) {
        const n = activeLength()
        resetState()
        fired.clear()
        return n
      }
      const active = events.slice(start)
      const survivors = clearScoped(active, fired, scope)
      const removed = active.length - survivors.length
      resetState()
      for (const entry of survivors) {
        events.push(entry)
        applyEntry(entry)
      }
      return removed
    },

    serialize() {
      const payload: SerializedLedger = {
        v: 1,
        events: events.slice(start).map((entry) => entry.event),
        firedBreaches: [...fired],
      }
      return JSON.stringify(payload)
    },

    hydrate(jsonl) {
      // Reset to a known state first — even on garbage input, the ledger ends
      // up empty (contract #7). Either we replace with valid data or we end
      // up cleared.
      resetState()
      fired.clear()
      const hydratedEvents: UsageEvent[] = []
      rehydrate(jsonl, hydratedEvents, fired, maxEvents)
      for (const event of hydratedEvents) {
        pushEvent(event)
      }
      evictIfOver()
    },
  }
}
