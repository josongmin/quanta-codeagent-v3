/**
 * ADR-0326 — System prompt cache content hash.
 *
 * SHA-256 hex digest of UTF-8 bytes, via Node's built-in `crypto`. Same
 * shape as ADR-0322's `src/llm/cache-control-audit/hash.ts` so an
 * external audit can cross-check the digest of a cached prompt against
 * a stability snapshot's hash without re-hashing.
 *
 * No external library. The slice fence forbids it (single `node:crypto`
 * import here, no other runtime deps).
 */

import { createHash } from "node:crypto"

/**
 * Hex-encoded SHA-256 of `content`'s UTF-8 bytes. Pure, synchronous,
 * deterministic across processes / OSes.
 *
 * Empty string is legal (returns the well-known `e3b0c4...` digest). The
 * cache uses this for the empty-prompt edge case so a prompt source that
 * legitimately returns "" still gets a cached entry, not an exception.
 */
export const sha256Hex = (content: string): string =>
  createHash("sha256").update(content, "utf8").digest("hex")
