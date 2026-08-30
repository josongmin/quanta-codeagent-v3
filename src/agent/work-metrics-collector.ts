/**
 * Per-turn work-metrics collector (absorb #6, ADR-0064 wiring).
 *
 * A small mutable accumulator the loop pokes during a turn:
 *   - {@link recordToolCall}   bumps `agentActions`
 *   - {@link recordRead}       bumps `linesRead` when a `read` tool result lands
 *   - {@link recordUsage}      sums LLM input/output/cacheRead tokens
 *   - {@link recordDiff}       folds `git diff --numstat` rows into `diffMap`
 *   - {@link finalize}         returns a frozen {@link WorkMetrics} snapshot via
 *                              {@link buildWorkMetrics} (cost derived when the
 *                              caller supplies a known model)
 *
 * Why this lives in `@/agent`, not `@/observability`:
 * The slice rule (`biome.noRestrictedImports`) lets `@/agent` import
 * `@/observability/work-metrics` but NOT vice versa, AND the collector needs
 * the loop's tool/usage signals — which are agent-loop concepts. So the pure
 * observable module stays in `@/observability` and the wiring surface lives
 * here. The collector itself imports ONLY from `@/observability/work-metrics`.
 *
 * Default-OFF contract (RFC §1.2): the loop only instantiates a collector when
 * `AgentConfig.workMetricsSink !== undefined`. With the sink absent, this
 * module is unreferenced at runtime and the loop is byte-identical to the
 * pre-absorption path.
 */

import {
  buildWorkMetrics,
  costUsd,
  type FileDiffStat,
  parseNumstat,
  type WorkMetrics,
} from "@/observability"

/** Sink the loop emits the per-turn {@link WorkMetrics} into when configured.
 *  Absent ⇒ no collector is instantiated, no emit (byte-identical). The
 *  `ctx.turnId` is the same id the surface uses to correlate `turn_start` /
 *  `done` events (no new id space introduced). */
export interface WorkMetricsSink {
  emit(m: WorkMetrics, ctx: { turnId: string }): void
}

/** Mutable per-turn accumulator. One instance per turn; finalize at turn end.
 *
 * Pure logic (no clock, no IO). Fields are private and only touched through
 * the `recordX` / `finalize` methods so the contract is easy to audit. */
export class TurnWorkMetricsCollector {
  private agentActions = 0
  private linesRead = 0
  private tokensInput = 0
  // A4 — the recorded-cost accumulation (see recordUsage's `cost` doc).
  private sawRecordedCost = false
  private recordedKnownUsd = 0
  private recordedUnpriced = 0
  private tokensOutput = 0
  private cacheReadTokens: number | undefined = undefined
  /** MR-05 — per-MODEL token buckets. A turn can span several models (a `/model`
   *  switch between requests, a skill override for one step, a provider fallback),
   *  and cost is only correct when each request is priced with the model that
   *  actually ran it. */
  private readonly byModel = new Map<
    string,
    { tokensInput: number; tokensOutput: number; cacheReadTokens?: number }
  >()
  // Per-file running totals. Indexed by path so a same-file second emit
  // (e.g. a numstat row landing twice via two `git diff` calls) accumulates
  // rather than duplicates.
  private readonly diffByFile = new Map<string, FileDiffStat>()

  /** A tool call completed (success OR error — actions count work attempted,
   *  same as the pre-wired `agent.tool_calls` counter). `result` is accepted
   *  to keep the call-site uniform with `recordRead`; the value is unused for
   *  generic tools so the loop can pipe ALL dispatch results through one
   *  collector method. */
  recordToolCall(_name: string, _result?: unknown): void {
    this.agentActions += 1
  }

