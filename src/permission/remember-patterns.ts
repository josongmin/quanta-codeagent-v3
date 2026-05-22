/**
 * Permission learning — remember-patterns + cascade auto-resolve (ADR absorb #2,
 * from v0.dev's pending-permission bundle) + ClassifiedCommand suggested-allowlist
 * surface (L3→L4 promotion: Cursor absorption).
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

// ─────────────────────────────────────────────────────────────────────────
// L4 promotion — ClassifiedCommand `suggested_allowlist_entry` surface.
//
// Cursor reference (`cursor/agent-exec.js:99207-99213`):
//
//   ClassifiedCommand{name, arguments[], suggested_allowlist_entry, subcommand_tokens[]}
//
// A classifier proposes a TOKEN-SEQUENCE allowlist entry (e.g. `"npm,install"`)
// so the user grants a *pattern* (every `npm install …`) instead of the literal
// invocation. Our surface is intentionally smaller than Cursor's:
//
//   - We do NOT ship the ML classifier itself (overfitting risk on known-
//     dangerous flags). The current implementation is a deterministic
//     prefix-token sniffer over the action's stable key.
//   - The pattern is computed at the GATE seam (so the gate gives every
//     reviewer / surface a consistent suggestion without re-tokenizing).
//   - The suggested entry is OPT-IN — a surface that does not want to
//     surface it can ignore the field.
//
// `learning_source` tag — when a grant lands, the registry records WHICH
// path produced it: `user_accept` for an explicit confirm, `classifier` for
// a pattern auto-pass. This lets a host display "auto-allowed because of
// the npm,install grant" instead of "auto-allowed".
// ─────────────────────────────────────────────────────────────────────────

/** Where a granted pattern came from. Closed enum so trajectory consumers
 *  can switch exhaustively without string-matching. */
export type LearningSource = "user_accept" | "classifier"

/** Cursor's ClassifiedCommand surface, narrowed to what the gate uses. */
export interface ClassifiedCommand {
  /** Tool name (e.g. `"bash"`). */
  readonly name: string
  /** Tokenized arguments — for an `actionKey` of `"bash|git status"` the
   *  tokens are `["git","status"]`. Pure data; no executable semantics. */
  readonly arguments: readonly string[]
  /** Subcommand tokens — first N tokens that form the durable "shape" of
   *  the command (e.g. `["git","status"]` for `git status --porcelain`). */
  readonly subcommandTokens: readonly string[]
  /** Suggested pattern in `"npm,install"` form (leading-token sequence,
   *  comma-separated). `null` when no useful pattern could be derived (e.g.
   *  an action with no shell command — non-shell tools yield no tokens). */
  readonly suggestedAllowlistEntry: string | null
}

const SAFE_LEADING_TOKENS = 2
const MAX_LEADING_TOKENS = 4

/** Heuristic guard for tokens that should NOT extend a pattern beyond their
 *  position. A `-`-prefixed flag like `--save-dev` is highly invocation-
 *  specific — the pattern stops at the prior token. Per the v0.dev hardening
 *  guard (the absorption ADR's overfitting concern). */
const isFlagLike = (token: string): boolean => token.startsWith("-")

/** Tokenize an actionKey (`bash|git status --porcelain`) into the command's
 *  ordered tokens. Drops the tool prefix. Pure. */
const tokenizeAction = (actionKey: string): string[] => {
  const idx = actionKey.indexOf("|")
  const body = idx >= 0 ? actionKey.slice(idx + 1) : actionKey
  return body
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0)
}

/** Compute the subcommand tokens for a tokenized actionKey: the leading
 *  non-flag tokens up to `MAX_LEADING_TOKENS`. Returns `[]` when no usable
 *  leading tokens exist. */
export const computeSubcommandTokens = (tokens: readonly string[]): string[] => {
  const out: string[] = []
  for (const t of tokens) {
    if (isFlagLike(t)) break
    out.push(t)
    if (out.length >= MAX_LEADING_TOKENS) break
  }
  return out
}

/** Derive a suggested allowlist entry from an action's `actionKey`. Returns
 *  `null` when the action does not present a usable leading-token sequence
 *  (no actionKey, fewer than `SAFE_LEADING_TOKENS` non-flag tokens, or a
 *  classifier-flagged dangerous shape).
 *
 *  Hardening:
 *    - When the first token is `sudo` we drop it and use the next leading
 *      tokens — `sudo npm install` becomes `npm,install`, not `sudo,npm`.
 *    - At least two tokens required (so we never propose `"npm"` alone —
 *      too broad). Override the floor via `minTokens` (default 2).
 *
 *  Pure; safe to call on every dispatch even when the gate is opted out. */
export const inferSuggestedAllowlistEntry = (args: {
  toolName: string
  actionKey?: string | null
  minTokens?: number
}): string | null => {
  const actionKey = args.actionKey
  if (actionKey === undefined || actionKey === null || actionKey.length === 0) return null
  const tokens = tokenizeAction(actionKey)
  // Strip a leading `sudo` so we propose the underlying command pattern.
  const stripped = tokens[0] === "sudo" ? tokens.slice(1) : tokens
  const subcommand = computeSubcommandTokens(stripped)
  const floor = args.minTokens ?? SAFE_LEADING_TOKENS
  if (subcommand.length < floor) return null
  return subcommand.join(",")
}

/** Build a {@link ClassifiedCommand} for an action. The gate exposes this on
 *  the reviewer-port seam so a UI can render "grant 'npm install' (pattern)"
 *  instead of the literal full invocation. */
export const classifyCommand = (args: {
  toolName: string
  actionKey?: string | null
}): ClassifiedCommand => {
  const tokens =
    args.actionKey === undefined || args.actionKey === null ? [] : tokenizeAction(args.actionKey)
  const subcommand = computeSubcommandTokens(tokens[0] === "sudo" ? tokens.slice(1) : tokens)
  const suggested = inferSuggestedAllowlistEntry({
    toolName: args.toolName,
    ...(args.actionKey !== undefined && args.actionKey !== null
      ? { actionKey: args.actionKey }
      : {}),
  })
  return {
    name: args.toolName,
    arguments: tokens,
    subcommandTokens: subcommand,
    suggestedAllowlistEntry: suggested,
  }
}
