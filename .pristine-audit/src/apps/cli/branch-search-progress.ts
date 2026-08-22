/**
 * Live progress visualization for speculative branch search (ADR-0083 / 대6
 * catalog L4). The N-best verifier-prover loop can spend many seconds running
 * candidates in parallel — without a sticky indicator the user sees dead air
 * and a single eventual `winner` line. This module reads the typed
 * `BranchTraceEvent` stream (raw, NOT the formatted ProgressLine text) and
 * maintains a deterministic state machine over it:
 *
 *   - per-candidate phase: started | finished | failed | scored | delta
 *   - rolling "best so far" = highest score seen across `candidate-scored`
 *     events (ties broken lexicographically by id for determinism — matches
 *     the orchestrator's `argmaxSelector` tie-break shape)
 *   - terminal latch on `winner-selected`
 *
 * Two render surfaces:
 *
 *   1. {@link formatStatusLine} — single compact line for the StatusBar
 *      transient slot (Codex/Claude `thinking…` parity, but for the
 *      branch-search inner loop):
 *
 *        [branch-search: 3/5 scored · best: cand-2@0.87]
 *
 *   2. {@link formatBranchesPanel} — multi-line scrollback panel used by the
 *      `/branches` slash command (last-search inventory):
 *
 *        ─ Branch search · 5 candidates ────────────────
 *          ✓ #2  0.87  cand-2 (winner)
 *          ✓ #4  0.82  cand-4
 *          ✓ #1  0.74  cand-1
 *          ✓ #3  0.71  cand-3
 *          ✓ #5  0.68  cand-5
 *        ────────────────────────────────────────────────
 *
 * Slice discipline:
 *   - This file lives in `src/apps/cli` (read-only surface tier).
 *   - Imports type-only from `@/agent/branch-search` — never the runtime
 *     orchestrator, never `@/agent`. The host wires this module's `ingest`
 *     into `AgentConfig.onBranchTrace` (the typed-observer seam added at
 *     the same time as this module).
 *   - Default-OFF: when {@link isBranchProgressEnabled} returns `false`
 *     (e.g. non-TTY, `QUANTA_BRANCH_SEARCH_PROGRESS=0`), the caller skips
 *     wiring entirely and `AgentConfig.onBranchTrace` stays absent
 *     (byte-identical to pre-feature behaviour).
 *
 * Negative invariants:
 *   - No I/O, no clock, no globals other than `process.env` in
 *     {@link isBranchProgressEnabled} (which itself is a pure function over
 *     its `env` argument).
 *   - The state machine NEVER mutates input events.
 *   - A late event after `winner-selected` is folded in but does NOT undo
 *     the terminal latch (matches orchestrator: winner is final).
 */

import type { BranchTraceEvent, VerifierSignal } from "@/agent/branch-search"

// ----------------------------------------------------------------------------
// State
// ----------------------------------------------------------------------------

/** Per-candidate phase. Closed union — every observed `kind` mapping is
 *  total. Order encodes a natural progression: started → finished → scored
 *  → (delta? cosmetic). A `failed` event short-circuits past `scored` (the
 *  orchestrator emits `candidate-scored` with score 0 for failed runs, so
 *  it's still represented as a terminal scored=0). */
export type CandidatePhase = "started" | "finished" | "failed" | "scored"

export interface CandidateRow {
  readonly id: string
  readonly phase: CandidatePhase
  /** Verifier-weighted total ∈ [0,1]. Absent until `candidate-scored` fires
   *  (or 0 if `phase === "failed"`). */
  readonly score?: number
  /** Optional `+added/-removed` delta detail from `candidate-delta`. Only
   *  populated for completed candidates when a shadow-odb anchor is wired. */
  readonly delta?: { addedLines: number; removedLines: number; changedFiles: number }
  /** Optional reason string when `phase === "failed"`. */
  readonly failure?: string
  readonly turns?: number
  readonly durationMs?: number
  readonly signals?: ReadonlyArray<VerifierSignal>
}

