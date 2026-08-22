/**
 * ADR-0263 — pure SHA-256 over UTF-8 text → 64-char lowercase hex.
 *
 * Web Crypto only (`crypto.subtle.digest`) so the same code runs in Bun,
 * Node 20+, and any browser surface — no native bindings. Deterministic
 * by construction: same input → same output across processes and platforms.
 *
 * `makeCacheKey` is the single source of truth for `"{hash}:{modelTag}"`
 * composition — every adapter MUST go through this helper to avoid
 * per-adapter key-shape drift.
 *
 * `isCanonicalModelTag` enforces the documented modelTag grammar
 * `{provider}-{model}-v{version}-d{dim}` (provider + at least one model
 * segment + version + dim, in that order). Adapters do NOT validate on
 * every call — validation is an explicit, user-callable check.
 */
import type { CacheKey } from "./types"

const HEX_TABLE = "0123456789abcdef"

const toHex = (bytes: Uint8Array): string => {
  let out = ""
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number
    out += HEX_TABLE[(b >>> 4) & 0xf]
    out += HEX_TABLE[b & 0xf]
  }
  return out
}

/** SHA-256 hex of UTF-8(text). Deterministic, allocation-light. */
export const hashText = async (text: string): Promise<string> => {
  const buf = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest("SHA-256", buf)
  return toHex(new Uint8Array(digest))
}

/** Canonical key shape: `"{sha256(text)}:{modelTag}"`. */
export const makeCacheKey = async (text: string, modelTag: string): Promise<CacheKey> => {
  const hash = await hashText(text)
  return `${hash}:${modelTag}`
}

/**
 * `{provider}-{modelPart}-v{version}-d{dim}` where `provider`/`modelPart`
 * are `[a-z0-9]+` segments (model may span multiple `-` segments), the
 * version segment is `v\d+`, and the dim segment is `d\d+`. The version
 * MUST precede the dim segment.
 */
const CANONICAL_TAG = /^[a-z0-9]+(?:-[a-z0-9]+)+-v\d+-d\d+$/

export const isCanonicalModelTag = (tag: string): boolean => {
  if (tag.length === 0) return false
  return CANONICAL_TAG.test(tag)
}
