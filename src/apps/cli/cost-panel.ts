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
import {
  type CostSurfaceView,
  costSurfaceView,
  type UsageAccountingPort,
} from "@/observability/usage-accounting"
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
   *  `costUsd(model, ...)` so the panel still produces a value when the caller
   *  only hands us tokens. */
  costUsd?: number | null
  /**
   * The model THIS usage ran on (MR-05), as reported by the adapter that streamed
   * it. Absent ⇒ `state.model`, the session's boot label.
   *
   * The panel used to have no way to learn a model at all: `state.model` was set
   * once at session start and NOTHING in production ever called `update({model})`
   * — grep found zero callers. So after a `/model` switch every turn was priced
   * with the boot model's rates and bucketed under its name, which is worse than a
   * missing number because it looks like data.
   */
  model?: string
}

/** §23.5 — per-model cumulative bucket. One per distinct model id seen across
 *  the session (attributed to whichever model was active at each turn). */
export interface ModelCostBucket {
  readonly model: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  /** `null` until a known-model turn produced a cost (mirrors the aggregate). */
  readonly costUsd: number | null
}

export interface CostPanel {
  /** Read-only snapshot for tests + the slash command. */
  snapshot(): CostPanelState
  /** §23.5 — per-model cumulative breakdown, sorted by model id
   *  (deterministic). Empty when disabled or before any turn. A
   *  heterogeneous-model session is no longer collapsed to the last model. */
  byModel(): readonly ModelCostBucket[]
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
  /**
   * MR-04 — the session's usage-accounting authority.
   *
   * When present the panel PROJECTS it: every token and dollar it reports comes
   * from that one snapshot, and `incrementTurn`'s own accumulation is inert. It
   * is the reason the status line, `/cost`, and the dashboards stop being able
   * to disagree — and the reason subagent spend appears at all, since the
   * counter feed the panel used to read never saw a child.
   *
   * Turn COUNT stays panel-local. A turn is a UI concept and a turn can contain
   * several model calls, so it is not something the accountant can answer;
   * `incrementTurn` keeps advancing it even in projected mode.
   */
  accounting?: UsageAccountingPort
}

// ── formatters ──────────────────────────────────────────────────────────

/** Compact token formatter — "1,247" / "12.3k" / "1.20M". Mirrors the
 *  turn-indicator formatter shape so the two surfaces look consistent. */
const formatTokens = (n: number): string => {
  if (n < 10_000) return n.toLocaleString("en-US")
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

/** Strip C0/C1/DEL control bytes from a model id before it is interpolated into
 *  a status line or the boxed `/cost` report. A model id ultimately comes from
 *  operator config, but an embedded ANSI/OSC escape would corrupt the box
 *  border or rewrite the terminal title — same terminal-injection defense the
 *  notify/auto-title slices apply. Cap keeps a pathological id from blowing out
 *  the box width. */
const sanitizeModel = (m: string): string =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberately stripping control bytes
  m.replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, 64)

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

/**
 * The panel's shared state: the running totals and the formatting helpers both
 * renderers use. Split out of `createCostPanel` (god-function burndown).
 */
