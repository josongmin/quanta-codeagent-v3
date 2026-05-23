import type { Message } from "@/llm"

/**
 * Id-addressable session persistence — V2 schema.
 *
 * V1 (path-based) lives in `src/agent/state.ts` and is NOT touched. This slice
 * is a NEW rail next to it: callers mint an opaque id and we keep the file at
 * `<sessionsRoot>/<id>.json` (or `<sessionsRoot>/archived/<id>.json` when
 * archived) plus a single `index.jsonl` for cheap listing. Inspired by the
 * Codex CLI's session UX.
 *
 * Schema bump: `SESSION_VERSION = 2` so a future reader can tell V1 / V2 apart
 * (their on-disk shapes differ — V2 has a `meta` envelope; V1 has flat fields).
 */
export const SESSION_VERSION = 2 as const

export interface SessionMeta {
  id: string
  title: string
  cwd: string
  createdAt: number
  lastTouched: number
  archived: boolean
  /** ADR-0106 git fingerprint (Codex §18.9 absorption). Captured at session
   *  start when the cwd is a git repository; each field is independent —
   *  a detached HEAD has SHA but no branch; a local-only repo has branch
   *  but no originUrl. Absent fields mean "not captured" (cwd not a repo,
   *  spawn failure, etc.) — never lossy stripping. */
  gitSha?: string
  gitBranch?: string
  gitOriginUrl?: string
}

export interface SavedSession {
  version: typeof SESSION_VERSION
  meta: SessionMeta
  reason: string
  turns: number
  messages: Message[]
}

export interface SavePayload {
  reason: string
  turns: number
  messages: Message[]
}
