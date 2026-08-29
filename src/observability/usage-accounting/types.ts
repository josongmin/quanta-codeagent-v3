/**
 * Canonical usage-accounting vocabulary (MR-01).
 *
 * ONE shape for "what a model call consumed" and ONE shape for "what it cost",
 * so every downstream — status line, `/cost`, work metrics, budget meter, cross
 * -run ledger, OTel — reads the same numbers instead of each deriving its own.
 *
 * The load-bearing idea is {@link NormalizedUsage}: token buckets that are
 * DISJOINT by construction. Providers do not agree on this. Anthropic reports
 * `input_tokens` EXCLUDING cache reads; OpenAI reports `prompt_tokens`
 * INCLUDING `cached_tokens`. Pricing code that takes the raw numbers has to
 * remember which convention it is holding, and historically two independent
 * implementations remembered differently — the same event cost $1.60 on one
 * path and $2.60 on the other. Normalizing once, at the edge, makes that class
 * of bug unrepresentable downstream: after normalization the buckets simply add
 * up, for every provider.
 */

/** Which billing convention the provider's raw usage numbers follow. */
export type Provider = "openai" | "anthropic"

/** USD per 1,000,000 tokens, per bucket. */
export interface ModelPrice {
  /** Input (prompt) tokens, $/1M. */
  inPerM: number
  /** Output (completion) tokens, $/1M. */
  outPerM: number
  /** Cache-READ tokens, $/1M — the provider's discounted rate. */
  cacheReadPerM: number
  /** Cache-CREATION (write) tokens, $/1M. Omitted ⇒ the provider does not bill
   *  cache creation separately. */
  cacheWritePerM?: number
}

/** Usage exactly as a provider reported it — conventions intact, unvalidated.
 *  This is the ONLY shape allowed to be provider-shaped; it must be run through
 *  `normalizeUsage` before anything prices or aggregates it. */
export interface RawUsage {
  readonly model: string
  /** The provider's own input/prompt count, INCLUDING cache reads on OpenAI. */
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
  /** Explicit provider beats inference from the model name. Supply it whenever
   *  the caller knows — name-prefix inference is a fallback, not a source of
   *  truth, and it is wrong for any model whose id does not follow the vendor's
   *  usual prefix. */
  readonly provider?: Provider
}

/** Provider-neutral usage. Every bucket is DISJOINT: no token is counted in
 *  two of them, so `fresh + cacheRead + cacheWrite` is the true prompt size and
 *  the buckets can be summed, diffed, and aggregated without knowing where
 *  they came from. */
export interface NormalizedUsage {
  readonly model: string
  readonly provider: Provider
  /** Prompt tokens actually processed — cache reads already carved out. */
  readonly freshInputTokens: number
  /** Prompt tokens served from cache, billed at the cache-read rate. */
  readonly cacheReadTokens: number
  /** Tokens written INTO the cache, billed at the cache-write rate. */
  readonly cacheWriteTokens: number
  readonly outputTokens: number
  /** Reasoning tokens, when the provider splits them out. Informational: they
   *  are already inside `outputTokens` for billing and are NOT priced again. */
  readonly reasoningTokens?: number
}

/** What a normalized usage costs, itemized. */
export interface UsageCost {
  readonly totalUsd: number
  readonly freshInputUsd: number
  readonly cacheReadUsd: number
  readonly cacheWriteUsd: number
  readonly outputUsd: number
  /**
   * `false` ⇒ the model had no entry in the rate card and these numbers came
   * from a stand-in rate. The amount is still an honest estimate and is still
   * worth showing — unpriced spend that renders as `$0` or vanishes is the
   * worse failure — but it must never be presented, aggregated, or enforced
   * against as if it were measured. Every surface that displays a cost is
   * responsible for marking an estimate as one.
   */
  readonly pricingKnown: boolean
  /** The rate-card entry actually used. Differs from `usage.model` exactly when
   *  `pricingKnown` is false, and then names the stand-in. */
  readonly pricingModel: string
  /** Rate-card version these numbers were derived under, so a historical cost
   *  can be re-derived after the table drifts. */
  readonly pricingVersion: string
}

/** Who spent it. Attached at emit time from the agent config's own lineage. */
export interface UsageProvenance {
  readonly sessionId: string
  /** Stable id of the agent that made the call. */
  readonly agentId: string
  /** Root turn vs. a spawned subagent — the distinction every "why is my bill
   *  bigger than the panel says" question turns on. */
  readonly agentKind: "root" | "subagent"
  /** Spawning agent, absent for the root. */
  readonly parentAgentId?: string
  /** 0 for the root, `parent + 1` for each nesting level. */
  readonly depth: number
  readonly turnId?: string
}

/** One priced, attributed model call — the atom every aggregate is built from. */
export interface UsageRecord {
  /**
   * Idempotency key for this model call. Recording the same `callId` twice is
   * a no-op, so a retry, a replayed stream, or two sinks racing the same event
   * cannot double-bill.
   */
  readonly callId: string
  /** Epoch ms, caller-supplied so aggregation stays deterministic in tests. */
  readonly at: number
  readonly usage: NormalizedUsage
  readonly cost: UsageCost
  readonly provenance: UsageProvenance
}
