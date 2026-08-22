/**
 * K-way fan-out grading backend (ADR-0536 P2).
 *
 * Wraps an inner `GradeBackend` factory: shards the predictions across K
 * backends graded CONCURRENTLY (e.g. K fresh EC2 boxes), then merges the shard
 * reports into one {@link GradeOutcome}. Wall-clock for full SWE-bench-500 drops
 * ~linearly with K.
 *
 * Fault tolerance: a shard whose `grade()` REJECTS does not fail the whole run —
 * that shard's instance ids are recorded as `errored` and the surviving shards'
 * results are still merged (partial results beat total failure for a long run).
 *
 * `shards <= 1` (or fewer predictions than shards) degenerates to the minimal
 * number of real shards — never an empty shard that would crash a grader.
 */
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { GradeBackend, GradeOptions, GradeOutcome } from "./backend"

export interface FanoutConfig {
  /** Number of shards K (≥ 1). Capped to the prediction count at run time. */
  readonly shards: number
  /** One fresh backend per shard (e.g. `(i) => createEc2Backend({...})`). */
  readonly makeBackend: (shardIndex: number) => GradeBackend
  /** Injectable file writer (default `Bun.write`). */
  readonly writeFile?: (path: string, content: string) => Promise<void>
  /** Injectable file reader (default `Bun.file().text()`). */
  readonly readFile?: (path: string) => Promise<string>
  /** Directory for shard prediction files + the merged report. Default os tmp. */
  readonly tmpDir?: string
}

const instanceIdOf = (line: string): string => {
  try {
    return (JSON.parse(line) as { instance_id?: string }).instance_id ?? "?"
  } catch {
    return "?"
  }
}

/** Round-robin split into `k` buckets (balanced counts), dropping empty buckets. */
const shardLines = (lines: readonly string[], k: number): string[][] => {
  const buckets: string[][] = Array.from({ length: k }, () => [])
  lines.forEach((line, i) => {
    // biome-ignore lint/style/noNonNullAssertion: i % k is always in range
    buckets[i % k]!.push(line)
  })
  return buckets.filter((b) => b.length > 0)
}

const mergedReportJson = (
  resolved: string[],
  unresolved: string[],
  errored: string[],
  emptyPatch: string[],
): string =>
  JSON.stringify({
    resolved_ids: resolved,
    unresolved_ids: unresolved,
    error_ids: errored,
    empty_patch_ids: emptyPatch,
    resolved_instances: resolved.length,
    unresolved_instances: unresolved.length,
    error_instances: errored.length,
    empty_patch_instances: emptyPatch.length,
    total_instances: resolved.length + unresolved.length + errored.length + emptyPatch.length,
  })

export const createFanoutBackend = (cfg: FanoutConfig): GradeBackend => {
  const writeFile = cfg.writeFile ?? ((p, c) => Bun.write(p, c).then(() => undefined))
  const readFile = cfg.readFile ?? ((p) => Bun.file(p).text())
  const dir = cfg.tmpDir ?? tmpdir()

  const grade = async (predictionsPath: string, opts: GradeOptions): Promise<GradeOutcome> => {
    const lines = (await readFile(predictionsPath)).split("\n").filter((l) => l.trim() !== "")
    const k = Math.max(1, Math.min(Math.floor(cfg.shards), lines.length || 1))
    const buckets = shardLines(lines, k)

    // Single-shard fast path: no split files, straight passthrough.
    if (buckets.length <= 1) {
      return cfg.makeBackend(0).grade(predictionsPath, opts)
    }

    // Write shard prediction files + remember each shard's instance ids (for
    // attributing a rejected shard's instances to `errored`).
    const shardPaths: string[] = []
    const shardIds: string[][] = []
    for (let i = 0; i < buckets.length; i++) {
      const bucket = buckets[i] ?? []
      const path = join(dir, `${opts.runId}-shard-${i}.jsonl`)
      await writeFile(path, `${bucket.join("\n")}\n`)
      shardPaths.push(path)
      shardIds.push(bucket.map(instanceIdOf))
    }

    // Grade every shard CONCURRENTLY; never reject the whole run.
    const settled = await Promise.allSettled(
      shardPaths.map((path, i) =>
        cfg.makeBackend(i).grade(path, { ...opts, runId: `${opts.runId}-s${i}` }),
      ),
    )

    const resolved: string[] = []
    const unresolved: string[] = []
    const errored: string[] = []
    const emptyPatch: string[] = []
    // Carry each shard's error-log dir through the merge — else a K>1 sharded
    // grade (the cli DEFAULT path) silently drops the per-instance error logs the
    // shards DID fetch, defeating the observability feature exactly on the
    // multi-box runs it exists for. Shards share opts.outDir (so the dir is
    // usually identical); dedup, and join if a shard mkdtemp'd its own (no --out).
    const errorLogDirs: string[] = []
    settled.forEach((res, i) => {
      if (res.status === "fulfilled") {
        resolved.push(...res.value.resolved)
        unresolved.push(...res.value.unresolved)
        errored.push(...res.value.errored)
        emptyPatch.push(...res.value.emptyPatch)
        if (res.value.errorLogDir !== undefined) errorLogDirs.push(res.value.errorLogDir)
      } else {
        // Shard crashed ⇒ its instances are errored (re-runnable), not lost.
        errored.push(...(shardIds[i] ?? []))
      }
    })

    const dedup = (xs: string[]): string[] => [...new Set(xs)]
    const r = dedup(resolved)
    const u = dedup(unresolved)
    const e = dedup(errored).filter((id) => !r.includes(id) && !u.includes(id))
    const p = dedup(emptyPatch).filter(
      (id) => !r.includes(id) && !u.includes(id) && !e.includes(id),
    )

    const reportPath = join(dir, `${opts.runId}-merged.json`)
    await writeFile(reportPath, mergedReportJson(r, u, e, p))
    const mergedLogDirs = [...new Set(errorLogDirs)]
    const errorLogDir = mergedLogDirs.length === 0 ? undefined : mergedLogDirs.join(", ")
    return {
      reportPath,
      resolved: r,
      unresolved: u,
      errored: e,
      emptyPatch: p,
      ...(errorLogDir !== undefined ? { errorLogDir } : {}),
    }
  }

  return { name: `fanout:${cfg.shards}`, grade }
}
