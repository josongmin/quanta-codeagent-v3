/**
 * ADR-0237 — `threadRollbackFailed` layer-owned arm wire (LLM error 16-kind
 * close-out, slice B of 3).
 *
 * # What this is
 *
 * A pure, default-OFF wrapper `withRollbackLlmErrorEmit(port, knobs)` that
 * decorates the closed {@link ThreeWayRestorePort} surface and OPT-IN-emits
 * an `LLMError("thread_rollback_failed", ...)` whenever any of the three
 * rollback methods (`restoreFiles` / `restoreTask` / `restoreBoth`) returns
 * a typed FAILURE outcome (`ok: false`). The original outcome is preserved
 * as `cause.outcome` so a downstream caller still has access to the
 * `RestoreErrorCode` / `originalCode` / `tag` / `filesChanged`.
 *
 * # Why this lives in `src/agent/per-tool-checkpoint/`
 *
 * `thread_rollback_failed` is one of the THREE layer-owned arms in the
 * ADR-0214 16-kind `LLMErrorKind` taxonomy that the LLM ADAPTER boundary
 * cannot emit (no provider returns a "checkpoint rebuild failed" status —
 * only the conversation-checkpoint / shadow-ODB rollback API KNOWS). ADR-0234
 * wired the two provider-emitable arms; this slice closes the rollback-side
 * conversion to the typed LLM error so the recovery router's
 * `reactive_compaction` route can fire on rollback failure.
 *
 * # Default-OFF
 *
 * `enabled` defaults to `false`. When OFF the wrapper returns the inner port
 * VERBATIM — no allocation, no extra try/catch, byte-identical to the
 * pre-bridge consumer. The bridge is purely additive: legacy callers that
 * already branch on `RestoreOutcome.ok` continue to work unchanged.
 *
 * # No-throw posture
 *
 * The wrapper has TWO modes:
 *
 *   - `mode: "throw"` (default when `enabled === true`) — the wrapped method
 *     THROWS the `LLMError` when the inner outcome is `ok:false`. This
 *     matches the `LLMError` convention from `@/shared/errors.ts`
 *     ("THROW for exceptional / unrecoverable faults … RETURN Result<T,E>
 *     for EXPECTED domain failures"). Rollback failure IS exceptional —
 *     the user / agent asked to rewind and the rewind broke.
 *   - `mode: "outcome-with-llm-error"` — the wrapped method continues to
 *     RETURN the outcome BUT augments it with a typed `llmError` field
 *     carrying the same `LLMError` (the outcome is still `ok:false`).
 *     Use this when the caller wants both the typed envelope AND the
 *     observability hook without changing call sites that already check
 *     `.ok` first. The outcome shape extension is OPTIONAL on the typed
 *     port (it lives in {@link RollbackOutcomeWithError}, not on the
 *     base {@link RestoreOutcome}, so consumers that do not opt in are
 *     never confused).
 *
 * # Mapping (every `RestoreErrorCode` → same LLMErrorKind)
 *
 * All five {@link RestoreErrorCode} arms map to `thread_rollback_failed`.
 * Sub-classification (tag-not-found vs shadow-rewind-failed) survives on
 * `cause.outcome.errorCode` — downstream code that wants the SPECIFIC sub-
 * reason reads it from there. The kind itself is uniform because every
 * rollback failure maps to the same recovery action (`reactive_compaction`
 * — rebuild a shorter prefix).
 */

import { LLMError } from "@/shared"
import type { CheckpointTag, RestoreOptions, RestoreOutcome, ThreeWayRestorePort } from "./port"

/** Closed knob set for the rollback → LLMError bridge. exactOptional. */
export interface RollbackLlmErrorKnobs {
  /** Default-OFF (`false`). When `false`, `withRollbackLlmErrorEmit` returns
   *  the inner port verbatim (byte-identical, no allocation). */
  readonly emitRollbackFailureAsLlmError?: boolean
  /** When `emitRollbackFailureAsLlmError === true`, choose between the two
   *  conversion modes (see file-level docs):
   *    - `"throw"` (default): the wrapped method THROWS the `LLMError`.
   *    - `"outcome-with-llm-error"`: the wrapped method returns an
   *      augmented {@link RollbackOutcomeWithError} carrying the typed
   *      `llmError` field alongside the original `ok:false` outcome. */
  readonly mode?: "throw" | "outcome-with-llm-error"
}

