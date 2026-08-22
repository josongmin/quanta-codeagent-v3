/**
 * @/retrieval/versioning closed ports — ADR-0266.
 *
 * - `ModelTagger`           — build / parse a canonical {@link ModelTag}.
 * - `InvalidationCallback`  — named hook that some cache / store layer
 *                             registers; gets called with a human-readable
 *                             reason when the invalidator decides the
 *                             current run is incompatible with the stored
 *                             data.
 * - `Invalidator`           — pure decision (`check`) + I/O fan-out
 *                             (`invalidateAll`). Default impl is in
 *                             `./invalidator.ts`; the callback list lives
 *                             in `./registry-callbacks.ts`.
 *
 * Ports stay in this file so adapters and consumers reach a single source
 * of truth without back-edges.
 */

import type { Result } from "@/shared"
import type { InvalidationDecision, ModelTag, ParseError } from "./types"

/**
 * Input to `ModelTagger.tag`. Kept as a small literal so the tagger has
 * no positional-argument confusion.
 */
export interface ModelTagInput {
  readonly provider: string
  readonly model: string
  readonly version: string
  readonly dim: number
}

/**
 * Build a canonical tag from its components, or parse one back from its
 * canonical string form. Both are pure (no I/O).
 *
 * `tag(...)` THROWS for inputs that cannot be canonicalised
 * (whitespace / control chars / empty fields / non-positive dim). The
 * thrown error is a plain `Error` with a normalised message — callers
 * that need a typed channel can wrap.
 *
 * `parse(...)` returns a `Result<ModelTag, ParseError>` so a malformed
 * stored value can be inspected (e.g. for a one-time migration warn)
 * without try/catch.
 */
export interface ModelTagger {
  tag(input: ModelTagInput): ModelTag
  parse(canonical: string): Result<ModelTag, ParseError>
}

/**
 * A named cache / store invalidation hook. The `name` field is purely
 * for the OPS warn log when one callback throws — it identifies which
 * subsystem failed without forcing the consumer to wrap the error.
 */
export interface InvalidationCallback {
  readonly name: string
  invalidate(reason: string): Promise<void>
}

/**
 * Decide-then-fan-out. `check` is pure; `invalidateAll` runs every
 * registered callback even if some throw (HELL-MT-12 invariant).
 */
export interface Invalidator {
  check(stored: ModelTag, current: ModelTag): InvalidationDecision
  invalidateAll(callbacks: ReadonlyArray<InvalidationCallback>): Promise<void>
}
