/**
 * Default Invalidator — ADR-0266.
 *
 * Rules (any-match → stale):
 *   - `provider` differs           → "provider-changed"
 *   - `model` differs              → "model-changed"
 *   - `dim` differs                → "dim-changed"  (always stale — cosine
 *                                    is undefined across dimensions)
 *   - major version differs        → "major-version-bump"
 *
 * Minor version bumps are NOT stale (HELL-MT-08). Callers that want a
 * stricter policy can construct their own `Invalidator` implementation.
 *
 * `invalidateAll(callbacks)` calls every registered callback. One callback
 * throwing does NOT prevent the others from running (HELL-MT-12). The
 * function itself never throws. Failures are reported via `onCallbackError`
 * (default: the injected `writeStderr` sink with the callback name + reason).
 */

import { writeStderr } from "@/shared"
import type { InvalidationCallback, Invalidator } from "./port"
import type { InvalidationDecision, ModelTag } from "./types"

/**
 * Extract the major-version integer from a semver-ish string. Tolerates:
 *   - `"3"`        → 3
 *   - `"3.0"`      → 3
 *   - `"3.0.1"`    → 3
 *   - `"v3"`       → 3   (a leading `v` is stripped)
 *   - `"3-beta"`   → 3
 *   - `"3.0-rc1"`  → 3
 *
 * Anything that does not start with a non-negative integer returns
 * `Number.NaN`. The `check` rule treats two `NaN` majors as "different"
 * (NaN !== NaN) — that is the safe default: if a version string is so
 * unstructured we cannot extract a major, assume the stored data is
 * suspect and invalidate.
 */
const majorOf = (version: string): number => {
  const trimmed = version.startsWith("v") ? version.slice(1) : version
  const m = /^(\d+)/.exec(trimmed)
  if (!m) return Number.NaN
  return Number.parseInt(m[1] ?? "", 10)
}

/**
 * Options for {@link createDefaultInvalidator}.
 */
export interface DefaultInvalidatorOptions {
  /**
   * Called when a registered callback throws during `invalidateAll`.
   * Default: the injected `writeStderr` sink with `[ModelTag invalidator]
   * callback {name} failed: {error}`.
   * Override to silence the warn or route to a structured logger.
   */
  readonly onCallbackError?: (failure: { callback: string; error: unknown }) => void
}

const defaultOnCallbackError = (failure: { callback: string; error: unknown }): void => {
  const msg =
    failure.error instanceof Error ? failure.error.message : String(failure.error ?? "<unknown>")
  // OPS surface — single warn per failed callback, never throws. Routed through
  // the ADR-0303 injected terminal sink (default NOOP) so this non-app leaf owns
  // no raw terminal; override via `onCallbackError` for structured telemetry.
  writeStderr(`[ModelTag invalidator] callback ${failure.callback} failed: ${msg}\n`)
}

const checkPure = (stored: ModelTag, current: ModelTag): InvalidationDecision => {
  if (stored.provider !== current.provider) {
    return {
      stale: true,
      reason: `provider-changed: ${stored.provider} -> ${current.provider}`,
    }
  }
  if (stored.model !== current.model) {
    return {
      stale: true,
      reason: `model-changed: ${stored.model} -> ${current.model}`,
    }
  }
  if (stored.dim !== current.dim) {
    return {
      stale: true,
      reason: `dim-changed: ${stored.dim} -> ${current.dim}`,
    }
  }
  const storedMajor = majorOf(stored.version)
  const currentMajor = majorOf(current.version)
  if (storedMajor !== currentMajor) {
    return {
      stale: true,
      reason: `major-version-bump: v${stored.version} -> v${current.version}`,
    }
  }
  return { stale: false }
}

/**
 * Construct the default {@link Invalidator}. Pure decision (`check`)
 * plus best-effort fan-out (`invalidateAll`). Both are safe to call
 * concurrently — no internal state.
 */
export const createDefaultInvalidator = (opts: DefaultInvalidatorOptions = {}): Invalidator => {
  const onErr = opts.onCallbackError ?? defaultOnCallbackError
  return {
    check: checkPure,
    async invalidateAll(callbacks: ReadonlyArray<InvalidationCallback>): Promise<void> {
      // Run sequentially so the warn output stays in registration order;
      // a registered callback's I/O is rarely on the critical path.
      for (const cb of callbacks) {
        try {
          await cb.invalidate("model-tag-mismatch")
        } catch (error) {
          onErr({ callback: cb.name, error })
        }
      }
    },
  }
}

/**
 * Pure `check` — exported for callers that don't need a port object.
 * Identical semantics to `createDefaultInvalidator().check`.
 */
export const checkInvalidation = checkPure
