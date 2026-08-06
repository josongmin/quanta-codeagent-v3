/**
 * RFC-12-2 — Prior-thread sub-resolver for the composite mention resolver.
 * `@thread:<id>` injects a compact summary (title + provenance) of a prior
 * session so the model can orient against earlier work without a full replay.
 *
 * Owner reuse (NO new store/registry): this slice NEVER reads the session
 * index / transcript store itself. The composition root injects a
 * {@link ThreadSummaryPort} — a thin read-only port backed by the ALREADY-LIVE
 * session store (`@/session`'s `listSessions` / `SessionMeta`), exactly as the
 * git resolver takes an injected `GitContextProvider`. A test injects a canned
 * port for deterministic replay.
 *
 * Body: `thread: <title>` header + provenance lines (`id`, `cwd`, and — when
 * present — the git branch / `threadSource` provenance the session index
 * already carries). A miss (unknown / archived-out id) ⇒ `null` (skip), never
 * a fabricated stub.
 *
 * NO-THROW: a throwing / rejecting port ⇒ `null`. The ADR-0325 `safeCall`
 * wrapper is the belt-and-suspenders second line.
 */

import type { MentionResolverPort } from "@/agent/mention-injection"
import { errMessage, logger } from "@/shared"

/** Read-only projection of a prior session/thread (a structural subset of
 *  `@/session`'s `SessionMeta`, re-declared here so this slice never imports
 *  the session store — mirroring the local `SkillRegistryReadOnly` idiom). */
export interface ThreadSummary {
  readonly id: string
  readonly title: string
  readonly cwd?: string
  readonly gitBranch?: string
  /** Codex `thread_source` — "new"/"resumed"/"forked"/"subagent". */
  readonly threadSource?: string
}

/**
 * Injected read-only thread-summary port. Returns the summary for a session
 * id, or `null` when NO thread by that id exists (⇒ the mention is skipped).
 * MUST be NO-THROW per the resolver contract; the wrapper catches regardless.
 */
export type ThreadSummaryPort = (id: string) => Promise<ThreadSummary | null>

/** Options for {@link createThreadResolver}. */
export interface ThreadResolverOptions {
  /** Injected summary port. Absent ⇒ every `@thread:` mention resolves to `null`. */
  readonly summary: ThreadSummaryPort
}

/**
 * Build the `resolveThread` method of a {@link MentionResolverPort}.
 *
 * @param opts — injected summary port. An absent port ⇒ every `@thread:`
 *               mention resolves to `null` (graceful omit).
 */
/** Append a `key: value` provenance line when `value` is a non-empty string.
 *  Mutates `lines`. Keeps the render loop flat (complexity ratchet). */
const pushMeta = (lines: string[], key: string, value: string | undefined): void => {
  if (typeof value === "string" && value.length > 0) lines.push(`${key}: ${value}`)
}

/** Render the compact summary body for a resolved prior thread. Pure. */
const renderThreadBody = (meta: ThreadSummary): string => {
  const title = typeof meta.title === "string" && meta.title.length > 0 ? meta.title : "(untitled)"
  const lines: string[] = [`thread: ${title}`, `id: ${meta.id}`]
  pushMeta(lines, "cwd", meta.cwd)
  pushMeta(lines, "branch", meta.gitBranch)
  pushMeta(lines, "source", meta.threadSource)
  return lines.join("\n")
}

export const createThreadResolver = (
  opts: ThreadResolverOptions,
): NonNullable<MentionResolverPort["resolveThread"]> => {
  const summary = opts?.summary
  return async (target: string) => {
    if (typeof summary !== "function") return null
    if (typeof target !== "string" || target.length === 0) return null
    try {
      const meta = await summary(target)
      if (meta === null || meta === undefined) return null
      return { bodyText: renderThreadBody(meta) }
    } catch (e) {
      logger.warn(`mention.thread-resolver: ${errMessage(e)}`)
      return null
    }
  }
}
