/**
 * Track D (runtime → REPL context wire) — surface-owned holder for the latest
 * per-turn prompt-assembly snapshot.
 *
 * The agent loop's `onPromptAssembled` seam (default-OFF) hands the surface a
 * {@link PromptAssembledSnapshot} once per turn, immediately after the system
 * prompt is assembled. This holder retains the MOST RECENT snapshot and, on
 * demand (`/context`), maps it through the loop's OWN token estimator
 * (`buildUsageBreakdownDefault`, which is bound to `estimateTokens`) into the
 * renderer's structural {@link SegmentedUsageView}. NO second token heuristic
 * is introduced — the breakdown module owns the single estimator.
 *
 * `sink` is the callback the composition root wires into
 * `AgentConfig.onPromptAssembled`; `view()` is the getter wired into the
 * `/context` slash seam. Before the first turn `view()` returns `undefined` so
 * `/context` keeps its graceful fallback.
 *
 * Pure aside from the in-memory mutable slot — no I/O, no clock.
 */

import {
  buildUsageBreakdownDefault,
  type PromptAssembledSnapshot,
  snapshotToBreakdownInput,
} from "@/agent/context/usage-breakdown"
import type { SegmentedUsageView } from "../status-line"

export interface ContextUsageHolder {
  /** Wire into `AgentConfig.onPromptAssembled`. Retains the latest snapshot. */
  readonly sink: (snapshot: PromptAssembledSnapshot) => void
  /** Wire into the `/context` slash seam (`SlashContext.contextUsage`). Returns
   *  the segmented view for the latest snapshot, or `undefined` before the
   *  first turn. */
  readonly view: () => SegmentedUsageView | undefined
}

/** Create a fresh per-session {@link ContextUsageHolder}. Two concurrent
 *  sessions each own their OWN holder (no module singleton). */
export const createContextUsageHolder = (): ContextUsageHolder => {
  let latest: PromptAssembledSnapshot | undefined
  return {
    sink: (snapshot) => {
      latest = snapshot
    },
    view: () => {
      if (latest === undefined) return undefined
      // `ContextUsageBreakdown` is structurally assignable to `SegmentedUsageView`
      // (segments:{id,tokens}[] ⊇ {id,tokens}[], total, max, model?).
      return buildUsageBreakdownDefault(snapshotToBreakdownInput(latest))
    },
  }
}
