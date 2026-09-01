/**
 * RFC-03 C2 — Objective authority constructor-owner ratchet.
 *
 * The per-session objective authority must be constructed at ONE production
 * owner — the session-authority objective builder — and every surface consumes
 * it (host objective wire, CLI core-state, agent observability wire) instead of
 * minting its own `createObjectiveStore()` / `createObjectiveAuthority()`
 * fallback. This mirrors the RFC-04 D4 ActivityStore constructor-owner ratchet
 * (`tests/unit/activity/activity-store-constructor-owner-ratchet.test.ts`).
 *
 * RULE (exact, count 0 outside the allowlist): a production
 * `createObjectiveStore(` / `createObjectiveAuthority(` CALL may appear ONLY in:
 *   - `src/objective/authority.ts` — the library home (the constructor
 *     definitions + `createObjectiveStore` delegating to `createObjectiveAuthority`);
 *   - `src/runner/assemble/session-authorities/build-objective.ts` — THE session
 *     objective authority builder (the one production minter, threaded to every
 *     surface).
 *
 * Any OTHER src file that calls either constructor is a NEW surface/command-local
 * objective store and fails this ratchet — route it through
 * `buildObjectiveAuthority` (the assembly builder) instead.
 *
 * RED baseline (pre-C2): `src/host/runtime/objective-store-wire.ts`,
 * `src/apps/cli/repl/surface-compose/core-state.ts`, and
 * `src/agent/observability-wire/wire.ts` each mint their own store ⇒ 3
 * unauthorized owners. GREEN (post-C2): 0.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { assertScanPopulation } from "../_shared/scan-population"
import { stripComments } from "../_shared/strip-comments"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")
const SRC_DIR = join(REPO_ROOT, "src")

/** A constructor CALL — the immediate `(` excludes the `export const … = (`
 *  DEFINITIONS (a space precedes their paren) and the `…WithCore(` internal
 *  helper (its name continues past `createObjectiveAuthority` before the paren),
 *  so only real public-constructor call sites are counted. */
const CALL = /createObjective(Store|Authority)\(/

/** Files that legitimately construct the objective authority (see docblock).
 *  Repo-relative, POSIX separators. */
const ALLOWED_OWNERS: ReadonlySet<string> = new Set<string>([
  "src/objective/authority.ts",
  "src/runner/assemble/session-authorities/build-objective.ts",
])

const posix = (p: string): string => p.split(/[\\/]/).join("/")

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) {
      yield* walk(p)
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts") && !entry.endsWith(".test.ts")) {
      yield p
    }
  }
}

interface SourceCorpusEntry {
  readonly absolutePath: string
  readonly relativePath: string
  readonly strippedSource: string
}

let sourceCorpus: readonly SourceCorpusEntry[] | undefined

/** Read and strip the production corpus once. The normal detector and its
 * red-on-injection control must evaluate the exact same frozen bytes. Keep the
 * initial cost inside the anti-vacuity test so the unit speed budget sees it. */
const getSourceCorpus = (): readonly SourceCorpusEntry[] => {
  if (sourceCorpus !== undefined) return sourceCorpus
  sourceCorpus = [...walk(SRC_DIR)].map((absolutePath) => ({
    absolutePath,
    relativePath: posix(relative(REPO_ROOT, absolutePath)),
    strippedSource: stripComments(readFileSync(absolutePath, "utf8")),
  }))
  return sourceCorpus
}

/** Pure detector — reused by the red-on-injection self-test. */
const findUnauthorizedOwners = (
  corpus: readonly SourceCorpusEntry[],
  allowed: ReadonlySet<string>,
): string[] =>
  corpus
    .filter(
      ({ relativePath, strippedSource }) => !allowed.has(relativePath) && CALL.test(strippedSource),
    )
    .map(({ relativePath }) => relativePath)

const sourceAt = (relativePath: string): string | undefined =>
  getSourceCorpus().find((entry) => entry.relativePath === relativePath)?.strippedSource

describe("RFC-03 C2 — objective authority constructor-owner ratchet", () => {
  test("ANTI-VACUITY: the walk reaches a real, populated `src/` tree", () => {
    // "No unauthorized constructor" and "no file was read" are the same result.
    const corpus = getSourceCorpus()
    assertScanPopulation(
      corpus.map(({ absolutePath }) => absolutePath),
      SRC_DIR,
      {
        id: "tests/unit/objective/constructor-owner-ratchet.test.ts#SRC-DIR",
        collectable: (n) => n.endsWith(".ts") && !n.endsWith(".d.ts") && !n.endsWith(".test.ts"),
      },
    )
  })

  test("no surface/command-local objective constructor outside the authority builder", () => {
    const unauthorized = findUnauthorizedOwners(getSourceCorpus(), ALLOWED_OWNERS)
    if (unauthorized.length > 0) {
      throw new Error(
        `Unauthorized objective constructors (route through buildObjectiveAuthority DI):\n${unauthorized
          .map((f) => `  ${f}`)
          .join("\n")}`,
      )
    }
    expect(unauthorized).toEqual([])
  })

  test("the authority builder DOES construct the session objective (non-vacuous)", () => {
    const build = sourceAt("src/runner/assemble/session-authorities/build-objective.ts")
    expect(build).toBeDefined()
    expect(CALL.test(build ?? "")).toBe(true)
  })

  test("red-on-injection: the library home IS flagged when de-allowlisted", () => {
    // authority.ts genuinely calls `createObjectiveAuthority(...)`; removing it
    // from the allowlist MUST surface it — proving the scan reads real call
    // sites (not a vacuous always-empty result).
    const withoutLibraryAllowed = findUnauthorizedOwners(
      getSourceCorpus(),
      new Set<string>([...ALLOWED_OWNERS].filter((f) => f !== "src/objective/authority.ts")),
    )
    expect(withoutLibraryAllowed).toContain("src/objective/authority.ts")
  })
})
