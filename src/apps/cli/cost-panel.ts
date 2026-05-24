/**
 * Cumulative session cost panel — sticky session-wide spend tracker (Claude
 * SOTA-inspired). Complements the existing per-turn `renderTurnDashboard`
 * (which paints a fresh snapshot at each turn end) by aggregating across the
 * whole REPL session so the operator sees TOTAL spend even when idle.
 *
 * Two renderers share one mutable state:
 *  - {@link CostPanel.render}         — single-line status-bar form
 *  - {@link CostPanel.renderDetailed} — boxed multi-line for `/cost` slash
 *
 * Design constraints (pin):
 *  - **Default-ON for TTY** — caller gates with {@link isCostPanelEnabled}.
 *    Non-TTY surfaces (pipes, redirects, eval/bench) get a disabled instance ⇒
 *    every method is a no-op + the slash command prints "not wired".
 *  - **Read-only @/observability** — `costUsd` from `@/observability/pricing`
 *    is the single source of truth. We DO NOT mint our own price table; if
 *    the provider returns `null` (unknown model) we propagate `null` ⇒
 *    "n/a" in the render. No silent $0.
 *  - **Pure DI** — `now` is injectable so tests drive the duration clock
 *    without `Date.now()`.
 *  - **Slice isolation** — imports from `@/observability` + `@/ui/ui-helpers`
 *    only. No `@/agent`, no `@/llm`, no `@/stream`.
 */

import { costUsd } from "@/observability"
import { dim, gray, renderBox } from "@/ui/ui-helpers"

export interface CostPanelState {
  /** Session start (ms epoch). */
  sessionStart: number
  /** Cumulative turn count (incremented by {@link CostPanel.incrementTurn}). */
  turns: number
  /** Cumulative input tokens across all turns. */
  inputTokens: number
  /** Cumulative output tokens across all turns. */
  outputTokens: number
  /** Cumulative cache-read tokens (Anthropic disjoint bucket / OpenAI subset). */
  cacheReadTokens: number
  /** Accumulated USD cost. `null` when no turn has produced a known-model
   *  cost yet (the per-turn cost stays null for unknown models). */
  totalCostUsd: number | null
  /** Most recent model id (last-writer-wins across heterogeneous turns). */
  model: string
}

export interface CostPanelUsageDelta {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  /** Pre-computed USD cost for THIS turn. When omitted we derive it via
   *  `costUsd(state.model, ...)` so the panel still produces a value when
   *  the caller only hands us tokens. */
  costUsd?: number | null
}

export interface CostPanel {
  /** Read-only snapshot for tests + the slash command. */
  snapshot(): CostPanelState
  /** Patch any field — used by the REPL to push the active model id when
   *  it changes mid-session (e.g. `/retry-with`). */
  update(patch: Partial<CostPanelState>): void
  /** Fold a single-turn usage delta into the cumulative state. Increments
   *  `turns` by 1. `cacheReadTokens` defaults to 0. When `costUsd` is
   *  omitted we derive it from the current model + the new token counts;
   *  unknown model ⇒ contributes nothing to `totalCostUsd` (the running
   *  sum is preserved). */
  incrementTurn(usage: CostPanelUsageDelta): void
  /** Single-line render — used as a status-bar slot. Empty string when the
   *  panel is disabled. */
  render(): string
  /** Boxed multi-line render — used by the `/cost` slash command. Empty
   *  string when disabled. */
  renderDetailed(): string
  /** Tear-down hook (reserved for future async writers; no-op today). */
  dispose(): void
}

export interface CostPanelOptions {
  /** When false, every method is a no-op (`render*` returns `""`). Default
   *  `true`. Caller's env/TTY gate decides whether to even construct one. */
  enabled?: boolean
  /** Clock injection for tests. Defaults to `Date.now`. */
  now?: () => number
  /** Initial model id stamped on the state. Required (caller already knows
   *  the active model when assembling the REPL stack). */
  model: string
}

// ── formatters ──────────────────────────────────────────────────────────

/** Compact token formatter — "1,247" / "12.3k" / "1.20M". Mirrors the
 *  turn-indicator formatter shape so the two surfaces look consistent. */