export interface BranchProgressState {
  /** Insertion-ordered candidate ledger. Iterated as-emitted (i.e. `cand-1`
   *  before `cand-2`); the panel renderer re-sorts by score for the "leaderboard"
   *  view, but the sticky-line uses insertion order for the "X/Y scored" count. */
  readonly candidates: ReadonlyMap<string, CandidateRow>
  /** Id of the highest-scoring candidate observed so far (NOT the final
   *  winner unless `winnerId === bestSoFarId`). Lexicographic tie-break on
   *  equal scores keeps the indicator stable across re-renders. */
  readonly bestSoFarId?: string
  readonly bestSoFarScore?: number
  /** Latched on `winner-selected`. Absent ⇒ search is still in flight. */
  readonly winnerId?: string
  /** Anchor-registration failure (non-fatal — search proceeds without
   *  delta measurement). Surfaced verbatim on the panel so the user knows
   *  the `delta` columns will be empty. */
  readonly anchorFailure?: string
}

const EMPTY_STATE: BranchProgressState = Object.freeze({
  candidates: new Map(),
})

export interface BranchProgressTracker {
  /** Fold one `BranchTraceEvent` into the state. Idempotent on duplicate
   *  events for the same `(id, kind)` pair: a second `candidate-finished`
   *  overwrites duration/turns last-writer-wins; a second `candidate-scored`
   *  re-evaluates the leaderboard. */
  ingest(event: BranchTraceEvent): void
  /** Snapshot of the current state. Map identity changes on each ingest so
   *  React-style consumers can shallow-compare. */
  snapshot(): BranchProgressState
  /** Reset to the initial empty state. Called by the surface at the START
   *  of each new branch-search invocation (the panel reflects the LAST
   *  search; live state restarts per search). */
  reset(): void
}

/** Tie-break: higher score wins; on equal score, lexicographic id wins
 *  (stable + deterministic; matches `argmaxSelector` shape). Returns
 *  `true` when `(scoreA, idA)` beats `(scoreB, idB)`. */
const beats = (scoreA: number, idA: string, scoreB: number, idB: string): boolean => {
  if (scoreA !== scoreB) return scoreA > scoreB
  return idA < idB
}

const cloneState = (
  s: BranchProgressState,
): {
  candidates: Map<string, CandidateRow>
  bestSoFarId?: string
  bestSoFarScore?: number
  winnerId?: string
  anchorFailure?: string
} => {
  const next: {
    candidates: Map<string, CandidateRow>
    bestSoFarId?: string
    bestSoFarScore?: number
    winnerId?: string
    anchorFailure?: string
  } = { candidates: new Map(s.candidates) }
  if (s.bestSoFarId !== undefined) next.bestSoFarId = s.bestSoFarId
  if (s.bestSoFarScore !== undefined) next.bestSoFarScore = s.bestSoFarScore
  if (s.winnerId !== undefined) next.winnerId = s.winnerId
  if (s.anchorFailure !== undefined) next.anchorFailure = s.anchorFailure
  return next
}

/** Build a tracker. State is held in the closure; the returned object is a
 *  thin facade. Holding state in a closure (vs. a class) keeps the unit
 *  tests trivial — no `new`, no `this`, full structural equality on
 *  snapshots. */