const panelState = (opts: CostPanelOptions) => {
  const enabled = opts.enabled ?? true
  const now = opts.now ?? Date.now
  const state: CostPanelState = {
    sessionStart: now(),
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    totalCostUsd: null,
    model: sanitizeModel(opts.model),
  }

  // §23.5 — per-model cumulative buckets. Keyed by the model active at each
  // turn. Kept as a closure var (NOT on CostPanelState) so `snapshot()` stays
  // byte-identical and existing deep-reads are unaffected.
  const perModel = new Map<
    string,
    { inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: number | null }
  >()
  const bucketFor = (
    model: string,
  ): {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    costUsd: number | null
  } => {
    let b = perModel.get(model)
    if (b === undefined) {
      b = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: null }
      perModel.set(model, b)
    }
    return b
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
    // Model id may arrive via a mid-session patch (e.g. /retry-with) — keep the
    // same control-byte defense as construction so render() can't be poisoned.
    state.model = sanitizeModel(state.model)
  }

  // Deterministic model ordering — byte compare (avoids locale drift).
  const sortedModelEntries = (): Array<
    [
      string,
      {
        inputTokens: number
        outputTokens: number
        cacheReadTokens: number
        costUsd: number | null
      },
    ]
  > => [...perModel.entries()].sort((a, z) => (a[0] < z[0] ? -1 : a[0] > z[0] ? 1 : 0))
  return {
    enabled,
    now,
    state,
    perModel,
    bucketFor,
    accumulateCost,
    PATCH_KEYS,
    applyPatch,
    sortedModelEntries,
    accounting: opts.accounting,
  }
}

/** The state every operation group shares, inferred from {@link panelState} so it
 *  can never drift from what that function actually builds. */
type PanelCtx = ReturnType<typeof panelState>

/** Accounting: the totals, their per-model breakdown, and the two mutators
 *  that advance them. */
const accountingOps = (
  ctx: PanelCtx,
): Pick<CostPanel, "snapshot" | "byModel" | "update" | "incrementTurn"> => {
  const { enabled, state, applyPatch, sortedModelEntries, accounting } = ctx
  /** The authority's current numbers, or `undefined` when unwired. */
  const projected = (): CostSurfaceView | undefined =>
    accounting === undefined ? undefined : costSurfaceView(accounting.snapshot())

  return {
    snapshot: () => {
      const view = projected()
      if (view === undefined) return { ...state }
      // `turns` and `model` remain panel-local: one is a UI concept the
      // accountant does not model, the other is the session's label.
      return {
        ...state,
        inputTokens: view.promptTokens,
        outputTokens: view.outputTokens,
        cacheReadTokens: view.cacheReadTokens,
        // `null` only when nothing has been spent yet — the panel's contract
        // for "no known-model cost has landed", preserved.
        totalCostUsd: view.calls === 0 ? null : view.totalUsd,
      }
    },

    byModel: () => {
      if (!enabled) return []
      const view = projected()
      if (view === undefined) return sortedModelEntries().map(([model, b]) => ({ model, ...b }))
      return view.byModel.map((line) => ({
        model: line.model,
        inputTokens: line.promptTokens,
        outputTokens: line.outputTokens,
        cacheReadTokens: line.cacheReadTokens,
        costUsd: line.totalUsd,
      }))
    },

    update: (patch) => {
      if (!enabled) return
      applyPatch(patch)
    },

    incrementTurn: (usage) => {
      if (!enabled) return
      state.turns += 1
      // Projected mode: the accountant owns every token and dollar, so the turn
      // count above is the only thing left for this panel to advance.
      if (accounting === undefined) accumulateLegacyTurn(ctx, usage)
    },
  }
}

/** The pre-MR-04 accumulation path: fold one turn's counter DELTA into the
 *  panel's own state. Reached only when no accounting authority is wired, and
 *  deleted outright once the authority is the only feed (MR-07). Kept whole and
 *  separate rather than interleaved with the projected branch, so the two feeds
 *  never half-mix. */
