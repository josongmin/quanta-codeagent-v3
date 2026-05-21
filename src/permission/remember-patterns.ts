/**
 * Permission learning — remember-patterns + cascade auto-resolve (ADR absorb #2,
 * from v0.dev's pending-permission bundle).
 *
 * Pure module. No IO, no wall-clock, no cross-slice imports. Lives entirely in
 * `@/permission` and must NOT reach into `@/llm` or `@/agent` (biome slice
 * isolation).
 *
 * v0's exact mechanism (reverse-engineered):
 *
 *   filter(t => t.id!==excludeId && !resolved[t.id]
 *            && t.rememberPatterns.length>0
 *            && t.rememberPatterns.every(p => allowedPatterns.has(p)))
 *
 * i.e. granting ONE permission re-evaluates ALL OTHER pending tool requests and
 * auto-resolves any whose patterns are now all covered by the session's
 * allowed-pattern set (CASCADE). The model self-proposes `suggestedPermissions`
 * and self-flags `isMaybeDangerous`.
 *
 * Wiring into the live admissibility gate is OPTIONAL and intentionally NOT done
 * here — this is a standalone-callable surface a follow-up can adopt. Default
 * behavior of every existing file is unchanged (additive-only).
 */

/** A pending permission request awaiting resolution.
 *
 *  - `rememberPatterns`: the concrete pattern strings this request would be
 *    satisfied by (e.g. `["bash:git status", "read:src/**"]`). A request with
 *    ZERO patterns can never be auto-resolved — it must be explicitly granted.
 *  - `suggestedPermissions`: patterns the MODEL self-proposes to remember if
 *    the user grants this request. Advisory; not used by the auto-resolve
 *    filter (the filter keys off `rememberPatterns`).
 *  - `isMaybeDangerous`: the model's self-flag. Hardening over v0: even when
 *    every pattern is covered, a dangerous request is NOT auto-resolved unless
 *    an explicit `allowDangerous` flag is passed by the caller. */
export interface PendingPermission {
  readonly toolCallId: string
  readonly rememberPatterns: readonly string[]
  readonly suggestedPermissions: readonly string[]
  readonly isMaybeDangerous: boolean
}

/** Pure union — returns a NEW set covering `allowed` ∪ `patterns`. Never
 *  mutates its inputs (the caller's set is left untouched). */
export const grantPatterns = (
  allowed: ReadonlySet<string>,
  patterns: readonly string[],
): Set<string> => {
  const next = new Set<string>(allowed)
  for (const p of patterns) next.add(p)
  return next
}

/** Returns the pending items that can now be auto-passed given the current
 *  `allowedPatterns` set. Mirrors v0's filter, with two hardening rules:
 *
 *    1. A request with ZERO `rememberPatterns` is NEVER auto-passed (must be
 *       explicitly granted) — matches v0's `length>0` guard.
 *    2. An `isMaybeDangerous` request is NEVER auto-passed unless the caller
 *       opts in via `allowDangerous: true`. This is an improvement over v0,
 *       which had no dangerous-gate on the cascade.
 *
 *  `excludeToolCallId` skips the just-granted request itself (v0's
 *  `t.id!==excludeId`). `alreadyResolved` skips anything already settled
 *  (v0's `!resolved[t.id]`). Both inputs are read-only; nothing is mutated. */
export const autoResolvable = (args: {
  allowedPatterns: ReadonlySet<string>
  pending: readonly PendingPermission[]
  excludeToolCallId?: string | undefined
  alreadyResolved: ReadonlySet<string>
  allowDangerous?: boolean | undefined
}): PendingPermission[] => {
  const { allowedPatterns, pending, excludeToolCallId, alreadyResolved } = args
  const allowDangerous = args.allowDangerous === true
  return pending.filter((t) => {
    if (t.toolCallId === excludeToolCallId) return false
    if (alreadyResolved.has(t.toolCallId)) return false
    if (t.rememberPatterns.length === 0) return false
    if (t.isMaybeDangerous && !allowDangerous) return false
    return t.rememberPatterns.every((p) => allowedPatterns.has(p))
  })
}

/** Session-scoped store of granted patterns + the cascade engine.
 *
 *  Pure-ish: holds in-memory state (the allowed-pattern set) but performs no IO,
 *  no clock reads, and no cross-slice calls. Construct one per session; feed it
 *  grants and ask it which pending requests cascade open. */
export class PatternGrantStore {
  private allowed: Set<string>

  constructor(initial?: Iterable<string>) {
    this.allowed = new Set<string>(initial ?? [])
  }

  /** Snapshot of the currently-granted patterns (defensive copy). */
  granted(): ReadonlySet<string> {
    return new Set(this.allowed)
  }

  /** Add patterns to the session's allowed set. Idempotent. */
  grant(patterns: readonly string[]): void {
    this.allowed = grantPatterns(this.allowed, patterns)
  }

  /** True iff EVERY pattern in `patterns` is currently granted. An empty
   *  `patterns` array is vacuously covered (`every` over [] is true) — callers
   *  that treat "no patterns" as not-auto-resolvable should use
   *  {@link autoResolvable}, which guards `length>0` explicitly. */
  isCovered(patterns: readonly string[]): boolean {
    return patterns.every((p) => this.allowed.has(p))
  }

  /** Cascade: after `justResolvedId` was granted, return the toolCallIds of all
   *  OTHER pending requests whose patterns are now fully covered. Pass
   *  `alreadyResolved` to exclude requests already settled this session;
   *  `allowDangerous` to include `isMaybeDangerous` requests in the cascade. */
  cascade(
    pending: readonly PendingPermission[],
    justResolvedId: string,
    opts?: { alreadyResolved?: ReadonlySet<string>; allowDangerous?: boolean },
  ): string[] {
    const resolved = opts?.alreadyResolved ?? new Set<string>()
    return autoResolvable({
      allowedPatterns: this.allowed,
      pending,
      excludeToolCallId: justResolvedId,
      alreadyResolved: resolved,
      allowDangerous: opts?.allowDangerous,
    }).map((t) => t.toolCallId)
  }
}
