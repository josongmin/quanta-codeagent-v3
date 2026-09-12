/**
 * `@/shared/knob-overrides.ts` — the SINGLE process-level session-override store
 * for `QUANTA_*` knobs (ADR-0503 P4 live-control SSOT).
 *
 * `/knobs set <envKey>=<val>` writes HERE (one place), and every read accessor
 * consults it so a live set takes effect this session WITHOUT a restart:
 *   - `runtimeConfig()` (@/shared)   — merges over `process.env`, cache keyed on
 *     {@link knobOverridesVersion} so a set invalidates it
 *   - `readCliKnob()` (apps/cli)     — session layer of its precedence chain
 *   - (later) `resolveKnobs()` (@/runner)
 *
 * Lives in `@/shared` (leaf) so all layers import it downward. Process-memory
 * ONLY — never persisted (that is `/knobs save`'s explicit, separate job). A
 * monotonic version counter lets cached accessors detect changes cheaply.
 */

/**
 * SECURITY carve-out (RFC §4.3): knobs that gate a security boundary must NOT be
 * enable-able via a session `/knobs set` — only via `env` / managed config that
 * a workspace can't forge. Without this, making `runtimeConfig()` session-aware
 * would let `/knobs set QUANTA_CODE_MODE=1` enable code execution / disable the
 * FS jail / authorize TLS-MITM at runtime. Enforced at BOTH the writer (`/knobs
 * set` rejects) and the reader (`runtimeConfig` merge drops these). */
export const SESSION_FORBIDDEN_KNOBS: ReadonlySet<string> = new Set([
  "QUANTA_CODE_MODE",
  "QUANTA_CODE_MODE_ONLY",
  "QUANTA_FS_JAIL",
  "QUANTA_TLS_MITM",
  "QUANTA_TLS_MITM_ACK",
  "QUANTA_CENTRAL_CONFIG",
  "QUANTA_LLM_CREDENTIAL_TRUSTED",
  // D2 (AUDIT-2026-07-14, INV-G6 / RFC jul-13 §6.1 rule 5) — the sub-agent
  // nesting policy ceiling. A mid-session `/knobs set QUANTA_MAX_DESCENDANT_DEPTH=5`
  // would RAISE the descendant-depth cap (widening the spawn boundary), so the
  // policy must be session-pinned like every other security-boundary knob.
  // `QUANTA_MAX_SPAWN_DEPTH` is the legacy alias of the same policy; the per-config
  // `QUANTA_SUBAGENT_MAX_DEPTH` can only TIGHTEN via `effectiveCap = min(policy, …)`,
  // pinned here defensively so no session set can perturb the resolved cap.
  "QUANTA_MAX_DESCENDANT_DEPTH",
  "QUANTA_MAX_SPAWN_DEPTH",
  "QUANTA_SUBAGENT_MAX_DEPTH",
  // The STARTUP PERMISSION POSTURE. `/knobs set QUANTA_PERMISSION=bypass` was accepted
  // and stored, and `resolveCatalogValues` then displayed it as `source: "session"`
  // with the overridden mark — a security boundary showing as moved. It was inert only
  // because the reader is `process.env`-only and ignores the override store: an
  // accident, not a control. Every other operator entry point for the posture goes
  // through `isPermissionMode` and a surface that owns the change (`/posture`, the web
  // control verb, `serve --stdio`); a session knob set is not one of them.
  "QUANTA_PERMISSION",
])

/** True if `envKey` is a security-boundary knob that a session override may NOT set. */
export const isSessionForbidden = (envKey: string): boolean => SESSION_FORBIDDEN_KNOBS.has(envKey)

let OVERRIDES = new Map<string, string>()
let VERSION = 0

/** Set (or clear, with `undefined`) a live override. Bumps the version on any
 *  real change so version-keyed caches (runtimeConfig) rebuild on next read.
 *  Returns `false` (and does NOT store) if `envKey` is a security-boundary knob
 *  ({@link isSessionForbidden}) — the single chokepoint that keeps a session
 *  override out of EVERY reader (runtimeConfig / readCliKnob / resolveKnobs). */
export const setKnobOverride = (envKey: string, raw: string | undefined): boolean => {
  if (raw !== undefined && isSessionForbidden(envKey)) return false
  if (raw === undefined) {
    if (OVERRIDES.delete(envKey)) VERSION++
    return true
  }
  if (OVERRIDES.get(envKey) !== raw) {
    OVERRIDES.set(envKey, raw)
    VERSION++
  }
  return true
}

/** The live override for one knob, or `undefined` if none. */
export const getKnobOverride = (envKey: string): string | undefined => OVERRIDES.get(envKey)

/** Immutable snapshot of all overrides (for merging into an env bag / `/knobs save`). */
export const knobOverrides = (): Readonly<Record<string, string>> => Object.fromEntries(OVERRIDES)

/** PURE reader-side forbidden partition — the record MINUS any `isSessionForbidden`
 *  key. Extracted so it is directly testable with a forbidden key present (the store
 *  itself can never hold one — the writer gate refuses it — so testing the drop
 *  through the store would be vacuous; testing this pure fn is not). */
export const filterSessionForbidden = (
  record: Readonly<Record<string, string>>,
): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(record)) if (!isSessionForbidden(k)) out[k] = v
  return out
}

/** Reader-side defense-in-depth: `knobOverrides()` MINUS any session-forbidden key.
 *  `runtimeConfig()` merges THIS (not raw `knobOverrides()`) over env, so even if a
 *  FUTURE store-writer bypassed `setKnobOverride`'s writer gate, a forbidden knob
 *  still cannot take effect at read time — making the module's "enforced at BOTH the
 *  writer AND the reader" contract actually true. Byte-identical on the happy path
 *  (the writer already refuses forbidden keys, so the store never holds one). */
export const sessionSafeKnobOverrides = (): Readonly<Record<string, string>> =>
  filterSessionForbidden(Object.fromEntries(OVERRIDES))

/** Number of active overrides (fast "any overrides?" check). */
export const knobOverrideCount = (): number => OVERRIDES.size

/** Monotonic version — increments on every effective set/clear. Cache key. */
export const knobOverridesVersion = (): number => VERSION

/** Test seam — wipe the store (bumps version so caches invalidate). */
export const __resetKnobOverrides = (): void => {
  OVERRIDES = new Map()
  VERSION++
}
