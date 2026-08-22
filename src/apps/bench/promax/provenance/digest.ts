/**
 * PMX-00 digests — the one hashing convention every layer shares.
 *
 * Pure: `node:crypto` only. Bytes are authoritative, so a `string` input is
 * encoded as UTF-8 and hashes identically to the file bytes it came from.
 */
import { createHash } from "node:crypto"
import type { BundleBytes } from "./types"

export const asBytes = (input: BundleBytes): Uint8Array =>
  typeof input === "string" ? new TextEncoder().encode(input) : input

/**
 * Decode bundle bytes as STRICT UTF-8. Invalid UTF-8 throws rather than
 * silently producing replacement characters — a corpus that is not valid UTF-8
 * is a provenance failure, not something to paper over with U+FFFD.
 */
export const decodeUtf8 = (input: BundleBytes): string =>
  typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: true }).decode(input)

/** Lowercase hex sha256 over the UTF-8 bytes of `input`. */
export const sha256Hex = (input: BundleBytes): string =>
  createHash("sha256").update(asBytes(input)).digest("hex")

/**
 * The instance-id SET digest: sha256 over the sorted UNIQUE ids joined by "\n",
 * with a trailing "\n".
 *
 * This exact convention is what reproduces the recorded upstream digest
 * `19944e59...` from the real 170-row corpus (re-verified 2026-08-22), and the
 * anti-vacuum test pins it. It is a SET digest, so it is insensitive to row
 * order but sensitive to membership — which is the property the id-set equality
 * claim needs.
 */
export const instanceIdSetDigest = (ids: readonly string[]): string =>
  sha256Hex(`${[...new Set(ids)].sort().join("\n")}\n`)
