import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { testEnvironmentSha256 } from "../../../tools/dev/test-shard-receipt"
import { VERDICT_RELEVANT_DOTENV_FILES, verdictDotenvSha256 } from "../../../tools/dev/verdict-env"
import { verificationDependencySha256 } from "../../../tools/dev/verification-receipt"

/**
 * An untracked dotenv file changes test verdicts, so it must change both
 * fingerprints.
 *
 * MEASURED. `src/apps/agent/index.ts` runs
 * `loadEnvFiles([".env.dev", ".env.local", ".env"])` at module scope, so merely
 * IMPORTING it seeds whatever that file holds into the process — here, real
 * `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` plus `QUANTA_LSP`, `QUANTA_LSP_TOOLS`,
 * `QUANTA_AST_GREP`, `QUANTA_REPO_MAP`, `QUANTA_READ_OUTLINE`,
 * `QUANTA_BENCH_LSP`. On a clean checkout of the same commit, 13 cases across
 * four composition-root wire files failed with `ProviderKeyMissingError`; in
 * the working copy they passed. Neither receipt could tell the two runs apart,
 * because the file is read INSIDE the child and hashing the parent's env
 * cannot see it.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")

/** Loaders that turn a dotenv file into process environment at import time. */
const LOADER_SOURCES: readonly string[] = [
  "src/apps/agent/index.ts",
  "src/apps/cli/index.ts",
  "src/apps/eval/index.ts",
]

const LOADER_CALL = /loadEnvFiles?\(\[([^\]]*)\]\)/g
const STRING_LITERAL = /"([^"]+)"/g

/** Every dotenv name those loaders name, read from the source. */
const dotenvNamesReadByLoaders = (): ReadonlySet<string> => {
  const named = new Set<string>()
  for (const file of LOADER_SOURCES) {
    const source = readFileSync(join(REPO_ROOT, file), "utf8")
    for (const call of source.matchAll(LOADER_CALL)) {
      for (const literal of (call[1] ?? "").matchAll(STRING_LITERAL)) {
        if (literal[1] !== undefined) named.add(literal[1])
      }
    }
  }
  return named
}

const scratch = (): string => mkdtempSync(join(tmpdir(), "quanta-dotenv-fp-"))

const withRoot = <T>(use: (root: string) => T): T => {
  const root = scratch()
  try {
    return use(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe("dotenv files are part of a verdict's identity", () => {
  test("every name a production loader reads is fingerprinted", () => {
    // Bound to the SOURCE, not to a remembered list: a loader that starts
    // reading `.env.ci` must not silently leave it out of the identity.
    const named = dotenvNamesReadByLoaders()
    // ANTI-VACUITY: a regex that stops matching must fail here, not report
    // perfect coverage over an empty set.
    expect(named.size).toBeGreaterThanOrEqual(3)

    const covered = new Set(VERDICT_RELEVANT_DOTENV_FILES)
    const missing = [...named].filter((name) => !covered.has(name)).sort()
    expect(
      missing,
      missing.length === 0
        ? ""
        : "a production loader reads these dotenv files, so their content can change a " +
            "test verdict, but they are not in the verification fingerprint — a green " +
            `earned with one present is replayable without it: ${missing.join(", ")}`,
    ).toEqual([])
  })

  test("gaining a dotenv file changes the fingerprint; losing it changes it back", () => {
    withRoot((root) => {
      const bare = verdictDotenvSha256(root)
      const path = join(root, ".env.dev")
      writeFileSync(path, "ANTHROPIC_API_KEY=sk-not-real\nQUANTA_LSP_TOOLS=full\n")
      const withFile = verdictDotenvSha256(root)
      expect(withFile).not.toBe(bare)

      // Content, not mere presence: editing a knob is as much a different run
      // as adding the file was.
      writeFileSync(path, "ANTHROPIC_API_KEY=sk-not-real\nQUANTA_LSP_TOOLS=off\n")
      expect(verdictDotenvSha256(root)).not.toBe(withFile)

      rmSync(path)
      expect(verdictDotenvSha256(root)).toBe(bare)
    })
  })

  test("BOTH receipts move — the exact receipt and the shard cache", () => {
    // Two identities, two chances to be wrong. The exact receipt skips all 21
    // gates and the shard cache skips execution, so a hole in either replays a
    // green that was earned under different environment.
    withRoot((root) => {
      writeFileSync(join(root, "package.json"), '{"name":"fixture"}\n')
      const env = { PATH: "/usr/bin", TZ: "UTC" }

      const exactBefore = verificationDependencySha256(root)
      const shardBefore = testEnvironmentSha256(env, 120_000, root)

      writeFileSync(join(root, ".env.dev"), "ANTHROPIC_API_KEY=sk-not-real\n")

      expect(verificationDependencySha256(root)).not.toBe(exactBefore)
      expect(testEnvironmentSha256(env, 120_000, root)).not.toBe(shardBefore)
    })
  })

  test("an unrelated file in the root does not invalidate anything", () => {
    // Paired control: the fingerprint must react to dotenv content and not to
    // any file appearing, or every scratch write becomes a cache miss.
    withRoot((root) => {
      const before = verdictDotenvSha256(root)
      writeFileSync(join(root, ".env.example"), "ANTHROPIC_API_KEY=put-yours-here\n")
      writeFileSync(join(root, "notes.txt"), "hello\n")
      expect(verdictDotenvSha256(root)).toBe(before)
    })
  })
})
