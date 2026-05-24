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
 */

import type { LlmProvider } from "@/llm/providers"
import type { BackgroundSubagentScheduler } from "@/agent/subagent-background"
import type { ShadowOdb } from "@/storage/shadow-odb"
import type { PlanQueueStore } from "@/agent/plan-queue"
import type { BudgetLedger } from "@/agent/budget-ledger"
import type { Tool } from "@/tool"
import type { MetricsRegistry } from "./port"
import { instrumentLlmProvider, instrumentSubagentScheduler } from "./instrument"
import { instrumentShadowOdb } from "./instrument-shadow"
import { instrumentTools } from "./instrument-tool"
import { instrumentPlanQueue } from "./instrument-plan-queue"
import { instrumentBudgetLedger } from "./instrument-budget"
import { type InstrumentableLspClient, instrumentLspClient } from "./instrument-lsp"

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

export const withFullObservability = (
  bag: ObservabilityBag,
  opts: ObservabilityOpts,
): InstrumentedBag => {
  const m = opts.metrics
  const px = opts.prefixes ?? {}
  return {
    llmProvider: bag.llmProvider !== undefined ? instrumentLlmProvider(bag.llmProvider, m, px.llm ? { namePrefix: px.llm } : {}) : undefined,
    scheduler: bag.scheduler !== undefined ? instrumentSubagentScheduler(bag.scheduler, m, px.subagent ? { namePrefix: px.subagent } : {}) : undefined,
    shadowOdb: bag.shadowOdb !== undefined ? instrumentShadowOdb(bag.shadowOdb, m, px.shadow ? { namePrefix: px.shadow } : {}) : undefined,
    planQueue: bag.planQueue !== undefined ? instrumentPlanQueue(bag.planQueue, m, px.planQueue ? { namePrefix: px.planQueue } : {}) : undefined,
    budgetLedger: bag.budgetLedger !== undefined ? instrumentBudgetLedger(bag.budgetLedger, m, px.budget ? { namePrefix: px.budget } : {}) : undefined,
    lspClient: bag.lspClient !== undefined ? instrumentLspClient(bag.lspClient, m, px.lsp ? { namePrefix: px.lsp } : {}) : undefined,
    tools: bag.tools !== undefined ? instrumentTools(bag.tools, m, px.tool ? { namePrefix: px.tool } : {}) : undefined,
  }
}
