/**
 * ADR-0110 — Session git-fingerprint wiring helper (opt-in seam).
 *
 * Non-destructive wrapper around {@link captureGitFingerprint} that returns a
 * NEW {@link SessionMeta} with `gitSha` / `gitBranch` / `gitOriginUrl`
 * attached when available. Designed so a caller (CLI bootstrap / app layer)
 * can `await wireSessionGitFingerprint(meta, defaultGitRunner)` at session
 * start without touching `src/agent/loop.ts` (which is currently in-flight on
 * the auth track).
 *
 * Best-effort contract:
 *   - Never throws. A failing git probe collapses to "field absent".
 *   - Original `meta` object is NEVER mutated — returns a shallow clone.
 *   - When the cwd is not a repo, returns a clone with all three fields
 *     undefined (carrying the input's other fields unchanged).
 */

import { captureGitFingerprint } from "@/session/git-fingerprint"
import type { SessionMeta } from "@/session/types"
import type { GitRunner } from "@/tool/git/types"

export const wireSessionGitFingerprint = async (
  meta: SessionMeta,
  runner: GitRunner,
  signal?: AbortSignal,
): Promise<SessionMeta> => {
  let fp: { sha?: string; branch?: string; originUrl?: string } = {}
  try {
    fp = await captureGitFingerprint(runner, meta.cwd, signal)
  } catch {
    // captureGitFingerprint is already best-effort, but defend against any
    // future regression — we MUST NOT throw out of this helper.
    fp = {}
  }
  // Return a NEW object so callers can rely on referential inequality + leave
  // the input meta untouched. Only attach fields when present so a consumer
  // that does `if ("gitSha" in meta)` doesn't see undefined-but-present keys.
  const out: SessionMeta = { ...meta }
  if (fp.sha !== undefined) out.gitSha = fp.sha
  if (fp.branch !== undefined) out.gitBranch = fp.branch
  if (fp.originUrl !== undefined) out.gitOriginUrl = fp.originUrl
  return out
}
