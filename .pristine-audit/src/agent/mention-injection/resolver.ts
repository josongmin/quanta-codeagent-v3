/**
 * ADR-0325 / ADR-0418 — Resolver port for mention → body-text rendering.
 *
 * Closed port. Every kind has its own method (5 kinds now: skill /
 * plugin / app / file / symbol). The port is **async** (ADR-0418
 * supersedes ADR-0325's sync port and ADR-0330's sync runner) so file /
 * symbol resolvers can perform I/O (fs read, LSP query) without blocking
 * the caller's event loop.
 *
 * The resolver is BANNED from throwing — adapter authors MUST swallow
 * I/O errors and return `null` (= "skip this mention"). This slice
 * nonetheless wraps every call in a try/catch as a belt-and-suspenders
 * NO-THROW guard so a hostile adapter cannot crash the pipeline. A
 * rejected promise is also treated as `null`.
 *
 * Resolution runs in PARALLEL (`Promise.all`): kind dispatch is HARD
 * (a `@skill` mention CANNOT fall through to `resolvePlugin` even if
 * `resolveSkill` returns null) — but independent mentions are resolved
 * concurrently because their I/O is orthogonal. Output order matches the
 * input order of RESOLVED mentions (skipped ones drop out), preserved by
 * `Promise.all`'s index-stable result array.
 *
 * The port is INTENTIONALLY NOT wired here. Adapter implementations
 * (skill-registry-backed, plugin-manifest-backed, app-catalog-backed,
 * fs-backed file resolver, LSP/semantic symbol resolver) live in the
 * mention-runner / plugin-app-resolver slices + this slice's
 * `file-resolver.ts` / `symbol-resolver.ts`.
 */

import { errMessage, logger } from "@/shared"
import type { InjectionFragment, MentionKind, ParsedMention } from "./types"

/**
 * Result of a successful resolution. Wrapped in a single-field object so
 * `null` vs `{ bodyText: "" }` is unambiguous — the former means "target
 * unknown / skip", the latter means "target known but its body is empty".
 */
export interface MentionResolverResult {
  readonly bodyText: string
}

/**
 * Closed async resolver port. Kind-dispatched. Each method returns a
 * Promise of the body text for the resolved mention, or `null` if the
 * target is unknown (skip — DO NOT emit a fragment for unknown targets).
 * MUST NOT throw / reject; implementations should catch and convert to
 * `Promise.resolve(null)`. The wrapping {@link buildInjectionFragments}
 * also catches as belt-and-suspenders.
 *
 * The three legacy methods (skill / plugin / app) are REQUIRED so a
 * composite factory can assign them unconditionally. The two ADR-0418
 * methods (file / symbol) are OPTIONAL: a resolver that omits (e.g.)
 * `resolveSymbol` causes every `symbol` mention to resolve to `null`
 * (skipped) — byte-identical to a resolver that explicitly returns null.
 * A hostile partial port that ALSO drops a legacy method is still handled
 * (the dispatch `?.` + safeCall treats a missing method as `null`).
 */
export interface MentionResolverPort {
  resolveSkill(target: string): Promise<MentionResolverResult | null>
  resolvePlugin(target: string): Promise<MentionResolverResult | null>
  resolveApp(target: string): Promise<MentionResolverResult | null>
  /** ADR-0418 — workspace file path resolver. Reads the file and returns
   *  its (possibly truncated) contents as bodyText. */
  resolveFile?(target: string): Promise<MentionResolverResult | null>
  /** ADR-0418 — code symbol resolver. Looks up the symbol via LSP /
   *  semantic search and returns a definition / outline body. */
  resolveSymbol?(target: string): Promise<MentionResolverResult | null>
  /** §10.3 — workspace folder resolver. Lists the directory entries and
   *  returns a bounded listing as bodyText. Omit ⇒ `folder` mentions
   *  resolve to `null` (byte-identical to the pre-§10.3 path). */
  resolveFolder?(target: string): Promise<MentionResolverResult | null>
  /** §10.3 — git context resolver. `target` is the subcommand
   *  (`status` / `diff` / `log`); returns a compressed git body. Omit ⇒
   *  `git` mentions resolve to `null`. */
  resolveGit?(target: string): Promise<MentionResolverResult | null>
  /** RFC-12-2 — MCP server resolver. `target` is the server name; returns a
   *  bounded listing of the server's exposed tools as bodyText. Omit ⇒ `mcp`
   *  mentions resolve to `null` (byte-identical to the pre-RFC-12-2 path). */
  resolveMcp?(target: string): Promise<MentionResolverResult | null>
  /** RFC-12-2 — named-agent (subagent) resolver. `target` is the agent-type /
   *  handle; returns the role's handle + description (first line of its system
   *  prompt). Omit ⇒ `subagent` mentions resolve to `null`. */
  resolveSubagent?(target: string): Promise<MentionResolverResult | null>
  /** RFC-12-2 — prior-thread resolver. `target` is the session id; returns a
   *  compact summary (title + provenance) of that prior session. Omit ⇒
   *  `thread` mentions resolve to `null`. */
  resolveThread?(target: string): Promise<MentionResolverResult | null>
}

/**
 * A per-mention resolution FAILURE (adapter threw / rejected). Distinct
 * from "unknown target" (a clean `null`), which is intentional + silent.
 * Handed to an OPTIONAL {@link MentionResolveErrorSink} so a failed
 * `@file` / `@skill` / `@symbol` reference is OPERATOR-VISIBLE instead of
 * vanishing indistinguishably from "no mentions".
 */
export interface MentionResolutionError {
  readonly kind: MentionKind
  readonly target: string
  readonly message: string
}

