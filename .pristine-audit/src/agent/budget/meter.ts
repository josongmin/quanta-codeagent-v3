/**
 * `BudgetMeter` — pure, deterministic state machine for cumulative
 * per-run quantitative tracking. NO I/O, NO clock side-effects (wall-clock
 * sampling is delegated to a caller-supplied `now()` so tests are
 * deterministic). Every gate is propositional: `dial !== undefined && observed
 * > dial`. There are NO numerical literals in the comparison logic — all
 * thresholds come from the constructor-supplied `BudgetDials`.
 *
 * Lifecycle:
 *   const meter = new BudgetMeter({ dials, caps, exhaustion })
 *   meter.tick("turn")
 *   meter.tick("tool_call")
 *   const e = meter.checkExhausted()  // propositional check across every dial
 *   meter.recordSuccess()              // resets consecutive_failure counter
 *
 * `tick(kind, n?)` increments by `n` (default `1`). `kind` is the closed
 * `TickKind` union — an unknown kind is a TS type error; runtime guards in
 * the switch are defense-in-depth.
 */

import type {
  BudgetCaps,
  BudgetDials,
  BudgetExhaustion,
  BudgetExhaustionPolicy,
  BudgetUsage,
  TickKind,
} from "./types"

/** Caller-supplied options. `now` lets tests inject a deterministic clock. */
export interface BudgetMeterOptions {
  dials?: BudgetDials
  caps?: BudgetCaps
  exhaustion?: BudgetExhaustionPolicy
  /** Returns the current monotonic ms timestamp. Defaults to `Date.now`. */
  now?: () => number
}

export class BudgetMeter {
  readonly dials: BudgetDials
  readonly caps: BudgetCaps
  readonly exhaustion: BudgetExhaustionPolicy
  private readonly clock: () => number
  private readonly startedAtMs: number

  // Counters — pure ints; mutation is the meter's only state.
  private turns = 0
  private modelCalls = 0
  private toolCalls = 0
  private shellCommands = 0
  private testRuns = 0
  private inputTokens = 0
  private outputTokens = 0
  private reasoningTokens = 0
  private filesChanged = 0
  private patchBytes = 0
  private retries = 0
  private consecutiveFailures = 0
  // Cumulative USD cost. Accumulated via `tick("cost_usd", n)` where the
  // CALLER has already priced the event through the pricing SSOT
  // (`@/observability` `costUsd(ev.model, …)`). The meter holds no price table
  // — it is a pure accountant of dollars it is handed, exactly like the token
  // counters are pure accountants of tokens.
  private costUsdAccum = 0
  // Per-TURN USD cost (L3 runaway-turn guard). Reset to 0 at each `tick("turn")`
  // boundary, accumulated by `tick("cost_usd")`, compared against
  // `maxCostPerTurnUsd`. Distinct from `costUsdAccum` (cumulative across the run).
  private costUsdThisTurn = 0
  // jul-03 B3 — LAST observed PROVIDER rate-limit remaining percentage (0..100),
  // parsed off `x-ratelimit-*` / `x-codex-*-used-percent` response headers by the
  // composition root and pushed here via `observeProviderRateLimitRemainingPercent`.
  // This is a REAL provider quota signal, DELIBERATELY SEPARATE from the local
  // cost/token fractions in `remainingPercent()` (which returns 100 with no dial —
  // the fake `min_rate_limit_remaining_percent`-by-name signal). `undefined` until
  // the provider actually reports one, so a consumer can distinguish "no provider
  // snapshot yet" (fail-open) from "provider window nearly exhausted".
  private providerRateLimitRemainingPct: number | undefined = undefined

  constructor(opts: BudgetMeterOptions = {}) {
    this.dials = opts.dials ?? {}
    this.caps = opts.caps ?? {}
    this.exhaustion = opts.exhaustion ?? "stop"
    this.clock = opts.now ?? Date.now
    this.startedAtMs = this.clock()
  }

