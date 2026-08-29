/**
 * `/model` ctx-adapter (ticket 14, §11.6).
 *
 * Projects the surface's model facts onto the `SlashContext.model` slot the
 * `/model` picker consumes:
 *   - `current()`       — the active sticky model for the CURRENT provider+mode,
 *                         falling back to the boot model when no entry is set.
 *                         Read straight off the store via `peek` (aug-28), the
 *                         port's SYNC read. It used to be a per-mode shadow map
 *                         this adapter maintained from its own `set()` calls,
 *                         because the port was async-only — and that copy went
 *                         stale for any pick that did not travel through this
 *                         adapter (a persisted one, another surface, a
 *                         `/sticky-model` set), so the picker marked a model the
 *                         loop was not running.
 *   - `candidates()`    — the selectable ids (boot model + retry candidates),
 *                         each enriched with render metadata from the
 *                         provider-metadata SSOT (window/output/recommended/hint).
 *                         Metadata absent ⇒ field omitted (picker degrades).
 *   - `set(id)`         — persist via the SAME `StickyModelStore` the loop reads,
 *                         keyed to the CURRENT mode (mode-implicit). Mirrors the
 *                         `/sticky-model` set path's typed outcome.
 *   - `clear()`         — REMOVE that same key's pick (aug-28), so the session goes
 *                         back to the boot model. There was no way to un-set a
 *                         pick at all before: `/model gpt-4o` once meant gpt-4o
 *                         forever, in every later session, unless the user
 *                         hand-edited `~/.quanta/sticky-model.json`.
 *   - `effortSupport()` — resolve the model's reasoning-effort metadata so the
 *                         command can clamp the session effort (Codex
 *                         `validateEffort`).
 *
 * REUSES the sticky-model store rather than minting a parallel persistence
 * surface, so `/model` and `/sticky-model` agree, the loop's consume side
 * (ADR-0462) observes either, and there is exactly ONE source for "the active
 * model" that this adapter and `stickyModelStore.effectiveModel` (the value
 * `describe().modelSlug` publishes to the attach pill / SDK / web readouts) both
 * read. The CURRENT-mode binding is supplied by the host
 * (a getter — the active posture can change via shift+tab between turns), so a
 * `/model` always targets the mode the next turn will actually run in.
 */

import type { AgentMode } from "@/agent"
import type { ModelRoutingAuthority } from "@/agent/model-routing"
import {
  MODEL_EFFORT_SUPPORT,
  type ModelEffortSupport,
  resolveModelEffortSupport,
  resolveModelWindow,
} from "@/llm/provider-metadata"
import { AGENT_PROMPT_MODES } from "@/shared"
import type { ModelLineMeta } from "../../slash/model-picker"

/** Typed set outcome the `/model` command renders. Structurally identical to the
 *  sticky-model set outcome so the slot can forward the store's result. */
export type ModelSetOutcome =
  | "ok"
  | { readonly kind: "invalid-mode"; readonly known: readonly string[] }
  | { readonly kind: "write-error"; readonly message: string }

/** Typed CLEAR outcome (aug-28). Structurally the SAME union as
 *  {@link ModelSetOutcome} — a clear can fail for exactly the two reasons a set
 *  can (an impossible mode, or the durable write refusing) — spelled as its own
 *  name so the command's render sites read honestly and the two can diverge later
 *  without a silent widening. */
export type ModelClearOutcome = ModelSetOutcome

/** The `SlashContext.model` slot shape (kept in sync with `slash-contract.ts`
 *  structurally — the contract uses inline types to avoid importing this CLI
 *  internal). */
export interface ModelAdapter {
  readonly current: () => string
  readonly candidates: () => readonly ModelLineMeta[]
  readonly set: (id: string) => Promise<ModelSetOutcome>
  /** aug-28 — REMOVE the pick for the CURRENT provider+mode (the same key
   *  {@link set} writes), so the session falls back to the boot model. Required,
   *  not optional: `/model --clear` is the only front door for undoing a pick, and
   *  a surface that wires `set` without it strands the user with a permanent
   *  preference. */
  readonly clear: () => Promise<ModelClearOutcome>
  readonly effortSupport: (id: string) => ModelEffortSupport | undefined
  /** Present when the surface wired a catalog probe: awaited by `/model` BEFORE
   *  it lists or resolves an id, so `candidates()` (sync, by contract) can still
   *  reflect an ASYNC provider lookup. No-throw + memoized by the wire. */
  readonly refresh?: () => Promise<void>
}

const isAgentMode = (m: string): m is AgentMode =>
  (AGENT_PROMPT_MODES as readonly string[]).includes(m)

/**
 * Capability/cost hint for a candidate, derived PURELY from the metadata SSOT
 * (no hand-maintained per-model copy that could drift). Mirrors the CC picker's
 * one-liners ("most capable" / "fastest" / "lower cost"). Conservative — returns
 * `undefined` (omit the hint) when neither signal is present.
 */
const deriveHint = (id: string): string | undefined => {
  // aug-27 — EXACT metadata only. Both resolvers fall back to a per-FAMILY
  // entry, so a live-catalog id no table knows (`gpt-5.4-mini`,
  // `gpt-5.3-codex-spark`) resolved through the `gpt-5` family and every row in
  // the picker printed the same "most capable" — a badge that is actively wrong
  // on a mini/spark model. A hint is a CLAIM about the specific model, so it is
  // emitted only when the SSOT has that exact id; the window/output columns keep
  // using the family fallback (a conservative size estimate is still useful).
  if (MODEL_EFFORT_SUPPORT[id] === undefined) return undefined
  const support = resolveModelEffortSupport(id)
  const window = resolveModelWindow(id)
  // Non-reasoning small-output models read as the "fast / lower cost" tier; the
  // largest-window reasoning models read as "most capable". Everything else has
  // no confident hint ⇒ omit.
  if (support !== undefined && !support.reasoning) {
    return window !== undefined && window.maxOutput <= 16_384 ? "fast · lower cost" : "lower cost"
  }
  if (support?.reasoning === true && window !== undefined && window.contextWindow >= 400_000) {
    return "most capable"
  }
  if (support?.reasoning === true) return "extended reasoning"
  return undefined
}

