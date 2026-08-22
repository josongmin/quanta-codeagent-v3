/**
 * Turn-diff emitter (ADR-0102 — Codex `turn/diff/updated` absorption).
 *
 * Codex Desktop emits a `turn/diff/updated` event at turn end carrying the
 * cumulative unified diff of everything the turn touched, so a UI / replay /
 * session jsonl recorder sees the shape of the change without parsing
 * assistant text. We absorb the same shape as a closed `AgentEvent` variant
 * (see `@/stream/types.ts`) plus this opt-in emitter slice.
 *
 * Design (closed-port + default-OFF):
 *   - `captureTurnStart(runner, cwd)` ⇒ snapshot the HEAD SHA at turn start.
 *     Returns `null` when the cwd is not a git repo or git spawn fails — the
 *     emitter then no-ops for the rest of the turn, byte-identical.
 *   - `computeTurnDiff(runner, cwd, startSha)` ⇒ at turn end, compute the
 *     diff between `startSha` and the current state (HEAD + working tree).
 *     Returns a structured payload (stats + unified body) or `null` when
 *     no diff is observable.
 *   - The loop wires this opt-in via a config seam: absent runner ⇒ no
 *     event emitted, byte-identical contract.
 *
 * Slice isolation: imports only `@/tool/git/types` (for `GitRunner`) and
 * `@/stream/types` (for the event shape). No back-references to the loop;
 * the caller owns when to capture / when to compute / when to emit.
 */

import type { AgentEvent } from "@/stream/types"
import type { GitRunner } from "@/tool/git/types"

/** Default per-emit max bytes for the unified diff body. Mirrors the
 *  `MAX_BYTES` repo-rules cap (64 KiB) — large enough for a normal turn,
 *  small enough that a runaway diff doesn't blow the recorder budget. */
export const TURN_DIFF_DEFAULT_MAX_BYTES = 64 * 1024

/** Hard cap on the diff body — emitter refuses requests larger than this
 *  regardless of caller arg, to keep telemetry bounded. */
const TURN_DIFF_HARD_MAX_BYTES = 4 * 1024 * 1024

export interface TurnDiffPayload {
  readonly fromSha: string
  readonly toSha: string
  readonly filesChanged: number
  readonly insertions: number
  readonly deletions: number
  readonly unifiedDiff: string
}

/** Capture the HEAD SHA at the start of a turn. Returns `null` when:
 *   - `cwd` is not a git repository (the agent is running outside one)
 *   - The repo has no commits yet (`git rev-parse HEAD` errors)
 *   - The runner spawn fails for any reason
 *  In all `null` cases the emitter should skip {@link computeTurnDiff} too —
 *  there's no anchor to diff against. */
export const captureTurnStart = async (
  runner: GitRunner,
  cwd: string,
  signal?: AbortSignal,
): Promise<string | null> => {
  try {
    const result = await runner.run(["rev-parse", "HEAD"], cwd, signal)
    if (result.exitCode !== 0) return null
    const sha = result.stdout.trim()
    return sha.length > 0 ? sha : null
  } catch {
    // Spawn errors (no git binary, network FS issues) all collapse to null —
    // the emitter is best-effort.
    return null
  }
}

/** Compute the turn-diff payload given the snapshot taken by
 *  {@link captureTurnStart}. Returns `null` when nothing changed and there is
 *  no unified-diff body to emit. */
