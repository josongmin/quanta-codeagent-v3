/**
 * Prefix-rule allowlist DSL — types (SSOT for the rules slice).
 *
 * Inspired by Codex's `~/.codex/rules/default.rules` (1060 `allow` prefix
 * rules, 100% allow, default-deny). We extend Codex's model along three
 * deliberate axes:
 *
 * 1. `deny` rule support — Codex is allow-only; we allow explicit blocking
 *    so security policies can be expressed positively.
 * 2. `ask` action — escalates to the ADR-0029 reviewer 3-tier system instead
 *    of auto-allowing or auto-denying.
 * 3. 3-layer (system / user / project) precedence — project > user > system,
 *    with longest-prefix-match WITHIN a layer. Codex is single-file; we
 *    separate layers so vendor / operator / repo policy compose cleanly.
 *
 * Determinism contract: this module has no I/O, no randomness, no clocks,
 * and no heuristics. All decisions are total functions of (rules, command).
 * Errors are named (`RuleParseError`, `RuleConflictError`) — never silent
 * fallthrough, never best-effort recovery (RFC §"no fallback").
 */
/** Parser-level error. Raised on malformed lines and on conflicting actions
 *  for the same prefix within a single layer. NEVER silently dropped. */
export class RuleParseError extends Error {
    sourceFile;
    lineNumber;
    constructor(message, sourceFile, lineNumber) {
        super(`${sourceFile}:${lineNumber}: ${message}`);
        this.name = "RuleParseError";
        this.sourceFile = sourceFile;
        this.lineNumber = lineNumber;
    }
}
/** Cross-layer / merge-time conflict. Reserved for future multi-source
 *  ingestion that wants to surface the conflicting rules to the caller
 *  rather than silently picking a winner. The matcher itself uses explicit
 *  precedence (layer + longest-prefix) and does NOT raise this — but
 *  callers ingesting external rule bundles may want to.
 *
 *  The `conflicts` array is informational; carrying it preserves the
 *  caller's ability to render a remediation message without re-parsing. */
export class RuleConflictError extends Error {
    conflicts;
    constructor(message, conflicts) {
        super(message);
        this.name = "RuleConflictError";
        this.conflicts = conflicts;
    }
}
