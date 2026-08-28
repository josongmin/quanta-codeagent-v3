/**
 * Session-scoped sticky-model store (aug-28) — persistence WITHOUT mid-session
 * cross-surface surprise.
 *
 * THE PROBLEM THIS SOLVES. The fs-backed store re-reads the file on every `get`
 * (deliberately: out-of-band edits are meant to be visible). Once a live surface
 * started reading it PER TURN, that turned into three defects at once:
 *
 *   1. FOREIGN ADOPTION MID-SESSION — session B's turns silently switch to the
 *      model session A (or the web daemon) just picked. B never asked, and B's
 *      own displays keep naming B's model, so the two disagree.
 *   2. FROZEN DISPLAYS — the picker/status line/banner read a SYNC cell seeded at
 *      boot, while the loop read the file; whichever changed last won, and the
 *      operator had no way to tell which.
 *   3. A LOST-UPDATE read window — two surfaces read-modify-writing one file, so
 *      a concurrent write could be observed half-applied.
 *
 * THE SHAPE. A session reads its OWN cell and writes THROUGH to disk:
 *   - `get`  → the in-memory cell, seeded from the boot snapshot. Never disk. So a
 *              turn's model changes only when THIS session changes it.
 *   - `set`  → the inner (fs) store first; on success, update the cell. So the
 *              pick survives for the NEXT session (the persistence the operator
 *              asked for) and the failure mode is honest: a rejected write leaves
 *              the cell untouched, so no display claims a model the turn will not
 *              use.
 *   - `load` → the cell (this session's truth), NOT the file. `/sticky-model list`
 *              should describe what this session will run.
 *
 * WHAT IS DELIBERATELY GIVEN UP: a pick made elsewhere no longer lands mid-session.
 * It lands on the next session start (the boot snapshot). That is the trade this
 * decorator exists to make — "one user, one preference" ACROSS sessions, not a
 * live remote-control channel into a running one.
 */

import {
  readStickyModelFrom,
  type StickyModelKey,
  type StickyModelLoadResult,
  type StickyModelSetResult,
  type StickyModelStore,
  stickyModelKeyOf,
} from "./port"

export const sessionScopedStickyModelStore = (args: {
  /** The durable store writes go through to (the fs-backed one in production). */
  readonly inner: StickyModelStore
  /** The boot snapshot — what a PREVIOUS session (or another surface) persisted.
   *  Non-mode keys are ignored by `get`, which only ever looks up a real mode. */
  readonly seed?: Readonly<Record<string, string>>
}): StickyModelStore => {
  const cell = new Map<string, string>(Object.entries(args.seed ?? {}))
  return {
    get: async (input: StickyModelKey): Promise<string | undefined> =>
      readStickyModelFrom((k) => cell.get(k), input),
    set: async (
      input: StickyModelKey & { readonly modelId: string },
    ): Promise<StickyModelSetResult> => {
      const res = await args.inner.set(input)
      // Only reflect a pick the durable write ACCEPTED — otherwise this session
      // would run a model the next one has no record of, and the displays (which
      // read this same cell through the adapter) would claim a phantom.
      if (res.ok) cell.set(stickyModelKeyOf(input), input.modelId)
      return res
    },
    unset: async (input: StickyModelKey): Promise<StickyModelSetResult> => {
      // Durable removal FIRST, cell second — the exact mirror of `set` above, and
      // for the same reason: only a removal disk ACCEPTED may change what this
      // session runs. Clearing the cell on a failed write would drop this session
      // back to the boot model while the file still holds the pick, so the next
      // session would silently resurrect it — the "did my clear work?" ambiguity
      // this whole decorator exists to avoid.
      const res = await args.inner.unset(input)
      if (res.ok) cell.delete(stickyModelKeyOf(input))
      return res
    },
    // The cell is already this session's truth, so the sync read is exact (no IO,
    // no staleness window) — the reason the decorator can back every display.
    peek: (input: StickyModelKey): string | undefined =>
      readStickyModelFrom((k) => cell.get(k), input),
    load: async (): Promise<StickyModelLoadResult> => ({
      ok: true,
      snapshot: Object.freeze(Object.fromEntries(cell)),
    }),
  }
}
