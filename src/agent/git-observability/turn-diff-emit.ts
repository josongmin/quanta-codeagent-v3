/**
 * ADR-0110 — Turn-diff emit wiring helper (opt-in seam).
 *
 * Stateful per-session adapter that orchestrates the
 * {@link captureTurnStart} / {@link computeTurnDiff} / {@link buildTurnDiffEvent}
 * trio from `@/agent/turn-diff` into a tiny turn-scoped state machine:
 *
 *   ┌─────────────┐  startTurn(i)   ┌──────────────┐  endTurn(i)
 *   │  no anchor  │ ──────────────▶ │ anchor = sha │ ──────────────▶ event | null
 *   └─────────────┘                 └──────────────┘
 *
 * Closed-port: the {@link GitRunner} is injected via {@link WireTurnDiffOpts},
 * so a fake runner drives every adversarial case in unit tests and the real
 * `defaultGitRunner` plugs in for production. No back-reference into the
 * loop; the loop calls `startTurn(turnIndex)` at turn start and `endTurn(
 * turnIndex)` at turn end and pushes the returned event onto its stream.
 *
 * Idempotence:
 *   - `startTurn(i)` is no-op when a SHA is already anchored for `i` so the
 *     loop can re-enter (e.g. after a side-conversation) without re-probing
 *     git or losing the original turn-start anchor.
 *   - Calling `endTurn` for a turn with no anchor returns `null` (no diff).
 *
 * State isolation:
 *   - Each turnIndex carries its own anchor. Different turns never share
 *     state; one turn's `endTurn` does not consume another turn's anchor.
 *   - `endTurn` consumes its own anchor exactly once, even when diff
 *     computation returns `null`, so the session state does not grow
 *     monotonically with completed turns.
 *
 * Best-effort:
 *   - All git failures collapse to `null`. The wiring never throws.
 */

import { buildTurnDiffEvent, captureTurnStart, computeTurnDiff } from "@/agent/turn-diff"
import type { AgentEvent } from "@/stream/types"
import type { GitRunner } from "@/tool/git/types"

export interface TurnDiffSession {
  /** Snapshot the HEAD SHA for `turnIndex`. Idempotent — a second call for
   *  the same `turnIndex` keeps the original anchor (no re-probe). */
  startTurn(turnIndex: number): Promise<void>
  /** Compute the turn-diff payload for `turnIndex` and return an
   *  `AgentEvent` ready for the loop's stream. Returns `null` when:
   *    - `startTurn(turnIndex)` was never called (no anchor).
   *    - The cwd is not a git repo / git is missing / spawn errors.
   *    - The diff body is empty AND `--shortstat` reports zero changes. */
  endTurn(turnIndex: number): Promise<Extract<AgentEvent, { type: "turn_diff_updated" }> | null>
}

export interface WireTurnDiffOpts {
  /** Closed-port DI. Defaults are at the caller (e.g. `defaultGitRunner`). */
  readonly runner: GitRunner
  readonly cwd: string
  /** Forwarded to {@link computeTurnDiff}. Defaults to the emitter's
   *  built-in 64 KiB cap; the underlying primitive clamps anything larger
   *  to a 4 MiB hard ceiling. */
  readonly maxUnifiedBytes?: number
  /** Forwarded to every runner call so a cancelled turn (loop abort,
   *  subagent cancel) actually kills the spawned `git`. */
  readonly signal?: AbortSignal
}

export const wireTurnDiffEmit = (opts: WireTurnDiffOpts): TurnDiffSession => {
  const { runner, cwd, maxUnifiedBytes, signal } = opts
  // Per-turn anchor map. The map itself is local to this closure so different
  // wiring instances (e.g. one per session) never cross-pollute.
  const anchors = new Map<number, string>()
  return {
    async startTurn(turnIndex) {
      if (anchors.has(turnIndex)) return // idempotent
      const sha = await captureTurnStart(runner, cwd, signal)
      if (sha === null) return // no anchor — endTurn will short-circuit
      anchors.set(turnIndex, sha)
    },
    async endTurn(turnIndex) {
      const fromSha = anchors.get(turnIndex)
      if (fromSha === undefined) return null
      anchors.delete(turnIndex)
      const payload = await computeTurnDiff({
        runner,
        cwd,
        fromSha,
        ...(maxUnifiedBytes !== undefined ? { maxUnifiedBytes } : {}),
        ...(signal !== undefined ? { signal } : {}),
      })
      if (payload === null) return null
      return buildTurnDiffEvent(turnIndex, payload)
    },
  }
}