/**
 * Build the `/model` adapter.
 *  - `routing`       — THE model-routing authority (MR-02). Every read and every
 *                      mutation goes through it. This adapter used to poke the
 *                      sticky STORE directly, which made it a second owner of the
 *                      selection: `/model --clear` cleared the store while the
 *                      authority still held the pick, and `current()` kept
 *                      reporting a model the session had just dropped.
 *  - `bootModel`     — the model the session started with. It is the surface's
 *                      "recommended" default badge AND the `current()` anchor
 *                      when no `currentModel` getter is supplied.
 *  - `currentMode`   — a GETTER for the active posture (mode-implicit set target).
 *  - `candidateIds`  — GETTER over the selectable ids (boot model + retry
 *                      candidates + anything the catalog probe added). A getter
 *                      rather than an array because the probe grows the list
 *                      after boot; reading it per call keeps the picker and
 *                      `AgentConfig.modelCandidates` in agreement.
 *  - `refresh`       — OPTIONAL async catalog probe `/model` awaits first.
 *  - `currentModel`  — OPTIONAL getter for the effective model the NEXT turn will
 *                      run (the host already resolves this per turn via the
 *                      sticky resolver). When supplied it WINS for `current()` (so
 *                      the no-arg list marks the REAL active model the host
 *                      resolved). Absent ⇒ `current()` falls back to the per-mode
 *                      SYNC SHADOW (set by this adapter's own `set()`), then the
 *                      boot model. The shadow is what makes an in-surface set
 *                      visible WITHOUT a host getter (the surface-compose wiring):
 *                      the sticky store is async, so a store-reading getter would
 *                      return a Promise — a sync `current()` cannot use it.
 */
export const buildModelAdapter = (args: {
  readonly routing: ModelRoutingAuthority
  readonly bootModel: string
  readonly currentMode: () => AgentMode
  /** The session's provider — part of the sticky key (see `StickyModelKey`). */
  readonly provider?: string
  readonly candidateIds: () => readonly string[]
  readonly currentModel?: () => string
  readonly refresh?: () => Promise<void>
}): ModelAdapter => {
  const ids = (): readonly string[] => [
    ...new Set([args.bootModel, ...args.candidateIds()].filter((s) => s.length > 0)),
  ]
  // aug-28 — the sync read is THE STORE's (`peek`), not a shadow map this adapter
  // maintains. It used to keep its own per-mode copy, updated by its own `set()`
  // and seeded from the boot snapshot, purely because `current()` is sync and the
  // store port was async-only. That copy was a second source of truth for the one
  // fact four displays report: any pick that did not travel through THIS adapter
  // (a persisted pick, another surface, a `/sticky-model` set) left it stale, and
  // the picker then marked a model the loop was not running. `peek` moved the sync
  // read onto the port, so the store answers every reader identically.
  const lineMeta = (id: string): ModelLineMeta => {
    const window = resolveModelWindow(id)
    const hint = deriveHint(id)
    return {
      id,
      ...(window !== undefined
        ? { contextWindow: window.contextWindow, maxOutput: window.maxOutput }
        : {}),
      // The boot model is the surface's recommended default.
      ...(id === args.bootModel ? { recommended: true } : {}),
      ...(hint !== undefined ? { hint } : {}),
    }
  }
  return {
    current: () => args.currentModel?.() ?? args.routing.view().modelId,
    candidates: () => ids().map(lineMeta),
    ...(args.refresh !== undefined ? { refresh: args.refresh } : {}),
    set: async (id: string): Promise<ModelSetOutcome> => {
      const mode = args.currentMode()
      if (!isAgentMode(mode)) {
        return { kind: "invalid-mode", known: AGENT_PROMPT_MODES }
      }
      if (id.trim() === "") {
        return { kind: "write-error", message: "modelId must be non-empty" }
      }
      // Through the AUTHORITY: it validates against the live catalog (probing once
      // if the id has not been discovered yet) and publishes the selection only
      // after the durable write settles. `current()` reads the same authority, so
      // the set is visible on the next paint by construction rather than by two
      // places remembering to agree.
      const res = await args.routing.select(id, mode)
      if (res.ok) return "ok"
      return res.kind === "unknown-model"
        ? { kind: "write-error", message: `unknown model — known: ${res.known.join(", ")}` }
        : { kind: "write-error", message: res.message }
    },
    clear: async (): Promise<ModelClearOutcome> => {
      const mode = args.currentMode()
      if (!isAgentMode(mode)) {
        return { kind: "invalid-mode", known: AGENT_PROMPT_MODES }
      }
      // The SAME key `set` writes (mode + provider), so a clear can only ever undo
      // a pick this surface could have made — a sibling mode's or another
      // provider's preference is a different key and is left alone.
      const res = await args.routing.clear(mode)
      if (res.ok) return "ok"
      return {
        kind: "write-error",
        message: res.ok === false && res.kind === "write-error" ? res.message : "clear rejected",
      }
    },
    effortSupport: (id: string): ModelEffortSupport | undefined => resolveModelEffortSupport(id),
  }
}
