/**
 * Knob: `task-budget` — SOFT, model-facing task token budget (jun-02).
 *
 * Claude's `task_budget: { type: "tokens", total: N }` surfaces a budget TO
 * THE MODEL so it can self-moderate — prioritize, then wrap up cleanly as the
 * remaining budget nears zero. This knob is the quanta wire: it sets
 * `config.taskBudget`, which the loop forwards (with `spent` accumulated from
 * observed usage) into `buildTurnContext` so a single advisory line rides the
 * trailing `<system-reminder>`.
 *
 * ORTHOGONAL to the hard `BudgetMeter` breaker (ADR-0138): this NEVER stops the
 * run, NEVER throws, NEVER mutates enforcement state. It is pure guidance.
 *
 * Default-OFF. Mirrors `branch-search` exactly:
 *   - `parse(raw) → Value | undefined`, no `default` (absent ⇒ inactive).
 *   - `apply` is PURE and sets `config.taskBudget`.
 *
 * Domain (ACTIVE):
 *   - integer N > 0 ⇒ `{ tokens: N }`.
 *
 * Domain (INACTIVE — `parse` returns `undefined`, byte-identical default-OFF):
 *   - absent / empty / whitespace
 *   - `"0"` / negative / non-integer / NaN / Infinity / garbage
 *     (a non-positive total carries no meaningful budget — the renderer would
 *      return `undefined` anyway, so we reject it at the knob to keep the
 *      AgentConfig untouched and the dynamic context byte-identical).
 */

import type { AgentConfig, TaskBudget } from "@/agent"
import { registerKnob } from "../registry"
import type { Knob, Surface } from "../types"

const SURFACES: readonly Surface[] = ["cli", "agent-batch", "agent-interactive"]

const parseTaskBudget = (raw: string | undefined): TaskBudget | undefined => {
  if (raw === undefined) return undefined
  const s = raw.trim()
  if (s === "") return undefined
  // Reject internal whitespace, signs, decimals — anything that isn't a run of
  // digits. This excludes `"-5"`, `"1.5"`, `"1e3"`, `"Infinity"`, `"NaN"`,
  // `"10 "` (already trimmed), `"1_000"`, and garbage in one predicate.
  if (!/^\d+$/.test(s)) return undefined
  const n = Number(s)
  // `^\d+$` already guarantees finite + integer; the explicit guard documents
  // the invariant and pins it against future regex drift. `> 0` rejects `"0"`.
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return undefined
  return { tokens: n }
}

const applyTaskBudget = (
  cfg: AgentConfig,
  value: TaskBudget,
  ctx: { surface: Surface },
): AgentConfig => {
  if (!SURFACES.includes(ctx.surface)) return cfg
  return { ...cfg, taskBudget: value }
}

export const taskBudgetKnob: Knob<TaskBudget> = {
  id: "task-budget",
  envKey: "QUANTA_TASK_BUDGET",
  category: "hint",
  surfaces: SURFACES,
  parse: parseTaskBudget,
  apply: applyTaskBudget,
  describe: "Soft model-facing token budget — advisory self-moderation line (never a hard stop)",
  // Pure guidance: adds one reminder line, no extra model calls or trajectories.
  costMultiplier: 1,
  source: "jun-02 / Claude task_budget mirror",
}

registerKnob(taskBudgetKnob)
