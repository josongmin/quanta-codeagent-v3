/**
 * §2.5 — marketplace.json install/auth POLICY gating (jun-08 longtail).
 *
 * SOTA reference: Claude Code's managed-settings `strictKnownMarketplaces`
 * (enterprise STRICT allowlist — ONLY these exact sources may be added as
 * marketplaces) + a blocklist of sources. The check happens BEFORE downloading,
 * so a blocked source NEVER touches the filesystem. Policy scope only (managed
 * settings), ignored in user/project/local.
 *
 * This module is the PURE policy DECISION — no I/O, no env read in the core
 * `checkMarketplaceSource`. The gated entry point `enforceMarketplacePolicy`
 * adds the `QUANTA_MARKETPLACE_POLICY` opt-in: default-OFF ⇒ everything is
 * allowed (byte-identical, no gating). The HOST owns wiring the verdict into its
 * marketplace-add flow (deny before clone/download on a `block`).
 *
 * Slice posture: pure leaf — imports only `@/shared` (gateOn). NO-THROW: a
 * malformed/empty policy degrades to "allow" (no source constraints), never
 * crashes the add flow.
 */
import { gateOn } from "@/shared"

/**
 * Enterprise marketplace policy. Both lists are EXACT-match source strings
 * (a marketplace `source` — a git URL / directory path / npm spec). Both are
 * optional: an empty policy imposes NO constraints.
 *
 *  - `strictKnownSources`: when present + non-empty, ONLY a source that EXACTLY
 *    matches an entry may be added; everything else is blocked (`not-allowlisted`).
 *  - `blockedSources`: any source that EXACTLY matches an entry is blocked
 *    (`blocklisted`). Takes PRECEDENCE over the allowlist (a source in BOTH is
 *    blocked — block always wins, fail-closed).
 */
export interface MarketplacePolicy {
  readonly strictKnownSources?: readonly string[]
  readonly blockedSources?: readonly string[]
}

/** Why a source was blocked. Stable arm so callers branch without string parse. */
export type MarketplaceBlockReason = "blocklisted" | "not-allowlisted"

/** Typed verdict — no throw. `allow` ⇒ the add may proceed; `block` ⇒ the host
 *  MUST deny the add BEFORE any download/clone. */
export type MarketplaceVerdict =
  | { readonly kind: "allow" }
  | { readonly kind: "block"; readonly reason: MarketplaceBlockReason; readonly source: string }

const ALLOW: MarketplaceVerdict = { kind: "allow" }

/**
 * PURE policy decision for ONE marketplace source. No I/O, no env. The source is
 * trimmed of surrounding whitespace before EXACT comparison (a leading/trailing
 * space must not let a blocked source slip through, nor reject an allowlisted
 * one). Block precedence: blocklist is checked first (fail-closed).
 */
export const checkMarketplaceSource = (
  source: string,
  policy: MarketplacePolicy,
): MarketplaceVerdict => {
  const s = source.trim()
  const blocked = policy.blockedSources ?? []
  if (blocked.some((b) => b.trim() === s)) {
    return { kind: "block", reason: "blocklisted", source: s }
  }
  const strict = policy.strictKnownSources ?? []
  if (strict.length > 0 && !strict.some((a) => a.trim() === s)) {
    return { kind: "block", reason: "not-allowlisted", source: s }
  }
  return ALLOW
}

/**
 * Gated entry point. DEFAULT-OFF: when `QUANTA_MARKETPLACE_POLICY` is not
 * gate-on, returns `allow` for EVERY source (byte-identical — no enterprise
 * gating, the prior behavior). When ON, delegates to {@link
 * checkMarketplaceSource}. `env` is injectable for tests.
 */
export const enforceMarketplacePolicy = (
  source: string,
  policy: MarketplacePolicy,
  env: Record<string, string | undefined> = process.env,
): MarketplaceVerdict => {
  if (!gateOn(env, "QUANTA_MARKETPLACE_POLICY")) return ALLOW
  return checkMarketplaceSource(source, policy)
}
