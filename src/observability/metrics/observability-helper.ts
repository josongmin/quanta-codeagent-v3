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
import { errMessage } from "@/shared"
import type { ShadowOdb } from "@/storage/shadow-odb"
// biome-ignore lint/style/noRestrictedImports: type-only import (erased at compile time) — no runtime slice coupling; the AST slice-boundary scanner exempts type imports.
import type { Tool } from "@/tool"
import { buildHealthSnapshot, writeHealthSnapshot } from "./health-snapshot"
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
  /** ADR-0177: when set, write a JSON health snapshot to this path at
   *  helper construction time. Absolute paths are used verbatim; relative
   *  paths are anchored to `${os.homedir()}/.quanta/`. Pass `true` to use
   *  the default `${os.homedir()}/.quanta/health.json`. Default = no write
   *  (byte-identical to ADR-0172 baseline). Errors are swallowed and routed
   *  to `opts.warn` (or `console.warn`) — the snapshot is operator
   *  convenience, never a hot-path failure mode. */
  readonly healthSnapshotPath?: string | true
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

/** The ONE wrap-or-passthrough gate. Every bag slice used to spell this
 *  3-way decision out inline (`present? -> instrument(..., prefix? -> {namePrefix} : {})
 *  : undefined`), seven times over. Contract, unchanged from the inline form:
 *   - `value === undefined` (slice unwired)  -> `undefined`, no instrument call
 *   - falsy `prefix` (absent OR empty string) -> `{}`, so the instrument keeps
 *     its own default prefix. Empty string deliberately falls back — matching
 *     the original truthiness test, NOT an `!== undefined` test. */
const wrapSlice = <V, R>(
  value: V | undefined,
  metrics: MetricsRegistry,
  prefix: string | undefined,
  instrument: (v: V, m: MetricsRegistry, opts: { namePrefix?: string }) => R,
): R | undefined =>
  value === undefined ? undefined : instrument(value, metrics, prefix ? { namePrefix: prefix } : {})

/** ADR-0169 — one combined operator warning naming every unwired-and-unexpected
 *  slice. `skippedExpected` silences intentional skips (and ONLY the log; the
 *  ADR-0172 gauge still reports the truth). Silent when nothing qualifies. */
const warnSkippedSlices = (bag: ObservabilityBag, opts: ObservabilityOpts): void => {
  const expected = opts.skippedExpected
  const actuallySkipped = ALL_BAG_KEYS.filter(
    (k) => bag[k] === undefined && !(expected?.has(k) ?? false),
  )
  if (actuallySkipped.length === 0) return
  const msg = `[observability] withFullObservability: ${actuallySkipped.length} slice(s) unwired and not in skippedExpected: ${actuallySkipped.join(", ")}. Set 'skippedExpected' to silence intentional skips.`
  // Slice invariant (ADR-0144): no console.* in @/observability. Caller injects warn sink; absent ⇒ silent.
  opts.warn?.(msg)
}

/** ADR-0172 — one `observability.wired.total` gauge per bag key, in
 *  `ALL_BAG_KEYS` order, value 1 (wired) / 0 (unwired). The gauge name ignores
 *  `opts.prefixes` on purpose: prefixes scope per-subsystem metrics, this one
 *  is about the helper itself. Sink failures are swallowed PER KEY so one
 *  broken gauge cannot block the remaining six. */
const emitWiredGauges = (metrics: MetricsRegistry, out: InstrumentedBag): void => {
  for (const k of ALL_BAG_KEYS) {
    try {
      metrics.gauge("observability.wired.total", out[k] === undefined ? 0 : 1, { slice: k })
    } catch {
      // continue — other slices still get their gauge.
    }
  }
}

/** ADR-0177 — fire-and-forget JSON health snapshot mirroring the wired-gauge
 *  state. The helper stays SYNC (construction-time convenience, never a hot
 *  path), so the write is launched and its promise parked in `lastInFlight`
 *  for tests. Build errors and write errors both route to `opts.warn`; neither
 *  may propagate. No-op when `healthSnapshotPath` is absent. */
const writeHealthSnapshotIfRequested = (out: InstrumentedBag, opts: ObservabilityOpts): void => {
  if (opts.healthSnapshotPath === undefined) return
  try {
    const snap = buildHealthSnapshot(
      out,
      opts.skippedExpected ? { skippedExpected: opts.skippedExpected } : {},
    )
    const pathOpt = opts.healthSnapshotPath === true ? undefined : opts.healthSnapshotPath
    const writeOpts = pathOpt !== undefined ? { path: pathOpt } : {}
    const warn = opts.warn
    lastInFlight = writeHealthSnapshot(snap, writeOpts).catch((err: unknown) => {
      const msg = `[observability] health snapshot write failed: ${errMessage(err)}`
      // Slice invariant: warn opt only; no console.* fallback.
      warn?.(msg)
      return ""
    })
  } catch (err) {
    const msg = `[observability] health snapshot build failed: ${errMessage(err)}`
    // Slice invariant: warn opt only; no console.* fallback.
    opts.warn?.(msg)
  }
}

export const withFullObservability = (
  bag: ObservabilityBag,
  opts: ObservabilityOpts,
): InstrumentedBag => {
  const m = opts.metrics
  const px = opts.prefixes ?? {}
  const out: InstrumentedBag = {
    llmProvider: wrapSlice(bag.llmProvider, m, px.llm, instrumentLlmProvider),
    scheduler: wrapSlice(bag.scheduler, m, px.subagent, instrumentSubagentScheduler),
    shadowOdb: wrapSlice(bag.shadowOdb, m, px.shadow, instrumentShadowOdb),
    planQueue: wrapSlice(bag.planQueue, m, px.planQueue, instrumentPlanQueue),
    budgetLedger: wrapSlice(bag.budgetLedger, m, px.budget, instrumentBudgetLedger),
    lspClient: wrapSlice(bag.lspClient, m, px.lsp, instrumentLspClient),
    tools: wrapSlice(bag.tools, m, px.tool, instrumentTools),
  }
  if (opts.warnOnSkipped === true) warnSkippedSlices(bag, opts)
  if (opts.emitWiredGauge === true) emitWiredGauges(m, out)
  writeHealthSnapshotIfRequested(out, opts)
  return out
}

/** ADR-0177 test seam: the in-flight health-snapshot write promise from the
 *  most recent `withFullObservability(... healthSnapshotPath ...)` call, or
 *  `undefined` if none has fired. Production code SHOULD NOT depend on this —
 *  it exists so tests (and operator scripts that want construction-time
 *  confirmation) can `await lastHealthSnapshotInFlight()` before reading the
 *  file back. Resolves to the final path on success or `""` on swallowed
 *  failure. */
let lastInFlight: Promise<string> | undefined
export const lastHealthSnapshotInFlight = (): Promise<string> | undefined => lastInFlight
