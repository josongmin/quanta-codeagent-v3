/**
 * Composition-root auto-instrument helper (ADR-0161 Part 2). Wraps an entire
 * "subsystems bag" in one call so callers don't repeat the wrap-per-slice
 * boilerplate every bootstrap.
 *
 * Usage:
 *   const obs = await withFullObservability({
 *     llmProvider,
 *     scheduler,
 *     shadowOdb,
 *     planQueue,
 *     budgetLedger,
 *     lspClient,
 *     tools,
 *   }, { metrics })
 *   // obs has the same keys, each instrumented.
 *
 * Default-OFF: missing key → undefined passthrough (no wrap, no metrics).
 *
 * ADR-0169: opt-in `warnOnSkipped` + `skippedExpected` allowlist + `warn`
 * port help operators catch silent unwired-slice drift (e.g. someone added
 * a new bag key but forgot to wire it at composition root). Default behavior
 * is byte-identical to ADR-0161 when `warnOnSkipped` is absent.
 *
 * ADR-0172: opt-in `emitWiredGauge` flag emits one `observability.wired.total`
 * gauge per bag key with `{slice: <key>}` label and value `1` (wired) or `0`
 * (unwired). Machine-readable counterpart to ADR-0169's operator-facing log:
 * the log reminds humans during startup; the gauge feeds PromQL alerts and
 * dashboards. Default `false` — byte-identical when absent (no gauge emit).
 */

import type { BudgetLedger } from "@/agent/budget-ledger"
import type { PlanQueueStore } from "@/agent/plan-queue"
import type { BackgroundSubagentScheduler } from "@/agent/subagent-background"
import type { LlmProvider } from "@/llm/providers"
import type { ShadowOdb } from "@/storage/shadow-odb"
import type { Tool } from "@/tool"
import { instrumentLlmProvider, instrumentSubagentScheduler } from "./instrument"
import { instrumentBudgetLedger } from "./instrument-budget"
import { type InstrumentableLspClient, instrumentLspClient } from "./instrument-lsp"
import { instrumentPlanQueue } from "./instrument-plan-queue"
import { instrumentShadowOdb } from "./instrument-shadow"
import { instrumentTools } from "./instrument-tool"
import type { MetricsRegistry } from "./port"

export interface ObservabilityBag {
  readonly llmProvider?: LlmProvider
  readonly scheduler?: BackgroundSubagentScheduler
  readonly shadowOdb?: ShadowOdb
  readonly planQueue?: PlanQueueStore
  readonly budgetLedger?: BudgetLedger
  readonly lspClient?: InstrumentableLspClient
  readonly tools?: ReadonlyArray<Tool>
}

export interface ObservabilityOpts {
  readonly metrics: MetricsRegistry
  /** Optional per-subsystem name prefix override. */
  readonly prefixes?: Partial<{
    llm: string
    subagent: string
    shadow: string
    planQueue: string
    budget: string
    lsp: string
    tool: string
  }>
  /** When true, log a single combined warning at helper-construction time
   *  listing every bag key that's `undefined`. Set when the caller WANTS
   *  to be reminded ("I intend to wire LLM but I forgot today"). Default
   *  false — silent (matches today's behavior, byte-identical). */
  readonly warnOnSkipped?: boolean
  /** Set of bag keys to EXPECT skipped (no warning). Useful when a
   *  deployment intentionally doesn't wire a slice (e.g. read-only
   *  observability bot that has no LSP client). */
  readonly skippedExpected?: ReadonlySet<keyof ObservabilityBag>
  /** Inject the warning sink (default: console.warn). */
  readonly warn?: (msg: string) => void
  /** ADR-0172: when true, emit one gauge per `ObservabilityBag` key with
   *  value `1` (wired) or `0` (unwired) under metric name
   *  `observability.wired.total` with label `{slice: <key>}`. Operators
   *  query via PromQL (`observability_wired_total{slice="llmProvider"} == 0`
   *  → alert; `sum(observability_wired_total) by(slice) == 0` for any
   *  required slice). Default `false` — silent (byte-identical to today,
   *  no gauge emission).
   *
   *  Semantics: the gauge ALWAYS reflects truth — `skippedExpected` only
   *  silences the operator-facing warning log; an "intentionally skipped"
   *  slice still emits `observability.wired.total{slice=X} = 0`. The
   *  warning is operator-facing (sticky reminder), the gauge is
   *  machine-facing (PromQL-grepable wiring health). Different concerns;
   *  do not couple. */
  readonly emitWiredGauge?: boolean
}

