/**
 * ── Generic batch chunker ───────────────────────────────────────────────────
 *
 * ONE canonical `chunkBatches` for "split a flat list into contiguous batches
 * of at most `size`". Before this module each embedder slice
 * (`@/retrieval/embedders/{openai,voyage}`, `@/agent/memory-embedder`)
 * open-coded its own identical copy — drift-prone (one spread-copied each
 * sub-array, one returned the raw `.slice`) with no shared test surface.
 *
 * Semantics (deliberately reconciled from the prior copies):
 *   - `size <= 0` (or `NaN` / fractional) is GUARDED: a non-positive or
 *     non-finite size would otherwise produce an infinite loop (`i += 0`) or a
 *     degenerate batching. We clamp to a minimum batch of 1 and floor toward an
 *     integer, matching every prior call site's `Math.max(1, Math.floor(size))`
 *     guard. Callers never legitimately pass `<= 0` (batch sizes default to
 *     96 / 128); the clamp is the fail-safe, not a feature.
 *   - The input is `readonly` and never mutated; each returned batch is a fresh
 *     array (`Array.prototype.slice` already copies), so callers may freely
 *     mutate the batches without aliasing the source.
 *   - Empty input ⇒ empty output (no zero-length batch is ever emitted).
 */

/** Split `items` into contiguous batches of at most `size` (size clamped to a
 *  minimum of 1 — see module header). Returns fresh, mutable batch arrays. */
export const chunkBatches = <T>(items: readonly T[], size: number): T[][] => {
  const n = Number.isFinite(size) ? Math.max(1, Math.floor(size)) : 1
  const out: T[][] = []
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n))
  return out
}
