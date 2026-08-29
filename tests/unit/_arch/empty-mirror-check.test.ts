/**
 * Paired test for the empty-corpus oracle.
 *
 * `tools/dev/empty-mirror-check.ts` is the instrument that decides whether a
 * guard would notice its corpus vanishing. Three static detectors were built
 * before it and all three shipped inert while green, so this one is pinned
 * rather than trusted — and the specific things pinned here are the exact
 * distinctions whose absence made the previous engines wrong.
 *
 * ## The two failures this file exists to prevent
 *
 * **Collapsing a broken run into a verdict.** bun folds an unresolved import, a
 * timeout and a genuine assertion failure into the same non-zero exit and the
 * same `1 fail` counter. An earlier engine read the `1 fail` from
 * `Cannot find module '@/tool'` as "the guard noticed", which inverted the
 * verdict for four of six arms — every guard looked sound because the runtime
 * had died before any of them ran.
 *
 * **A mirror that is not actually empty.** Two engines refilled the corpus while
 * trying to keep the runtime alive: a static preload closure restored 281 of the
 * 291 files under `src/tool`, and an execution-driven fixpoint took 107 seconds
 * to restore the same 281. Both reported green over a corpus that was intact.
 * The canary is what makes that visible, so the canary itself is tested here in
 * the direction that matters: it must NOT hold on a mirror whose corpus is
 * present.
 */

import { describe, expect, test } from "bun:test"
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  buildMirror,
  CORPUS_ROOTS,
  canaryHolds,
  classifyOutput,
  importClosure,
  ledgerEntries,
  manifest,
} from "@/../tools/dev/empty-mirror-check"

/** Files under a mirrored root, split by guard vs corpus. */
const corpusFiles = (dir: string): { nonTest: number; tests: number } => {
  let nonTest = 0
  let tests = 0
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (p.endsWith(".test.ts")) tests++
      else if (p.endsWith(".ts")) nonTest++
    }
  }
  walk(dir)
  return { nonTest, tests }
}

