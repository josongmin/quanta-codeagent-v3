/**
 * Ratchet — a `*.test.ts` that no gate runs is not a test, it is a comment.
 *
 * `bun test tests/unit …` (and `test:ci`, which adds `tests/contract`) is what
 * every gate, every contributor and every agent actually runs. A test file
 * outside those roots executes only if some OTHER script names its directory.
 * Nothing enforces that, and the failure is silent in the worst way: the file
 * exists, it is tracked, it typechecks, it reads like a guarantee — and it has
 * never once been executed.
 *
 * This was not hypothetical when the ratchet was written. Two live examples:
 *
 *   - `tests/meta/no-test-js-artifacts-hellgate.test.ts` guards against stale
 *     `.test.js` emit (a real 2026-05-25 incident: 520 orphan files causing
 *     double execution). `bunfig.toml` states in a comment that it "asserts this
 *     at CI time". No script and no workflow names `tests/meta`. The comment was
 *     describing a guarantee that did not exist.
 *   - `tests/_helpers/expect-present.test.ts` pinned the failure MESSAGES of the
 *     two helpers that ~100 test files now read their values through — the whole
 *     justification for retiring 593 non-null assertions — from a directory no
 *     glob covers. Moved into `tests/unit/_arch/` in the same commit as this
 *     ratchet.
 *
 * ## 2026-08-27 — the guard had the defect it was written to catch
 *
 * The original walk started at `join(REPO_ROOT, "tests")`, so its "closed"
 * allowlist was closed over the WRONG UNIVERSE. Outside `tests/` sat 296
 * `src/**` + 46 `apps/**` + 17 `tools/**` colocated test files and one stray at
 * the repo root, and NO script pointed `bun test` at any of them — and this file
 * was green the whole time. Running them for the first time found two hellgates
 * that had been RED and unseen:
 *
 *   - `src/apps/cli/repl/surface-compose/__tests__/prompt-ux-mention-provider.hellgate.test.ts`
 *     asserted `@thread:` autocomplete candidates from a fixture with no
 *     `selfThreadId`. The B4 lineage scope made that path FAIL-CLOSED on
 *     2026-08-10; the sibling fixture in the same directory was updated and this
 *     one was not. RED for 17 days.
 *   - `src/host/runtime/__tests__/composition-slot-registry-byte-identical.hellgate.test.ts`
 *     — the composition fingerprint drifted when the GOAL-03 verifier slot and
 *     the rewritten objective store API landed. A "byte-identical hellgate" that
 *     nothing executes cannot make anyone look at the diff.
 *
 * So the walk now covers the WHOLE repo, and both the directory count and the
 * FILE count carry an anti-vacuity floor: a walk that breaks must read as
 * "broken", never as "everything is gated".
 *
 * ## What is pinned
 *
 * Not "every test must live under the gated roots" — several directories are
 * deliberately outside, with their own runner and their own reasons (a PTY
 * harness that needs a real terminal, live-API embedder evals, an hours-long
 * smoke battery, a vitest/jsdom SPA suite that `bun test` cannot run at all).
 * Those are listed with the runner that reaches them, so the list doubles as the
 * answer to "how do I run this file".
 *
 * What must not happen is a NEW directory of test files appearing with no runner
 * at all — which is how every example above came to be. So the allowlist is by
 * DIRECTORY and it is closed: an unlisted one fails.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")

const scripts = (): Readonly<Record<string, string>> => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    scripts?: Record<string, string>
  }
  return pkg.scripts ?? {}
}

/**
 * The KEY a directory of tests is admitted (or refused) under.
 *
 * `tests/` is deliberately finer-grained than the rest: its immediate children
 * are the unit of gating (`tests/unit` is gated, `tests/smoke` is not), and
 * collapsing them to a single `tests` key would re-admit exactly the orphan
 * directories this ratchet was written for. Everywhere else the top-level
 * directory is the unit — `src`, `tools`, `apps` — and `"."` is the repo root.
 */
export const gateKey = (rel: string): string => {
  if (rel === "" || rel === ".") return "."
  const parts = rel.split("/")
  const head = parts[0] as string
  const second = parts[1]
  return head === "tests" && second !== undefined ? `tests/${second}` : head
}

