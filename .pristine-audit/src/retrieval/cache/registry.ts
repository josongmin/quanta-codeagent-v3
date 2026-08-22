/**
 * ADR-0263 — env-driven adapter swap.
 *
 * `QUANTA_EMBED_CACHE=in-memory|sqlite|none` picks the wire at composition
 * time. The default is `none` so the cache is OPT-IN and the byte-identical
 * "no cache" path stays the production default until a caller explicitly
 * enables one of the two real backends.
 *
 * The resolver accepts `{ readonly [k: string]: string | undefined }` so
 * callers pass `process.env` directly (no `as` casts at the boundary).
 */

import { newInMemoryEmbedCache } from "./in-memory-lru"
import { newNoneEmbedCache } from "./none-cache"
import type { EmbedCache } from "./port"
import { newSqliteEmbedCache } from "./sqlite-cache"

export type EmbedCacheKind = "in-memory" | "sqlite" | "none"

const KINDS: readonly EmbedCacheKind[] = ["in-memory", "sqlite", "none"]

const parseKind = (raw: string | undefined): EmbedCacheKind => {
  if (raw === undefined) return "none"
  return (KINDS as readonly string[]).includes(raw) ? (raw as EmbedCacheKind) : "none"
}

export const resolveEmbedCacheFromEnv = (
  env: { readonly [k: string]: string | undefined } = {},
): EmbedCache => {
  const kind = parseKind(env.QUANTA_EMBED_CACHE)
  switch (kind) {
    case "in-memory":
      return newInMemoryEmbedCache()
    case "sqlite":
      return newSqliteEmbedCache()
    case "none":
      return newNoneEmbedCache()
  }
}
