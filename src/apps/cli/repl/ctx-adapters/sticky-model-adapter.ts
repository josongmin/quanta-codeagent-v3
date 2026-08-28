/**
 * Sticky-model adapter (ADR-0462 follow-up — `/sticky-model` SET surface).
 *
 * Adapts the surface's `StickyModelStore` onto the `SlashContext.stickyModel`
 * shape `/sticky-model` consumes. The CONSUME side (agent loop, ADR-0462) reads
 * the SAME store INSTANCE every turn, so a write here is observed on the next one.
 *
 * aug-28 — this used to say "the same on-disk FILE, fresh every turn", and the
 * difference is load-bearing. The surface now wraps the fs-backed store in
 * `sessionScopedStickyModelStore`: this session's turns read ITS cell, while writes
 * still reach disk for the NEXT session. So a pick made in another process no
 * longer lands mid-session — deliberately, because the per-turn file read let
 * another surface switch this session's model while every display here kept
 * naming the old one.
 *
 * The adapter validates the `<mode>` arg against the prompt-mode union and
 * returns a typed outcome (never throws — IO errors surface as `write-error`).
 */

import type { AgentMode } from "@/agent"
import type { StickyModelStore } from "@/agent/sticky-model"
import { AGENT_PROMPT_MODES } from "@/shared"

/** The prompt modes `/sticky-model` accepts as its `<mode>` arg. REUSES the
 *  single source of truth ({@link AGENT_PROMPT_MODES}) from which the
 *  `AgentMode` union is itself derived — so this list can NEVER silently drift
 *  from the union (a hand-maintained copy with `satisfies` would compile fine
 *  while missing a newly-added mode; this cannot). */
export const STICKY_MODEL_MODES: readonly AgentMode[] = AGENT_PROMPT_MODES

/** aug-28 CLEAR outcome. A clear cannot hit `unknown-model` (there is no id to
 *  validate), so it is its own narrower union rather than a reuse of
 *  {@link StickyModelSetOutcome} — the command then has no unreachable branch to
 *  render. */
export type StickyModelClearOutcome =
  | "ok"
  | { readonly kind: "invalid-mode"; readonly known: readonly string[] }
  | { readonly kind: "write-error"; readonly message: string }

export type StickyModelSetOutcome =
  | "ok"
  | { readonly kind: "invalid-mode"; readonly known: readonly string[] }
  /** aug-28 — the id is not in the switchable set, so no turn could run it. */
  | { readonly kind: "unknown-model"; readonly known: readonly string[] }
  | { readonly kind: "write-error"; readonly message: string }

export interface StickyModelAdapter {
  /** Valid mode names, for the `/sticky-model` listing + arg validation. */
  readonly modes: () => readonly string[]
  /** The switchable model ids: BOTH the `<modelId>` completion source AND (aug-28)
   *  the validation gate `set` enforces — an id nothing can run must not persist.
   *  Empty ⇒ the surface wired no catalog, and `set` accepts any plausible id
   *  (there is nothing to validate against). */
  readonly candidates: () => readonly string[]
  /** Current `{mode → modelId}` snapshot (fresh disk read). */
  readonly list: () => Promise<Readonly<Record<string, string>>>
  /** Persist a per-mode sticky model. Typed outcome; never throws. */
  readonly set: (mode: string, modelId: string) => Promise<StickyModelSetOutcome>
  /** aug-28 — REMOVE the pick for `mode` (`/sticky-model <mode> --clear`), the
   *  SAME key {@link set} writes. Required, not optional: before this the store had
   *  no removal at all, so a per-mode pick was permanent for every future session
   *  and the only escape was hand-editing `~/.quanta/sticky-model.json`.
   *  Idempotent — clearing a mode that holds no pick succeeds. Never throws. */
  readonly clear: (mode: string) => Promise<StickyModelClearOutcome>
}

const isStickyMode = (m: string): m is AgentMode =>
  (STICKY_MODEL_MODES as readonly string[]).includes(m)

export const buildStickyModelAdapter = (args: {
  readonly store: StickyModelStore
  /** The session's provider — part of the sticky key (see `StickyModelKey`). The
   *  surface supplies it so this wire writes the SAME key `/model` writes and the
   *  loop reads. Absent (a host with no provider) ⇒ the legacy bare-mode key, which
   *  reads still accept (see `stickyModelReadKeys`). */
  readonly provider?: string
  /** Known model ids for `<modelId>` completion (deduped by the caller). */
  /** aug-28 — a GETTER, not a snapshot: the catalog grows when the lazy probe
   *  runs, and a boot-time array froze `/sticky-model` out of every
   *  probe-discovered model while `/model` offered them. */
  readonly candidateIds?: () => readonly string[]
}): StickyModelAdapter => ({
  modes: (): readonly string[] => STICKY_MODEL_MODES,
  candidates: (): readonly string[] => args.candidateIds?.() ?? [],
  list: async (): Promise<Readonly<Record<string, string>>> => {
    // load() is no-throw by port contract; on corruption it returns ok:false
    // WITH a (possibly partial) snapshot, which is exactly what we want to show.
    const res = await args.store.load()
    return res.snapshot
  },
  set: async (mode: string, modelId: string): Promise<StickyModelSetOutcome> => {
    if (!isStickyMode(mode)) {
      return { kind: "invalid-mode", known: STICKY_MODEL_MODES }
    }
    const id = modelId.trim()
    if (id === "") {
      // An empty modelId is what the resolver treats as "no override" (it
      // falls through to the default), so persisting it would be a silent
      // no-op. Reject up front with a clear message instead.
      return { kind: "write-error", message: "modelId must be non-empty" }
    }
    // aug-28 — VALIDATE against the switchable set. This used to be advisory
    // ("NOT a validation gate; an id with no matching candidate is an advisory
    // no-op on the consume side"), which was survivable only while nothing on this
    // surface consumed the store. Now the loop reads it per turn and four displays
    // (banner, status line, `/model`, `/why`) report it — so `/sticky-model default
    // gtp-5.6-terra` (a typo) would have persisted globally and made every session
    // announce a model no turn could run. Fail-closed with the known set instead,
    // mirroring `/model`'s own unknown-model error.
    const known = args.candidateIds?.() ?? []
    if (known.length > 0 && !known.includes(id)) {
      return {
        kind: "unknown-model",
        known,
      }
    }
    // PROVIDER-KEYED, like `/model`'s adapter (aug-28). This wire used to write the
    // bare mode while the loop composed `<provider>:<mode>`, so `/sticky-model
    // default <id>` printed a success line, wrote the file, and the turn read
    // nothing — measured end to end: command says `default → boot-model`, disk says
    // `{"default":"boot-model"}`, `readStickyModelForMode` says `undefined`.
    const res = await args.store.set({
      mode,
      modelId: id,
      ...(args.provider !== undefined ? { provider: args.provider } : {}),
    })
    if (res.ok) return "ok"
    return { kind: "write-error", message: res.error.message }
  },
  clear: async (mode: string): Promise<StickyModelClearOutcome> => {
    if (!isStickyMode(mode)) {
      return { kind: "invalid-mode", known: STICKY_MODEL_MODES }
    }
    // Keyed EXACTLY like this adapter's own `set` above — a clear that guessed a
    // different key shape would report success while the pick stayed.
    const res = await args.store.unset({
      mode,
      ...(args.provider !== undefined ? { provider: args.provider } : {}),
    })
    if (res.ok) return "ok"
    return { kind: "write-error", message: res.error.message }
  },
})