/**
 * Optional non-fatal error sink. Invoked once per FAILING mention (throw /
 * reject). MUST NOT be relied upon for control flow — the mention is still
 * dropped and resolution still degrades clean. A sink that itself throws is
 * swallowed (belt-and-suspenders); it can never abort the pipeline. When
 * omitted, behaviour is byte-identical to the pre-fix path.
 */
export type MentionResolveErrorSink = (error: MentionResolutionError) => void

/** Report a per-mention failure to the optional sink WITHOUT letting the
 *  sink's own throw escape (it is a side-channel — dropping the signal is
 *  preferable to crashing the turn, mirroring `safeCall` itself). */
const reportError = (
  sink: MentionResolveErrorSink | undefined,
  kind: MentionKind,
  target: string,
  message: string,
): void => {
  if (sink === undefined) return
  try {
    sink({ kind, target, message })
  } catch (e) {
    logger.warn(`mention.resolver.sink: ${errMessage(e)}`)
    /* swallow — side-channel, never crash the turn */
  }
}

/** Belt-and-suspenders NO-THROW wrapper around a single resolver call.
 *  Hostile / buggy adapter throwing OR rejecting ⇒ treated as `null`
 *  (skip). `undefined` results are also normalized to `null`.
 *
 *  A THROW / REJECT (as opposed to a clean `null` = "unknown target") is
 *  additionally reported to the optional {@link MentionResolveErrorSink} so
 *  a failed reference is OPERATOR-VISIBLE. Mirrors the outer-wrapper
 *  (`resolveMentionInjectionMessages`) emit-on-throw fix, whose `stream`
 *  handle never reaches this inner path because `safeCall` catches first.
 *  The `logger.warn` is RETAINED (the sink only ADDS visibility). */
const safeCall = async (
  fn: ((target: string) => Promise<MentionResolverResult | null>) | undefined,
  kind: MentionKind,
  target: string,
  onError: MentionResolveErrorSink | undefined,
): Promise<MentionResolverResult | null> => {
  if (typeof fn !== "function") return null
  try {
    const v = await fn(target)
    if (v === null || v === undefined) return null
    return v
  } catch (e) {
    const message = errMessage(e)
    logger.warn(`mention.resolver: ${message}`)
    reportError(onError, kind, target, message)
    return null
  }
}

/** Pick the kind-specific resolver method. Exhaustive over the closed
 *  `MentionKind` enum (10 kinds: ADR-0418's 5 + §10.3's folder + git +
 *  RFC-12-2's mcp + subagent + thread). */
const pickResolver = (
  resolver: MentionResolverPort,
  kind: MentionKind,
): ((target: string) => Promise<MentionResolverResult | null>) | undefined => {
  switch (kind) {
    case "skill":
      return resolver.resolveSkill?.bind(resolver)
    case "plugin":
      return resolver.resolvePlugin?.bind(resolver)
    case "app":
      return resolver.resolveApp?.bind(resolver)
    case "file":
      return resolver.resolveFile?.bind(resolver)
    case "symbol":
      return resolver.resolveSymbol?.bind(resolver)
    case "folder":
      return resolver.resolveFolder?.bind(resolver)
    case "git":
      return resolver.resolveGit?.bind(resolver)
    case "mcp":
      return resolver.resolveMcp?.bind(resolver)
    case "subagent":
      return resolver.resolveSubagent?.bind(resolver)
    case "thread":
      return resolver.resolveThread?.bind(resolver)
  }
}

/** Dispatch one parsed mention through the resolver port. Returns `null`
 *  on unknown / unresolvable / hostile-error. Kind dispatch is hard. */
const resolveOne = async (
  mention: ParsedMention,
  resolver: MentionResolverPort,
  onError: MentionResolveErrorSink | undefined,
): Promise<InjectionFragment | null> => {
  const fn = pickResolver(resolver, mention.kind)
  const result = await safeCall(fn, mention.kind, mention.target, onError)
  if (result === null) return null

  return {
    kind: mention.kind,
    target: mention.target,
    bodyText: result.bodyText,
    originSpan: { start: mention.span.start, end: mention.span.end },
  }
}

/**
 * Build {@link InjectionFragment}s from parsed mentions via the
 * {@link MentionResolverPort}. Unresolved mentions are SKIPPED (not
 * placeholders). Order of the returned array matches the input order of
 * resolvable mentions (parallel resolution preserves input order via
 * `Promise.all`'s index-stable result array).
 *
 * Async: each mention is resolved concurrently. Total wall time =
 * `max(per-mention latency)`, not sum. One mention's rejection /
 * exception does NOT drop the others — `resolveOne` catches per-mention.
 *
 * NO-THROW: any resolver exception / rejection is swallowed and the
 * mention is skipped. Empty `mentions` ⇒ `[]`.
 *
 * Observability: an OPTIONAL `onError` sink is invoked once per FAILING
 * mention (adapter threw / rejected — NOT for a clean `null` "unknown
 * target"). Without it, behaviour is byte-identical to the pre-fix path;
 * with it, a failed `@file` / `@skill` / `@symbol` reference becomes
 * operator-visible instead of vanishing like "no mentions". A caller can
 * bridge the sink to its stream (`stream.emit({ type: "error", ... })`) at
 * the wire-up seam — mirroring the outer-wrapper emit-on-throw fix.
 */
export const buildInjectionFragments = async (
  mentions: readonly ParsedMention[],
  resolver: MentionResolverPort,
  onError?: MentionResolveErrorSink,
): Promise<readonly InjectionFragment[]> => {
  if (mentions.length === 0) return []
  const results = await Promise.all(mentions.map((m) => resolveOne(m, resolver, onError)))
  const out: InjectionFragment[] = []
  for (const r of results) {
    if (r !== null) out.push(r)
  }
  return out
}