export interface InstrumentedBag {
  readonly llmProvider: LlmProvider | undefined
  readonly scheduler: BackgroundSubagentScheduler | undefined
  readonly shadowOdb: ShadowOdb | undefined
  readonly planQueue: PlanQueueStore | undefined
  readonly budgetLedger: BudgetLedger | undefined
  readonly lspClient: InstrumentableLspClient | undefined
  readonly tools: ReadonlyArray<Tool> | undefined
}

/** Stable ordered enumeration of every `ObservabilityBag` key. Hand-maintained:
 *  adding a new key to `ObservabilityBag` requires extending this tuple so the
 *  skipped-warning path can see it. TypeScript can't iterate interface keys at
 *  runtime, so this is the canonical source — drift caught by the existing
 *  C8 drift-catcher e2e (key-set equality). */
const ALL_BAG_KEYS: ReadonlyArray<keyof ObservabilityBag> = [
  "llmProvider",
  "scheduler",
  "shadowOdb",
  "planQueue",
  "budgetLedger",
  "lspClient",
  "tools",
] as const

export const withFullObservability = (
  bag: ObservabilityBag,
  opts: ObservabilityOpts,
): InstrumentedBag => {
  const m = opts.metrics
  const px = opts.prefixes ?? {}
  const out: InstrumentedBag = {
    llmProvider:
      bag.llmProvider !== undefined
        ? instrumentLlmProvider(bag.llmProvider, m, px.llm ? { namePrefix: px.llm } : {})
        : undefined,
    scheduler:
      bag.scheduler !== undefined
        ? instrumentSubagentScheduler(
            bag.scheduler,
            m,
            px.subagent ? { namePrefix: px.subagent } : {},
          )
        : undefined,
    shadowOdb:
      bag.shadowOdb !== undefined
        ? instrumentShadowOdb(bag.shadowOdb, m, px.shadow ? { namePrefix: px.shadow } : {})
        : undefined,
    planQueue:
      bag.planQueue !== undefined
        ? instrumentPlanQueue(bag.planQueue, m, px.planQueue ? { namePrefix: px.planQueue } : {})
        : undefined,
    budgetLedger:
      bag.budgetLedger !== undefined
        ? instrumentBudgetLedger(bag.budgetLedger, m, px.budget ? { namePrefix: px.budget } : {})
        : undefined,
    lspClient:
      bag.lspClient !== undefined
        ? instrumentLspClient(bag.lspClient, m, px.lsp ? { namePrefix: px.lsp } : {})
        : undefined,
    tools:
      bag.tools !== undefined
        ? instrumentTools(bag.tools, m, px.tool ? { namePrefix: px.tool } : {})
        : undefined,
  }
  if (opts.warnOnSkipped === true) {
    const expected = opts.skippedExpected
    const actuallySkipped = ALL_BAG_KEYS.filter(
      (k) => bag[k] === undefined && !(expected?.has(k) ?? false),
    )
    if (actuallySkipped.length > 0) {
      const msg = `[observability] withFullObservability: ${actuallySkipped.length} slice(s) unwired and not in skippedExpected: ${actuallySkipped.join(", ")}. Set 'skippedExpected' to silence intentional skips.`
      if (opts.warn !== undefined) {
        opts.warn(msg)
      } else {
        // biome-ignore lint/suspicious/noConsole: documented default sink (ADR-0169)
        console.warn(msg)
      }
    }
  }
  if (opts.emitWiredGauge === true) {
    // ADR-0172: emit one gauge per bag key. Value = 1 when wrapped output is
    // defined (slice was wired), 0 otherwise. Gauge name is the meta-metric
    // `observability.wired.total` regardless of `opts.prefixes` (prefixes
    // scope per-subsystem metrics; this gauge is about the helper itself).
    // Sink failures are swallowed per-key so one broken gauge does not block
    // the remaining 6 — `metrics.gauge` is documented no-throw on the
    // in-memory registry, but a custom adapter may throw; we defend here.
    for (const k of ALL_BAG_KEYS) {
      try {
        m.gauge("observability.wired.total", out[k] === undefined ? 0 : 1, { slice: k })
      } catch {
        // continue — other slices still get their gauge.
      }
    }
  }
  return out
}
