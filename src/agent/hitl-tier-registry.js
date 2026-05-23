import { errMessage } from "@/shared";
/**
 * ADR-0047 — HITL tier annotation registry.
 *
 * A tier *annotation* registry sits between the tool's own `hitlTier(input)`
 * method (which ADR-0020 defined) and the admissibility-gate. It exists so:
 *
 *  1. Built-in tier hints can attach to tools that DON'T own their own
 *     classifier — `bash` cases beyond the ones the bash classifier covers,
 *     and any future tool whose tier policy is decided by the agent
 *     framework (not the tool slice).
 *  2. Operators can override built-in annotations via a JSON file at
 *     `~/.quanta/hitl-overrides.json` (path resolved by `runtimeConfig.
 *     hitlOverridesPath`). Overrides are clamped to a **one-way ratchet**:
 *     they may ESCALATE a tier (e.g. pre-approval-ok → always-confirm)
 *     but never DOWNGRADE `hand-off-required` (the gate's last-line
 *     security boundary).
 *
 * Resolution precedence (highest priority first):
 *  - explicit `tool.hitlTier(input)` returning `"hand-off-required"`
 *    (cannot be downgraded by any later layer)
 *  - operator override clamped against built-in (escalate-only)
 *  - built-in annotation
 *  - `tool.hitlTier(input)` for non-handoff tiers
 *  - secure-by-default fallback in `@/permission#inferToolTier`
 *
 * The registry is intentionally simple — exact tool-name match + optional
 * command-prefix match. Regex matching is deliberately NOT supported to
 * keep evaluation deterministic and the override file auditable. A more
 * expressive matcher would push us toward a DSL (see ADR-0031 for a
 * precedent we explicitly do NOT want to repeat here).
 *
 * Failure mode: malformed override file ⇒ stderr warn + fall back to
 * built-in annotations. The agent NEVER throws at startup over a bad
 * override file; that would be a foot-gun for operators who edit it by
 * hand. (Schema errors are still surfaced loudly so they're actionable.)
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import { ALL_HITL_TIERS, runtimeConfig } from "@/shared";
/** Zod tier validator — produces a precise error message including the
 *  offending value when an override file contains an unknown tier. Built from
 *  the canonical `ALL_HITL_TIERS` tuple so the runtime validator can never
 *  drift from the `HITLTier` literal union. */
const TierSchema = z.enum(ALL_HITL_TIERS);
/** Single annotation entry. `commandPrefix` is OPTIONAL — when absent the
 *  rule fires on every invocation of `tool`. When present it must be a
 *  literal string prefix of the tool input's `command` field (or the input
 *  itself when the tool's input is a string). */
const AnnotationSchema = z
    .object({
    tool: z.string().min(1),
    commandPrefix: z.string().optional(),
    tier: TierSchema,
    /** Free-form rationale that flows through to deny messages / telemetry.
     *  Operators are encouraged to fill it in for audit trails. */
    reason: z.string().optional(),
})
    .strict();
const OverrideFileSchema = z.object({
    /** Schema version for forward-compat. Unknown ⇒ stderr warn + skip file. */
    version: z.literal(1),
    annotations: z.array(AnnotationSchema).default([]),
});
/** Built-in annotation table. ORDER MATTERS — the first matching entry
 *  wins. Keep entries ordered most-specific (longest commandPrefix) to
 *  most-general (tool-only) so an operator reading this file can predict
 *  which one fires. */
const BUILTIN_ANNOTATIONS = Object.freeze([
// No built-in annotations ship by default — the bash classifier already
// covers the well-known cases (curl/wget/git push/git fetch/git reset
// --hard/git commit --amend). The registry exists so the OPERATOR can
// add their own without changing source code. Future absorption rounds
// may add framework-owned entries here; today the list is intentionally
// empty so the byte-identical contract holds for default callers.
]);
/** Lazy-cached override list. The override file is read at most once per
 *  process; tests reset via `__resetHitlOverrides`. */
let overrideCache;
const stderrWarn = (msg) => {
    process.stderr.write(`[quanta] hitl-overrides: ${msg}\n`);
};
/** Convert a parsed override entry to the frozen public shape. */
const freezeAnnotation = (raw) => {
    const out = {
        tool: raw.tool,
        tier: raw.tier,
    };
    if (raw.commandPrefix !== undefined)
        out.commandPrefix = raw.commandPrefix;
    if (raw.reason !== undefined)
        out.reason = raw.reason;
    return Object.freeze(out);
};
/** Load operator overrides from `runtimeConfig().hitlOverridesPath`. Absent
 *  path ⇒ empty list (byte-identical legacy). File errors ⇒ stderr warn +
 *  empty list. Schema errors ⇒ stderr warn + empty list. Never throws. */
