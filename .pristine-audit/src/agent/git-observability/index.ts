/**
 * ADR-0110 — Git observability wiring helpers (barrel + composite).
 *
 * Two opt-in seams that callers (app/CLI bootstrap) wire to surface the
 * already-closed contracts from ADR-0102 (turn-diff emitter) and ADR-0106
 * (session git fingerprint) without modifying `src/agent/loop.ts`:
 *
 *   - {@link wireSessionGitFingerprint} — call at session creation to attach
 *     `gitSha` / `gitBranch` / `gitOriginUrl` to a {@link SessionMeta}.
 *   - {@link wireTurnDiffEmit} — call at session creation to get a per-turn
 *     state machine that emits `turn_diff_updated` events at turn end.
 *   - {@link wireGitObservability} — single-call composite that bundles both
 *     for callers that want full git observability on by default.
 *
 * Why opt-in seam (not loop modification): `src/agent/loop.ts` is currently
 * mid-flight on a separate (auth) track and amending it from this ADR would
 * race that work. The seams here let the CLI bootstrap layer wire both
 * pieces from outside; a future loop integration can grow a typed
 * `gitObservability?: GitObservability` field on its run config and forward
 * the same calls (no breaking change to this surface required).
 */

import type { SessionMeta } from "@/session/types"
import { wireSessionGitFingerprint } from "./session-fingerprint"
import { type TurnDiffSession, type WireTurnDiffOpts, wireTurnDiffEmit } from "./turn-diff-emit"

export { wireSessionGitFingerprint } from "./session-fingerprint"
export { type TurnDiffSession, type WireTurnDiffOpts, wireTurnDiffEmit } from "./turn-diff-emit"

/** Composite handle that bundles both wiring seams. The `fingerprintMeta`
 *  call is a single-shot (consumes the runner once); `turnDiff` is a long-
 *  lived per-turn state machine. */
export interface GitObservability {
  /** Attach `gitSha` / `gitBranch` / `gitOriginUrl` to a {@link SessionMeta}. */
  readonly fingerprintMeta: (meta: SessionMeta) => Promise<SessionMeta>
  /** Per-session turn-diff state machine. */
  readonly turnDiff: TurnDiffSession
}

/** Build a composite git-observability handle. Re-uses {@link WireTurnDiffOpts}
 *  so the runner / cwd / signal / cap flow through both halves with one
 *  options object. */
export const wireGitObservability = (opts: WireTurnDiffOpts): GitObservability => {
  const turnDiff = wireTurnDiffEmit(opts)
  return {
    fingerprintMeta: (meta) => wireSessionGitFingerprint(meta, opts.runner, opts.signal),
    turnDiff,
  }
}
