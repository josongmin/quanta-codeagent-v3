/**
 * RFC-04 D4 — ActivityStore constructor-owner ratchet.
 *
 * The session activity store must be minted ONCE, at the session-authority
 * composition root, and observed by every surface via DI — NOT re-minted with a
 * command/surface-local `createActivityStore()` fallback (RFC-04 §D4 stop:
 * "slash code must not own reusable activity state"; owner map: "every production
 * session receives one assembled handle").
 *
 * RULE (exact, count 0 outside the allowlist): a production `createActivityStore(`
 * CALL may appear ONLY in:
 *   - `src/activity/store.ts` — the library home (the constructor definition +
 *     the `seedStoreFromSnapshot` transient-view helper, both part of `@/activity`
 *     itself, not a surface-local session store);
 *   - `src/runner/assemble/session-authorities/build.ts` — THE authority builder
 *     (the one production minter threaded through `SessionAuthorities.activity`);
 *   - `src/apps/headless/fake-deps.ts` — the ONE explicit offline test/fake deps
 *     helper (RFC-04 owner map: "explicit test fakes remain local"). The ADR-0308
 *     headless slice fence forbids importing the `@/runner/assemble` authority
 *     builder into the offline slice, so this fake mints its own store; it is a
 *     FAKE deps bundle, never a live production session surface.
 *
 * Any OTHER src file that calls `createActivityStore(` is a NEW surface/command-
 * local store and fails this ratchet — route it through `buildSessionAuthorities`
 * (DI) instead.
 *
 * RED baseline (pre-D4): repl.ts / serve-stdio-cmd.ts / lifecycle.ts /
 * registry-surface.ts / brain-mode-session-scaffold.ts / fake-deps.ts each mint
 * their own store ⇒ 6 unauthorized owners. GREEN (post-D4): 0.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { assertScanPopulation } from "../_shared/scan-population"
import { stripComments } from "../_shared/strip-comments"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")
const SRC_DIR = join(REPO_ROOT, "src")

/** A `createActivityStore(` CALL — the immediate `(` excludes the definition
 *  `export const createActivityStore = (): ActivityStore => …` (space before the
 *  paren) so only real call sites are counted. */
const CALL = /createActivityStore\(/

/** Files that legitimately construct the store (see docblock). Repo-relative,
 *  POSIX separators. */
const ALLOWED_OWNERS: ReadonlySet<string> = new Set<string>([
  "src/activity/store.ts",
  "src/runner/assemble/session-authorities/build.ts",
  "src/apps/headless/fake-deps.ts",
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

/** Pure detector — reused by the red-on-injection self-test. */
const findUnauthorizedOwners = (srcRoot: string, allowed: ReadonlySet<string>): string[] => {
  const hits: string[] = []
  for (const abs of walk(srcRoot)) {
    const rel = posix(relative(REPO_ROOT, abs))
    if (allowed.has(rel)) continue
    if (CALL.test(stripComments(readFileSync(abs, "utf8")))) hits.push(rel)
  }
  return hits
}

describe("RFC-04 D4 — ActivityStore constructor-owner ratchet", () => {
  test("ANTI-VACUITY: the walk reaches a real, populated `src/` tree", () => {
    // "No unauthorized constructor" and "no file was read" are the same result.
    assertScanPopulation([...walk(SRC_DIR)], SRC_DIR, {
      id: "tests/unit/activity/activity-store-constructor-owner-ratchet.test.ts#SRC-DIR",
      collectable: (n) => n.endsWith(".ts") && !n.endsWith(".d.ts") && !n.endsWith(".test.ts"),
    })
  })

  test("no surface/command-local createActivityStore() outside the authority builder", () => {
    const unauthorized = findUnauthorizedOwners(SRC_DIR, ALLOWED_OWNERS)
    if (unauthorized.length > 0) {
      throw new Error(
        `Unauthorized ActivityStore constructors (route through buildSessionAuthorities DI):\n${unauthorized
          .map((f) => `  ${f}`)
          .join("\n")}`,
      )
    }
    expect(unauthorized).toEqual([])
  })

  test("the authority builder DOES mint the session store (non-vacuous)", () => {
    const build = readFileSync(
      join(SRC_DIR, "runner/assemble/session-authorities/build.ts"),
      "utf8",
    )
    expect(CALL.test(build)).toBe(true)
  })

  test("red-on-injection: a surface-local store IS flagged by the detector", () => {
    // Inject a hypothetical owner (repl.ts) into the fixture universe by NOT
    // allowing it — the detector must catch a real call site there. This proves
    // the detector is not vacuous (it actually reads files + matches calls).
    const withoutReplAllowed = findUnauthorizedOwners(
      SRC_DIR,
      new Set<string>([...ALLOWED_OWNERS].filter((f) => f !== "src/activity/store.ts")),
    )
    // store.ts genuinely calls it (seedStoreFromSnapshot); removing it from the
    // allowlist MUST surface it — proving the scan reads real call sites.
    expect(withoutReplAllowed).toContain("src/activity/store.ts")
  })
})
