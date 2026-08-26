/**
 * Paired test for the cwd-parity harness.
 *
 * `tools/dev/cwd-parity-check.ts` runs each test file at the repo root and again
 * from a throwaway cwd, and reports only the difference. Its failure mode is the
 * worst kind for a measuring instrument: it does not crash, it reports FINDINGS —
 * and a list of files that are not actually cwd-dependent is worse than no list,
 * because it gets acted on.
 *
 * Both bugs pinned here shipped on its first run, which reported **507
 * cwd-dependent files** and was entirely wrong:
 *
 *   - `parseParityArgs`. With `--shard` absent, `indexOf` returns -1 and the
 *     old inline `i !== shardAt + 1` dropped index **0** — the first root. The
 *     harness then fell back to its `tests/unit` default and measured 3,000 files
 *     while its own banner claimed the 10 it was asked for. This is the SECOND
 *     time this exact off-by-one shipped in this repo; `sandboxed-test.ts`'s
 *     `parseArgs` had it and is pinned for the same reason.
 *   - Relative roots. The sandbox arm runs with a different cwd, so a relative
 *     path resolves for one arm and not the other: every sandbox arm died before
 *     bun printed a counter line, and "no counters" was then read as "failed",
 *     i.e. as cwd dependence. `parseCounters` distinguishing "-1, never ran" from
 *     "0 fail" is what makes that visible instead of silent.
 */

import { describe, expect, test } from "bun:test"

import {
  armsDiffer,
  parseCounters,
  parseParityArgs,
  shardOf,
} from "@/../tools/dev/cwd-parity-check"

describe("cwd-parity harness", () => {
  describe("argv", () => {
    test("🔴 a lone root survives when --shard is absent (it used to be dropped)", () => {
      expect(parseParityArgs(["tests/unit/_arch"])).toEqual({
        shardSpec: undefined,
        roots: ["tests/unit/_arch"],
      })
    })

    test("--shard consumes exactly its value, wherever it sits", () => {
      expect(parseParityArgs(["--shard", "2/8", "tests/unit"])).toEqual({
        shardSpec: "2/8",
        roots: ["tests/unit"],
      })
      expect(parseParityArgs(["tests/unit", "--shard", "2/8"])).toEqual({
        shardSpec: "2/8",
        roots: ["tests/unit"],
      })
    })

    test("a root that looks like the shard value is not eaten", () => {
      expect(parseParityArgs(["--shard", "1/2", "1/2"]).roots).toEqual(["1/2"])
    })

    test("several roots are all kept", () => {
      expect(parseParityArgs(["a", "b", "c"]).roots).toEqual(["a", "b", "c"])
    })
  })

  describe("counters", () => {
    test("🔴 an arm that never ran is -1, NOT a clean zero", () => {
      // The distinction the 507-finding run needed and did not have: bun failing
      // to open the file prints no counter line, and treating that as `0 fail`
      // makes a dead arm look like a passing one.
      expect(parseCounters("error: no such file")).toEqual({ ok: false, pass: -1, fail: -1 })
    })

    test("reads a passing and a failing tail", () => {
      expect(parseCounters(" 12 pass\n 0 fail\n")).toEqual({ ok: true, pass: 12, fail: 0 })
      expect(parseCounters(" 9 pass\n 3 fail\n")).toEqual({ ok: false, pass: 9, fail: 3 })
    })

    test("zero passes with zero fails is not OK — nothing was proven", () => {
      expect(parseCounters(" 0 pass\n 0 fail\n").ok).toBe(false)
    })
  })

  describe("arm comparison", () => {
    test("identical arms do not differ", () => {
      const a = { ok: true, pass: 4, fail: 0 } as const
      expect(armsDiffer(a, { ...a })).toBe(false)
    })

    test("🔴 a dead arm differs from a passing one", () => {
      expect(armsDiffer({ ok: true, pass: 4, fail: 0 }, { ok: false, pass: -1, fail: -1 })).toBe(
        true,
      )
    })

    test("a differing pass count alone does not count — skips drift", () => {
      // Only the OUTCOME is compared. Pinning pass counts would make every
      // conditionally-skipped test look cwd-dependent.
      expect(armsDiffer({ ok: true, pass: 4, fail: 0 }, { ok: true, pass: 5, fail: 0 })).toBe(false)
    })
  })

  describe("sharding", () => {
    test("shards partition the input exactly once", () => {
      const xs = Array.from({ length: 10 }, (_, i) => i)
      const all = [1, 2, 3].flatMap((i) => [...shardOf(xs, `${i}/3`)])
      expect(all.sort((a, b) => a - b)).toEqual(xs)
    })

    test("no spec is the whole set", () => {
      expect(shardOf([1, 2, 3], undefined)).toEqual([1, 2, 3])
    })

    test("a malformed or out-of-range spec is refused, not silently ignored", () => {
      expect(() => shardOf([1], "x")).toThrow(/N\/M/)
      expect(() => shardOf([1], "0/4")).toThrow(/out of range/)
      expect(() => shardOf([1], "5/4")).toThrow(/out of range/)
    })
  })
})