/** A `bun test` argument reduced to a gate key — `undefined` for flags and for
 *  anything that is not a plain path (`--parallel=1`, `$(find …)`, `""`).
 *
 *  The leading `./` is stripped because the gate globs NEED it: a `bun test`
 *  positional is a SUBSTRING filter over absolute paths, not a scan root, so a
 *  bare `src/` also sweeps `apps/web-frontend/src/` — 77 vitest files `bun test`
 *  cannot run. `./src/` anchors the filter at the cwd. Measured 2026-08-27:
 *  `bun test src/` → 392 files / 18 fail; `bun test ./src/` → 296 files / 0 fail. */
const keyForToken = (tok: string): string | undefined => {
  const path = tok.replace(/^\.\//, "").replace(/\/+$/, "")
  if (path === "" || path.startsWith("-") || !/^[A-Za-z0-9_/-]+$/.test(path)) return undefined
  const key = gateKey(path)
  return key === "." ? undefined : key
}

/**
 * The roots the PER-PUSH gates actually point `bun test` at.
 *
 * DERIVED from `package.json` rather than restated here. Restating them is the
 * very drift this file exists to catch: `bunfig.toml`, `tests/README.md` and
 * the feature catalog all asserted that `tests/meta/` runs at CI time while no
 * script named it, and each of those three was a hand-written copy of a fact
 * nobody rechecked.
 */
export const gatedRoots = (allScripts: Readonly<Record<string, string>>): readonly string[] => {
  const gates = ["test", "test:unit", "test:integration", "test:ci"]
  const roots = new Set<string>()
  for (const g of gates) {
    for (const m of (allScripts[g] ?? "").matchAll(/\bbun test ([^&|]*)/g)) {
      for (const tok of (m[1] ?? "").split(/\s+/)) {
        const key = keyForToken(tok)
        if (key !== undefined) roots.add(key)
      }
    }
  }
  return [...roots].sort()
}

/** True when SOME script mentions the path — i.e. a human can run it at all. */
export const reachableByAnyScript = (
  path: string,
  allScripts: Readonly<Record<string, string>>,
): boolean => Object.values(allScripts).some((cmd) => cmd.includes(path))

/**
 * Directories of tests that live OUTSIDE the per-push gates on purpose, each
 * with the runner that executes them. An entry is a promise that the named
 * script exists AND that the script body still points at `path` — both checked
 * below, so a justification cannot rot into a comment the way the ones above
 * did. `path` is what the runner must mention: for a key that is already a real
 * directory it is the key itself, and for a coarse key like `apps` it is the
 * concrete sub-directory, so `"apps"` cannot be satisfied by the word "apps"
 * appearing incidentally in some unrelated script.
 */
const OUT_OF_BAND: Readonly<
  Record<string, { readonly runner: string; readonly path: string; readonly why: string }>
> = {
  "tests/e2e-pty": {
    runner: "e2e:pty",
    path: "tests/e2e-pty",
    why: "raw-mode interactive CLI e2e — needs a real pty (FFI openpty), which the normal runner cannot provide.",
  },
  "tests/smoke": {
    runner: "smoke",
    path: "tests/smoke",
    why: "the smoke battery drives a real agent loop with recorded tool/LLM replay; deliberately off the per-commit path.",
  },
  "tests/eval": {
    runner: "eval:retrieval",
    path: "tests/eval",
    why: "retrieval embedder/reranker evals hit LIVE provider APIs and cost money; run deliberately, never on a gate.",
  },
  apps: {
    runner: "test:web-frontend",
    path: "apps/web-frontend",
    why: "every file under apps/ is the vitest/jsdom SPA suite in apps/web-frontend — all 77 import `vitest`, which `bun test` cannot resolve (vitest lives only in that workspace's own node_modules, not the root's), and they need a DOM environment. Verified 2026-08-27: 732 tests green in 7s under `vitest run`, 0 under `bun test`.",
  },
}

/** Entries worth descending into: skip `node_modules` and dotted directories. */
const isWalkable = (name: string): boolean => name !== "node_modules" && !name.startsWith(".")

const isTestFile = (name: string): boolean =>
  name.endsWith(".test.ts") || name.endsWith(".test.tsx")

/** Every directory in the REPO that holds at least one test file, plus the file
 *  count — the count is what makes a broken walk legible as broken.
 *
 *  The recursion is split from the per-entry decision on purpose: this file
 *  ratchets cognitive complexity's own cousin, and an inline 4-branch loop body
 *  inside a nested closure scored 19 against the cap of 15 — this test would
 *  have been the thing that broke the ceiling it exists beside. */
const walkTestDirs = (rel: string, found: Set<string>, count: { n: number }): void => {
  for (const ent of readdirSync(join(REPO_ROOT, rel), { withFileTypes: true })) {
    if (!isWalkable(ent.name)) continue
    if (ent.isDirectory()) walkTestDirs(rel === "" ? ent.name : `${rel}/${ent.name}`, found, count)
    else if (isTestFile(ent.name)) {
      count.n += 1
      found.add(rel === "" ? "." : rel)
    }
  }
}

const testDirsInRepo = (): { readonly dirs: readonly string[]; readonly files: number } => {
  const found = new Set<string>()
  const count = { n: 0 }
  walkTestDirs("", found, count)
  return { dirs: [...found].sort(), files: count.n }
}

describe("gated test scope", () => {
  const { dirs, files } = testDirsInRepo()

  test("anti-vacuity: the walk finds the real test tree, repo-wide", () => {
    // If this ever went small, every assertion below would pass for free — and
    // the walk being scoped to the wrong sub-tree is precisely how this file was
    // green while 360 files ran under no gate at all.
    expect(dirs.length).toBeGreaterThan(150) // 211 on 2026-08-27
    expect(files).toBeGreaterThan(3000) // 3765 on 2026-08-27
    expect(dirs.some((d) => d.startsWith("tests/unit"))).toBe(true)
    expect(dirs.some((d) => d.startsWith("tests/integration"))).toBe(true)
    // The three roots the old `tests`-only walk could not see at all. If a
    // future refactor re-narrows the walk, these fail rather than passing empty.
    expect(dirs.some((d) => d === "src" || d.startsWith("src/"))).toBe(true)
    expect(dirs.some((d) => d === "apps" || d.startsWith("apps/"))).toBe(true)
    expect(dirs.some((d) => d === "tools" || d.startsWith("tools/"))).toBe(true)
  })

  const all = scripts()
  const gated = gatedRoots(all)

  test("the gate globs are readable from package.json at all", () => {
    // If this regexed to nothing, every directory would look ungated and the
    // next assertion would fail for the wrong reason.
    expect(gated).toContain("tests/unit")
    expect(gated).toContain("tests/integration")
    expect(gated).toContain("src")
    expect(gated).toContain("tools")
  })

  test("every test directory is either GATED or has a declared runner", () => {
    const orphans = [...new Set(dirs.map(gateKey))]
      .filter((seg) => !gated.includes(seg))
      .filter((seg) => OUT_OF_BAND[seg] === undefined)
      .sort()
    expect(
      orphans,
      orphans.length === 0
        ? ""
        : `these hold test files that NO gate runs — add them to the gate globs in package.json (currently ${gated.join(
            ", ",
          )}) or add an OUT_OF_BAND entry naming the runner that does:\n  ${orphans
            .map((o) => (o === "." ? "<repo root>" : `${o}/`))
            .join("\n  ")}`,
    ).toEqual([])
  })

  test("every out-of-band runner exists AND actually reaches its directory", () => {
    // The half that rots: an entry claims a runner, the script is renamed or
    // repointed, and the justification becomes as false as the bunfig comment
    // that prompted this ratchet. Existence alone is not enough — the NAMED
    // script must still point at the directory.
    expect(Object.keys(all).length).toBeGreaterThan(10) // the read is real
    for (const [key, { runner, path }] of Object.entries(OUT_OF_BAND)) {
      const body = all[runner]
      expect(body, `${key}/ claims runner \`${runner}\`, which does not exist`).toBeDefined()
      expect(
        body?.includes(path) ?? false,
        `\`${runner}\` no longer mentions ${path} — the runner claimed for ${key}/ does not reach it`,
      ).toBe(true)
      expect(
        reachableByAnyScript(path, all),
        `no script mentions ${path} — it is unreachable however it is labelled`,
      ).toBe(true)
    }
  })

  test("no out-of-band entry is stale — each directory still exists and holds tests", () => {
    // One-directional the other way: an entry that no longer matches anything is
    // a permission nobody needs, and it would silently re-admit the directory if
    // it ever came back for a different reason.
    const keys = new Set(dirs.map(gateKey))
    for (const key of Object.keys(OUT_OF_BAND)) {
      expect(keys.has(key), `OUT_OF_BAND lists ${key}/, which holds no test files`).toBe(true)
    }
  })
})