  /**
   * Increment the counter for `kind` by `n` (default 1). Pure state mutation.
   *
   * `n` is hardened against non-finite / negative deltas. Token + cost dials
   * are fed by provider-reported usage (`loop.ts` passes `ev.inputTokens` /
   * `ev.outputTokens` straight through); when a provider omits a usage field
   * or reports `NaN`, an unguarded `counter += NaN` would POISON the counter
   * for the rest of the run — every later `observed > dial` becomes
   * `NaN > dial === false`, silently DISABLING the token + cost caps. We reject
   * a non-finite or negative `n` (a programmer/provider error) as a no-op so a
   * single bad usage report cannot defeat the budget gate. Valid finite
   * non-negative deltas are unaffected (byte-identical).
   */
  tick(kind: TickKind, n = 1): void {
    if (!Number.isFinite(n) || n < 0) return
    switch (kind) {
      case "turn":
        this.turns += n
        // A new turn boundary — reset the per-turn cost accumulator so the
        // maxCostPerTurnUsd ceiling measures THIS turn's spend only. (Cost is
        // ticked during the turn that follows; the per-turn check runs at the
        // turn epilogue, before the next `tick("turn")`.)
        this.costUsdThisTurn = 0
        return
      case "model_call":
        this.modelCalls += n
        return
      case "tool_call":
        this.toolCalls += n
        return
      case "shell_command":
        this.shellCommands += n
        return
      case "test_run":
        this.testRuns += n
        return
      case "input_tokens":
        this.inputTokens += n
        return
      case "output_tokens":
        this.outputTokens += n
        return
      case "reasoning_tokens":
        this.reasoningTokens += n
        return
      case "files_changed":
        this.filesChanged += n
        return
      case "patch_bytes":
        this.patchBytes += n
        return
      case "retry":
        this.retries += n
        return
      case "consecutive_failure":
        this.consecutiveFailures += n
        return
      case "cost_usd":
        // `n` is a fractional USD amount (e.g. 0.0023) already priced by the
        // caller. The non-finite/negative guard above protects the same way it
        // protects the token counters: a malformed price (NaN / negative) is a
        // no-op so a single bad usage report cannot poison the cost cap.
        this.costUsdAccum += n
        this.costUsdThisTurn += n
        return
      default: {
        // Exhaustive switch — TS narrows `kind` to `never` here. Defense in
        // depth: throw on a programmer error rather than silently drop.
        const _exhaustive: never = kind
        throw new Error(`BudgetMeter.tick: unknown kind ${String(_exhaustive)}`)
      }
    }
  }

  /** Reset the consecutive-failure counter (called on successful dispatch). */
  recordSuccess(): void {
    this.consecutiveFailures = 0
  }

  /**
   * jul-03 B3 — record the PROVIDER's live rate-limit remaining percentage
   * (0..100), as parsed off the response headers by the composition root. This
   * is the REAL provider quota signal, orthogonal to the local cost/token dials.
   *
   * NO invented number (project rule): a non-finite / out-of-band value is a
   * NO-OP so a single garbage header can never poison the tap (mirrors the
   * `tick` guard). Only a finite value in the documented [0,100] band updates
   * the stored percentage; last-write-wins so a fresher response refines it.
   * Does NOT touch any cost/token counter — the two signals stay separate.
   */
  observeProviderRateLimitRemainingPercent(pct: number): void {
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return
    this.providerRateLimitRemainingPct = pct
  }

  /**
   * The LAST observed provider rate-limit remaining percentage, or `undefined`
   * when the provider has not reported one this run. UNLIKE {@link remainingPercent}
   * (local cost, defaults to 100 with no dial), this stays `undefined` until a
   * real provider signal arrives — so a guard reading it can fail-open on
   * "unknown" while still refusing on a genuinely low provider window.
   */
  providerRateLimitRemainingPercent(): number | undefined {
    return this.providerRateLimitRemainingPct
  }

  /**
   * L2 pre-flight admission control (cost dimension). Pure projection — NO
   * mutation. Answers "if `projectedUsd` MORE dollars were spent, would the
   * cost cap trip?" without billing them. The loop uses this BEFORE issuing a
   * model call: when the accumulated cost plus the next prompt's input-floor
   * cost already exceeds `maxCostUsd`, the call is GUARANTEED to breach (output
   * only adds cost), so the loop can stop without spending.
   *
   * Propositional, same contract as `checkExhausted`:
   *   - No `maxCostUsd` dial ⇒ `{ exhausted: false }` (byte-identical no-op).
   *   - A non-finite / negative projection ⇒ `{ exhausted: false }` (never
   *     pre-empt on a garbage estimate — fail-open toward letting the call run,
   *     since the post-hoc `checkExhausted` still guards the real spend).
   *   - Otherwise trips iff `costUsdAccum + projectedUsd > maxCostUsd`.
   * `wouldExceedCost(0)` is exactly the cost arm of `checkExhausted`.
   */
  wouldExceedCost(projectedUsd: number): BudgetExhaustion {
    const cap = this.dials.maxCostUsd
    if (cap === undefined) return { exhausted: false }
    if (!Number.isFinite(projectedUsd) || projectedUsd < 0) return { exhausted: false }
    const observed = this.costUsdAccum + projectedUsd
    return observed > cap
      ? { exhausted: true, kind: "cost_usd", budget: cap, observed }
      : { exhausted: false }
  }

