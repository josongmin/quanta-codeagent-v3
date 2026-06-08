/**
 * `/model` ctx-adapter (ticket 14, §11.6).
 *
 * Projects the surface's model facts onto the `SlashContext.model` slot the
 * `/model` picker consumes:
 *   - `current()`       — the active sticky model for the CURRENT mode, falling
 *                         back to the boot model when no per-mode entry is set.
 *                         Backed by a per-mode SYNC SHADOW this adapter's own
 *                         `set()` updates, so an in-surface `/model` set is
 *                         reflected IMMEDIATELY (the sticky store is ASYNC, so a
 *                         store-reading getter could only return a Promise — a
 *                         sync getter cannot read it). The shadow is keyed to the
 *                         mode the set targeted, so it never leaks across modes.
 *   - `candidates()`    — the selectable ids (boot model + retry candidates),
 *                         each enriched with render metadata from the
 *                         provider-metadata SSOT (window/output/recommended/hint).
 *                         Metadata absent ⇒ field omitted (picker degrades).
 *   - `set(id)`         — persist via the SAME `StickyModelStore` the loop reads,
 *                         keyed to the CURRENT mode (mode-implicit). Mirrors the
 *                         `/sticky-model` set path's typed outcome.
 *   - `effortSupport()` — resolve the model's reasoning-effort metadata so the
 *                         command can clamp the session effort (Codex
 *                         `validateEffort`).
 *
 * REUSES the sticky-model store rather than minting a parallel persistence
 * surface, so `/model` and `/sticky-model` agree and the loop's consume side
 * (ADR-0462) observes either. The CURRENT-mode binding is supplied by the host
 * (a getter — the active posture can change via shift+tab between turns), so a
 * `/model` always targets the mode the next turn will actually run in.
 */

import type { AgentMode } from "@/agent"
import type { StickyModelStore } from "@/agent/sticky-model"
import {
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

/** The `SlashContext.model` slot shape (kept in sync with `slash-contract.ts`
 *  structurally — the contract uses inline types to avoid importing this CLI
 *  internal). */
export interface ModelAdapter {
  readonly current: () => string
  readonly candidates: () => readonly ModelLineMeta[]
  readonly set: (id: string) => Promise<ModelSetOutcome>
  readonly effortSupport: (id: string) => ModelEffortSupport | undefined
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
 *  - `store`         — the sticky-model store (SAME instance the loop reads).
 *  - `bootModel`     — the model the session started with. It is the surface's
 *                      "recommended" default badge AND the `current()` anchor
 *                      when no `currentModel` getter is supplied.
 *  - `currentMode`   — a GETTER for the active posture (mode-implicit set target).
 *  - `candidateIds`  — selectable ids (boot model + retry candidates), deduped.
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
  readonly store: StickyModelStore
  readonly bootModel: string
  readonly currentMode: () => AgentMode
  readonly candidateIds: readonly string[]
  readonly currentModel?: () => string
}): ModelAdapter => {
  const ids = [...new Set([args.bootModel, ...args.candidateIds].filter((s) => s.length > 0))]
  // Per-mode SYNC shadow of the last in-surface set. The async sticky store IS
  // the durable source of truth (and the loop's consume side reads it); this
  // shadow is purely so a SYNC `current()` reflects a SET this surface just made,
  // keyed to the mode it targeted (no cross-mode leak).
  const shadow = new Map<AgentMode, string>()
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
    current: () => args.currentModel?.() ?? shadow.get(args.currentMode()) ?? args.bootModel,
    candidates: () => ids.map(lineMeta),
    set: async (id: string): Promise<ModelSetOutcome> => {
      const mode = args.currentMode()
      if (!isAgentMode(mode)) {
        return { kind: "invalid-mode", known: AGENT_PROMPT_MODES }
      }
      if (id.trim() === "") {
        return { kind: "write-error", message: "modelId must be non-empty" }
      }
      const res = await args.store.set({ mode, modelId: id })
      if (res.ok) {
        // Reflect the set in the sync shadow for the mode it targeted, so a
        // following `current()` (no host getter) sees it immediately.
        shadow.set(mode, id)
        return "ok"
      }
      return { kind: "write-error", message: res.error.message }
    },
    effortSupport: (id: string): ModelEffortSupport | undefined => resolveModelEffortSupport(id),
  }
}