  /** When the tool is `read`, count the lines returned and add to `linesRead`.
   *  Detection is duck-typed by name (no `@/tool` import — preserves the
   *  collector's lone dependency on `@/observability`). `output` may be the
   *  full string returned by the tool OR an `{output:string}` envelope; both
   *  shapes are accepted because dispatch sites carry either. Lines are
   *  counted by `\n` splits — empty/whitespace-only outputs yield 0. */
  recordRead(name: string, output: unknown): void {
    if (name !== "read") return
    const text = this.extractText(output)
    if (text === undefined) return
    // An empty string is 0 lines; one line of content with no trailing newline
    // is 1 line; n newlines + non-empty tail is n+1 lines. `split("\n")` gives
    // the natural count and we drop the trailing empty when the text ended in
    // `\n` so `"a\nb\n"` reports 2 lines, not 3.
    if (text === "") return
    const parts = text.split("\n")
    const last = parts[parts.length - 1]
    const lines = last === "" ? parts.length - 1 : parts.length
    this.linesRead += lines
  }

  /**
   * Fold one usage report from a model stream. `cacheReadTokens` is summed lazily
   * — when never observed it stays `undefined` (preserves the optional contract on
   * the emitted {@link WorkMetrics}).
   *
   * MR-05 — `model` is the model THAT REQUEST ran on, reported by the adapter that
   * streamed it. Kept in a PER-MODEL bucket, because one turn can legitimately span
   * several: a `/model` switch between requests, a skill override for one step, a
   * provider fallback. Costing the whole turn at one model — which is what
   * `finalize(effectiveModelOf(cfg))` did, reading a LIVE selection at turn close —
   * priced every request at whatever happened to be selected when the turn ended.
   * Absent `model` ⇒ the tokens still land in the totals, just uncosted.
   */
  recordUsage(u: {
    tokensInput: number
    tokensOutput: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    model?: string
    /**
     * A4 — the cost the loop ACTUALLY billed for this event (the emitUsage
     * fan-out's single priced figure). When any event of the turn carries one,
     * `finalize()` sums THESE instead of re-deriving from buckets — the derive
     * cannot express cache-write and silently skips unknown models. Unpriced
     * events are counted, never absorbed into a confident-looking total.
     */
    cost?: UsageCost
  }): void {
    if (u.cost !== undefined) {
      this.sawRecordedCost = true
      if (u.cost.pricingKnown && Number.isFinite(u.cost.totalUsd)) {
        this.recordedKnownUsd += u.cost.totalUsd
      }
      if (!u.cost.pricingKnown) this.recordedUnpriced += 1
    }
    this.tokensInput += u.tokensInput
    this.tokensOutput += u.tokensOutput
    if (u.cacheReadTokens !== undefined) {
      this.cacheReadTokens = (this.cacheReadTokens ?? 0) + u.cacheReadTokens
    }
    if (u.model === undefined || u.model.length === 0) return
    const bucket = this.byModel.get(u.model) ?? { tokensInput: 0, tokensOutput: 0 }
    bucket.tokensInput += u.tokensInput
    bucket.tokensOutput += u.tokensOutput
    if (u.cacheReadTokens !== undefined) {
      bucket.cacheReadTokens = (bucket.cacheReadTokens ?? 0) + u.cacheReadTokens
    }
    this.byModel.set(u.model, bucket)
  }

  /** Cost summed over the per-model buckets, or `null` when no bucket has a known
   *  price. Each bucket is priced with ITS OWN model, then added — the only way a
   *  multi-model turn can report a true total. */
  private costFromBuckets(): number | null {
    let total = 0
    let known = false
    for (const [model, b] of this.byModel) {
      const cost = costUsd(model, b.tokensInput, b.tokensOutput, b.cacheReadTokens ?? 0)
      if (cost === null) continue
      known = true
      total += cost
    }
    return known ? total : null
  }

  /** Fold `git diff --numstat` stdout into the per-file running totals. Empty
   *  / malformed input is silently skipped (matches `parseNumstat`). */
  recordDiff(numstatStdout: string): void {
    for (const row of parseNumstat(numstatStdout)) {
      const prev = this.diffByFile.get(row.file)
      if (prev) {
        prev.addedLines += row.addedLines
        prev.removedLines += row.removedLines
      } else {
        this.diffByFile.set(row.file, {
          file: row.file,
          addedLines: row.addedLines,
          removedLines: row.removedLines,
        })
      }
    }
  }

