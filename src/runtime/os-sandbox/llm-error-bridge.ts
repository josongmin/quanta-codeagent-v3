/**
 * ADR-0237 — `sandboxError` layer-owned arm wire (LLM error taxonomy close-out,
 * slice C of 3).
 *
 * # What this is
 *
 * A pure, default-OFF wrapper `withSandboxLlmErrorEmit(sandbox, knobs)` that
 * decorates the closed {@link OsSandbox} surface and OPT-IN-emits an
 * `LLMError("sandbox_error", ...)` whenever a `spawn()` call returns a
 * result with `sandboxApplied: false` AND a non-empty `degradeReason`
 * (i.e. the sandbox was REQUESTED — policy.profile not `"off"` /
 * `"danger-full-access"` — but the host could not enforce it).
 *
 * # Why this lives in `src/runtime/os-sandbox/`
 *
 * `sandbox_error` is one of the layer-owned arms in the ADR-0214 error
 * `LLMErrorKind` taxonomy that the LLM ADAPTER boundary cannot emit (no
 * provider knows about Seatbelt / Landlock / Bubblewrap availability). Only
 * the sandbox port KNOWS when its enforcement degraded. ADR-0234 wired the
 * two provider-emitable arms; this slice closes the sandbox-side conversion
 * to the typed LLM error so the recovery router's `hitl_handoff` route can
 * fire on degraded enforcement (the user must inspect the host).
 *
 * # Default-OFF
 *
 * `enabled` defaults to `false`. When OFF the wrapper returns the inner port
 * VERBATIM — no allocation, no extra try/catch, byte-identical to the
 * pre-bridge consumer. The bridge is purely additive: legacy callers that
 * already branch on `result.sandboxApplied` continue to work unchanged.
 *
 * # No-throw posture
 *
 * The wrapper has TWO modes mirroring the rollback bridge (slice B):
 *
 *   - `mode: "throw"` (default when `enabled === true`) — the wrapped
 *     `spawn` THROWS the `LLMError` when degradation is detected. Use
 *     this when the caller wants a single typed-throw escape and the
 *     `RecoveryRouter` is on the call stack.
 *   - `mode: "result-with-llm-error"` — the wrapped `spawn` continues to
 *     RETURN the result BUT augments it with a typed `llmError` field
 *     carrying the same `LLMError` (still `sandboxApplied: false`).
 *     Use this when the caller wants both the typed envelope AND the
 *     observability hook without changing call sites.
 *
 * # When does the bridge fire?
 *
 *  - `sandboxApplied: true`  ⇒ never fires (success).
 *  - `sandboxApplied: false` + `degradeReason` ABSENT
 *    (= profile was `"off"` / `"danger-full-access"`) ⇒ never fires
 *    (the caller EXPLICITLY asked for no sandbox).
 *  - `sandboxApplied: false` + `degradeReason` PRESENT ⇒ fires per `mode`.
 *
 * The `exitCode === 127` "spawn-failed" path falls into the third bucket
 * (degradeReason: "spawn-failed") and IS routed — spawn failure when the
 * caller asked for a sandbox is a `sandbox_error` (the agent cannot tell
 * "binary missing" apart from "policy rejected" without re-parsing the
 * stderr, which the layered classify ban forbids).
 */

import { LLMError } from "@/shared"
import type { OsSandbox, SandboxedSpawnResult, SandboxedSpawnSpec, SandboxPolicy } from "./types"

/** Closed knob set for the sandbox → LLMError bridge. exactOptional. */
export interface SandboxLlmErrorKnobs {
  /** Default-OFF (`false`). When `false`, `withSandboxLlmErrorEmit` returns
   *  the inner port verbatim (byte-identical, no allocation). */
  readonly emitFailureAsLlmError?: boolean
  /** When `emitFailureAsLlmError === true`, choose between the two
   *  conversion modes (see file-level docs):
   *    - `"throw"` (default): the wrapped `spawn` THROWS the `LLMError`.
   *    - `"result-with-llm-error"`: the wrapped `spawn` returns an
   *      augmented {@link SandboxResultWithLlmError} carrying the typed
   *      `llmError` field alongside the original degraded result. */
  readonly mode?: "throw" | "result-with-llm-error"
}

/** Result extension carrying the LLMError. Returned ONLY when knobs
 *  `emitFailureAsLlmError === true` AND `mode === "result-with-llm-error"`.
 *  Otherwise the bridge throws (or is identity). exactOptional. */
export interface SandboxResultWithLlmError extends SandboxedSpawnResult {
  /** Present iff `sandboxApplied:false` AND `degradeReason` was present
   *  AND the bridge was wired with `"result-with-llm-error"` mode. */
  readonly llmError?: LLMError
}

