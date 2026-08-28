/**
 * Ticket 14 (§11.6) — `/model` interactive picker command.
 *
 * Mode-implicit model picker, mirroring `/effort`'s structure EXACTLY:
 *   - no-arg  ⇒ render the current sticky model (MARKED `*`) + every candidate
 *               with its context-window / max-output / recommended badge /
 *               capability hint inline (each field degrades gracefully when its
 *               metadata is absent) + a `use:` hint line. tab-complete = prefix
 *               filter over the candidate ids.
 *   - `--clear` ⇒ DROP the saved pick for the current provider+mode (aug-28) and
 *               report the boot model the session falls back to. Until this
 *               existed there was no way to un-set a pick: one `/model <id>`
 *               applied to every future session for that provider+mode unless the
 *               user hand-edited `~/.quanta/sticky-model.json`.
 *   - one arg ⇒ `pickModel` (exact → case-insensitive → throw), persist via the
 *               existing sticky-model set path for the CURRENT mode, AND — the
 *               SOTA++ CORE — `clampEffortForModel`: if the session reasoning-
 *               effort is not supported by the newly-picked model, clamp it to
 *               the model's default and echo a one-line notice (Codex
 *               `validateEffort`). Closes the real coherence gap where `/model`
 *               and `/effort`, being independent, can leave a non-reasoning
 *               model pinned to a high reasoning-effort tier.
 *
 * The candidate set is the provider's live catalog: `ctx.model.refresh()` (when
 * the surface wired a probe) is awaited before BOTH paths, so `/model` offers
 * exactly the models this credential may run instead of a static slug list.
 *
 * Absent `ctx.model` slot ⇒ "not wired in this surface" + exit 0 (parity with
 * the rest of the surface-only commands). Orthogonal to `/sticky-model` (which
 * takes an explicit `<mode> <modelId>` and renders no candidate list).
 *
 * Lives in its own `*-cmd.ts` module (NOT inline in `registry-surface.ts`) so
 * its `model-picker` import is allowed under the ADR-0306 fence — the registry
 * brings it in as an opaque `SlashCommand`.
 */

import type { SlashContext } from "../slash-contract"
import { clampEffortForModel, formatModelLine, pickModel, UnknownModelError } from "./model-picker"

type ModelWire = NonNullable<SlashContext["model"]>
type EffortWire = NonNullable<SlashContext["effort"]>

/**
 * THE spelling of the clear verb — one flag, not a family (`--clear` only; no
 * bare `clear`, no `--unset`/`--reset` alias), so the help line, the completion
 * and the parse below can never describe three different things. It is a FLAG
 * rather than a bare word because a bare `clear` is also a legal-looking model id,
 * and a provider that ever ships one would silently become unpickable.
 */
const CLEAR_FLAG = "--clear"

/** No-arg path — render the current model (marked) + each candidate + a hint. */
const renderList = (model: ModelWire, out: (s: string) => void): void => {
  const candidates = model.candidates()
  const current = model.current()
  out(`🎛️  model: ${current.length > 0 ? current : "(none set)"}\n`)
  if (candidates.length === 0) out("/model: no candidates configured\n")
  else for (const meta of candidates) out(formatModelLine(meta, meta.id === current))
  out(`use: /model <id>  |  /model ${CLEAR_FLAG} (drop the saved pick, back to the boot model)\n`)
}

/** `--clear` path — drop the pick for the CURRENT provider+mode, then report what
 *  the session will now run. The report reads the wire's OWN `current()` (which is
 *  the store's sync `peek`, not a cached copy), so the line cannot claim a
 *  fallback the next turn will not honor. */
