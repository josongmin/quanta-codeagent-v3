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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  CORPUS_ROOTS,
  canaryHolds,
  classifyOutput,
  ledgerEntries,
  manifest,
} from "@/../tools/dev/empty-mirror-check"

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
        for (let i = 0; i < 20; i++) {
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

  describe("manifest", () => {
    test("anti-vacuity: the manifest and the ledger are both non-empty reads", () => {
      // Both are JSON on disk, so an unreadable or renamed file would make every
      // assertion below pass over an empty array.
      expect(manifest().length).toBeGreaterThan(0)
      expect(ledgerEntries().length).toBeGreaterThan(0)
    })

    test("🔴 every ledger entry is bound to a corpus root", () => {
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
