/**
 * Tier-1 per-subsystem builder: BUDGET block (ADR-0136).
 *
 * Returns `[budgetStatusTool(ledger)]` when a ledger is wired; `[]` otherwise
 * (DEFAULT-OFF — byte-identical for every legacy caller). The ledger is the
 * pure in-memory primitive from `@/agent/budget-ledger` (token × pricing → $$
 * + soft/hard breach events at session/daily scope).
 *
 * Slot shape: this builder reads `cfg.budgetLedger` via a NARROW structural
 * type — we intentionally do NOT extend the canonical `AgentConfig` here
 * (constraint: no modifications to `src/agent/types.ts`). The composition
 * root can pass either a typed config object that happens to carry a
 * `budgetLedger?` field, or `undefined` to opt out.
 *
 * Recording is still DEFERRED: `buildSessionFeatures()` already invokes this
 * builder, so `budget_status` is registered whenever `budgetLedger` is wired.
 * The remaining follow-up is the producer-side auto-record path from LLM
 * usage events into the ledger.
 */

import type { Tool } from "@/tool"
import type { BudgetLedger } from "../budget-ledger"
import { createBudgetStatusTool } from "../budget-tool"

/** Narrow structural shape — only the slot this builder actually reads.
 *  Kept local so we never depend on the canonical `AgentConfig` shape. */
export interface BudgetBuilderConfig {
  readonly budgetLedger?: BudgetLedger
}

/** Build the budget block. When `config.budgetLedger` is wired, returns the
 *  single `budget_status` tool; otherwise returns an empty array so the
 *  composer can splat without a conditional. */
export const buildBudgetBlock = (config: BudgetBuilderConfig): Tool[] =>
  config.budgetLedger === undefined ? [] : [createBudgetStatusTool(config.budgetLedger)]