/** Outcome extension carrying the LLMError. Returned ONLY when knobs
 *  `emitRollbackFailureAsLlmError === true` AND `mode === "outcome-with-
 *  llm-error"`. Otherwise the bridge throws (or is identity). exactOptional. */
export interface RollbackOutcomeWithError extends RestoreOutcome {
  /** Present iff `ok:false` AND the bridge was wired with the "outcome-
   *  with-llm-error" mode. Carries the typed LLMError with `kind:
   *  "thread_rollback_failed"`. */
  readonly llmError?: LLMError
}

/** Construct an LLMError describing a rollback failure outcome. Pure. */
export const rollbackOutcomeToLlmError = (outcome: RestoreOutcome): LLMError => {
  const tag = outcome.tag
  const code = outcome.errorCode ?? "unknown"
  const original = outcome.originalCode !== undefined ? ` original=${outcome.originalCode}` : ""
  const msg = `thread rollback failed (tag=${tag} code=${code}${original}): ${outcome.message}`
  return new LLMError(msg, {
    kind: "thread_rollback_failed",
    cause: { outcome },
  })
}

/**
 * Decorate a {@link ThreeWayRestorePort} so rollback failures surface as
 * typed `LLMError("thread_rollback_failed", ...)` per the wired mode.
 *
 * When `knobs.emitRollbackFailureAsLlmError !== true`, this function returns
 * the inner port verbatim — no wrapper allocation. The bridge is OPT-IN.
 *
 * @example
 *   const port = withRollbackLlmErrorEmit(defaultThreeWayRestore(ports), {
 *     emitRollbackFailureAsLlmError: true,
 *     mode: "throw",
 *   })
 *   try {
 *     await port.restoreFiles("turn:42")
 *   } catch (e) {
 *     if (e instanceof LLMError && e.kind === "thread_rollback_failed") {
 *       // route to reactive_compaction
 *     }
 *   }
 */
export const withRollbackLlmErrorEmit = (
  inner: ThreeWayRestorePort,
  knobs: RollbackLlmErrorKnobs | undefined,
): ThreeWayRestorePort => {
  if (knobs?.emitRollbackFailureAsLlmError !== true) {
    return inner
  }
  const mode: "throw" | "outcome-with-llm-error" = knobs.mode ?? "throw"
  return {
    async restoreFiles(tag: CheckpointTag, opts?: RestoreOptions): Promise<RestoreOutcome> {
      return await applyMode(await inner.restoreFiles(tag, opts), mode)
    },
    async restoreTask(tag: CheckpointTag, opts?: RestoreOptions): Promise<RestoreOutcome> {
      return await applyMode(await inner.restoreTask(tag, opts), mode)
    },
    async restoreBoth(tag: CheckpointTag, opts?: RestoreOptions): Promise<RestoreOutcome> {
      return await applyMode(await inner.restoreBoth(tag, opts), mode)
    },
  }
}

/** Internal: apply the configured conversion mode to a raw outcome. Pure
 *  apart from a possible throw. */
const applyMode = async (
  outcome: RestoreOutcome,
  mode: "throw" | "outcome-with-llm-error",
): Promise<RestoreOutcome> => {
  // Success: byte-identical passthrough.
  if (outcome.ok) return outcome
  // Failure path: build the typed error.
  const err = rollbackOutcomeToLlmError(outcome)
  if (mode === "throw") {
    throw err
  }
  // mode === "outcome-with-llm-error" — augment + return.
  const augmented: RollbackOutcomeWithError = { ...outcome, llmError: err }
  return augmented
}

/** Test-only re-exports. */
export const __test = {
  applyMode,
}
