/**
 * ADR-0325 — Resolver port for mention → body-text rendering.
 *
 * Closed port: every kind has its own method so a registry without
 * (e.g.) plugin support can implement two of three without breaking the
 * other two. The resolver is BANNED from throwing — adapter authors
 * MUST swallow registry I/O errors and return `null` (= "skip this
 * mention"). This slice nonetheless wraps every call in a try/catch as
 * a belt-and-suspenders NO-THROW guard so a hostile adapter cannot
 * crash the parser pipeline.
 *
 * The port is INTENTIONALLY NOT wired here. Adapter implementations
 * (skill-registry-backed, plugin-manifest-backed, app-catalog-backed)
 * live in follow-up ADRs.
 */

import type { InjectionFragment, MentionKind, ParsedMention } from "./types"

/**
 * Result of a successful resolution. Wrapped in a single-field object so
 * `null` vs `{ bodyText: "" }` is unambiguous — the former means "skill
 * unknown / skip", the latter means "skill known but its body is empty".
 */
export interface MentionResolverResult {
  readonly bodyText: string
}

/**
 * Closed resolver port. Kind-dispatched. Each method returns the body
 * text for the resolved mention, or `null` if the target is unknown
 * (skip — DO NOT emit a fragment for unknown targets). MUST NOT throw;
 * implementations should catch and convert to `null`.
 */
export interface MentionResolverPort {
  resolveSkill(target: string): MentionResolverResult | null
  resolvePlugin(target: string): MentionResolverResult | null
  resolveApp(target: string): MentionResolverResult | null
  /** ADR-0414 — resolve a `@file` mention to its body text. SYNC
   *  (`fs.readFileSync`-backed adapter). `target` is the raw file path
   *  (sigil/prefix stripped). Returns `null` for missing / outside-jail /
   *  binary / unreadable files (skip — graceful). MUST NOT throw. Optional
   *  on the port: a resolver that pre-dates ADR-0414 (e.g. ADR-0330's
   *  skill-only flavour) omits it, and a `file` mention then resolves to
   *  `null` (skipped) — byte-identical to the legacy 3-kind behaviour. */
  resolveFile?(target: string): MentionResolverResult | null
}

/** Belt-and-suspenders NO-THROW wrapper around a single resolver call.
 *  Hostile / buggy adapter throwing ⇒ treated as `null` (skip). */
const safeCall = (
  fn: ((target: string) => MentionResolverResult | null) | undefined,
  target: string,
): MentionResolverResult | null => {
  if (typeof fn !== "function") return null
  try {
    return fn(target)
  } catch {
    return null
  }
}

/** Dispatch one parsed mention through the resolver port. Returns `null`
 *  on unknown / unresolvable / hostile-error. Kind dispatch is hard
 *  (a `skill` mention CANNOT fall through to `resolvePlugin` even if
 *  `resolveSkill` returns null) — preserves user-intent. */
const resolveOne = (
  mention: ParsedMention,
  resolver: MentionResolverPort,
): InjectionFragment | null => {
  const fn = pickResolver(resolver, mention.kind)
  const result = safeCall(fn, mention.target)
  if (result === null) return null

  return {
    kind: mention.kind,
    target: mention.target,
    bodyText: result.bodyText,
    originSpan: { start: mention.span.start, end: mention.span.end },
  }
}

/** Pick the kind-specific resolver method. Exhaustive over the closed
 *  `MentionKind` enum. */
const pickResolver = (
  resolver: MentionResolverPort,
  kind: MentionKind,
): ((target: string) => MentionResolverResult | null) | undefined => {
  switch (kind) {
    case "skill":
      return resolver.resolveSkill?.bind(resolver)
    case "plugin":
      return resolver.resolvePlugin?.bind(resolver)
    case "app":
      return resolver.resolveApp?.bind(resolver)
    case "file":
      return resolver.resolveFile?.bind(resolver)
  }
}

/**
 * Build {@link InjectionFragment}s from parsed mentions via the
 * {@link MentionResolverPort}. Unresolved mentions are SKIPPED (not
 * placeholders). Order of the returned array matches the input order
 * of resolvable mentions.
 *
 * Pure: no clock read, no I/O.
 *
 * NO-THROW: any resolver exception is swallowed and the mention is
 * skipped. Empty `mentions` ⇒ `[]`.
 */
export const buildInjectionFragments = (
  mentions: readonly ParsedMention[],
  resolver: MentionResolverPort,
): readonly InjectionFragment[] => {
  if (mentions.length === 0) return []
  const out: InjectionFragment[] = []
  for (const m of mentions) {
    const fragment = resolveOne(m, resolver)
    if (fragment !== null) out.push(fragment)
  }
  return out
}