  /** Snapshot the accumulator as a {@link WorkMetrics}. When `model` is a
   *  known pricing-table entry, `estimatedCostUsd` is derived; unknown / absent
   *  model ⇒ left undefined. Idempotent: the collector is NOT reset, so
   *  repeated finalize() calls observe the same state and yield equal
   *  snapshots (the loop instantiates one collector per turn, so resetting is
   *  unnecessary; idempotency only matters for accidental double-finalize). */
  /** The recorded-cost pair for {@link finalize}: the summed known spend and
   *  the unpriced-call count, or `undefined` when no event carried a cost. */
  private recordedCost(): { estimatedCostUsd: number; unpricedCalls?: number } | undefined {
    if (!this.sawRecordedCost) return undefined
    return {
      estimatedCostUsd: this.recordedKnownUsd,
      ...(this.recordedUnpriced > 0 ? { unpricedCalls: this.recordedUnpriced } : {}),
    }
  }

  finalize(model?: string): WorkMetrics {
    // Copy the per-file map to a fresh array so the returned snapshot does
    // NOT alias internal state — a subsequent recordDiff() would otherwise
    // mutate a previously-returned snapshot.
    const diffMap: FileDiffStat[] = [...this.diffByFile.values()].map((d) => ({
      file: d.file,
      addedLines: d.addedLines,
      removedLines: d.removedLines,
    }))
    if (model === undefined) {
      // No model ⇒ buildWorkMetrics would still derive cost off an empty
      // table lookup, which returns null → undefined. We could call it with
      // `model:""` but constructing the WorkMetrics directly here keeps the
      // intent obvious and avoids an unnecessary `""` lookup.
      const out: WorkMetrics = {
        diffMap,
        agentActions: this.agentActions,
        linesRead: this.linesRead,
        tokensInput: this.tokensInput,
        tokensOutput: this.tokensOutput,
      }
      if (this.cacheReadTokens !== undefined) out.cacheReadTokens = this.cacheReadTokens
      // Even with no caller-supplied label, the per-request buckets can price the
      // turn — the adapter reported which model each usage came from.
      const cost = this.costFromBuckets()
      if (cost !== null) out.estimatedCostUsd = cost
      return out
    }
    const bucketCost = this.costFromBuckets()
    if (bucketCost !== null) {
      // MR-05 — the per-model sum WINS over a single-model estimate. `model` here
      // is the caller's best label for the turn; pricing every request at it is
      // exactly the misattribution this replaces.
      const out: WorkMetrics = {
        diffMap,
        agentActions: this.agentActions,
        linesRead: this.linesRead,
        tokensInput: this.tokensInput,
        tokensOutput: this.tokensOutput,
        estimatedCostUsd: bucketCost,
      }
      if (this.cacheReadTokens !== undefined) out.cacheReadTokens = this.cacheReadTokens
      return out
    }
    return buildWorkMetrics({
      diffMap,
      agentActions: this.agentActions,
      linesRead: this.linesRead,
      model,
      tokensInput: this.tokensInput,
      tokensOutput: this.tokensOutput,
      ...(this.cacheReadTokens !== undefined ? { cacheReadTokens: this.cacheReadTokens } : {}),
    })
  }

  /** Best-effort extraction of the text payload from a tool result. Tool
   *  results land here in two shapes:
   *    - the raw `ToolResultBlock.content` string (when the loop pipes the
   *      block content directly);
   *    - an `{output:string}` envelope (when the loop pipes the dispatch
   *      result). Anything else returns `undefined` (skip). */
  private extractText(output: unknown): string | undefined {
    if (typeof output === "string") return output
    if (output !== null && typeof output === "object" && "output" in output) {
      const inner = (output as { output: unknown }).output
      if (typeof inner === "string") return inner
    }
    return undefined
  }
}
