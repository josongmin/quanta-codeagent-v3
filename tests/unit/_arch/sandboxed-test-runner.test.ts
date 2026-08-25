/**
 * Paired test for the sandboxed test runner.
 *
 * `tools/dev/sandboxed-test.ts` runs the suite from a throwaway working
 * directory so a stray relative write lands somewhere disposable instead of the
 * repo root — the containment answer to a leak whose SOURCE five methods failed
 * to identify (see `docs/analysis/aug-24-repo-root-fixture-leak-investigation.md`).
 *
 * Three of its pure parts decide whether it works at all, and each fails
 * SILENTLY when broken — which is why they are pinned here rather than trusted:
 *
 *   - `assertPreloadsMatchBunfig`. The runner must pass `bunfig.toml`'s
 *     `[test] preload` entries explicitly, because bunfig resolves them against
 *     the CWD and a foreign CWD therefore loads NONE of them. A drift between
 *     the runner's copy and bunfig does not crash: the suite runs, most tests
 *     pass, and the global setup is simply absent.
 *   - `batches`. The localization step. Getting it wrong does not error, it just
 *     reports the wrong slice as guilty — which is worse than reporting none.
 *   - `parseUntracked`. Shared shape with the worktree-pollution guard: git's
 *     `-z` output must not be split on newlines, or a path with a space reads as
 *     a brand-new file on every run.
 */

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  assertPreloadsMatchBunfig,
  batches,
  expandTestFiles,
  parseArgs,
  parseConcurrentBunTests,
  parseUntracked,
  walkRelative,
} from "@/../tools/dev/sandboxed-test"

