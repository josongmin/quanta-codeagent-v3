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
  // S3 — latest observed reasoning-token split (OpenAI-Responses-only).
  // `undefined` until a usage event with a split is seen; providers without a
  // split never set it (Anthropic byte-identical).
  let latestReasoningTokens: number | undefined
  return {
    sink: (snapshot) => {
      latest = snapshot
    },
    observeUsage: (usage) => {
      // Only retain a REAL split. `!== undefined` (not truthiness) so an
      // explicit `0` from the provider is captured verbatim; the gauge then
      // omits it (0 ⇒ nothing to show) but we never fabricate one.
      if (usage.reasoningTokens !== undefined) latestReasoningTokens = usage.reasoningTokens
    },
    view: () => {
      if (latest === undefined) return undefined
      // `ContextUsageBreakdown` is structurally assignable to `SegmentedUsageView`
      // (segments:{id,tokens}[] ⊇ {id,tokens}[], total, max, model?).
      const base = buildUsageBreakdownDefault(snapshotToBreakdownInput(latest))
      // S3 — thread the observed reasoning split onto the view so the `/context`
      // gauge renders its distinct annotation. Absent ⇒ omitted (byte-identical).
      return latestReasoningTokens !== undefined
        ? { ...base, reasoningTokens: latestReasoningTokens }
        : base
    },
  }
}
