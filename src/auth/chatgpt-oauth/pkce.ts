import { createHash, randomBytes } from "node:crypto"

const toBase64Url = (buf: Buffer): string =>
  buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")

/** PKCE code_verifier. Codex uses 64 random bytes → URL_SAFE_NO_PAD, which
 *  yields an 86-char verifier comfortably within RFC 7636's 43..128 range. */
export const generateCodeVerifier = (): string => toBase64Url(randomBytes(64))

/** Derive the S256 code_challenge from a verifier:
 *  `BASE64URL_NO_PAD( SHA256( verifier_utf8_bytes ) )`. */
export const deriveChallengeS256 = (verifier: string): string =>
  toBase64Url(createHash("sha256").update(verifier, "utf8").digest())

/** Cryptographically-random `state` parameter (32 bytes → 43-char base64url).
 *  Long enough to defeat guessing and stays within URL-length limits. */
export const generateState = (): string => toBase64Url(randomBytes(32))
