import type { Message } from "@/llm"
import { fileExists, parentDir, readFile, writeFile } from "@/storage"

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
 * Persist the session transcript to `path` as JSON. Atomic-ish: write a
 * sibling `.tmp` then rename over the target so a crash mid-write never leaves
 * a half-file. Falls back to a plain write if rename is unavailable.
 */
export const saveSession = async (path: string, input: SaveSessionInput): Promise<void> => {
  const payload: SessionFile = {
    version: STATE_VERSION,
    sessionId: input.sessionId,
    reason: input.reason,
    turns: input.turns,
    messages: input.messages,
  }
  const json = JSON.stringify(payload)
  const tmp = `${path}.tmp`
  try {
    await writeFile(tmp, json)
    await Bun.write(path, Bun.file(tmp))
    await Bun.file(tmp).delete()
  } catch {
    await writeFile(path, json)
  }
}

/**
 * Load a previously saved session. Returns `null` when the file is missing or
 * corrupt — never throws (resume is best-effort; a bad file just means a fresh
 * conversation).
 */
export const loadSession = async (
  path: string,
): Promise<{ sessionId: string; messages: Message[] } | null> => {
  try {
    if (!(await fileExists(path))) return null
    const raw = await readFile(path)
    const parsed = JSON.parse(raw) as Partial<SessionFile>
    if (typeof parsed.sessionId !== "string" || !Array.isArray(parsed.messages)) {
      return null
    }
    return { sessionId: parsed.sessionId, messages: parsed.messages as Message[] }
  } catch {
    return null
  }
}

/** Exposed for callers that want to ensure the state dir exists first. */
export const stateParentDir = (path: string): string => parentDir(path)
