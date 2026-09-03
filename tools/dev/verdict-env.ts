import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

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

/**
 * Dotenv files that become environment INSIDE a test process, which is why
 * hashing the parent's `process.env` cannot see them.
 *
 * MEASURED, and it hid a real defect for as long as it existed. Importing
 * `src/apps/agent/index` runs `loadEnvFiles([".env.dev", ".env.local", ".env"])`
 * at module scope; the developer's untracked `.env.dev` here carries real
 * `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` plus `QUANTA_LSP`, `QUANTA_LSP_TOOLS`,
 * `QUANTA_AST_GREP`, `QUANTA_REPO_MAP`, `QUANTA_READ_OUTLINE` and
 * `QUANTA_BENCH_LSP` — knobs whose defaults those very suites make claims
 * about. On a clean checkout of the same commit, 13 cases across four files
 * failed; in this working copy they passed. Nothing in either receipt's
 * identity distinguished the two runs, so a green earned with the file present
 * was replayable without it, and the reverse.
 *
 * Bun itself also auto-loads some of these before any import runs. Measured on
 * 1.3.14: `bun test` reads `.env` and `.env.test`; `bun run` reads `.env` and
 * `.env.local`. `.env.dev` is NOT one of Bun's — it arrives only through the
 * application loaders above, which is exactly why it was invisible.
 *
 * `.env.example` is deliberately absent: it is tracked, so the tree hash
 * already covers it.
 */
export const VERDICT_RELEVANT_DOTENV_FILES: readonly string[] = [
  ".env",
  ".env.dev",
  ".env.development",
  ".env.local",
  ".env.test",
]

/**
 * Content fingerprint of the dotenv files above. A file that is absent hashes
 * as absent, so gaining one and losing one are both a miss.
 */
export const verdictDotenvSha256 = (repoRoot: string): string => {
  const hash = createHash("sha256")
  for (const name of VERDICT_RELEVANT_DOTENV_FILES) {
    const absolute = join(repoRoot, name)
    hash.update(`${name}\0`)
    hash.update(existsSync(absolute) ? readFileSync(absolute) : Buffer.from("<absent>"))
    hash.update("\0")
  }
  return hash.digest("hex")
}
