import type { Message } from "@/llm"
import { firstInvalidMessageElement } from "@/session/store"
import { errMessage, logger } from "@/shared"
import {
  type AtomicWriteSync,
  fileExists,
  parentDir,
  readFile,
  writeFileAtomic,
} from "@/storage"

/**
 * Session state persistence / resume (RFC §13 Q2 → DECISION: a plain JSON
 * transcript file via @/storage, Phase-3, CLI-level concern only).
 *
 * Rationale: resume needs the message transcript and nothing else — no event
 * sourcing, no DB, no replay engine (RFC §1.2 rejects deterministic replay).
 * One JSON file written through the existing @/storage slice is the whole
 * mechanism. The loop is intentionally NOT aware of this: the CLI loads prior
 * messages as the starting history and saves after each session. Default OFF.
 */

const STATE_VERSION = 1 as const

interface SessionFile {
  version: number
  sessionId: string
  reason: string
  turns: number
  messages: Message[]
}

export interface SaveSessionInput {
  sessionId: string
  messages: Message[]
  reason: string
  turns: number
}

/**
 * Typed load failure for an EXISTING `--state` / `--resume <path>` transcript
 * file (jun-10 silent-failure audit #2/#14). Thrown instead of silently
 * returning `null`: a `null` here makes the caller start a FRESH conversation
 * and the next per-turn save then OVERWRITES the file — i.e. a torn or forged
 * transcript would be silently destroyed. The message always names the file;
 * `firstInvalidIndex` is set when an individual message element failed the
 * shared S19 schema (element-level validation reused from `@/session/store`).
 */
export class SessionStateLoadError extends Error {
  public readonly path: string
  public readonly firstInvalidIndex: number | undefined
  constructor(path: string, detail: string, firstInvalidIndex?: number) {
    super(`session state file ${path}: ${detail}`)
    this.name = "SessionStateLoadError"
    this.path = path
    this.firstInvalidIndex = firstInvalidIndex
  }
}

/**
 * Persist the session transcript to `path` as JSON. Real-atomic (jun-10 audit
 * #2): the body is staged in a same-directory temp, `fsync`ed, then
 * `rename(2)`-d over the target — POSIX guarantees same-fs rename atomicity,
 * so a crash mid-write leaves either the OLD complete file or the NEW one,
 * never a torn half-file. The original file's permission bits survive the
 * rewrite (mode preservation in `writeFileAtomic`, ADR-0398).
 *
 * NO silent fallback: the prior implementation degraded to a plain truncating
 * write when the staged commit failed, which is exactly the torn-JSON window
 * the staging exists to close. A failed atomic commit is a REAL error — it is
 * logged with the target path and PROPAGATED to the caller.
 *
 * `sync` is the ADR-0398 durability seam (tests inject it to prove the
 * crash-point ordering); production callers omit it for the real `fsync`.
 */
export const saveSession = async (
  path: string,
  input: SaveSessionInput,
  sync?: AtomicWriteSync,
): Promise<void> => {
  const payload: SessionFile = {
    version: STATE_VERSION,
    sessionId: input.sessionId,
    reason: input.reason,
    turns: input.turns,
    messages: input.messages,
  }
  const json = JSON.stringify(payload)
  try {
    await writeFileAtomic(path, json, sync)
  } catch (e) {
    logger.warn("state: atomic session save failed — propagating", {
      path,
      error: errMessage(e),
    })
    throw e
  }
}

/**
 * Load a previously saved session. Returns `null` ONLY when the file is
 * missing (a legitimate fresh conversation). An EXISTING file that is
 * unreadable, torn/malformed JSON, envelope-mismatched, or carries message
 * elements that fail the shared S19 schema throws {@link SessionStateLoadError}
 * naming the file (jun-10 audit #2/#14) — silently returning `null` here used
 * to reset the transcript AND let the next save destroy the evidence.
 */
export const loadSession = async (
  path: string,
): Promise<{ sessionId: string; messages: Message[] } | null> => {
  if (!(await fileExists(path))) return null
  let raw: string
  try {
    raw = await readFile(path)
  } catch (e) {
    throw new SessionStateLoadError(path, `unreadable (${errMessage(e)})`)
  }
  let parsed: Partial<SessionFile>
  try {
    parsed = JSON.parse(raw) as Partial<SessionFile>
  } catch (e) {
    throw new SessionStateLoadError(
      path,
      `torn/malformed JSON — refusing to silently reset the transcript (${errMessage(e)})`,
    )
  }
  if (typeof parsed.sessionId !== "string" || !Array.isArray(parsed.messages)) {
    throw new SessionStateLoadError(
      path,
      "envelope shape mismatch (expected string `sessionId` + array `messages`)",
    )
  }
  // #14: element-level validation via the SAME zod Message schema the V2
  // id-mode store uses (S19 fix in @/session/store) — no cast-through of
  // arbitrary objects into the working-memory buffer.
  const invalid = firstInvalidMessageElement(parsed.messages)
  if (invalid !== undefined) {
    throw new SessionStateLoadError(
      path,
      `invalid message element at index ${invalid.index} (${invalid.issue})`,
      invalid.index,
    )
  }
  return { sessionId: parsed.sessionId, messages: parsed.messages as Message[] }
}

/** Exposed for callers that want to ensure the state dir exists first. */
export const stateParentDir = (path: string): string => parentDir(path)
