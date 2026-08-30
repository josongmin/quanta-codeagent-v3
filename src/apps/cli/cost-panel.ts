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

import {
  type CostSurfaceView,
  costSurfaceView,
  formatReconciliationReceipt,
  reconcileUsageAccounting,
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
  /** A3 — count one TURN. A turn is a UI fact (one turn can hold several
   *  model calls), so it is panel-local and independent of any metrics feed;
   *  the dashboard sink calls this BEFORE its metrics guard. */
  noteTurn(): void
  /** §23.5 — per-model cumulative breakdown, sorted by model id
   *  (deterministic). Empty when disabled or before any turn. A
   *  heterogeneous-model session is no longer collapsed to the last model. */
  byModel(): readonly ModelCostBucket[]
  /** Fold a single-turn usage delta into the cumulative state. Increments
   *  `turns` by 1. `cacheReadTokens` defaults to 0. When `costUsd` is
   *  omitted we derive it from the current model + the new token counts;
   *  unknown model ⇒ contributes nothing to `totalCostUsd` (the running
   *  sum is preserved). */
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
  /**
   * `false` ⇒ SHADOW: the authority records beside the legacy feed, the panel
   * still renders the legacy numbers, and `/cost` appends a reconciliation
   * receipt saying whether the two agree.
   *
   * Without this, shadow mode records into an authority nobody ever reads and
   * produces no evidence — which is the entire point of the mode, so the mode
   * would be inert. Default `true` keeps a caller that passes an authority and
   * nothing else on the projecting path.
   */
  accountingAuthoritative?: boolean
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
  /**
   * Per-model buckets are keyed on the model the PROVIDER reported, which is
   * untrusted text. The key stays verbatim so accounting stays exact; every
   * RENDER path runs it through `sanitizeModel` instead. `state.model` was
   * already sanitized at construction, but the per-model rows were not — an id
   * carrying ANSI escapes reached `/cost` output intact, and the projected
   * breakdown made that block render where it previously never did.
   */
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
  const accounting = opts.accounting
  const authoritative = opts.accountingAuthoritative ?? true

  /** The authority's current numbers, or `undefined` when this panel is not
   *  the projecting reader (no authority, or shadow). */
  const projected = (): CostSurfaceView | undefined =>
    // A disabled panel is a FULL no-op — it must not even read the authority,
    // so `snapshot()` keeps the historical pristine-state contract.
    !enabled || accounting === undefined || !authoritative
      ? undefined
      : costSurfaceView(accounting.snapshot())

  /**
   * The ONE state every read path renders from.
   *
   * In projected mode the authority owns the tokens and dollars, and `turns` /
   * `model` / `sessionStart` stay panel-local. This resolution used to live
   * only inside `snapshot()`, which left `render()` and `renderDetailed()`
   * reading the raw `state` — so with an authority wired, the status line said
   * "n/a · 0 in / 0 out" and the `/cost` header rows were zeros while
   * `snapshot()` reported the real total. Three readers, one rule, or the rule
   * is a suggestion.
   */
  const effectiveState = (): CostPanelState => {
    const view = projected()
    if (view === undefined) return { ...state }
    // A3-S1 — the label names what actually STREAMED last, not the boot pick;
    // the newest record's model is provider text, so it passes the same
    // render-boundary sanitizer as every other model string.
    const last = accounting?.recent(1)[0]?.usage.model
    return {
      ...state,
      model: last !== undefined ? sanitizeModel(last) : state.model,
      inputTokens: view.promptTokens,
      outputTokens: view.outputTokens,
      cacheReadTokens: view.cacheReadTokens,
      // `null` only when nothing has been spent yet — the panel's contract
      // for "no known-model cost has landed", preserved.
      totalCostUsd: view.calls === 0 ? null : view.totalUsd,
    }
  }

  return {
    enabled,
    now,
    state,
    perModel,
    bucketFor,
    accumulateCost,
    sortedModelEntries,
    accounting: opts.accounting,
    authoritative: opts.accountingAuthoritative ?? true,
    projected,
    effectiveState,
  }
}

