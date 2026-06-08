/**
 * §10.3 — Git resolver impl (the `resolveGit` method of a
 * `MentionResolverPort`). Cursor `@git` parity.
 *
 * Renders a compressed git-context body for the `@git` mention. The
 * subcommand (`status` / `diff` / `log` — the closed enum the parser
 * guarantees) selects WHICH context to inject.
 *
 * Clock / IO injection: this slice NEVER spawns git itself. The caller
 * injects a {@link GitContextProvider} — an async port that returns the raw
 * text for a subcommand (the runner supplies one backed by `@/runtime`'s
 * `runShell`, exactly like `repo-map-scan` supplies the `rg` shell). A test
 * injects a canned provider for fully deterministic replay.
 *
 * Bounded: the provider's text is truncated to {@link GitResolverOptions.maxBytes}
 * on a line boundary (Cursor / Codex keep the `@git` body small — the model
 * gets orientation, not the full diff). A blank provider result ⇒ `null`
 * (skip — no body for a clean tree / non-repo).
 *
 * NO-THROW: a throwing / rejecting provider ⇒ `null`. The ADR-0325 `safeCall`
 * wrapper is the belt-and-suspenders second line.
 */

import { errMessage, logger } from "@/shared"
import type { MentionResolverPort } from "@/agent/mention-injection"

/** The closed git subcommand enum (mirrors the parser's `@git:(status|diff|log)`). */
export type GitSubcommand = "status" | "diff" | "log"

/** Injected git-context port. Returns the raw text for a subcommand, or
 *  `null`/`""` when there is nothing to report (clean tree / non-repo). MUST
 *  be NO-THROW per the resolver contract; the wrapper catches regardless. */
export type GitContextProvider = (sub: GitSubcommand) => Promise<string | null>

/** Options for {@link createGitResolver}. */
export interface GitResolverOptions {
  /** Injected provider. Absent ⇒ every git mention resolves to `null`. */
  readonly provider: GitContextProvider
  /** Max body bytes spliced before truncation. Default {@link DEFAULT_GIT_MAX_BYTES}. */
  readonly maxBytes?: number
}

/** Default git body cap (~32 KiB). */
export const DEFAULT_GIT_MAX_BYTES = 32 * 1024

const GIT_TRUNCATION_MARKER = "… (git context truncated)"

const resolveMaxBytes = (raw: number | undefined): number =>
  typeof raw === "number" && Number.isFinite(raw) && raw > 0
    ? Math.trunc(raw)
    : DEFAULT_GIT_MAX_BYTES

const VALID_SUBS: ReadonlySet<string> = new Set<GitSubcommand>(["status", "diff", "log"])

/** Truncate to `maxBytes` on a LINE boundary, appending the marker. Pure. */
const truncate = (text: string, maxBytes: number): string => {
  if (text.length <= maxBytes) return text
  const slice = text.slice(0, maxBytes)
  const lastNl = slice.lastIndexOf("\n")
  const body = lastNl > 0 ? slice.slice(0, lastNl) : slice
  return `${body}\n${GIT_TRUNCATION_MARKER}`
}

/**
 * Build the `resolveGit` method of a {@link MentionResolverPort}.
 *
 * @param opts — injected provider + optional byte cap. An absent provider ⇒
 *               every git mention resolves to `null`.
 */
export const createGitResolver = (
  opts: GitResolverOptions,
): NonNullable<MentionResolverPort["resolveGit"]> => {
  const provider = opts?.provider
  const maxBytes = resolveMaxBytes(opts?.maxBytes)
  return async (target: string) => {
    if (typeof provider !== "function") return null
    // Defensive: the parser only emits the closed enum, but a hostile caller
    // could invoke the port directly. Reject unknown subcommands (no fallback).
    if (typeof target !== "string" || !VALID_SUBS.has(target)) return null
    try {
      const raw = await provider(target as GitSubcommand)
      if (raw === null || raw === undefined) return null
      const trimmed = raw.trim()
      if (trimmed.length === 0) return null
      return { bodyText: truncate(trimmed, maxBytes) }
    } catch (e) {
      logger.warn(`mention.git-resolver: ${errMessage(e)}`)
      return null
    }
  }
}