const loadOverridesFromDisk = () => {
    const path = runtimeConfig().hitlOverridesPath;
    if (path === undefined || path.length === 0)
        return Object.freeze([]);
    let raw;
    try {
        raw = readFileSync(path, "utf8");
    }
    catch (e) {
        const code = e.code;
        // ENOENT is the common case — the operator simply hasn't written one.
        // Don't warn for missing files; only warn for permission / IO errors.
        if (code !== "ENOENT") {
            const msg = errMessage(e);
            stderrWarn(`failed to read ${path}: ${msg} — falling back to built-in annotations`);
        }
        return Object.freeze([]);
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (e) {
        const msg = errMessage(e);
        stderrWarn(`malformed JSON in ${path}: ${msg} — falling back to built-in annotations`);
        return Object.freeze([]);
    }
    const result = OverrideFileSchema.safeParse(parsed);
    if (!result.success) {
        const issues = result.error.issues
            .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
            .join("\n");
        stderrWarn(`schema validation failed for ${path}:\n${issues}\n — falling back to built-in annotations`);
        return Object.freeze([]);
    }
    return Object.freeze(result.data.annotations.map(freezeAnnotation));
};
/** Return the cached override list, loading on first call. */
const overrides = () => {
    if (overrideCache === undefined)
        overrideCache = loadOverridesFromDisk();
    return overrideCache;
};
/** Test-only: reset the override cache so a test can drive a different
 *  file snapshot. Production code MUST NOT call this. */
export const __resetHitlOverrides = () => {
    overrideCache = undefined;
};
/** Numeric strictness ranking — higher = stricter. Used to enforce the
 *  one-way ratchet on overrides (never relax a built-in / explicit tier). */
const TIER_RANK = Object.freeze({
    none: 0,
    "pre-approval-ok": 1,
    "always-confirm": 2,
    "hand-off-required": 3,
});
/** Choose the STRICTER of two tiers (max by rank). The gate uses this to
 *  apply an override on top of a built-in / explicit tier so the override
 *  can only escalate. */
const maxTier = (a, b) => (TIER_RANK[a] >= TIER_RANK[b] ? a : b);
/** Extract the `command` string from a tool input shape, if present.
 *  Returns `null` for shapes that don't carry one (so command-prefix rules
 *  simply don't fire — never throws on malformed input). */
const extractCommand = (input) => {
    if (typeof input === "string")
        return input;
    if (input === null || typeof input !== "object")
        return null;
    const cmd = input["command"];
    return typeof cmd === "string" ? cmd : null;
};
/** Look up the first matching annotation in a list. */
const findAnnotation = (table, tool, command) => {
    for (const a of table) {
        if (a.tool !== tool)
            continue;
        if (a.commandPrefix !== undefined) {
            if (command === null)
                continue;
            if (!command.startsWith(a.commandPrefix))
                continue;
        }
        return a;
    }
    return undefined;
};
/**
 * Resolve the effective tier annotation for a tool call.
 *
 * @param tool       Name of the tool being dispatched.
 * @param input      Raw tool input (matched against `commandPrefix` if present).
 * @param baseline   The tier the upstream classifier (`inferToolTier` or the
 *                   tool's own `hitlTier`) already resolved. Used to enforce
 *                   the one-way ratchet — overrides can only ESCALATE this.
 *
 * @returns The final tier, plus the matching annotation when one applied.
 *          When no rule matches, `tier === baseline` and `matched` is
 *          `undefined` (so callers can tell "registry stayed silent" from
 *          "registry returned the same tier deliberately").
 */
export const resolveHitlAnnotation = (tool, input, baseline) => {
    // hand-off-required from the upstream classifier is the gate's final
    // security boundary — no registry layer (built-in or override) may
    // relax it. Short-circuit before we even read the override list.
    if (baseline === "hand-off-required") {
        return { tier: "hand-off-required", matched: undefined };
    }
    const command = extractCommand(input);
    // Built-in annotations apply first; the override list is then layered on
    // top with strict-only semantics (`maxTier`). This preserves the
    // ordering invariant that an operator can only TIGHTEN policy.
    const builtin = findAnnotation(BUILTIN_ANNOTATIONS, tool, command);
    const override = findAnnotation(overrides(), tool, command);
    let tier = baseline;
    let matched;
    if (builtin !== undefined) {
        tier = maxTier(tier, builtin.tier);
        matched = builtin;
    }
    if (override !== undefined) {
        const escalated = maxTier(tier, override.tier);
        // Only record `matched = override` when the override actually moved
        // the needle. A no-op override entry (e.g. `tier: "none"` for a tool
        // that was already `always-confirm`) is silently ignored — the
        // operator gets neither a tier change nor a misleading "matched" log.
        if (escalated !== tier) {
            tier = escalated;
            matched = override;
        }
        else if (TIER_RANK[override.tier] < TIER_RANK[tier]) {
            // Operator tried to DOWNGRADE the tier — one-way ratchet refuses.
            // We don't throw (the gate stays best-effort) but we surface the
            // attempt so it's actionable.
            stderrWarn(`override for tool="${tool}"${override.commandPrefix !== undefined ? ` commandPrefix="${override.commandPrefix}"` : ""} tried to downgrade tier from "${tier}" to "${override.tier}" — ignored (one-way ratchet)`);
        }
    }
    return { tier, matched };
};
/** Public read of the built-in table — exposed for tests that assert the
 *  default shipping policy. Production callers MUST go through
 *  `resolveHitlAnnotation`. */
export const builtinAnnotations = () => BUILTIN_ANNOTATIONS;
