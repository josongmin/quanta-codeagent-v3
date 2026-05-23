/**
 * Claude Code v1.7196 SOTA "Rewind + Fork" pattern — typed wrapper layer.
 *
 * The base `store.ts` slice already exposes two byte-identical primitives:
 *
 *   - `rewindToMessage(sessionId, msgId)` — truncate transcript so `msgId` is
 *     the last surviving message. Append-only envelope log is NOT touched
 *     (phase-A scope; replay/reconciliation stays the consumer's job).
 *   - `forkSession(sourceId, { newId?, title?, cwd? })` — full-state clone of
 *     the source into a new session id; source is unchanged.
 *
 * This module composes them into the richer Claude-pattern surface the CLI
 * `/rewind` and `/fork` slash commands consume:
 *
 *   - `rewindSession(opts)` returns a structured `RewindResult` (turn count,
 *     message count, file-state note). Optionally calls into an injected git
 *     port to reset working tree (default OFF — destructive).
 *   - `forkSession(opts)` clones the source THEN rewinds the clone to
 *     `atMessageId`. Result is a fresh session whose transcript ends at the
 *     fork point. Original session is preserved byte-identically.
 *
 * Default-OFF posture (RFC §1.2): these wrappers compose existing primitives;
 * nothing in the snapshot/envelope rail changes. The slash commands gate on
 * `QUANTA_REWIND` ENV — disabled ⇒ commands not registered at all.
 */

import type { Message } from "@/llm"
import { forkSession as forkSessionPrimitive, loadSessionById, rewindToMessage } from "./store"
import type { SessionMeta } from "./types"

/* ------------------------------------------------------------------ */
/* git port (optional, default OFF)                                    */
/* ------------------------------------------------------------------ */

/** Minimal git surface we need for working-tree restore. Implementations
 *  inject `git stash` + `git reset --hard <sha>` via two thin methods so
 *  this slice never reaches into `@/tool/git` or shells out directly
 *  (slice isolation: `@/session` is Layer-1, git tools are Layer-3).
 *
 *  When absent (the default), `restoreFiles: true` is a soft no-op and the
 *  `fileStateNote` reflects "git port not wired". */
export interface RewindGitPort {
  /** Stash the working tree and untracked files. Implementations should
   *  use `git stash push -u`. Returns the stash ref or `undefined` if
   *  nothing to stash. */
  stash(cwd: string): Promise<string | undefined>
  /** Hard-reset HEAD to `sha`. Caller has already confirmed destructive
   *  intent. Implementations should call `git reset --hard <sha>`. */
  resetHard(cwd: string, sha: string): Promise<void>
}

/* ------------------------------------------------------------------ */
/* rewind                                                              */
/* ------------------------------------------------------------------ */

export interface RewindOptions {
  readonly sessionId: string
  readonly messageId: string
  /** When true, also restore the git working tree to the commit SHA
   *  recorded in the session meta (`gitSha`). Default false — history
   *  truncation only.
   *
   *  DESTRUCTIVE — the working tree is `git stash`-ed then `git reset
   *  --hard` to the recorded SHA. The caller (slash command) is expected
   *  to have prompted the user. */
  readonly restoreFiles?: boolean
  /** Inject a git port for `restoreFiles: true`. Absent ⇒ file-restore is
   *  a no-op with an explanatory `fileStateNote`. */
  readonly git?: RewindGitPort
  /** Override the session loader (test seam). Defaults to
   *  `loadSessionById`. */
  readonly loader?: (id: string) => Promise<
    | {
        readonly meta: SessionMeta
        readonly messages: readonly Message[]
      }
    | undefined
  >
}

export interface RewindResult {
  readonly sessionId: string
  readonly rewindToMessageId: string
  /** Approximate "turn" count dropped — a turn is a USER message followed by
   *  zero+ assistant messages, so we count user messages in the dropped
   *  slice. Matches the user-visible "drop N turns" copy in the slash
   *  confirm prompt. */
  readonly removedTurns: number
  readonly removedMessages: number
  /** Human-readable note about file-state action: one of
   *    "working tree unchanged"                — restoreFiles was false
   *    "git port not wired; working tree unchanged"
   *    "no gitSha on session; working tree unchanged"
   *    "git stashed; reset to <sha>"
   *    "rewind no-op; working tree unchanged"  — message already last
   */
  readonly fileStateNote: string
}

/** Count user messages in `slice` — our proxy for "turn" count. A turn is
 *  bracketed by a user prompt, so the user-message count in the dropped
 *  slice is the number of full turns being rewound. */
const countUserMessages = (slice: readonly Message[]): number => {
  let n = 0
  for (const m of slice) if (m.role === "user") n += 1
  return n
}

/** Resolve a possibly-prefix `messageId` against the session's transcript.
 *  Returns the full id if a UNIQUE message starts with `prefix`. Multiple
 *  matches or none ⇒ undefined (caller surfaces the right error). */
