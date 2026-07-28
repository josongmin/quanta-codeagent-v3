/**
 * OPC-07 — stable opaque hashing for packet identity. `instanceIdHash` /
 * `candidatePatchHash` are opaque digests (never the raw problem statement or
 * patch), so packet identity is stable without carrying benchmark text.
 */

import { createHash } from "node:crypto"

export const stableHash = (text: string): string =>
  createHash("sha256").update(text).digest("hex").slice(0, 16)

export const opaqueInstanceIdHash = (problemStatement: string): string =>
  stableHash(problemStatement.trim())

export const candidatePatchHash = (patch: string): string => stableHash(patch)
