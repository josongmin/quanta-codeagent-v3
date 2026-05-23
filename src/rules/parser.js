/**
 * Prefix-rule DSL parser — pure, deterministic, fail-loud.
 *
 * Grammar (one rule per line):
 *   line     := comment | blank | rule
 *   comment  := optional-whitespace "#" any-text
 *   blank    := optional-whitespace
 *   rule     := action whitespace+ prefix
 *   action   := "allow" | "deny" | "ask"
 *   prefix   := non-empty token sequence (internal whitespace preserved,
 *               outer whitespace stripped)
 *
 * Errors (all `RuleParseError`, with 1-indexed `lineNumber` for diagnostics):
 *   - unknown action token
 *   - missing prefix (action without a body)
 *   - conflicting actions on the same prefix within this parse call
 *
 * Same-action duplicates are silently deduped (keeping the first occurrence)
 * — this is the only "merge" behaviour and is explicitly NOT a fallback;
 * the duplicate is observationally identical to the original.
 *
 * No I/O. No regex magic — the parser uses explicit `split` + `slice`
 * boundaries so the grammar is auditable line-by-line.
 */
import { RuleParseError } from "./types";
/** Set of accepted action tokens. Kept as a `Set` so membership checks are
 *  O(1) and the closed-enum invariant is encoded in one place. */
const ACTION_TOKENS = new Set(["allow", "deny", "ask"]);
/** Type guard for the closed action enum. */
const isRuleAction = (token) => ACTION_TOKENS.has(token);
/**
 * Parse a DSL document into a list of rules.
 *
 * @param text       Full DSL document (UTF-8 string). Line endings: `\n` or
 *                   `\r\n` (the parser splits on `\n` then strips trailing
 *                   `\r`, so both work byte-identically).
 * @param layer      Layer to tag every parsed rule with. The parser does
 *                   NOT infer layer from content — caller is authoritative.
 * @param sourceFile Free-form source identifier used in error messages.
 * @returns          Frozen array of rules in source order. Same-action
 *                   duplicates are deduped; conflicting actions throw.
 * @throws RuleParseError on malformed lines or same-line-layer conflicts.
 */
export const parseRules = (text, layer, sourceFile) => {
    const rules = [];
    // prefix -> first rule encountered with that prefix in THIS parse.
    // Used both for conflict detection and same-action dedupe.
    const byPrefix = new Map();
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
        const lineNumber = i + 1;
        const parsed = parseLine(lines[i] ?? "", sourceFile, lineNumber);
        if (parsed === null)
            continue;
        appendRule(parsed, layer, sourceFile, lineNumber, rules, byPrefix);
    }
    // Caller-visible immutability — prevents accidental in-place mutation of
    // parsed rules that would invalidate matcher invariants.
    return Object.freeze(rules);
};
/** Parse a single raw line. Returns `null` for blanks and comments; otherwise
 *  returns the validated `(action, prefix)` pair. Throws `RuleParseError` for
 *  malformed lines. Pure — no shared state. */
const parseLine = (raw, sourceFile, lineNumber) => {
    // Strip a trailing `\r` so CRLF documents parse identically to LF.
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const trimmed = line.trim();
    // Skip blanks and comments — comments are full-line only; trailing `#` on a
    // rule line is treated as part of the prefix (DSL is whitespace-delimited
    // only, so this stays deterministic).
    if (trimmed === "" || trimmed.startsWith("#")) {
        return null;
    }
    // Split off the action token at the FIRST whitespace run. Manual scan
    // (not `split(/\s+/)`) so we preserve the rest of the line verbatim —
    // internal whitespace in the prefix is meaningful.
    const wsIndex = findFirstWhitespace(trimmed);
    const actionToken = wsIndex === -1 ? trimmed : trimmed.slice(0, wsIndex);
    const rest = wsIndex === -1 ? "" : trimmed.slice(wsIndex + 1);
    if (!isRuleAction(actionToken)) {
        throw new RuleParseError(`unknown action token "${actionToken}" (expected one of: allow, deny, ask)`, sourceFile, lineNumber);
    }
    const prefix = rest.trim();
    if (prefix === "") {
        throw new RuleParseError(`missing prefix after action "${actionToken}"`, sourceFile, lineNumber);
    }
    return { action: actionToken, prefix };
};
/** Append a parsed line into the accumulator. Handles same-action dedupe
 *  (silent) and different-action conflicts (throws). Mutates `rules` and
 *  `byPrefix`. */
const appendRule = (parsed, layer, sourceFile, lineNumber, rules, byPrefix) => {
    const existing = byPrefix.get(parsed.prefix);
    if (existing !== undefined) {
        if (existing.action !== parsed.action) {
            throw new RuleParseError(`conflicting actions for prefix "${parsed.prefix}": ` +
                `previously "${existing.action}" at line ${existing.sourceLine}, ` +
                `now "${parsed.action}"`, sourceFile, lineNumber);
        }
        // Same-action duplicate: skip silently (observationally identical).
        return;
    }
    const rule = Object.freeze({
        action: parsed.action,
        prefix: parsed.prefix,
        layer,
        sourceLine: lineNumber,
        sourceFile,
    });
    rules.push(rule);
    byPrefix.set(parsed.prefix, rule);
};
/** Return the index of the first whitespace character in `s`, or -1.
 *  Whitespace = space or tab (the DSL is line-oriented; we already split
 *  on `\n` and we explicitly DO NOT treat other Unicode whitespace as a
 *  separator to keep behaviour deterministic across runtimes). */
const findFirstWhitespace = (s) => {
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        // 0x20 = space, 0x09 = tab.
        if (c === 0x20 || c === 0x09) {
            return i;
        }
    }
    return -1;
};