const formatTokens = (n: number): string => {
  if (n < 1000) return n.toLocaleString("en-US")
  if (n < 10_000) return n.toLocaleString("en-US")
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

/** Format a USD total with sub-cent precision for small spends and 2-decimal
 *  precision once the bill exceeds $1. `null` ⇒ "n/a" (unknown model). */
const formatUsd = (usd: number | null): string => {
  if (usd === null) return "n/a"
  if (!Number.isFinite(usd)) return "n/a"
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  if (usd < 1) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(2)}`
}

/** "12m 34s" / "5s" / "1h 2m". Pure formatter used by both renderers. */
const formatDuration = (ms: number): string => {
  if (!Number.isFinite(ms) || ms < 0) return "0s"
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec - h * 3600) / 60)
  const s = totalSec - h * 3600 - m * 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

const renderDisabled = (): string => ""

/** Right-pad a label to a fixed column width so the detailed box rows align. */
const padLabel = (label: string, width = 14): string => label.padEnd(width)

// ── factory ─────────────────────────────────────────────────────────────

export const createCostPanel = (opts: CostPanelOptions): CostPanel => {
  const enabled = opts.enabled ?? true
  const now = opts.now ?? Date.now
  const state: CostPanelState = {
    sessionStart: now(),
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    totalCostUsd: null,
    model: opts.model,
  }

  const accumulateCost = (turnCost: number | null): void => {
    if (turnCost === null || !Number.isFinite(turnCost)) return
    state.totalCostUsd = (state.totalCostUsd ?? 0) + turnCost
  }

  // Single typed-key assigner — biome's cognitive-complexity budget rejects
  // the 7-arm `if (patch.X !== undefined) state.X = patch.X` ladder, but a
  // closed key list driving Object.assign is structurally one decision and
  // keeps the type-safety (every state field name is statically listed).
  const PATCH_KEYS = [
    "sessionStart",
    "turns",
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "totalCostUsd",
    "model",
  ] as const satisfies ReadonlyArray<keyof CostPanelState>

  const applyPatch = (patch: Partial<CostPanelState>): void => {
    for (const k of PATCH_KEYS) {
      const v = patch[k]
      if (v === undefined) continue
      // Each branch assigns a same-typed value to the corresponding field.
      // The `as never` cast avoids a TS variance complaint on the union;
      // the closed key list keeps the operation safe at runtime.
      ;(state[k] as unknown) = v
    }
  }

  return {
    snapshot: () => ({ ...state }),

    update: (patch) => {
      if (!enabled) return
      applyPatch(patch)
    },

    incrementTurn: (usage) => {
      if (!enabled) return
      state.turns += 1
      state.inputTokens += Math.max(0, usage.inputTokens ?? 0)
      state.outputTokens += Math.max(0, usage.outputTokens ?? 0)
      state.cacheReadTokens += Math.max(0, usage.cacheReadTokens ?? 0)
      // Resolve cost: caller-provided > derived via pricing > null.
      const provided = usage.costUsd
      if (provided !== undefined) {
        accumulateCost(provided ?? null)
        return
      }
      const turnCost = costUsd(
        state.model,
        Math.max(0, usage.inputTokens ?? 0),
        Math.max(0, usage.outputTokens ?? 0),
        Math.max(0, usage.cacheReadTokens ?? 0),
      )
      accumulateCost(turnCost)
    },

    render: () => {
      if (!enabled) return renderDisabled()
      const cost = formatUsd(state.totalCostUsd)
      const turnLabel = `${state.turns} turn${state.turns === 1 ? "" : "s"}`
      const tokens = `${formatTokens(state.inputTokens)} in / ${formatTokens(state.outputTokens)} out`
      return `${cost} · ${turnLabel} · ${tokens} · ${state.model}`
    },

    renderDetailed: () => {
      if (!enabled) return renderDisabled()
      const duration = formatDuration(now() - state.sessionStart)
      const perTurn =
        state.totalCostUsd !== null && state.turns > 0
          ? formatUsd(state.totalCostUsd / state.turns)
          : "n/a"
      const lines = [
        `${padLabel("Duration:")}${duration}`,
        `${padLabel("Turns:")}${state.turns.toLocaleString("en-US")}`,
        `${padLabel("Input:")}${state.inputTokens.toLocaleString("en-US")} tok`,
        `${padLabel("Output:")}${state.outputTokens.toLocaleString("en-US")} tok`,
        `${padLabel("Cache read:")}${state.cacheReadTokens.toLocaleString("en-US")} tok`,
        `${padLabel("Total cost:")}${formatUsd(state.totalCostUsd)}`,
        `${padLabel("Per turn avg:")}${perTurn}`,
        `${padLabel("Model:")}${state.model}`,
      ]
      return renderBox(lines, {
        title: "session cost",
        titleStyle: gray,
        borderStyle: dim,
        minInner: 42,
      })
    },

    dispose: () => undefined,
  }
}

/** Pure env/TTY gate. Default-ON when stdout is a TTY; only an explicit
 *  `QUANTA_COST_PANEL=0|false|off|no` disables. Non-TTY surfaces (pipes,
 *  redirects, eval/bench) always return false so the panel stays silent. */
export const isCostPanelEnabled = (env: NodeJS.ProcessEnv, isTTY: boolean | undefined): boolean => {
  if (isTTY !== true) return false
  const knob = env.QUANTA_COST_PANEL
  if (knob === undefined) return true
  const norm = knob.trim().toLowerCase()
  return norm !== "0" && norm !== "false" && norm !== "off" && norm !== "no"
}