describe("empty-corpus oracle", () => {
  describe("verdict classification", () => {
    test("🔴 an unresolved import is INFRA, never a verdict", () => {
      // The precise bug: this output carries `1 fail`, and reading that as "the
      // guard noticed" is what made four of six arms report soundness over a
      // runtime that never started.
      expect(
        classifyOutput("error: Cannot find module '@/tool' from 'x'\n 0 pass\n 1 fail\n"),
      ).toBe("infra")
      expect(classifyOutput("error: Failed to resolve '@/x'\n 1 fail\n")).toBe("infra")
    })

    test("🔴 a timeout is INFRA, not a failing assertion", () => {
      expect(classifyOutput("this test timed out after 5000ms\n 0 pass\n 1 fail\n")).toBe("infra")
    })

    test("a run that executed nothing is NO-TESTS, not a pass", () => {
      expect(classifyOutput("Ran 0 tests across 0 files.\n")).toBe("no-tests")
    })

    test("a real failure is RED and a real pass is GREEN", () => {
      expect(classifyOutput(" 3 pass\n 1 fail\nRan 4 tests across 1 file.\n")).toBe("red")
      expect(classifyOutput(" 4 pass\n 0 fail\nRan 4 tests across 1 file.\n")).toBe("green")
    })

    test("output with no counters at all is INFRA, not green", () => {
      // Silence is not success. A crashed runner prints nothing usable, and
      // defaulting that to green would certify every guard at once.
      expect(classifyOutput("")).toBe("infra")
      expect(classifyOutput("segmentation fault")).toBe("infra")
    })
  })

  describe("the canary", () => {
    test("🔴 does NOT hold on a mirror whose corpus is still present", () => {
      // The control for the failure mode that beat two earlier engines. If a
      // mirror silently keeps its corpus, every guard passes and the sweep
      // reports a clean tree — so the canary must refuse to certify it.
      const dir = mkdtempSync(join(tmpdir(), "em-oracle-nonempty-"))
      try {
        mkdirSync(join(dir, "tests", "unit", "_arch"), { recursive: true })
        mkdirSync(join(dir, "src"), { recursive: true })
        // The canary's floor is a SHARE of the real corpus (10%), not a fixed
        // count — a guard's own imports legitimately leave a few dozen files
        // behind, and an absolute floor of 5 called that "corpus present" and
        // made the guard unjudgeable. So a fixture proving the canary can say
        // "not empty" has to be comparable to the real tree.
        for (let i = 0; i < 2000; i++) {
          writeFileSync(join(dir, "src", `f${i}.ts`), "export {}\n")
        }
        writeFileSync(join(dir, "bunfig.toml"), "[test]\ncoverage = false\n")
        expect(canaryHolds(dir, "src")).toBe(false)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 120_000)

    test("holds on a mirror whose corpus is empty", () => {
      // The other direction, without which the case above passes for a mirror
      // that is simply broken.
      const dir = mkdtempSync(join(tmpdir(), "em-oracle-empty-"))
      try {
        mkdirSync(join(dir, "tests", "unit", "_arch"), { recursive: true })
        mkdirSync(join(dir, "src"), { recursive: true })
        writeFileSync(join(dir, "bunfig.toml"), "[test]\ncoverage = false\n")
        expect(canaryHolds(dir, "src")).toBe(true)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 120_000)
  })

  /** Every path under `root` the per-file walk would have refused to copy. */
  const skippablePaths = (dir: string, root: string): string[] => {
    const out: string[] = []
    const walk = (rel: string): void => {
      for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
        const next = join(rel, e.name)
        if (e.name === "node_modules" || e.name.startsWith(".")) out.push(next)
        else if (e.isDirectory()) walk(next)
      }
    }
    walk(root)
    return out
  }

  describe("mirror construction", () => {
    // An audit ran 16 mutations against the oracle. Six SURVIVED, and every one
    // of them was on the mirror-construction path — which this file did not
    // execute at all (`grep -c buildMirror` was 0). The two properties the
    // header argues hardest for, materialise-don't-symlink and use-our-own-bunfig,
    // were both unpinned.
    const mirrorOf = (root: "src") => buildMirror(root)

    test("🔴 the blanked root is EMPTY of corpus, and guards survive", () => {
      // M1: inverting `isCorpus` (delete the guards, keep the corpus) survived.
      const dir = mirrorOf("src")
      try {
        const kept = corpusFiles(join(dir, "src"))
        expect(kept.nonTest, "corpus files survived the blank").toBe(0)
        expect(kept.tests, "the guards were deleted instead of the corpus").toBeGreaterThan(100)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 180_000)

    test("🔴 src and tests are MATERIALISED, never symlinked", () => {
      // M5: re-symlinking `tests` survived. It is the defect the header says
      // "returned twice in this file's history" — a guard's `import.meta.dir`
      // follows the link back to the real repo and reads the real corpus.
      const dir = mirrorOf("src")
      try {
        for (const root of ["src", "tests"]) {
          expect(lstatSync(join(dir, root)).isSymbolicLink(), `${root} is a symlink`).toBe(false)
        }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 180_000)

    test("🔴 no dotfile or node_modules survives — the two build paths agree", () => {
      // The mirror is built by `cp -Rc` (APFS clonefile) when it is available and
      // by a per-file walk when it is not. The walk NEVER copies a dotfile or a
      // `node_modules`; the clone copies everything. Left unreconciled the two
      // produce different trees, and the difference is corpus: `src/.env` is real,
      // is corpus by `isCorpus`, and survived a blank under the clone path only.
      // A mirror whose contents depend on which filesystem it was built on is two
      // oracles wearing one name.
      const dir = mirrorOf("src")
      try {
        const strays = ["src", "tests"].flatMap((root) => skippablePaths(dir, root))
        expect(strays, "the clone kept paths the walk would never have copied").toEqual([])
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 180_000)

    test("🔴 the mirror uses its OWN bunfig with no preload", () => {
      // M14: pointing the mirror at the repo's bunfig survived. That is the
      // decision the whole engine rests on — the repo's preload loads production
      // slices, so a mirror using it cannot have those slices emptied.
      const dir = mirrorOf("src")
      try {
        const cfg = readFileSync(join(dir, "bunfig.toml"), "utf8")
        expect(lstatSync(join(dir, "bunfig.toml")).isSymbolicLink()).toBe(false)
        expect(cfg).not.toContain("preload")
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 180_000)
  })

  describe("import closure", () => {
    test("🔴 a barrel's re-exports survive a `/*` written inside a LINE comment", () => {
      // `src/tool/index.ts` documents the globs `resources/*` and `prompts/*` in
      // a line comment. Under the naive strip-blocks-then-lines pair, that `/*`
      // opened a comment the scan closed 12,016 characters later, deleting the
      // re-export of `./mcp_tasks` with everything else in between. The closure
      // then kept the barrel without what it points at, and ten guards died with
      // `Cannot find module` before running — reported as unjudgeable by the tool
      // that had broken them.
      const closure = importClosure("src/tool/index.ts")
      expect(closure.has("src/tool/index.ts")).toBe(true)
      expect(
        closure.has("src/tool/mcp_tasks/index.ts"),
        "the re-export after the prose `/*` was eaten — the comment stripper is not quoting-aware",
      ).toBe(true)
    })

    test("🔴 a re-export list longer than 400 chars is still followed", () => {
      // The runaway guard used to be a character ceiling, and it silently
      // truncated every barrel above it: promax re-exports `./gate-run` after an
      // 852-char specifier list. A specifier list cannot contain `;`, so the
      // statement's own end is the bound.
      const closure = importClosure("src/apps/bench/harness/promax/index.ts")
      expect(
        closure.has("src/apps/bench/harness/promax/gate-run.ts"),
        "the closure stopped mid-statement — the bound is a character count again",
      ).toBe(true)
    })
  })

  describe("manifest", () => {
    test("anti-vacuity: the manifest is a non-empty read", () => {
      // The manifest is what the oracle iterates, so an unreadable or renamed
      // file would make every assertion below pass over an empty array. The
      // LEDGER is deliberately not floored here — it is now empty, and that is
      // the goal state rather than a broken read.
      expect(manifest().length).toBeGreaterThan(0)
    })

    test("🔴 the burn-down ledger is EMPTY — zero tolerance", () => {
      // It reached zero on 2026-08-29 and the exception mechanism is retired. A
      // new entry is not a normal state: fix the guard, or if the oracle cannot
      // judge it, it reports UNSUPPORTED and says why.
      const left = ledgerEntries()
      expect(
        left,
        left.length === 0
          ? ""
          : "the anti-vacuity ledger is not an accepted mechanism any more — give these a " +
              `floor derived from their corpus instead:\n  ${left.join("\n  ")}`,
      ).toEqual([])
    })

    test("every ledger entry, if any, is bound to a corpus root", () => {
      // The hole this closes: a guard in the burn-down with no declared corpus
      // is never run by the oracle, so it stays on the list forever while
      // appearing to be under a gate.
      const bound = new Set(manifest().map((c) => c.file))
      const unbound = ledgerEntries()
        .filter((f) => !bound.has(f))
        .sort()
      expect(
        unbound,
        unbound.length === 0
          ? ""
          : "these are in the burn-down but name no corpus root, so the oracle never " +
              `judges them — add them to tools/dev/anti-vacuity-cases.json:\n  ${unbound.join("\n  ")}`,
      ).toEqual([])
    })

    test("no manifest entry is stale, duplicated, or points at a missing file", () => {
      const files = manifest().map((c) => c.file)
      expect(new Set(files).size, "duplicate entries").toBe(files.length)
      for (const c of manifest()) {
        expect(CORPUS_ROOTS as readonly string[], `${c.file}: unknown corpus`).toContain(c.corpus)
        expect(
          Bun.file(join(import.meta.dir, "..", "..", "..", c.file)).size,
          c.file,
        ).toBeGreaterThan(0)
      }
    })
  })
})
