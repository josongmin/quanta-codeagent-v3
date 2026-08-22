/**
 * `@/ipc/session-export` — quanta session → portable v1 format.
 *
 * Mirrors Claude Code A11's `importCliSession` direction (Web imports the
 * CLI's session). The portable schema is deliberately tiny: a peer surface
 * gets enough to render the session UI (meta + messages + turn count); it
 * does NOT include slice-internal storage details (file paths, index
 * cache state, retention markers). That keeps the wire schema stable while
 * `@/session` evolves.
 *
 * Schema version is `1`. A future v2 bump MUST also bump
 * `PORTABLE_SESSION_VERSION` and add migration code in `session-import.ts`.
 */

import type { Message } from "@/llm"
import { loadSessionById, type SessionMeta } from "@/session"

/** Schema version literal — bumped on incompatible portable-format changes. */
export const PORTABLE_SESSION_VERSION = 1 as const

/**
 * Portable session shape. Field naming uses snake_case for wire-stability
 * (consistent with `@/session/envelope`'s envelope records) — the TS-side
 * `SessionMeta` is in camelCase, so the exporter maps explicitly.
 */
export interface PortableSessionV1 {
  readonly schema: "quanta.session.portable"
  readonly version: typeof PORTABLE_SESSION_VERSION
  readonly meta: {
    readonly id: string
    readonly title: string
    readonly cwd: string
    readonly created_at: number
    readonly last_touched: number
    readonly archived: boolean
    readonly git_sha?: string
    readonly git_branch?: string
    readonly git_origin_url?: string
  }
  readonly reason: string
  readonly turns: number
  readonly messages: readonly Message[]
}

/**
 * Map a `SessionMeta` to the portable wire shape. Pure / synchronous /
 * total — every required field is sourced; optional fields are dropped
 * when undefined (so a round-trip on a non-git cwd does not invent keys).
 */
export const metaToPortable = (meta: SessionMeta): PortableSessionV1["meta"] => {
  // Build the base object explicitly — exactOptionalPropertyTypes
  // forbids assigning `undefined` to an optional field, so we conditionally
  // spread each git-fingerprint slot only when defined.
  const base = {
    id: meta.id,
    title: meta.title,
    cwd: meta.cwd,
    created_at: meta.createdAt,
    last_touched: meta.lastTouched,
    archived: meta.archived,
  }
  return {
    ...base,
    ...(meta.gitSha !== undefined ? { git_sha: meta.gitSha } : {}),
    ...(meta.gitBranch !== undefined ? { git_branch: meta.gitBranch } : {}),
    ...(meta.gitOriginUrl !== undefined ? { git_origin_url: meta.gitOriginUrl } : {}),
  }
}

/**
 * Export a session by id to the portable v1 wire shape. Returns
 * `undefined` if the session does not exist (active or archived) — the
 * caller decides whether that is an error or a no-op (e.g. a peer asking
 * for a session it no longer owns).
 *
 * Read-only: this function NEVER mutates session storage. `loadSessionById`
 * may reconcile the index cache from the on-disk meta (self-healing), but
 * the underlying SavedSession is unchanged.
 */
export const exportSession = async (id: string): Promise<PortableSessionV1 | undefined> => {
  const saved = await loadSessionById(id)
  if (saved === undefined) return undefined
  return {
    schema: "quanta.session.portable",
    version: PORTABLE_SESSION_VERSION,
    meta: metaToPortable(saved.meta),
    reason: saved.reason,
    turns: saved.turns,
    messages: saved.messages,
  }
}
