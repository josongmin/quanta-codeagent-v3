/**
 * `tools/dev/shard-rss` — peak-RSS sampling for a test-shard worker.
 *
 * # Why this is not one `ps -p <pid>`
 * It used to be, and that was correct while every chunk ran `--parallel=1`: the
 * Bun child the runner spawned WAS the whole worker. Intra-worker parallelism
 * for `pure` chunks changed that — Bun forks N worker processes and the memory
 * lives in the children. Measured on a 16-CPU box with 8 allocating files:
 *
 *     --parallel=1 : direct child 1MB    child+descendants 1MB
 *     --parallel=4 : direct child 21MB   child+descendants 152MB
 *
 * A 7x undercount on a runner whose own concurrency decision is memory-gated,
 * so the number a human reads when asking "can this host afford another
 * worker?" was reading an order of magnitude low.
 *
 * # Why it is no longer two `ps` calls either
 * It was `ps -Ao pid=,ppid=` to find the tree, then `ps -o rss= -p …` to price
 * it: two unbounded synchronous spawns per sample, inside the same interval
 * that owns the inactivity watchdog. Both now come out of ONE bounded snapshot
 * (`process-observer`), which also carries the rows the drain check and the
 * leader-identity check need — so a watchdog tick costs one `ps`, not four.
 *
 * The parse is split from the spawn so the arithmetic is testable without a
 * process tree (tests/unit/shard-rss-sampling.test.ts).
 */

import {
  defaultProcessObserver,
  type ProcessObserver,
  type ProcessRow,
  treeRssKib,
  walkDescendants,
} from "./process-observer"

/** Sum every RSS row `ps` printed. A row that is not a positive integer (a
 *  header, a warning, a pid that vanished mid-sample) is skipped rather than
 *  poisoning the total — an unreadable row is missing data, not zero bytes. */
export const sumRssKib = (psOutput: string): number => {
  let total = 0
  for (const line of psOutput.split("\n")) {
    const kib = Number.parseInt(line.trim(), 10)
    if (Number.isSafeInteger(kib) && kib > 0) total += kib
  }
  return total
}

/** Every descendant of `pid`, breadth-first, from `ps -Ao pid=,ppid=` text.
 *  Bun's worker children are direct children today; the walk is general so a
 *  worker that spawns its own helper is still counted. Bounded so a
 *  pathological (or self-parented) tree cannot stall the watchdog. */
export const descendantPids = (pid: number, psAll: string, maxNodes = 512): readonly number[] => {
  const edges: { pid: number; ppid: number }[] = []
  for (const line of psAll.split("\n")) {
    const fields = line.trim().split(/\s+/u)
    const child = Number.parseInt(fields[0] ?? "", 10)
    const parent = Number.parseInt(fields[1] ?? "", 10)
    if (!Number.isSafeInteger(child) || !Number.isSafeInteger(parent)) continue
    edges.push({ pid: child, ppid: parent })
  }
  return walkDescendants(edges, pid, maxNodes)
}

/** Peak-RSS of the worker TREE, in bytes, from rows already in hand. */
export const treeRssBytesFromRows = (rows: readonly ProcessRow[], pid: number): number =>
  treeRssKib(rows, pid) * 1024

/**
 * Peak-RSS of the worker TREE in bytes.
 *
 * `0` means "could not measure", which the caller already treats as "leave the
 * previous peak alone". An unavailable snapshot lands there too: a bounded
 * failure to observe must read as no measurement, never as a worker that
 * suddenly uses nothing.
 */
export const sampleTreeRssBytes = (
  pid: number,
  observer: ProcessObserver = defaultProcessObserver(),
): number => {
  const snapshot = observer.snapshot()
  if (snapshot.kind !== "ok") return 0
  return treeRssBytesFromRows(snapshot.rows, pid)
}
