/**
 * Which environment variables can change a test verdict.
 *
 * ONE definition, because there are two receipts that must agree: the shard
 * cache (per chunk) and the exact verification receipt (which skips every
 * gate). They were written separately and drifted — the shard layer keyed
 * `TZ` and `LANG`, the exact receipt did not — so `TZ=Asia/Seoul bun run
 * prepush` reused a green minted under UTC without running a single date- or
 * locale-sensitive test.
 *
 * Everything else is deliberately excluded: hashing ALL inherited env made an
 * unrelated terminal variable (a new ITERM_SESSION_ID, a fresh SSH agent
 * socket) a guaranteed cache miss.
 */

/** Test/CI switches, locale and zone, plus the executable search path. */
const VERDICT_RELEVANT_EXACT: ReadonlySet<string> = new Set([
  "CI",
  "NODE_ENV",
  "PATH",
  "REQUIRE_CONTRACT",
  "TZ",
  "LANG",
  "LC_ALL",
])

export const isVerdictRelevantEnvKey = (key: string): boolean => {
  // The lease token is minted per campaign; keying it would make every receipt
  // unreusable by construction.
  if (key.startsWith("QUANTA_VERIFICATION_LEASE_")) return false
  return VERDICT_RELEVANT_EXACT.has(key) || key.startsWith("BUN_") || key.startsWith("QUANTA_")
}