/** The state every operation group shares, inferred from {@link panelState} so it
 *  can never drift from what that function actually builds. */
type PanelCtx = ReturnType<typeof panelState>

/** Accounting: the totals, their per-model breakdown, and the two mutators
 *  that advance them. */
const accountingOps = (ctx: PanelCtx): Pick<CostPanel, "snapshot" | "byModel" | "noteTurn"> => {
  const { enabled, state, sortedModelEntries, projected, effectiveState } = ctx

  return {
    snapshot: () => effectiveState(),

    byModel: () => {
      if (!enabled) return []
      const view = projected()
      if (view === undefined)
        return sortedModelEntries().map(([model, b]) => ({ model: sanitizeModel(model), ...b }))
      return view.byModel.map((line) => ({
        model: sanitizeModel(line.model),
        inputTokens: line.promptTokens,
        outputTokens: line.outputTokens,
        cacheReadTokens: line.cacheReadTokens,
        costUsd: line.totalUsd,
      }))
    },

    noteTurn: () => {
      if (!enabled) return
      state.turns += 1
    },
  }
}

/**
 * SHADOW mode's output — the whole reason the middle knob position exists.
 *
 * The authority recorded beside the legacy feed and nothing rendered from it;
 * this is where that comparison becomes something a person can read, on a real
 * session, before anything they look at depends on the new numbers. Empty in
 * every other mode.
 */
const shadowReceiptLines = (
  accounting: UsageAccountingPort | undefined,
  authoritative: boolean,
  state: CostPanelState,
): readonly string[] => {
  if (accounting === undefined || authoritative) return []
  return [
    "",
    formatReconciliationReceipt(
      // `promptTokens` is deliberately NOT supplied: this panel's legacy input
      // count comes from `gen_ai.usage.input_tokens`, which is provider-shaped,
      // so comparing it to the authority's provider-neutral prompt total
      // reports a divergence on every Anthropic session that used the cache.
      // Dollars and output tokens carry the signal without the false alarm.
      reconcileUsageAccounting(accounting.snapshot(), {
        totalUsd: state.totalCostUsd ?? 0,
        outputTokens: state.outputTokens,
      }),
    ),
  ]
}

/**
 * The root-vs-subagent split — the question this box exists to answer once a
 * session spawns. Rendered only when a subagent actually spent something, so
 * an ordinary session's `/cost` is unchanged.
 */
const agentSplitLines = (
  accounting: UsageAccountingPort | undefined,
  authoritative: boolean,
): readonly string[] => {
  if (accounting === undefined || !authoritative) return []
  const kinds = costSurfaceView(accounting.snapshot()).byKind
  if (kinds.subagent <= 0) return []
  return [
    "",
    "By agent:",
    `  root: ${formatUsd(kinds.root)}`,
    `  subagents: ${formatUsd(kinds.subagent)}`,
  ]
}

/**
 * A2 — the Total-cost cell, honest about what the number is.
 *   - estimates present  ⇒ "$X.XX ($Y.YY estimated)" (fallback-priced spend)
 *   - unpriced calls     ⇒ the figure is a FLOOR: "$X.XX+ · N unpriced" — and
 *     an unknown-only session says "incomplete", never an exact $0.00.
 */
const totalCostLine = (totalCostUsd: number | null, view: CostSurfaceView | undefined): string => {
  const base = formatUsd(totalCostUsd)
  if (view === undefined) return base
  const marks: string[] = []
  if (view.estimatedUsd > 0) marks.push(`${formatUsd(view.estimatedUsd)} estimated`)
  if (view.unpricedCalls > 0) marks.push(`${view.unpricedCalls} unpriced`)
  if (marks.length === 0) return base
  if (view.unpricedCalls > 0 && (totalCostUsd === null || totalCostUsd === 0)) {
    return `incomplete (${marks.join(" · ")})`
  }
  return `${base} (${marks.join(" · ")})`
}

