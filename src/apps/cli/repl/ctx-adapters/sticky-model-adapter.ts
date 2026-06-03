/**
 * Sticky-model adapter (ADR-0462 follow-up — `/sticky-model` SET surface).
 *
 * Adapts the fs-backed `StickyModelStore` onto the `SlashContext.stickyModel`
 * shape `/sticky-model` consumes. The CONSUME side (agent loop, ADR-0462) reads
 * the SAME on-disk file fresh every turn, so a write here is observed on the
 * next turn — the store's documented "best-effort persistence, last-write-wins
 * on rename" contract. Two store instances over one file is supported usage.
 *
 * The adapter validates the `<mode>` arg against the prompt-mode union and
 * returns a typed outcome (never throws — IO errors surface as `write-error`).
 */

import type { AgentMode } from "@/agent"
import type { StickyModelStore } from "@/agent/sticky-model"

/** The prompt-mode union `/sticky-model` accepts as its `<mode>` arg. Kept as a
 *  literal array (the `satisfies` pins it to `AgentMode`) so the command can
 *  list + validate without a runtime enum — none exists for this union. */
export const STICKY_MODEL_MODES = [
  "default",
  "plan",
  "review",
  "audit",
  "architect",
  "editor",
] as const satisfies readonly AgentMode[]

export type StickyModelSetOutcome =
  | "ok"
  | { readonly kind: "invalid-mode"; readonly known: readonly string[] }
  | { readonly kind: "write-error"; readonly message: string }

export interface StickyModelAdapter {
  /** Valid mode names, for the `/sticky-model` listing + arg validation. */
  readonly modes: () => readonly string[]
  /** Current `{mode → modelId}` snapshot (fresh disk read). */
  readonly list: () => Promise<Readonly<Record<string, string>>>
  /** Persist a per-mode sticky model. Typed outcome; never throws. */
  readonly set: (mode: string, modelId: string) => Promise<StickyModelSetOutcome>
}

const isStickyMode = (m: string): m is AgentMode =>
  (STICKY_MODEL_MODES as readonly string[]).includes(m)

export const buildStickyModelAdapter = (args: {
  readonly store: StickyModelStore
}): StickyModelAdapter => ({
  modes: (): readonly string[] => STICKY_MODEL_MODES,
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
    if (modelId.trim() === "") {
      // An empty modelId is what the resolver treats as "no override" (it
      // falls through to the default), so persisting it would be a silent
      // no-op. Reject up front with a clear message instead.
      return { kind: "write-error", message: "modelId must be non-empty" }
    }
    const res = await args.store.set({ mode, modelId })
    if (res.ok) return "ok"
    return { kind: "write-error", message: res.error.message }
  },
})
