export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E }

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value })
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error })

export type Id<Brand extends string> = string & { __brand: Brand }

/**
 * Codex HITL 4-tier taxonomy (hitl-audit.md) — the CANONICAL declaration.
 *
 * Every tool action — and within `bash`, each command — maps to exactly one
 * tier. The dispatch gate routes tier-specific behaviour (handoff terminates;
 * always-confirm bypasses mode; pre-approval-ok defers to the existing mode
 * policy; none allows).
 *
 *  - "hand-off-required": agent must terminate; only a human can proceed
 *    (matches HARD_DENY patterns and password/safety-bypass scenarios).
 *  - "always-confirm": explicit confirm EVERY time, even under
 *    `acceptEdits`/`bypass` (deletion, permissions change, financial txn,
 *    sending DMs, mutating network egress like `git push`).
 *  - "pre-approval-ok": existing mode policy applies; can be batch-approved.
 *  - "none": read-only / reversible / harmless.
 *
 * This lives in `@/shared` (the leaf layer below every slice) so the
 * `@/permission`, `@/tool`, and `@/agent` slices can each import it WITHOUT
 * violating the import-direction rule (biome forbids `@/tool ↔ @/permission`
 * etc., but `@/shared` is reachable from all of them). Slices re-export it
 * under the same name to preserve their public surface; the literal values
 * are byte-identical because there is now only one source.
 *
 * CRITICAL: the string values feed permission decisions and telemetry keys —
 * they must never drift. {@link ALL_HITL_TIERS} is the single ordered tuple a
 * zod `z.enum(...)` is built from so the runtime validator can't diverge from
 * the type either.
 */
export const ALL_HITL_TIERS = [
  "hand-off-required",
  "always-confirm",
  "pre-approval-ok",
  "none",
] as const

/** Canonical HITL 4-tier literal union, derived from {@link ALL_HITL_TIERS}. */
export type HITLTier = (typeof ALL_HITL_TIERS)[number]

/**
 * PDP capability declaration for a tool (jun-10, P2-T3) — lives in `@/shared` so
 * both `@/tool` and `@/permission` import it without a cycle. The SSOT for WHY a
 * tool needs a confirm; the security-floor decider (`@/permission` `decideFloor`)
 * reads it. `"sensitive"` ⇒ UNIVERSAL floor (every surface, even bypass);
 * `"needs-sandbox"` (e.g. bash without a profile) ⇒ defer to the sandbox / mode
 * layer; absent ⇒ defer (legacy). Minimal by design — room to grow (effects /
 * fsScope / netScope / dangerClass). */
export interface ToolCapability {
  readonly confirm?: "sensitive" | "needs-sandbox"
}

/**
 * WHY a tool resolved to its HITL tier (jul-10, D-1 follow-through) — the
 * first-class output of tier resolution that un-conflates the two reasons a
 * tool is `always-confirm` (see `@/permission/pdp.ts`):
 *   - `"sensitive"`     — capability opts into the UNIVERSAL floor (git push):
 *                         asks under every mode, even bypass.
 *   - `"needs-sandbox"` — bash w/o a sandbox profile OR the fail-closed
 *                         mutating catch-all (no `hitlTier`, no capability —
 *                         e.g. an MCP tool): asks under default/acceptEdits,
 *                         but BYPASS falls through to mode policy.
 *   - `"declared"`      — the tool's own explicit `hitlTier()` value
 *                         (deliberate audit ceremony; not relaxed by bypass).
 *   - `"registry"`      — the annotation registry ESCALATED the baseline tier
 *                         (operator asked for the gate; not relaxed by bypass).
 *   - `"inferred"`      — the read-only ⇒ "none" fallback (reason inert).
 */
export type HITLTierReason = "sensitive" | "needs-sandbox" | "declared" | "registry" | "inferred"