export const createBranchProgressTracker = (): BranchProgressTracker => {
  let state: BranchProgressState = EMPTY_STATE

  const upsert = (id: string, patch: Partial<CandidateRow> & { phase?: CandidatePhase }): void => {
    const next = cloneState(state)
    const existing = next.candidates.get(id)
    const merged: CandidateRow = {
      ...(existing ?? { id, phase: "started" }),
      ...patch,
      id,
    }
    next.candidates.set(id, merged)
    state = next
  }

  return {
    ingest(event: BranchTraceEvent): void {
      switch (event.kind) {
        case "candidate-started": {
          upsert(event.id, { phase: "started" })
          return
        }
        case "candidate-finished": {
          upsert(event.id, {
            phase: "finished",
            turns: event.turns,
            durationMs: event.durationMs,
          })
          return
        }
        case "candidate-failed": {
          if (event.id === "anchor") {
            // Anchor failure: NOT a real candidate row — stash on top-level
            // state instead so the panel can surface "anchor missing" once.
            const next = cloneState(state)
            next.anchorFailure = event.reason
            state = next
            return
          }
          upsert(event.id, {
            phase: "failed",
            failure: event.reason,
            score: 0,
          })
          return
        }
        case "candidate-scored": {
          upsert(event.id, {
            phase: "scored",
            score: event.total,
            signals: event.signals,
          })
          // Re-evaluate leaderboard.
          const next = cloneState(state)
          if (
            next.bestSoFarId === undefined ||
            next.bestSoFarScore === undefined ||
            beats(event.total, event.id, next.bestSoFarScore, next.bestSoFarId)
          ) {
            next.bestSoFarId = event.id
            next.bestSoFarScore = event.total
          }
          state = next
          return
        }
        case "candidate-delta": {
          upsert(event.id, { delta: event.delta })
          return
        }
        case "winner-selected": {
          const next = cloneState(state)
          next.winnerId = event.winnerId
          state = next
          return
        }
      }
    },
    snapshot(): BranchProgressState {
      return state
    },
    reset(): void {
      state = EMPTY_STATE
    },
  }
}

// ----------------------------------------------------------------------------
// Render: sticky status line
// ----------------------------------------------------------------------------

/** Count candidates currently in `scored` OR `failed` phase. Failed counts
 *  toward "scored" because the orchestrator emits a synthetic `candidate-scored`
 *  with score 0 for every failed run — by the time the user looks at the line,
 *  the orchestrator has already settled that candidate. */
const countScored = (state: BranchProgressState): number => {
  let n = 0
  for (const row of state.candidates.values()) {
    if (row.phase === "scored" || row.phase === "failed") n += 1
  }
  return n
}

/** Format the score as a 2-decimal string, e.g. `0.87`. Defensive against
 *  non-finite (treats as `--`) so a corrupt verifier signal never paints
 *  a `NaN` in the user's status line. */
const fmtScore = (n: number | undefined): string => {
  if (n === undefined || !Number.isFinite(n)) return "--"
  return n.toFixed(2)
}

/** Render the sticky one-line indicator. Returns `""` when the state is
 *  empty (no events yet) — callers should test for empty and skip the
 *  paint rather than show a misleading "0/0 scored". */
export const formatStatusLine = (state: BranchProgressState): string => {
  const total = state.candidates.size
  if (total === 0) return ""
  const scored = countScored(state)
  if (state.winnerId !== undefined) {
    const score = state.candidates.get(state.winnerId)?.score
    return `[branch-search: winner ${state.winnerId}@${fmtScore(score)}]`
  }
  if (state.bestSoFarId !== undefined) {
    return `[branch-search: ${scored}/${total} scored · best: ${state.bestSoFarId}@${fmtScore(state.bestSoFarScore)}]`
  }
  return `[branch-search: ${scored}/${total} scored]`
}

// ----------------------------------------------------------------------------
// Render: /branches panel
// ----------------------------------------------------------------------------

const PANEL_WIDTH = 50

/** Box-drawing top/bottom rule. Length includes the title segment so the
 *  panel looks balanced regardless of how many candidates rendered. */
const rule = (title?: string): string => {
  if (title === undefined) return "─".repeat(PANEL_WIDTH)
  const left = "─ "
  const right = " "
  const fill = Math.max(0, PANEL_WIDTH - left.length - title.length - right.length)
  return `${left}${title}${right}${"─".repeat(fill)}`
}

interface PanelOpts {
  /** Render with ANSI colors. Default `false` — the slash command opts in
   *  via the TTY check on the surface side. */
  readonly colors?: boolean
}

const ANSI_GREEN = "\x1b[32m"
const ANSI_RED = "\x1b[31m"
const ANSI_DIM = "\x1b[2m"
const ANSI_BOLD = "\x1b[1m"
const ANSI_RESET = "\x1b[0m"

const paint = (text: string, code: string, colors: boolean): string => {
  if (!colors) return text
  return `${code}${text}${ANSI_RESET}`
}

