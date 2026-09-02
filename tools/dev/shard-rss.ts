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
 * The parse is split from the spawn so the arithmetic is testable without a
 * process tree (tests/unit/shard-rss-sampling.test.ts).
 */

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

/** Every descendant of `pid`, breadth-first. Bun's worker children are direct
 *  children today; the walk is general so a worker that spawns its own helper
 *  is still counted. Bounded so a pathological tree cannot stall the watchdog. */
export const descendantPids = (pid: number, psAll: string, maxNodes = 512): readonly number[] => {
  const childrenOf = new Map<number, number[]>()
  for (const line of psAll.split("\n")) {
    const fields = line.trim().split(/\s+/)
    const child = Number.parseInt(fields[0] ?? "", 10)
    const parent = Number.parseInt(fields[1] ?? "", 10)
    if (!Number.isSafeInteger(child) || !Number.isSafeInteger(parent)) continue
    const siblings = childrenOf.get(parent) ?? []
    siblings.push(child)
    childrenOf.set(parent, siblings)
  }
  const out: number[] = []
  const queue = [pid]
  const seen = new Set<number>([pid])
  while (queue.length > 0 && out.length < maxNodes) {
    const next = queue.shift()
    if (next === undefined) break
    for (const child of childrenOf.get(next) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      out.push(child)
      queue.push(child)
    }
  }
  return out
}

/** Peak-RSS of the worker TREE in bytes. `0` means "could not measure", which
 *  the caller already treats as "leave the previous peak alone". */
export const sampleTreeRssBytes = (pid: number): number => {
  const all = Bun.spawnSync(["ps", "-Ao", "pid=,ppid="]).stdout.toString()
  const pids = [pid, ...descendantPids(pid, all)]
  const rows = Bun.spawnSync(["ps", "-o", "rss=", ...pids.flatMap((p) => ["-p", String(p)])])
  return sumRssKib(rows.stdout.toString()) * 1024
}