  /**
   * 0..100 remaining-budget percentage across the *configured* consumable
   * dials (token + cost dimensions). PURE / propositional — NO heuristics, NO
   * arbitrary thresholds. For each configured dial the remaining fraction is
   * `(dial - observed) / dial`; the binding (smallest-remaining) dimension wins
   * so the signal reflects the dial closest to exhaustion. Each per-dial
   * fraction is clamped to `[0,1]` (an over-consumed dial reads 0%). When NO
   * consumable dial is configured the budget is effectively unbounded ⇒ `100`.
   *
   * This is the 0..100 signal the ADR-0432 memory write-guard reads via the
   * injected `() => number` — the memory slice never touches this meter.
   */
  remainingPercent(): number {
    const u = this.snapshot()
    const d = this.dials
    const totalTokens = u.inputTokens + u.outputTokens + u.reasoningTokens
    const fractions: number[] = []
    const consider = (dial: number | undefined, observed: number): void => {
      // Only a positive, finite dial defines a consumable budget. A 0 (or
      // negative) dial is degenerate (already exhausted) and is skipped here so
      // it cannot poison the min with a divide-by-zero; `checkExhausted` still
      // governs the hard gate.
      if (dial === undefined || !Number.isFinite(dial) || dial <= 0) return
      const frac = (dial - observed) / dial
      fractions.push(frac < 0 ? 0 : frac > 1 ? 1 : frac)
    }
    consider(d.maxInputTokens, u.inputTokens)
    consider(d.maxOutputTokens, u.outputTokens)
    consider(d.maxReasoningTokens, u.reasoningTokens)
    consider(d.maxTotalTokens, totalTokens)
    consider(d.maxCostUsd, u.costUsd)
    if (fractions.length === 0) return 100
    return Math.min(...fractions) * 100
  }

  /** Snapshot of every counter. Stable — every call returns a fresh object. */
  snapshot(): BudgetUsage {
    const wallClockMs = this.clock() - this.startedAtMs
    const costUsd = this.costUsdAccum
    return {
      turns: this.turns,
      modelCalls: this.modelCalls,
      toolCalls: this.toolCalls,
      shellCommands: this.shellCommands,
      testRuns: this.testRuns,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      reasoningTokens: this.reasoningTokens,
      filesChanged: this.filesChanged,
      patchBytes: this.patchBytes,
      retries: this.retries,
      consecutiveFailures: this.consecutiveFailures,
      wallClockMs,
      costUsd,
    }
  }

  /**
   * Check every dial vs current observation. Returns the FIRST tripped dial
   * (deterministic order so behaviour is reproducible). Pure propositional
   * comparison — `dial !== undefined && observed > dial`. There are no
   * numerical literals in this function: every threshold comes from
   * `this.dials`.
   */
  checkExhausted(): BudgetExhaustion {
    const u = this.snapshot()
    const dials = this.dials

    const check = (
      dialValue: number | undefined,
      observed: number,
      kind: NonNullable<BudgetExhaustion["kind"]>,
    ): BudgetExhaustion | undefined =>
      dialValue !== undefined && observed > dialValue
        ? { exhausted: true, kind, budget: dialValue, observed }
        : undefined

    // Deterministic check order. Token totals (which combine multiple
    // counters) come AFTER the per-counter checks so a more specific dial
    // fires first.
    const totalTokens = u.inputTokens + u.outputTokens + u.reasoningTokens
    return (
      check(dials.maxTurns, u.turns, "turn") ??
      check(dials.maxModelCalls, u.modelCalls, "model_call") ??
      check(dials.maxToolCalls, u.toolCalls, "tool_call") ??
      check(dials.maxShellCommands, u.shellCommands, "shell_command") ??
      check(dials.maxTestRuns, u.testRuns, "test_run") ??
      check(dials.maxInputTokens, u.inputTokens, "input_tokens") ??
      check(dials.maxOutputTokens, u.outputTokens, "output_tokens") ??
      check(dials.maxReasoningTokens, u.reasoningTokens, "reasoning_tokens") ??
      check(dials.maxTotalTokens, totalTokens, "total_tokens") ??
      check(dials.maxFilesChanged, u.filesChanged, "files_changed") ??
      check(dials.maxPatchBytes, u.patchBytes, "patch_bytes") ??
      check(dials.maxRetries, u.retries, "retry") ??
      check(dials.maxConsecutiveFailures, u.consecutiveFailures, "consecutive_failure") ??
      check(dials.maxWallClockMs, u.wallClockMs, "wall_clock_ms") ??
      check(dials.maxCostUsd, u.costUsd, "cost_usd") ??
      // L3 runaway-turn guard — THIS turn's cost (reset each `tick("turn")`),
      // distinct from the cumulative `cost_usd` above. Read from the private
      // accumulator (not the snapshot, which carries cumulative cost only).
      check(dials.maxCostPerTurnUsd, this.costUsdThisTurn, "cost_per_turn") ?? {
        exhausted: false,
      }
    )
  }
}
