/**
 * Cache-control audit — content hashing (ADR-0319).
 *
 * SHA-256 from `node:crypto` (built-in; no external lib). 64-char lowercase
 * hex output, deterministic across runs and OSes, matching the hash the
 * Anthropic server is presumed to compare against (it does NOT publish the
 * digest, but byte-identical inputs MUST produce byte-identical hashes here
 * for the audit to be meaningful — that is the property we test).
 *
 * The function is intentionally tiny — kept in its own module so the
 * analyzer can stay synchronous and so callers who already hashed the
 * content elsewhere (e.g. via the replay recorder) can skip this entirely
 * and pre-fill `CachePrefixSnapshot.hash` directly.
 */

import { createHash } from "node:crypto"

/**
 * Hex-encoded SHA-256 of the UTF-8 bytes of `content`. Pure, synchronous.
 *
 * Empty string is legal and produces the well-known
 * `e3b0c4...` digest — the analyzer treats an empty block as a valid
 * (degenerate) snapshot rather than throwing, because the prefix being
 * audited might intentionally elide a section when the input is absent
 * (e.g. `repoRules` not supplied ⇒ no `project_md` section, no entry in
 * the snapshot list).
 */
export const sha256Hex = (content: string): string =>
  createHash("sha256").update(content, "utf8").digest("hex")