const glyphFor = (row: CandidateRow): string => {
  if (row.phase === "failed") return "✗"
  if (row.phase === "scored" || row.phase === "finished") return "✓"
  return "·"
}

interface RankedRow {
  readonly row: CandidateRow
  readonly rank: number
}

/** Sort by score descending; tie-break by id ascending. Failed candidates
 *  sort to the bottom (score 0 + lexicographic id). `#1` is the highest
 *  score; the rank number is independent of insertion order. */
const rankRows = (state: BranchProgressState): readonly RankedRow[] => {
  const rows = [...state.candidates.values()]
  rows.sort((a, b) => {
    const sa = a.score ?? 0
    const sb = b.score ?? 0
    if (sa !== sb) return sb - sa
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  return rows.map((row, i) => ({ row, rank: i + 1 }))
}

/** Render a single panel row. The leading 2-space indent and the trailing
 *  newline are intentionally OMITTED — `formatBranchesPanel` joins with
 *  `\n` so callers can pipe through their own writer. */
const renderRow = (r: RankedRow, winnerId: string | undefined, colors: boolean): string => {
  const glyph = glyphFor(r.row)
  const id = r.row.id
  const score = fmtScore(r.row.score)
  const isWinner = winnerId !== undefined && id === winnerId
  const tag = isWinner ? " (winner)" : ""
  const delta = r.row.delta ? ` [+${r.row.delta.addedLines}/-${r.row.delta.removedLines}]` : ""
  const failure =
    r.row.phase === "failed" && r.row.failure !== undefined ? ` — ${r.row.failure}` : ""
  const body = `${glyph} #${r.rank}  ${score}  ${id}${tag}${delta}${failure}`
  if (!colors) return `  ${body}`
  if (r.row.phase === "failed") return `  ${paint(body, ANSI_RED, colors)}`
  if (isWinner) return `  ${paint(body, ANSI_BOLD + ANSI_GREEN, colors)}`
  return `  ${body}`
}

/** Render the multi-line panel for the `/branches` slash command. Returns
 *  a single string ending WITHOUT a trailing newline (the caller appends
 *  one if needed — matches the rest of `slash-commands.ts` formatters).
 *
 *  Empty state ⇒ a friendly "(no branch search recorded yet)" rather than
 *  an empty box, so users who type `/branches` before any search ran see
 *  something useful. */
export const formatBranchesPanel = (state: BranchProgressState, opts?: PanelOpts): string => {
  const colors = opts?.colors === true
  const total = state.candidates.size
  if (total === 0) {
    return "(no branch search recorded yet)"
  }
  const ranked = rankRows(state)
  const titleParts: string[] = [`Branch search · ${total} candidate${total === 1 ? "" : "s"}`]
  if (state.winnerId !== undefined) {
    titleParts.push(`winner: ${state.winnerId}`)
  } else {
    const scored = countScored(state)
    titleParts.push(`${scored}/${total} scored`)
  }
  const title = titleParts.join(" · ")
  const lines: string[] = [rule(title)]
  for (const r of ranked) lines.push(renderRow(r, state.winnerId, colors))
  if (state.anchorFailure !== undefined) {
    const msg = `  ${paint(`! anchor: ${state.anchorFailure}`, ANSI_DIM, colors)}`
    lines.push(msg)
  }
  lines.push(rule())
  return lines.join("\n")
}

// ----------------------------------------------------------------------------
// Enablement gate
// ----------------------------------------------------------------------------

/** Pure env gate. Default-ON for TTY surfaces; explicit `0|false|off|no`
 *  disables. Non-TTY ⇒ disabled (pipes/redirects/bench/eval). Symmetric
 *  with `isIndicatorEnabled` in `turn-indicator.ts`. */
export const isBranchProgressEnabled = (
  env: NodeJS.ProcessEnv,
  isTTY: boolean | undefined,
): boolean => {
  if (isTTY !== true) return false
  const knob = env.QUANTA_BRANCH_SEARCH_PROGRESS
  if (knob === undefined) return true
  const norm = knob.trim().toLowerCase()
  return norm !== "0" && norm !== "false" && norm !== "off" && norm !== "no"
}
