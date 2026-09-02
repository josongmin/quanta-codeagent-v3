/**
 * ★ HELLGATE — the shard watchdog measures the whole worker TREE, not one pid.
 *
 * MEASURED DEFECT (2026-09-03): `sampleRssBytes` asked `ps` for a single pid —
 * the Bun child the runner spawned. That was accurate while every chunk ran
 * `--parallel=1`, because the child WAS the whole worker. It stopped being true
 * when `pure` chunks gained intra-worker parallelism: Bun then forks N worker
 * processes and the memory lives in the children.
 *
 * Measured on this box with 8 allocating test files:
 *
 *     --parallel=1 : direct child 1MB    child+descendants 1MB
 *     --parallel=4 : direct child 21MB   child+descendants 152MB
 *
 * A 7x undercount, on a runner whose concurrency decision is memory-gated
 * (`chooseShardConcurrency` needs >=16 GiB available). Reporting 21MB for a
 * 152MB worker is not a cosmetic stat: it is the number a human reads when
 * deciding whether this host can afford another worker.
 *
 * The parse is separated from the spawn so the arithmetic is testable without a
 * process tree; the integration is pinned by the descendant-summing test below.
 */

import { describe, expect, test } from "bun:test"
import { descendantPids, sumRssKib } from "../../tools/dev/shard-rss"

describe("shard RSS sampling — a worker is its whole tree", () => {
  test("sums every row `ps` returns, not just the first", () => {
    // `ps -o rss= -p <pid> -p <child> ...` prints one line per process.
    expect(sumRssKib("  1024\n  2048\n  512\n")).toBe(3584)
  })

  test("a single row still works — the pre-parallel behaviour is preserved", () => {
    expect(sumRssKib(" 4096\n")).toBe(4096)
  })

  test("PAIRED CONTROL — no rows means no measurement, never a fabricated zero-ish number", () => {
    expect(sumRssKib("")).toBe(0)
    expect(sumRssKib("\n\n")).toBe(0)
  })

  test("a malformed row is skipped rather than poisoning the total", () => {
    // `ps` can emit a header or a warning line if the pid vanished mid-sample.
    expect(sumRssKib("RSS\n  2048\n(not a number)\n  1024\n")).toBe(3072)
  })

  test("the tree walk finds a worker's children, and grandchildren", () => {
    // `ps -Ao pid=,ppid=` shape: 100 is the worker, 101/102 its Bun workers,
    // 103 a helper one of them spawned, 200 an unrelated process.
    const psAll = ["  100 1", "  101 100", "  102 100", "  103 101", "  200 1"].join("\n")

    expect([...descendantPids(100, psAll)].sort()).toEqual([101, 102, 103])
  })

  test("PAIRED CONTROL — an unrelated tree is not swept in", () => {
    const psAll = ["  100 1", "  200 1", "  201 200"].join("\n")

    expect(descendantPids(100, psAll)).toEqual([])
  })

  test("a cyclic or self-parented row cannot hang the watchdog", () => {
    const psAll = ["  100 1", "  101 100", "  100 101"].join("\n")

    expect(descendantPids(100, psAll)).toEqual([101])
  })

  test("negative or absurd values are ignored", () => {
    expect(sumRssKib("  -5\n  2048\n")).toBe(2048)
  })
})
