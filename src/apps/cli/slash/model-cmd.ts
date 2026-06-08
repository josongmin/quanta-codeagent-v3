/**
 * Ticket 14 (§11.6) — `/model` interactive picker command.
 *
 * Mode-implicit model picker, mirroring `/effort`'s structure EXACTLY:
 *   - no-arg  ⇒ render the current sticky model (MARKED `*`) + every candidate
 *               with its context-window / max-output / recommended badge /
 *               capability hint inline (each field degrades gracefully when its
 *               metadata is absent) + a `use:` hint line. tab-complete = prefix
 *               filter over the candidate ids.
 *   - one arg ⇒ `pickModel` (exact → case-insensitive → throw), persist via the
 *               existing sticky-model set path for the CURRENT mode, AND — the
 *               SOTA++ CORE — `clampEffortForModel`: if the session reasoning-
 *               effort is not supported by the newly-picked model, clamp it to
 *               the model's default and echo a one-line notice (Codex
 *               `validateEffort`). Closes the real coherence gap where `/model`
 *               and `/effort`, being independent, can leave a non-reasoning
 *               model pinned to a high reasoning-effort tier.
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

/** No-arg path — render the current model (marked) + each candidate + a hint. */
const renderList = (model: ModelWire, out: (s: string) => void): void => {
  const candidates = model.candidates()
  const current = model.current()
  out(`🎛️  model: ${current.length > 0 ? current : "(none set)"}\n`)
  if (candidates.length === 0) out("/model: no candidates configured\n")
  else for (const meta of candidates) out(formatModelLine(meta, meta.id === current))
  out("use: /model <id>\n")
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
  describe: "Show or switch the model for the current mode (with effort coupling)",
  category: "config",
  async run(args, ctx) {
    if (ctx.model === undefined) {
      ctx.out("/model: not wired in this surface\n")
      return 0
    }
    const model = ctx.model
    if (args.length === 0) {
      renderList(model, ctx.out)
      return 0
    }
    if (args.length > 1) {
      ctx.err(`/model: takes at most one argument; got ${args.length}\n`)
      return 1
    }

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
    return ctx.model
      .candidates()
      .filter((m) => m.id.toLowerCase().startsWith(seed))
      .map((m) => ({ value: m.id, kind: "argument" as const }))
  },
}

export { modelCmd }