export const computeTurnDiff = async (args: {
  runner: GitRunner
  cwd: string
  fromSha: string
  /** Override the default 64 KiB body cap; clamped to {@link TURN_DIFF_HARD_MAX_BYTES}. */
  maxUnifiedBytes?: number
  signal?: AbortSignal
}): Promise<TurnDiffPayload | null> => {
  const { runner, cwd, fromSha, signal } = args
  const maxBytes = clampMaxBytes(args.maxUnifiedBytes ?? TURN_DIFF_DEFAULT_MAX_BYTES)
  try {
    // Resolve `toSha` = current HEAD. If HEAD has advanced (the turn made a
    // commit) toSha != fromSha. If HEAD is unchanged we still want the
    // working-tree diff, so toSha == fromSha and the unified body is
    // `git diff <fromSha>` (which compares the working tree against the
    // commit, capturing both staged and unstaged edits).
    const headResult = await runner.run(["rev-parse", "HEAD"], cwd, signal)
    const toSha = headResult.exitCode === 0 ? headResult.stdout.trim() : fromSha

    // `git diff <fromSha>` compares working tree against the from-sha,
    // showing every change the turn made (committed + uncommitted). This
    // is more informative than `git diff <fromSha>..<toSha>` (which would
    // miss working-tree state).
    const diffResult = await runner.run(["diff", fromSha], cwd, signal)
    if (diffResult.exitCode !== 0) return null

    const statResult = await runner.run(["diff", "--shortstat", fromSha], cwd, signal)
    const stat = statResult.exitCode === 0 ? parseShortstat(statResult.stdout) : EMPTY_STAT

    const unifiedDiff =
      diffResult.stdout.length > maxBytes
        ? `${diffResult.stdout.slice(0, maxBytes)}\n\n[truncated: ${diffResult.stdout.length} bytes total, showing first ${maxBytes} bytes]`
        : diffResult.stdout

    // No-change short-circuit: empty body AND zero stats ⇒ caller can skip
    // the emit. The function returns null so the loop's "should I emit?"
    // gate is just a null check.
    if (
      unifiedDiff.length === 0 &&
      stat.filesChanged === 0 &&
      stat.insertions === 0 &&
      stat.deletions === 0
    ) {
      return null
    }

    return {
      fromSha,
      toSha,
      filesChanged: stat.filesChanged,
      insertions: stat.insertions,
      deletions: stat.deletions,
      unifiedDiff,
    }
  } catch {
    return null
  }
}

/** Compose a `turn_diff_updated` event from the payload. Pure (no stream
 *  side-effect); the caller pushes the returned event onto its stream. */
export const buildTurnDiffEvent = (
  turn: number,
  payload: TurnDiffPayload,
): Extract<AgentEvent, { type: "turn_diff_updated" }> => ({
  type: "turn_diff_updated",
  turn,
  fromSha: payload.fromSha,
  toSha: payload.toSha,
  filesChanged: payload.filesChanged,
  insertions: payload.insertions,
  deletions: payload.deletions,
  unifiedDiff: payload.unifiedDiff,
})

interface Shortstat {
  filesChanged: number
  insertions: number
  deletions: number
}

const EMPTY_STAT: Shortstat = { filesChanged: 0, insertions: 0, deletions: 0 }

/** Parse `git diff --shortstat` output. Format example:
 *    ` 3 files changed, 42 insertions(+), 7 deletions(-)`
 *  Any field can be absent (e.g. an insertion-only diff prints no deletions
 *  line). Returns zeros for absent fields. */
const parseShortstat = (out: string): Shortstat => {
  const filesMatch = /(\d+)\s+files?\s+changed/.exec(out)
  const insertionsMatch = /(\d+)\s+insertions?\(\+\)/.exec(out)
  const deletionsMatch = /(\d+)\s+deletions?\(-\)/.exec(out)
  return {
    filesChanged: filesMatch ? Number.parseInt(filesMatch[1]!, 10) : 0,
    insertions: insertionsMatch ? Number.parseInt(insertionsMatch[1]!, 10) : 0,
    deletions: deletionsMatch ? Number.parseInt(deletionsMatch[1]!, 10) : 0,
  }
}

const clampMaxBytes = (n: number): number => {
  if (!Number.isFinite(n) || n <= 0) return TURN_DIFF_DEFAULT_MAX_BYTES
  if (n > TURN_DIFF_HARD_MAX_BYTES) return TURN_DIFF_HARD_MAX_BYTES
  return Math.floor(n)
}
