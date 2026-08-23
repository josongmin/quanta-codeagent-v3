/**
 * RFC-04 D4 — live CLI worktree-transition progress orchestration.
 *
 * Split out of `session-ops/index.ts` (god-MODULE cap) so the `worktree` command
 * stays lean. This module owns the D4 seam: it subscribes to the session
 * `ActivityStore` ATOMICALLY (the store's `{snapshot,nextSeq}` contract) BEFORE
 * invoking `transitionThreadToWorktree`, so no staged event is lost between
 * subscribe and the operation start; it renders each materialized change the
 * instant it arrives (synchronous flush) so the FIRST progress render precedes
 * command completion; and it unsubscribes in `finally`.
 *
 * Gate discipline: `progress` is the resolved `QUANTA_WORKTREE_PROGRESS` decision
 * threaded from the composition root. When it is false (or no store is wired) the
 * function neither turns on the transaction's `staged` children NOR subscribes —
 * so the transition + output are byte-identical to the pre-D4 coarse path. The
 * caller still renders the final settled snapshot as a receipt.
 */

import { type ActivitySnapshot, type ActivityStore, renderActivity } from "@/activity"
import { bold, cyan, dim, gray, green, red, yellow } from "@/ui/ui-helpers"
import {
  type TransitionActivity,
  type TransitionRequest,
  type TransitionResult,
  transitionThreadToWorktree,
} from "../current-thread-worktree"

/** Render an activity snapshot as newline-terminated `/activity` lines onto the
 *  surface writer. Used by the FINAL settle receipt (one terminal block after the
 *  operation resolves). The live pre-completion path uses
 *  {@link createLiveProgressRenderer} instead, which dedups the repeated header. */
export const renderActivityTo = (snapshot: ActivitySnapshot, out: (s: string) => void): void => {
  for (const line of renderActivity(snapshot, { now: Date.now() })) out(`${line}\n`)
}

/** Status glyph → colour, layered at the surface (the pure `@/activity` renderer
 *  emits plain glyphs by design). Byte-identical no-op when colour is off. */
const GLYPH_COLOUR: Readonly<Record<string, (s: string) => string>> = {
  "✓": green,
  "⏳": cyan,
  "🛑": yellow,
  "✗": red,
  "💤": gray,
  "◌": gray,
  "⊘": yellow,
  "■": gray,
}

/** Colour a single `/activity` body row by its leading status glyph, preserving
 *  the row's tree indentation. Rows without a known glyph (footer / empty note)
 *  pass through untouched. */
const styleRow = (line: string): string => {
  const m = /^(\s*)(\S+)(.*)$/.exec(line)
  if (m === null) return line
  const [, indent = "", glyph = "", rest = ""] = m
  const paint = GLYPH_COLOUR[glyph]
  return paint === undefined ? line : `${indent}${paint(glyph)}${rest}`
}

/** Colour the `ACTIVITY  <stats>` header: bold-cyan label, dim aggregate stats. */
const styleHeader = (line: string): string => {
  const sep = line.indexOf("  ")
  return sep < 0 ? bold(cyan(line)) : `${bold(cyan(line.slice(0, sep)))}${dim(line.slice(sep))}`
}

/**
 * A STATEFUL live-progress renderer for ONE worktree-transition subscription.
 *
 * The pre-D4-polish path re-rendered the WHOLE `/activity` block (header + every
 * row) on every staged event, stacking 2-3 full `ACTIVITY` panels into
 * scrollback. This renderer prints the header + tree ONCE (the first render),
 * then on each subsequent render emits ONLY the changed rows (the staged delta) —
 * a clean append-style progress log, no repeated header. Colour is layered via
 * `@/ui/ui-helpers` (byte-identical no-op when the resolved policy is off).
 *
 * Each render is emitted as a SINGLE `out(...)` call so the D5 pre-completion
 * proof can count DISTINCT render events (one write per render) — the multi-render
 * timing signal the hellgate pins is preserved, only the repeated header noise is
 * removed. (A true in-place redraw is not attempted: the surface writer is an
 * append-only sink with no cursor addressing — this is header-dedup + delta-only.)
 */
export const createLiveProgressRenderer = (
  out: (s: string) => void,
): ((snapshot: ActivitySnapshot) => void) => {
  let headerShown = false
  let prevRows = new Set<string>()
  return (snapshot: ActivitySnapshot): void => {
    const [header = "", ...rows] = renderActivity(snapshot, { now: Date.now() })
    if (!headerShown) {
      headerShown = true
      out(`${[styleHeader(header), ...rows.map(styleRow)].join("\n")}\n`)
    } else {
      // Only rows that are NEW or changed vs the last render (the staged delta).
      const delta = rows.filter((r) => !prevRows.has(r))
      if (delta.length > 0) out(`${delta.map(styleRow).join("\n")}\n`)
    }
    prevRows = new Set(rows)
  }
}

/** Options resolved by the command front door. */
export interface WorktreeProgressOpts {
  /** The session activity store (DI). Absent ⇒ no activity emitted/rendered. */
  readonly store?: ActivityStore
  /** Resolved `QUANTA_WORKTREE_PROGRESS` gate. */
  readonly progress: boolean
  /** Correlation turn id the front door holds. */
  readonly turnId: string
}

/**
 * Run the worktree transition, wiring live staged progress when the gate is ON.
 *
 * When `progress` is true AND a `store` is wired: the transaction emits
 * `workspace`/`checkout` staged children (via `staged: true`), and a subscription
 * — attached BEFORE the transition and flushed synchronously — renders each stage
 * the moment it materializes (the `running` open is emitted before the git-effect
 * await, so the first render precedes completion). Otherwise the transition is
 * byte-identical to the coarse path: no `staged`, no subscription.
 */
export const runWorktreeTransitionWithProgress = async (
  req: TransitionRequest,
  out: (s: string) => void,
  opts: WorktreeProgressOpts,
): Promise<TransitionResult> => {
  const activity: TransitionActivity | undefined =
    opts.store !== undefined
      ? { store: opts.store, turnId: opts.turnId, ...(opts.progress ? { staged: true } : {}) }
      : undefined
  const liveStore = opts.progress ? opts.store : undefined
  const render = createLiveProgressRenderer(out)
  const sub = liveStore?.subscribe(() => render(liveStore.snapshot()), {
    schedule: (flush) => flush(),
  })
  try {
    return await transitionThreadToWorktree(req, () => Date.now(), activity)
  } finally {
    sub?.unsubscribe()
  }
}
