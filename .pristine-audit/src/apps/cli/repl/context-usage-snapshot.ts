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
  /**
   * S3 (jul-03) — wire into the surface `usage` AgentEvent tap (e.g. the
   * indicator stream port). Retains the MOST RECENT turn's reasoning-token
   * split so `/context` can annotate it. OpenAI-Responses-only: providers with
   * no split (Anthropic) emit no `reasoningTokens`, so nothing is retained and
   * the annotation stays absent (no synthetic value). `0` / absent both mean
   * "nothing to show" and are treated identically at the gauge.
   *
   * This is the composition wire the S3 gauge annotation needs: the pure
   * `formatSegmentedUsage` can render a reasoning line, but WITHOUT this the
   * render root never feeds it real provider data (wired-but-inert).
   */
  readonly observeUsage: (usage: { readonly reasoningTokens?: number }) => void
  /** Wire into the `/context` slash seam (`SlashContext.contextUsage`). Returns
   *  the segmented view for the latest snapshot, or `undefined` before the
   *  first turn. */
  readonly view: () => SegmentedUsageView | undefined
}

/** Create a fresh per-session {@link ContextUsageHolder}. Two concurrent
 *  sessions each own their OWN holder (no module singleton). */
export const createContextUsageHolder = (): ContextUsageHolder => {
  let latest: PromptAssembledSnapshot | undefined
  // S3 — reasoning-token split (OpenAI-Responses-only) for the CURRENT turn.
  // `undefined` until a usage event with a split is seen; providers without a
  // split never set it (Anthropic byte-identical). TURN-SCOPED, not
  // free-floating: `sink` (fired at turn START, when the next prompt is
  // assembled) clears it so a stale split from turn N can never annotate turn
  // N+1's snapshot (e.g. a same-session reasoning→non-reasoning model switch
  // whose usage event omits the split). Within a turn: sink clears → the
  // end-of-turn `usage` event's `observeUsage` sets the current split.
  let currentReasoningTokens: number | undefined
  return {
    sink: (snapshot) => {
      latest = snapshot
      // New turn's prompt ⇒ the previous turn's reasoning split no longer
      // describes the window `/context` now renders. Clear so absence stays
      // honest until THIS turn's usage event reports its own split.
      currentReasoningTokens = undefined
    },
    observeUsage: (usage) => {
      // Only retain a REAL split. `!== undefined` (not truthiness) so an
      // explicit `0` from the provider is captured verbatim; the gauge then
      // omits it (0 ⇒ nothing to show) but we never fabricate one. Absent ⇒
      // no-op, so the turn-scoped clear from `sink` stands (no stale carry).
      if (usage.reasoningTokens !== undefined) currentReasoningTokens = usage.reasoningTokens
    },
    view: () => {
      if (latest === undefined) return undefined
      // `ContextUsageBreakdown` is structurally assignable to `SegmentedUsageView`
      // (segments:{id,tokens}[] ⊇ {id,tokens}[], total, max, model?).
      const base = buildUsageBreakdownDefault(snapshotToBreakdownInput(latest))
      // S3 — thread the current turn's reasoning split onto the view so the
      // `/context` gauge renders its distinct annotation. Absent ⇒ omitted
      // (byte-identical). Explicit `0` is retained here and omitted at the
      // renderer (0 ⇒ nothing to show) — honest, no synthetic value.
      return currentReasoningTokens !== undefined
        ? { ...base, reasoningTokens: currentReasoningTokens }
        : base
    },
  }
}
