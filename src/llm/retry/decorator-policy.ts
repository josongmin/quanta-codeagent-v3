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
 * ── Parity contract (the win is DEDUP, not a behaviour change) ───────────────
 * `retryDispositionForKind` and `isFallbackKind` are proven byte-identical to
 * the removed hardcoded sets for all 18 `LLMErrorKind` members (see
 * tests/unit/retry-decorator-policy-hellgate.test.ts, which asserts each
 * derived decision against the historical set membership). Two subtleties keep
 * the derivation faithful rather than a naive projection:
 *
 *   1. `not_implemented` routes to `fallback_provider` in the table, but is
 *      NON-retryable at the same-provider `RetryingLLM` layer (a stub adapter
 *      throws identically every call — same-provider retry is pure waste; it is
 *      still fallback-ELIGIBLE, so `isFallbackKind` returns true). This is the
 *      one carve-out where the retry axis and the table's action diverge; it
 *      matches the legacy `FATAL_KINDS` membership exactly.
 *
 *   2. For the seven kinds the table maps to a non-retry action but that the
 *      legacy `RETRYABLE_KINDS`/`FATAL_KINDS` sets did NOT enumerate — `unknown`,
 *      `context_window_exceeded`, `cyber_policy`, `too_many_failed_attempts`,
 *      `thread_rollback_failed`, `sandbox_error`, `sandbox_blocked` — the legacy
 *      `isRetryable` fell through to a MESSAGE-MARKER scan. We preserve that by
 *      returning `"consult_markers"` for exactly those kinds, so `RetryingLLM`
 *      keeps its marker fallback BYTE-IDENTICALLY. This deliberately does NOT
 *      fix the latent divergence (a `cyber_policy` error whose message contains
 *      "429" currently RETRIES though the table says `hitl_handoff`); flipping
 *      those is a measure-first change, flagged in the catalog notes, NOT done
 *      silently here.
 */

import { codexSpecRoute } from "./codex-spec-router"
import type { LLMErrorKind } from "@/shared"

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
 *   - action `hitl_handoff` = `auth`               → `"no_retry"` (legacy FATAL)
 *   - action `fatal` ∈ legacy FATAL set            → `"no_retry"`
 *   - everything else (the 7 marker-scan kinds)    → `"consult_markers"`
 */
export const retryDispositionForKind = (kind: LLMErrorKind): RetryDisposition => {
  const action = codexSpecRoute(kind)
  if (action === "retry_after_backoff") return "retry"
  if (action === "fallback_provider") {
    // `not_implemented` is fallback-eligible but NOT same-provider-retryable.
    return kind === "not_implemented" ? "no_retry" : "retry"
  }
  // `auth` was the sole `hitl_handoff` kind enumerated by legacy FATAL_KINDS;
  // the other hitl kinds (cyber_policy / sandbox_error / sandbox_blocked) fell
  // through to the marker scan and must keep doing so (parity).
  if (kind === "auth") return "no_retry"
  if (LEGACY_FATAL_DECISIVE.has(kind)) return "no_retry"
  // unknown / context_window_exceeded / cyber_policy / too_many_failed_attempts
  // / thread_rollback_failed / sandbox_error / sandbox_blocked → legacy marker
  // fallback. Not a table-driven verdict; preserved for byte-identity.
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
