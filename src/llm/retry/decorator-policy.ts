/**
 * Single-authority decorator policy (DOF-30, ADR-0214).
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 * `codexSpecRoute` (./codex-spec-router.ts, the 18-kind × 6-action table) is the
 * SINGLE routing authority. Historically the two `LLMPort` decorators each
 * carried their OWN hardcoded kind-set:
 *   - `RetryingLLM` (src/agent/retry.ts): `RETRYABLE_KINDS` + `FATAL_KINDS`,
 *   - `FallbackLLM` (src/llm/fallback.ts): `FALLBACK_KINDS`.
 * That was a SECOND (and THIRD) source of truth for "which kind retries / falls
 * back" — drift-prone and redundant with the table. This module derives BOTH
 * decorator decisions FROM `codexSpecRoute`, so adding / re-routing a kind in
 * the table is the only edit needed; the decorators inherit it.
 *
 * ── Derivation contract ──────────────────────────────────────────────────────
 * `retryDispositionForKind` and `isFallbackKind` derive from the canonical
 * table for all 18 `LLMErrorKind` members. Two layer-specific rules apply:
 *
 *   1. `not_implemented` routes to `fallback_provider` in the table, but is
 *      NON-retryable at the same-provider `RetryingLLM` layer (a stub adapter
 *      throws identically every call — same-provider retry is pure waste; it is
 *      still fallback-ELIGIBLE, so `isFallbackKind` returns true). This is the
 *      one carve-out where the retry axis and the table's action diverge; it
 *      matches the legacy `FATAL_KINDS` membership exactly.
 *
 *   2. A `hitl_handoff` action is always decisive `"no_retry"`. Typed policy or
 *      sandbox errors outrank message text, so retry-looking words cannot
 *      resurrect an automatic request before the required user handoff.
 *      Historical marker fallback remains only for non-HITL kinds whose outer
 *      recovery action is handled outside this decorator.
 */

import type { LLMErrorKind } from "@/shared"
import { codexSpecRoute } from "./codex-spec-router"

/** Three-way retry disposition for a KIND, at the same-provider `RetryingLLM`
 *  layer. `"consult_markers"` means "the table has no decisive same-provider
 *  retry verdict for this kind — defer to the caller's legacy message-marker
 *  scan" (parity with the pre-dedup `isRetryable` fall-through). */
export type RetryDisposition = "retry" | "no_retry" | "consult_markers"

/**
 * Legacy `FATAL_KINDS` members whose table action is `fatal` (`bad_request`,
 * `not_found`, `stream_corrupt`, `aborted`, `invalid_image`). The OTHER
 * table-`fatal` kinds (`unknown`, `too_many_failed_attempts`) were NOT in the
 * legacy `FATAL_KINDS` set — they fell through to the marker scan — so we must
 * NOT collapse them here or we would silently flip their behaviour. This carve
 * is the exact legacy boundary, kept explicit so the divergence is visible and
 * a future measure-first flip is a one-line edit.
 */
const LEGACY_FATAL_DECISIVE: ReadonlySet<LLMErrorKind> = new Set<LLMErrorKind>([
  "bad_request",
  "not_found",
  "stream_corrupt",
  "aborted",
  "invalid_image",
])

/**
 * Derive `RetryingLLM`'s same-provider retry disposition from the single table.
 *
 * Derivation (all three groups sourced from `codexSpecRoute`, no re-listed set):
 *   - action `retry_after_backoff`                 → `"retry"`  (rate_limit)
 *   - action `fallback_provider`, kind ≠ stub      → `"retry"`  (overloaded /
 *                                                     server_error / network —
 *                                                     same-provider retry is a
 *                                                     legitimate first attempt
 *                                                     before FallbackLLM swaps)
 *   - action `fallback_provider`, `not_implemented`→ `"no_retry"` (carve-out #1)
 *   - action `hitl_handoff`                         → `"no_retry"`
 *   - action `fatal` ∈ legacy FATAL set            → `"no_retry"`
 *   - everything else (the 4 residual marker kinds) → `"consult_markers"`
 */
export const retryDispositionForKind = (kind: LLMErrorKind): RetryDisposition => {
  const action = codexSpecRoute(kind)
  if (action === "retry_after_backoff") return "retry"
  if (action === "fallback_provider") {
    // `not_implemented` is fallback-eligible but NOT same-provider-retryable.
    return kind === "not_implemented" ? "no_retry" : "retry"
  }
  // A typed HITL decision outranks free-form message markers. Retrying before
  // the handoff can repeat policy-blocked work or bypass the intended user
  // intervention boundary.
  if (action === "hitl_handoff") return "no_retry"
  if (LEGACY_FATAL_DECISIVE.has(kind)) return "no_retry"
  // unknown / context_window_exceeded / too_many_failed_attempts /
  // thread_rollback_failed → legacy marker fallback. Their outer recovery
  // actions remain separate from this same-provider decorator.
  return "consult_markers"
}

/**
 * Derive `FallbackLLM`'s provider-swap trigger from the single table. CLEAN
 * 1:1 projection — the kinds that warrant switching providers are EXACTLY the
 * kinds the table routes to `fallback_provider` (overloaded / server_error /
 * network / not_implemented). Zero carve-out: byte-identical to the removed
 * `FALLBACK_KINDS` set.
 */
export const isFallbackKind = (kind: LLMErrorKind): boolean =>
  codexSpecRoute(kind) === "fallback_provider"