/**
 * A2 — the status line's cost cell. An unpriced call makes every dollar
 * figure a FLOOR, and an unknown-only session must never read as an exact
 * $0.00 — that is an absence wearing a number's confidence.
 */
const statusCostCell = (totalCostUsd: number | null, unpriced: number): string => {
  if (unpriced <= 0) return formatUsd(totalCostUsd)
  if (totalCostUsd !== null && totalCostUsd > 0) {
    return `${formatUsd(totalCostUsd)} (+${unpriced} unpriced)`
  }
  return "cost incomplete"
}

/** Presentation + teardown. Rendering reads the accounting state and never
 *  mutates it. */
const renderOps = (ctx: PanelCtx): Pick<CostPanel, "render" | "renderDetailed" | "dispose"> => {
  const { enabled, now, sortedModelEntries, accounting, authoritative, projected, effectiveState } =
    ctx
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
    if (accounting === undefined || !authoritative) {
      return sortedModelEntries().map(([model, b]) => ({
        model: sanitizeModel(model),
        inputTokens: b.inputTokens,
        outputTokens: b.outputTokens,
        cacheReadTokens: b.cacheReadTokens,
        costUsd: b.costUsd ?? null,
      }))
    }
    return costSurfaceView(accounting.snapshot()).byModel.map((l) => ({
      model: sanitizeModel(l.model),
      inputTokens: l.promptTokens,
      outputTokens: l.outputTokens,
      cacheReadTokens: l.cacheReadTokens,
      costUsd: l.totalUsd,
    }))
  }
  return {
    render: () => {
      if (!enabled) return renderDisabled()
      const s = effectiveState()
      const turnLabel = `${s.turns} turn${s.turns === 1 ? "" : "s"}`
      // A3 — no authority means NO BOOKS. The legacy fold that used to fill
      // this in is gone, and rendering its absence as zeros would be a wrong
      // number wearing confidence; the off state is shown as what it is.
      if (accounting === undefined) return `accounting off · ${turnLabel} · ${s.model}`
      const cost = statusCostCell(s.totalCostUsd, projected()?.unpricedCalls ?? 0)
      const tokens = `${formatTokens(s.inputTokens)} in / ${formatTokens(s.outputTokens)} out`
      return `${cost} · ${turnLabel} · ${tokens} · ${s.model}`
    },

    renderDetailed: () => {
      if (!enabled) return renderDisabled()
      if (accounting === undefined) {
        const s = effectiveState()
        return renderBox(
          [
            `${padLabel("Accounting:")}off (QUANTA_USAGE_ACCOUNTING_V2=off)`,
            `${padLabel("Turns:")}${s.turns.toLocaleString("en-US")}`,
            `${padLabel("Model:")}${s.model}`,
          ],
          { title: "session cost", titleStyle: gray, borderStyle: dim, minInner: 42 },
        )
      }
      const s = effectiveState()
      const duration = formatDuration(now() - s.sessionStart)
      const perTurn =
        s.totalCostUsd !== null && s.turns > 0 ? formatUsd(s.totalCostUsd / s.turns) : "n/a"
      const lines = [
        `${padLabel("Duration:")}${duration}`,
        `${padLabel("Turns:")}${s.turns.toLocaleString("en-US")}`,
        `${padLabel("Input:")}${s.inputTokens.toLocaleString("en-US")} tok`,
        `${padLabel("Output:")}${s.outputTokens.toLocaleString("en-US")} tok`,
        `${padLabel("Cache read:")}${s.cacheReadTokens.toLocaleString("en-US")} tok`,
        `${padLabel("Total cost:")}${totalCostLine(s.totalCostUsd, projected())}`,
        `${padLabel("Per turn avg:")}${perTurn}`,
        `${padLabel("Model:")}${s.model}`,
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
      lines.push(...shadowReceiptLines(accounting, authoritative, s))
      lines.push(...agentSplitLines(accounting, authoritative))
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
