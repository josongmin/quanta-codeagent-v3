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
}

/** Belt-and-suspenders NO-THROW wrapper around a single resolver call.
 *  Hostile / buggy adapter throwing OR rejecting ⇒ treated as `null`
 *  (skip). `undefined` results are also normalized to `null`. */
const safeCall = async (
  fn: ((target: string) => Promise<MentionResolverResult | null>) | undefined,
  target: string,
): Promise<MentionResolverResult | null> => {
  if (typeof fn !== "function") return null
  try {
    const v = await fn(target)
    if (v === null || v === undefined) return null
    return v
  } catch {
    return null
  }
}

/** Pick the kind-specific resolver method. Exhaustive over the closed
 *  `MentionKind` enum (5 kinds, ADR-0418). */
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
  }
}

/** Dispatch one parsed mention through the resolver port. Returns `null`
 *  on unknown / unresolvable / hostile-error. Kind dispatch is hard. */
const resolveOne = async (
  mention: ParsedMention,
  resolver: MentionResolverPort,
): Promise<InjectionFragment | null> => {
  const fn = pickResolver(resolver, mention.kind)
  const result = await safeCall(fn, mention.target)
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
 */
export const buildInjectionFragments = async (
  mentions: readonly ParsedMention[],
  resolver: MentionResolverPort,
): Promise<readonly InjectionFragment[]> => {
  if (mentions.length === 0) return []
  const results = await Promise.all(mentions.map((m) => resolveOne(m, resolver)))
  const out: InjectionFragment[] = []
  for (const r of results) {
    if (r !== null) out.push(r)
  }
  return out
}
