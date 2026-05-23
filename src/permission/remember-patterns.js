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
/** Pure union — returns a NEW set covering `allowed` ∪ `patterns`. Never
 *  mutates its inputs (the caller's set is left untouched). */
export const grantPatterns = (allowed, patterns) => {
    const next = new Set(allowed);
    for (const p of patterns)
        next.add(p);
    return next;
};
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
export const autoResolvable = (args) => {
    const { allowedPatterns, pending, excludeToolCallId, alreadyResolved } = args;
    const allowDangerous = args.allowDangerous === true;
    return pending.filter((t) => {
        if (t.toolCallId === excludeToolCallId)
            return false;
        if (alreadyResolved.has(t.toolCallId))
            return false;
        if (t.rememberPatterns.length === 0)
            return false;
        if (t.isMaybeDangerous && !allowDangerous)
            return false;
        return t.rememberPatterns.every((p) => allowedPatterns.has(p));
    });
};
/** Session-scoped store of granted patterns + the cascade engine.
 *
 *  Pure-ish: holds in-memory state (the allowed-pattern set) but performs no IO,
 *  no clock reads, and no cross-slice calls. Construct one per session; feed it
 *  grants and ask it which pending requests cascade open. */
export class PatternGrantStore {
    allowed;
    constructor(initial) {
        this.allowed = new Set(initial ?? []);
    }
    /** Snapshot of the currently-granted patterns (defensive copy). */
    granted() {
        return new Set(this.allowed);
    }
    /** Add patterns to the session's allowed set. Idempotent. */
    grant(patterns) {
        this.allowed = grantPatterns(this.allowed, patterns);
    }
    /** True iff EVERY pattern in `patterns` is currently granted. An empty
     *  `patterns` array is vacuously covered (`every` over [] is true) — callers
     *  that treat "no patterns" as not-auto-resolvable should use
     *  {@link autoResolvable}, which guards `length>0` explicitly. */
    isCovered(patterns) {
        return patterns.every((p) => this.allowed.has(p));
    }
    /** Cascade: after `justResolvedId` was granted, return the toolCallIds of all
     *  OTHER pending requests whose patterns are now fully covered. Pass
     *  `alreadyResolved` to exclude requests already settled this session;
     *  `allowDangerous` to include `isMaybeDangerous` requests in the cascade. */
    cascade(pending, justResolvedId, opts) {
        const resolved = opts?.alreadyResolved ?? new Set();
        return autoResolvable({
            allowedPatterns: this.allowed,
            pending,
            excludeToolCallId: justResolvedId,
            alreadyResolved: resolved,
            allowDangerous: opts?.allowDangerous,
        }).map((t) => t.toolCallId);
    }
}
const SAFE_LEADING_TOKENS = 2;
const MAX_LEADING_TOKENS = 4;
/** Heuristic guard for tokens that should NOT extend a pattern beyond their
 *  position. A `-`-prefixed flag like `--save-dev` is highly invocation-
 *  specific — the pattern stops at the prior token. Per the v0.dev hardening
 *  guard (the absorption ADR's overfitting concern). */
const isFlagLike = (token) => token.startsWith("-");
/** Tokenize an actionKey (`bash|git status --porcelain`) into the command's
 *  ordered tokens. Drops the tool prefix. Pure. */
const tokenizeAction = (actionKey) => {
    const idx = actionKey.indexOf("|");
    const body = idx >= 0 ? actionKey.slice(idx + 1) : actionKey;
    return body
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 0);
};
/** Compute the subcommand tokens for a tokenized actionKey: the leading
 *  non-flag tokens up to `MAX_LEADING_TOKENS`. Returns `[]` when no usable
 *  leading tokens exist. */
export const computeSubcommandTokens = (tokens) => {
    const out = [];
    for (const t of tokens) {
        if (isFlagLike(t))
            break;
        out.push(t);
        if (out.length >= MAX_LEADING_TOKENS)
            break;
    }
    return out;
};
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
export const inferSuggestedAllowlistEntry = (args) => {
    const actionKey = args.actionKey;
    if (actionKey === undefined || actionKey === null || actionKey.length === 0)
        return null;
    const tokens = tokenizeAction(actionKey);
    // Strip a leading `sudo` so we propose the underlying command pattern.
    const stripped = tokens[0] === "sudo" ? tokens.slice(1) : tokens;
    const subcommand = computeSubcommandTokens(stripped);
    const floor = args.minTokens ?? SAFE_LEADING_TOKENS;
    if (subcommand.length < floor)
        return null;
    return subcommand.join(",");
};
/** Build a {@link ClassifiedCommand} for an action. The gate exposes this on
 *  the reviewer-port seam so a UI can render "grant 'npm install' (pattern)"
 *  instead of the literal full invocation. */
export const classifyCommand = (args) => {
    const tokens = args.actionKey === undefined || args.actionKey === null ? [] : tokenizeAction(args.actionKey);
    const subcommand = computeSubcommandTokens(tokens[0] === "sudo" ? tokens.slice(1) : tokens);
    const suggested = inferSuggestedAllowlistEntry({
        toolName: args.toolName,
        ...(args.actionKey !== undefined && args.actionKey !== null
            ? { actionKey: args.actionKey }
            : {}),
    });
    return {
        name: args.toolName,
        arguments: tokens,
        subcommandTokens: subcommand,
        suggestedAllowlistEntry: suggested,
    };
};