describe("sandboxed-test runner", () => {
  describe("preload drift guard", () => {
    test("accepts the bunfig the runner was written against", () => {
      const bunfig = `[test]\npreload = ["./tests/preload-clean-source-js.ts", "./tests/setup.ts"]\n`
      expect(() => assertPreloadsMatchBunfig(bunfig)).not.toThrow()
    })

    test("🔴 refuses when bunfig gained a preload the runner does not pass", () => {
      // The realistic drift: someone adds a global setup file to bunfig. Under a
      // sandboxed CWD it would silently not load.
      const bunfig = `[test]\npreload = ["./tests/preload-clean-source-js.ts", "./tests/setup.ts", "./tests/new-global.ts"]\n`
      expect(() => assertPreloadsMatchBunfig(bunfig)).toThrow(/new-global/)
    })

    test("🔴 refuses when the runner passes one bunfig no longer declares", () => {
      const bunfig = `[test]\npreload = ["./tests/setup.ts"]\n`
      expect(() => assertPreloadsMatchBunfig(bunfig)).toThrow(/preload-clean-source-js/)
    })

    test("🔴 refuses a bunfig with no preload at all rather than passing vacuously", () => {
      expect(() => assertPreloadsMatchBunfig(`[test]\ncoverage = false\n`)).toThrow(/no .*preload/i)
    })

    test("the REAL bunfig.toml agrees with the runner", async () => {
      // Anti-vacuity for the three synthetic cases above: this one reads the
      // LIVE file, and it is the assertion that actually protects a run.
      const text = await Bun.file(join(import.meta.dir, "..", "..", "..", "bunfig.toml")).text()
      expect(text).toContain("preload") // the fixture is real, not an empty read
      expect(() => assertPreloadsMatchBunfig(text)).not.toThrow()
    })
  })

  describe("argv parsing", () => {
    // A real bug, not a hypothetical: `--batch`'s value sits at `batchIdx + 1`,
    // and with the flag ABSENT `batchIdx` is -1, so `batchIdx + 1` is 0 — the
    // FIRST path argument was silently dropped and the run fell back to the
    // `tests/unit` default while reporting as though it had run the slice asked
    // for. Every single-target invocation was measuring the wrong set.
    test("🔴 a lone path is kept (it used to be dropped)", () => {
      expect(parseArgs(["tests/unit/retrieval"])).toEqual({
        batchCount: 1,
        targets: ["tests/unit/retrieval"],
      })
    })

    test("several paths with no flag are all kept", () => {
      expect(parseArgs(["a", "b", "c"]).targets).toEqual(["a", "b", "c"])
    })

    test("--batch consumes exactly its value, wherever it sits", () => {
      expect(parseArgs(["--batch", "8", "tests/unit"])).toEqual({
        batchCount: 8,
        targets: ["tests/unit"],
      })
      expect(parseArgs(["tests/unit", "--batch", "4"])).toEqual({
        batchCount: 4,
        targets: ["tests/unit"],
      })
    })

    test("a path that happens to look like the batch value is NOT eaten", () => {
      // `--batch 2` then a path literally named "2" would be ambiguous; the
      // value is taken positionally, so only the index after the flag is spent.
      expect(parseArgs(["--batch", "2", "2"]).targets).toEqual(["2"])
    })

    test("a non-numeric or non-positive --batch is refused, not silently 1", () => {
      for (const bad of ["x", "0", "-1", "1.5"]) {
        expect(() => parseArgs(["--batch", bad, "tests/unit"]), bad).toThrow(/positive integer/)
      }
    })

    test("no arguments means no targets — the caller supplies the default", () => {
      expect(parseArgs([])).toEqual({ batchCount: 1, targets: [] })
    })
  })

  describe("batch localization", () => {
    test("splits into contiguous batches that reassemble to the input", () => {
      const xs = Array.from({ length: 10 }, (_, i) => i)
      const out = batches(xs, 3)
      expect(out.length).toBeLessThanOrEqual(3)
      expect(out.flatMap((b) => [...b])).toEqual(xs) // contiguous AND complete
    })

    test("a batch count of 1 (or none) is the whole set, unsplit", () => {
      const xs = [1, 2, 3]
      expect(batches(xs, 1)).toEqual([xs])
      expect(batches(xs, 0)).toEqual([xs])
    })

    test("more batches than items does not produce empty batches", () => {
      // An empty batch would run `bun test` with no files, which bun treats as
      // "run everything" — the run would silently balloon instead of narrowing.
      const out = batches([1, 2], 8)
      expect(out.every((b) => b.length > 0)).toBe(true)
      expect(out.flatMap((b) => [...b])).toEqual([1, 2])
    })

    test("an empty input stays empty rather than becoming one empty batch to run", () => {
      expect(batches([], 4)).toEqual([[]])
    })
  })

  describe("exact test-file expansion", () => {
    test("mirrors Bun discovery and refuses explicit non-test files", () => {
      const dir = mkdtempSync(join(tmpdir(), "sbx-expand-"))
      try {
        mkdirSync(join(dir, ".scratch"), { recursive: true })
        writeFileSync(join(dir, "real.test.ts"), "test('real', () => {})")
        writeFileSync(join(dir, "helper.ts"), "export {}")
        writeFileSync(join(dir, ".scratch", "hidden.test.ts"), "test('hidden', () => {})")
        expect(expandTestFiles([dir])).toEqual([join(dir, "real.test.ts")])
        expect(expandTestFiles([join(dir, "helper.ts")])).toEqual([])
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  describe("concurrent Bun test sampling", () => {
    test("accepts real bun test commands and ignores text matches in wrappers", () => {
      const sample = [
        "101 bun test tests/unit/a.test.ts",
        "102 /opt/homebrew/bin/bun test tests/unit/b.test.ts",
        "103 rg bun test",
        "104 /bin/zsh -c echo bun test",
        "105 bun run tools/dev/sandboxed-test.ts",
      ].join("\n")
      expect(parseConcurrentBunTests(sample)).toEqual([
        "101 bun test tests/unit/a.test.ts",
        "102 /opt/homebrew/bin/bun test tests/unit/b.test.ts",
      ])
    })
  })

  describe("untracked parsing (shared shape with the pollution guard)", () => {
    test("reads NUL-separated porcelain and keeps only `??` entries", () => {
      const raw = "?? a.txt\0 M src/x.ts\0?? b.txt\0"
      expect([...parseUntracked(raw)].sort()).toEqual(["a.txt", "b.txt"])
    })

    test("a path containing a space survives intact", () => {
      // Split on newlines instead of NUL and this becomes two phantom paths that
      // look new on every single run.
      expect([...parseUntracked("?? my file.txt\0")]).toEqual(["my file.txt"])
    })

    test("empty output is an empty set, not a crash", () => {
      expect(parseUntracked("").size).toBe(0)
    })
  })

  describe("sandbox walk", () => {
    test("lists nested files relative to the sandbox root, sorted", () => {
      const dir = mkdtempSync(join(tmpdir(), "sbx-walk-"))
      try {
        mkdirSync(join(dir, "nested", "deep"), { recursive: true })
        writeFileSync(join(dir, "rel.txt"), "based")
        writeFileSync(join(dir, "nested", "deep", "x.ts"), "no edit")
        // Exactly the two shapes the real leak produces: a root-level file and
        // one under a directory the writer created on the way.
        expect(walkRelative(dir)).toEqual(["nested/deep/x.ts", "rel.txt"])
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    test("an empty sandbox is empty — the clean-run case", () => {
      const dir = mkdtempSync(join(tmpdir(), "sbx-empty-"))
      try {
        expect(walkRelative(dir)).toEqual([])
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })
})
