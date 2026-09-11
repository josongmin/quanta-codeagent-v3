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
import { createProcessObserver, type ProcessRow } from "../../tools/dev/process-observer"
import {
  descendantPids,
  sampleTreeRssBytes,
  sumRssKib,
  treeRssBytesFromRows,
} from "../../tools/dev/shard-rss"

const psRow = (over: Partial<ProcessRow> & Pick<ProcessRow, "pid">): ProcessRow => ({
  ppid: 1,
  pgid: over.pid,
  stat: "S",
  rssKib: 0,
  pcpu: "0.0",
  etime: "01:00",
  started: "Fri Sep 11 23:13:04 2026",
  comm: "bun",
  ...over,
})

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

  test("ONE snapshot now prices the tree — it used to be two unbounded `ps` calls", () => {
    // The sample is a pure function of rows the drain check and the identity
    // check already needed, so a watchdog tick costs one `ps`, not four.
    let calls = 0
    const observer = createProcessObserver({
      spawn: () => {
        calls += 1
        return {
          exitCode: 0,
          stdout: [
            "  100     1   100 S     1024   0.0 01:00 Fri Sep 11 23:13:04 2026 /usr/bin/bun",
            "  101   100   100 S     2048   0.0 01:00 Fri Sep 11 23:13:04 2026 /usr/bin/bun",
            "  103   101   100 S      256   0.0 01:00 Fri Sep 11 23:13:04 2026 /usr/bin/bun",
            "  200     1   200 S 99999999   0.0 01:00 Fri Sep 11 23:13:04 2026 /usr/bin/other",
          ].join("\n"),
        }
      },
    })

    expect(sampleTreeRssBytes(100, observer)).toBe((1024 + 2048 + 256) * 1024)
    expect(calls).toBe(1)
  })

  test("★ an unavailable snapshot reads as NO MEASUREMENT (0), never a shrunken worker", () => {
    // `0` is what the caller already treats as "leave the previous peak alone".
    // A bounded probe that could not run must land there rather than reporting
    // a worker that suddenly uses nothing.
    const observer = createProcessObserver({
      spawn: () => ({ exitCode: null, signalCode: "SIGTERM", stdout: "" }),
    })
    expect(sampleTreeRssBytes(100, observer)).toBe(0)
    // PAIRED CONTROL — the same pid against readable rows is non-zero.
    expect(treeRssBytesFromRows([psRow({ pid: 100, rssKib: 4096 })], 100)).toBe(4096 * 1024)
  })
})