const accumulateLegacyTurn = (ctx: PanelCtx, usage: CostPanelUsageDelta): void => {
  const { state, bucketFor, accumulateCost } = ctx
  const inTok = Math.max(0, usage.inputTokens ?? 0)
  const outTok = Math.max(0, usage.outputTokens ?? 0)
  const cacheTok = Math.max(0, usage.cacheReadTokens ?? 0)
  state.inputTokens += inTok
  state.outputTokens += outTok
  state.cacheReadTokens += cacheTok
  // Resolve cost ONCE: caller-provided > derived via pricing > null. Used
  // for BOTH the aggregate and the per-model bucket so they never diverge.
  // MR-05 — price and bucket by the model THIS usage ran on.
  const usageModel = usage.model !== undefined && usage.model.length > 0 ? usage.model : state.model
  const rawCost =
    usage.costUsd !== undefined ? usage.costUsd : costUsd(usageModel, inTok, outTok, cacheTok)
  // Clamp a finite negative cost to 0 — symmetric with the Math.max(0, …)
  // token clamps above. A negative bill (from a buggy/hostile upstream cost)
  // must never drive the cumulative total below zero.
  const turnCost = rawCost !== null && Number.isFinite(rawCost) ? Math.max(0, rawCost) : rawCost
  accumulateCost(turnCost)
  // §23.5 — attribute to the model active at this turn.
  const b = bucketFor(usageModel)
  b.inputTokens += inTok
  b.outputTokens += outTok
  b.cacheReadTokens += cacheTok
  if (turnCost !== null && Number.isFinite(turnCost)) {
    b.costUsd = (b.costUsd ?? 0) + turnCost
  }
}

/** Presentation + teardown. Rendering reads the accounting state and never
 *  mutates it. */
const renderOps = (ctx: PanelCtx): Pick<CostPanel, "render" | "renderDetailed" | "dispose"> => {
  const { enabled, now, state, sortedModelEntries, accounting } = ctx
  /**
   * Per-model rows for `/cost`, from whichever feed owns the numbers.
   *
   * This used to read `perModel` directly, which is the LEGACY internal map —
   * so in projected mode it was empty and the breakdown silently never
   * rendered, even though `byModel()` next door projected it correctly. Two
   * readers of "the per-model numbers" is exactly the split this campaign is
   * closing; there is one here now.
   */
  const modelRows = (): readonly {
    model: string
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    costUsd: number | null
  }[] => {
    if (accounting === undefined) {
      return sortedModelEntries().map(([model, b]) => ({
        model,
        inputTokens: b.inputTokens,
        outputTokens: b.outputTokens,
        cacheReadTokens: b.cacheReadTokens,
        costUsd: b.costUsd ?? null,
      }))
    }
    return costSurfaceView(accounting.snapshot()).byModel.map((l) => ({
      model: l.model,
      inputTokens: l.promptTokens,
      outputTokens: l.outputTokens,
      cacheReadTokens: l.cacheReadTokens,
      costUsd: l.totalUsd,
    }))
  }
  return {
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
      // §23.5 — append a per-model breakdown ONLY for heterogeneous sessions
      // (>1 distinct model). A single-model session renders byte-identical to
      // the pre-feature box (no extra rows).
      const rows = modelRows()
      if (rows.length > 1) {
        lines.push("")
        lines.push("By model:")
        for (const b of rows) {
          // Include cache-read so the per-model rows reconcile against the
          // aggregate `Cache read:` row above (parity with the box totals).
          lines.push(
            `  ${b.model}: ${b.inputTokens.toLocaleString("en-US")} in / ` +
              `${b.outputTokens.toLocaleString("en-US")} out / ` +
              `${b.cacheReadTokens.toLocaleString("en-US")} cache · ${formatUsd(b.costUsd)}`,
          )
        }
      }
      // The question this whole box exists to answer once a session spawns:
      // how much of the bill was the subagents? Rendered ONLY when a subagent
      // actually spent something, so a plain session's box is unchanged.
      const kinds =
        accounting === undefined ? undefined : costSurfaceView(accounting.snapshot()).byKind
      if (kinds !== undefined && kinds.subagent > 0) {
        lines.push("")
        lines.push("By agent:")
        lines.push(`  root: ${formatUsd(kinds.root)}`)
        lines.push(`  subagents: ${formatUsd(kinds.subagent)}`)
      }
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

export const createCostPanel = (opts: CostPanelOptions): CostPanel => {
  const ctx = panelState(opts)
  return {
    ...accountingOps(ctx),
    ...renderOps(ctx),
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