/** Test seam: does THIS result represent a sandbox-requested-but-degraded
 *  outcome (i.e. should the bridge fire)? Pure. */
export const isSandboxDegradedFailure = (r: SandboxedSpawnResult): boolean => {
  if (r.sandboxApplied) return false
  if (r.degradeReason === undefined) return false
  if (r.degradeReason.length === 0) return false
  return true
}

/** Build an LLMError describing a sandbox-degraded result. Pure. */
export const sandboxResultToLlmError = (r: SandboxedSpawnResult): LLMError => {
  const reason = r.degradeReason ?? "unknown"
  const msg = `sandbox enforcement degraded (reason=${reason} exitCode=${r.exitCode})`
  return new LLMError(msg, {
    kind: "sandbox_error",
    cause: { result: r },
  })
}

/**
 * RFC jun-6 — SIBLING converter for a sandbox BLOCK (the polar opposite of the
 * degrade path above). Does THIS result represent an OS-sandbox syscall block
 * (the sandbox RAN and DENIED something)? Pure.
 *
 * A block is identified by the discriminant {@link SandboxedSpawnResult.denialReason}
 * being present — which the platform result-mapping points set (gated on the
 * escalation knob) from {@link classifySandboxDenial}. This is NOT a reuse of
 * `isSandboxDegradedFailure` (that fires on `sandboxApplied:false`); a block is
 * `sandboxApplied:true` + a `denialReason`.
 */
export const isSandboxBlockedFailure = (r: SandboxedSpawnResult): boolean =>
  r.sandboxApplied === true && r.denialReason !== undefined

/** Build an LLMError describing a sandbox-BLOCKED result (`sandbox_blocked`
 *  kind — distinct from the degrade path's `sandbox_error`). Pure. The
 *  `denialReason` signal/confidence are carried in the message + cause for the
 *  escalation prompt + OTel; the free-form command text is NOT inlined here. */
export const sandboxBlockToLlmError = (r: SandboxedSpawnResult): LLMError => {
  const d = r.denialReason
  const signal = d?.signal ?? "heuristic"
  const confidence = d?.confidence ?? "low"
  const msg = `command blocked by OS sandbox (signal=${signal} confidence=${confidence} exitCode=${r.exitCode})`
  return new LLMError(msg, {
    kind: "sandbox_blocked",
    cause: { result: r },
  })
}

/**
 * Decorate an {@link OsSandbox} so degraded enforcement surfaces as a typed
 * `LLMError("sandbox_error", ...)` per the wired mode.
 *
 * When `knobs.emitFailureAsLlmError !== true`, this function returns the
 * inner sandbox verbatim — no wrapper allocation. The bridge is OPT-IN.
 *
 * @example
 *   const sandbox = withSandboxLlmErrorEmit(defaultOsSandbox(), {
 *     emitFailureAsLlmError: true,
 *     mode: "throw",
 *   })
 *   try {
 *     await sandbox.spawn(spec, { profile: "read-only" })
 *   } catch (e) {
 *     if (e instanceof LLMError && e.kind === "sandbox_error") {
 *       // route to hitl_handoff
 *     }
 *   }
 */
export const withSandboxLlmErrorEmit = (
  inner: OsSandbox,
  knobs: SandboxLlmErrorKnobs | undefined,
): OsSandbox => {
  if (knobs?.emitFailureAsLlmError !== true) {
    return inner
  }
  const mode: "throw" | "result-with-llm-error" = knobs.mode ?? "throw"
  return {
    async spawn(spec: SandboxedSpawnSpec, policy: SandboxPolicy): Promise<SandboxedSpawnResult> {
      const r = await inner.spawn(spec, policy)
      return applyMode(r, mode)
    },
    availability: inner.availability.bind(inner),
  }
}

/** Internal: apply the configured conversion mode to a raw result. Pure
 *  apart from a possible throw. */
const applyMode = (
  r: SandboxedSpawnResult,
  mode: "throw" | "result-with-llm-error",
): SandboxedSpawnResult => {
  // Not a degraded failure ⇒ byte-identical passthrough.
  if (!isSandboxDegradedFailure(r)) return r
  // Degraded failure: build the typed error.
  const err = sandboxResultToLlmError(r)
  if (mode === "throw") {
    throw err
  }
  // mode === "result-with-llm-error" — augment + return.
  const augmented: SandboxResultWithLlmError = { ...r, llmError: err }
  return augmented
}

/** Test-only re-exports. */
export const __test = {
  applyMode,
}