export const resolveMessageIdPrefix = (
  messages: readonly Message[],
  prefix: string,
): string | undefined => {
  if (prefix === "") return undefined
  let hit: string | undefined
  for (const m of messages) {
    const id = m.id
    if (typeof id !== "string") continue
    if (id === prefix) return id // exact match always wins
    if (id.startsWith(prefix)) {
      if (hit !== undefined) return undefined // ambiguous
      hit = id
    }
  }
  return hit
}

export const rewindSession = async (opts: RewindOptions): Promise<RewindResult> => {
  const loader =
    opts.loader ??
    (async (id) => {
      const s = await loadSessionById(id)
      return s === undefined ? undefined : { meta: s.meta, messages: s.messages }
    })
  const existing = await loader(opts.sessionId)
  if (existing === undefined) {
    throw new Error(`rewindSession: session not found: ${opts.sessionId}`)
  }

  // Resolve prefix → full id. Slash command typically passes a prefix.
  const fullId = resolveMessageIdPrefix(existing.messages, opts.messageId)
  if (fullId === undefined) {
    throw new Error(`rewindSession: messageId not found (or ambiguous): ${opts.messageId}`)
  }

  const idx = existing.messages.findIndex((m) => m.id === fullId)
  const removedSlice = idx < 0 ? [] : existing.messages.slice(idx + 1)
  const removedTurns = countUserMessages(removedSlice)

  // Run the truncate. Returns `removed: 0` if msg already last (no-op).
  const truncateResult = await rewindToMessage(opts.sessionId, fullId)

  // File-state handling — destructive, default OFF.
  let fileStateNote: string
  if (truncateResult.removed === 0) {
    fileStateNote = "rewind no-op; working tree unchanged"
  } else if (opts.restoreFiles !== true) {
    fileStateNote = "working tree unchanged"
  } else if (opts.git === undefined) {
    fileStateNote = "git port not wired; working tree unchanged"
  } else {
    const sha = existing.meta.gitSha
    if (typeof sha !== "string" || sha === "") {
      fileStateNote = "no gitSha on session; working tree unchanged"
    } else {
      await opts.git.stash(existing.meta.cwd)
      await opts.git.resetHard(existing.meta.cwd, sha)
      fileStateNote = `git stashed; reset to ${sha}`
    }
  }

  return {
    sessionId: opts.sessionId,
    rewindToMessageId: fullId,
    removedTurns,
    removedMessages: truncateResult.removed,
    fileStateNote,
  }
}

/* ------------------------------------------------------------------ */
/* fork                                                                */
/* ------------------------------------------------------------------ */

export interface ForkOptions {
  readonly fromSessionId: string
  /** The message id (or prefix) at which to fork. The forked session's
   *  transcript ends with this message. */
  readonly atMessageId: string
  /** Title for the new session. Default `"<orig> (fork)"` (delegated to
   *  the underlying `forkSession` primitive). */
  readonly newTitle?: string
  /** Override the new session id (test seam). Default `crypto.randomUUID`. */
  readonly newId?: string
}

export interface ForkResult {
  readonly newSessionId: string
  readonly fromSessionId: string
  readonly forkedAtMessageId: string
  /** Message count in the new session AFTER the fork-time rewind. */
  readonly messageCount: number
}

export const forkSessionAtMessage = async (opts: ForkOptions): Promise<ForkResult> => {
  const source = await loadSessionById(opts.fromSessionId)
  if (source === undefined) {
    throw new Error(`forkSessionAtMessage: source session not found: ${opts.fromSessionId}`)
  }

  // Resolve the fork-point messageId against the SOURCE transcript first
  // (so we surface "not found" without creating a clone we then have to
  // delete).
  const fullId = resolveMessageIdPrefix(source.messages, opts.atMessageId)
  if (fullId === undefined) {
    throw new Error(`forkSessionAtMessage: messageId not found (or ambiguous): ${opts.atMessageId}`)
  }

  // Clone source → new session id.
  const cloneOpts: { newId?: string; title?: string; cwd?: string } = {}
  if (opts.newId !== undefined) cloneOpts.newId = opts.newId
  if (opts.newTitle !== undefined) cloneOpts.title = opts.newTitle
  const newSessionId = await forkSessionPrimitive(opts.fromSessionId, cloneOpts)

  // Truncate the CLONE to the fork-point. Source is untouched (forkSession
  // primitive deep-clones via structuredClone).
  await rewindToMessage(newSessionId, fullId)

  // Reload to compute final message count for the caller.
  const reloaded = await loadSessionById(newSessionId)
  const messageCount = reloaded === undefined ? 0 : reloaded.messages.length

  return {
    newSessionId,
    fromSessionId: opts.fromSessionId,
    forkedAtMessageId: fullId,
    messageCount,
  }
}