const runClear = async (
  model: ModelWire,
  out: (s: string) => void,
  err: (s: string) => void,
): Promise<number> => {
  const res = await model.clear()
  if (res !== "ok") {
    err(
      res.kind === "invalid-mode"
        ? `/model: unknown mode; known = ${res.known.join(", ")}\n`
        : `/model: clear failed — ${res.message}\n`,
    )
    return 1
  }
  // Idempotent by port contract: clearing when nothing was set prints the same
  // line and exits 0 — "there is no saved pick" is the requested end state.
  out(`🎛️  model: ${model.current()} (saved pick cleared for this mode)\n`)
  return 0
}

/** Resolve the requested id against the candidates. Returns the canonical id, or
 *  `null` after emitting the "unknown model" error (caller exits 1). */
const resolveChosen = (
  requested: string,
  model: ModelWire,
  err: (s: string) => void,
): string | null => {
  const ids = model.candidates().map((m) => m.id)
  try {
    return pickModel(requested, ids)
  } catch (e) {
    if (e instanceof UnknownModelError) {
      const known = e.known.length > 0 ? e.known.join(", ") : "(none)"
      err(`/model: unknown model '${e.requested}'; known = ${known}\n`)
      return null
    }
    throw e
  }
}

/** SOTA++ CORE — model↔effort coupling (Codex `validateEffort`). Reconcile the
 *  session effort with the newly-picked model ONLY when both the effort wire and
 *  the model's effort metadata are present; otherwise leave effort untouched
 *  (conservative — never invent a mismatch). */
const applyEffortClamp = (
  chosen: string,
  model: ModelWire,
  effort: EffortWire | undefined,
  out: (s: string) => void,
): void => {
  if (effort === undefined) return
  const clamp = clampEffortForModel(chosen, effort.get(), model.effortSupport(chosen))
  if (clamp.clamped) {
    effort.set(clamp.effort)
    out(`🧠 ${clamp.notice}\n`)
  }
}

const modelCmd: import("../slash-contract").SlashCommand = {
  name: "/model",
  describe:
    "Show or switch the model for the current mode (with effort coupling); --clear drops the saved pick",
  category: "config",
  async run(args, ctx) {
    if (ctx.model === undefined) {
      ctx.out("/model: not wired in this surface\n")
      return 0
    }
    const model = ctx.model
    // Populate the candidate set from the provider's LIVE catalog before either
    // path reads it: the no-arg listing would otherwise show only the seeded ids
    // and `resolveChosen` would reject every other model the account can run.
    // No-throw by wire contract (a failed probe leaves the seeded ids).
    await model.refresh?.()
    if (args.length === 0) {
      renderList(model, ctx.out)
      return 0
    }
    if (args.length > 1) {
      ctx.err(`/model: takes at most one argument; got ${args.length}\n`)
      return 1
    }

    if ((args[0] as string) === CLEAR_FLAG) return runClear(model, ctx.out, ctx.err)

    const chosen = resolveChosen(args[0] as string, model, ctx.err)
    if (chosen === null) return 1

    const res = await model.set(chosen)
    if (res !== "ok") {
      ctx.err(
        res.kind === "invalid-mode"
          ? `/model: unknown mode; known = ${res.known.join(", ")}\n`
          : `/model: write failed — ${res.message}\n`,
      )
      return 1
    }
    ctx.out(`🎛️  model: ${chosen}\n`)
    applyEffortClamp(chosen, model, ctx.effort, ctx.out)
    return 0
  },
  complete: (args, partial, ctx) => {
    if (ctx.model === undefined || args.length >= 1) return []
    const seed = partial.toLowerCase()
    // `--clear` completes alongside the ids: an undo the user cannot discover by
    // tab is an undo most users never find.
    const clearHint = CLEAR_FLAG.startsWith(seed)
      ? [{ value: CLEAR_FLAG, kind: "argument" as const }]
      : []
    return [
      ...ctx.model
        .candidates()
        .filter((m) => m.id.toLowerCase().startsWith(seed))
        .map((m) => ({ value: m.id, kind: "argument" as const })),
      ...clearHint,
    ]
  },
}

export { modelCmd }
