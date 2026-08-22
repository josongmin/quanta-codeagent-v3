/**
 * ADR-0312 — `X-Hub-Signature-256` (GitHub webhook HMAC-SHA256) verifier.
 *
 * This helper is shipped in the slice ahead of the Tier-1 webhook server
 * impl (which is intentionally NOT_IMPLEMENTED) so the signature path can be
 * tested in isolation and is reachable by future host adapters.
 *
 * Constant-time compare via `crypto.timingSafeEqual`. Returns `false` on:
 *   - missing / non-`sha256=` prefix,
 *   - non-hex signature payload (any non-`[0-9a-fA-F]` byte),
 *   - length mismatch (without giving a timing oracle),
 *   - empty `secret` (open-bypass defense — a misconfigured host MUST NOT
 *     unconditionally accept payloads).
 */

import { createHmac, timingSafeEqual } from "node:crypto"

const PREFIX = "sha256="
const HEX_RE = /^[0-9a-fA-F]+$/

/**
 * Verify a GitHub webhook signature.
 *
 * @param rawBody - the EXACT bytes GitHub sent (NOT re-stringified JSON).
 *                  An adapter MUST capture the raw body before parsing.
 * @param signatureHeader - the `X-Hub-Signature-256` header value
 *                          (`sha256=<64 hex chars>`).
 * @param secret - the shared secret configured in the GH App / webhook.
 *                 Empty string returns `false` (no open bypass).
 * @returns `true` iff the header matches HMAC-SHA256(secret, rawBody).
 */
export const verifyHubSignature256 = (
  rawBody: Uint8Array,
  signatureHeader: string,
  secret: string,
): boolean => {
  if (typeof secret !== "string" || secret.length === 0) return false
  if (typeof signatureHeader !== "string" || signatureHeader.length === 0) return false
  if (!signatureHeader.startsWith(PREFIX)) return false
  const provided = signatureHeader.slice(PREFIX.length)
  if (provided.length === 0) return false
  if (!HEX_RE.test(provided)) return false

  // Expected sig — re-compute against the raw body.
  const expectedHex = createHmac("sha256", secret).update(rawBody).digest("hex")
  // Length mismatch — refuse without exposing a timing signal that would
  // reveal "how far did we get". timingSafeEqual itself rejects mismatched
  // lengths by throwing; we pre-pad to a fixed size before the compare.
  if (provided.length !== expectedHex.length) return false

  const a = Buffer.from(provided.toLowerCase(), "hex")
  const b = Buffer.from(expectedHex, "hex")
  if (a.length !== b.length) return false
  try {
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}
