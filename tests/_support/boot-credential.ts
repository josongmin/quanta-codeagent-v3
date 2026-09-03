/**
 * A credential a composition-root wire test brings with it, instead of
 * borrowing the operator's.
 *
 * WHY. `buildBaseFromArgs` builds a REAL boot port, so every test that asks it
 * "is this config slot wired?" also has to satisfy provider selection. Those
 * tests were passing on this machine for a reason no test stated: importing
 * `src/apps/agent/index` runs `loadEnvFiles([".env.dev", ".env.local", ".env"])`
 * at module scope, and the developer's untracked `.env.dev` carries real
 * `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` — plus `QUANTA_LSP`, `QUANTA_LSP_TOOLS`,
 * `QUANTA_AST_GREP`, `QUANTA_REPO_MAP`, `QUANTA_READ_OUTLINE` and
 * `QUANTA_BENCH_LSP`, which are exactly the knobs these suites make claims
 * about. The keys also arrive via a ChatGPT OAuth token under the real `$HOME`.
 *
 * MEASURED: on a clean checkout of the same commit, with the scrubbed HOME the
 * shard workers use, 13 of these cases fail with `ProviderKeyMissingError` —
 * and that is what the isolated campaign found. The local green was the wrong
 * one.
 *
 * So the file declares what it needs. `loadEnvFiles` never overrides a value
 * already in the environment, which makes an explicit assignment here dominant
 * over whatever the operator's dotenv holds — the same verdict on a laptop with
 * credentials and on a bare checkout without them.
 *
 * The provider is pinned too, not just the key: without it, selection resolves
 * to `chatgpt-oauth` on a box with a token on disk and to `anthropic` without
 * one, so the two would boot different adapters for the same assertion.
 */

import { afterAll, beforeAll } from "bun:test"

/** Obviously non-functional. Nothing here reaches a network. */
const FAKE_KEY = "test-key-composition-root-wire-only"

const PINNED: Readonly<Record<string, string>> = {
  QUANTA_PROVIDER: "anthropic",
  ANTHROPIC_API_KEY: FAKE_KEY,
}

/**
 * Pin provider + key for the duration of THIS file, then put the environment
 * back exactly as it was.
 *
 * Scoped rather than assigned at module level on purpose: a chunk runs ~100
 * files in one process, so a bare assignment would hand every later file in
 * that chunk a provider and a key it never asked for — the same
 * borrow-from-elsewhere the helper exists to end, pointed the other way.
 */
export const pinHermeticBootCredential = (): void => {
  const prior: Record<string, string | undefined> = {}
  beforeAll(() => {
    for (const [key, value] of Object.entries(PINNED)) {
      prior[key] = process.env[key]
      process.env[key] = value
    }
  })
  afterAll(() => {
    for (const key of Object.keys(PINNED)) {
      const before = prior[key]
      if (before === undefined) delete process.env[key]
      else process.env[key] = before
    }
  })
}
