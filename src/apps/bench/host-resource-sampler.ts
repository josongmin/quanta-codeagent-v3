/** Host resource sampler — periodic memory + process-count telemetry so a
 *  runaway (fork-storm / OOM climb) surfaces in the run log AS IT HAPPENS,
 *  instead of being reverse-engineered from a dead box across many probe runs.
 *
 *  WHY (jun-28): a pydata/xarray bench box was OOM-killed (exit 137, no verdict)
 *  by ~4700 leaked `uv` processes (~6MB anon each ⇒ ~30GB AnonPages). The death
 *  was invisible in the run log — it took five instrumented boxes to learn the
 *  victim was "process count", not any single RSS. With this sampler the run log
 *  would have carried `[resource] WARN procs=2100 top=2000x uv free=200MB` on the
 *  first run. Linux-only (reads /proc); a no-op where /proc is absent (macOS CLI).
 */

export interface MemInfoMb {
  totalMb: number
  freeMb: number
  availableMb: number
  anonMb: number
  shmemMb: number
}

/** Parse `/proc/meminfo` (KB values) into MB. Missing fields → 0. */
export function parseMemInfoMb(text: string): MemInfoMb {
  const get = (key: string): number => {
    const m = text.match(new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, "m"))
    return m ? Math.round(Number.parseInt(m[1] as string, 10) / 1024) : 0
  }
  return {
    totalMb: get("MemTotal"),
    freeMb: get("MemFree"),
    availableMb: get("MemAvailable"),
    anonMb: get("AnonPages"),
    shmemMb: get("Shmem"),
  }
}

export interface ProcSummary {
  nproc: number
  /** Most frequent process names, descending — the fork-storm culprit is #1. */
  top: ReadonlyArray<{ name: string; count: number }>
}

/** Tally process command names into a count-descending summary. */
export function summarizeProcNames(names: readonly string[], topN = 4): ProcSummary {
  const counts = new Map<string, number>()
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1)
  const top = [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, topN)
  return { nproc: names.length, top }
}

export interface ResourceSnapshot {
  mem: MemInfoMb
  procs: ProcSummary
}

export interface ResourceThresholds {
  /** WARN when process count exceeds this. Normal bench runs sit in the low
   *  hundreds; a fork-storm blows past 1000. */
  nprocWarn: number
  /** WARN when available memory drops below this (MB). */
  availMbWarn: number
}

export const DEFAULT_RESOURCE_THRESHOLDS: ResourceThresholds = {
  nprocWarn: 1_000,
  availMbWarn: 1_024,
}

/** Returns a WARN reason string if any threshold is breached, else null. The
 *  message names the dominant process (the fork-storm culprit) so the root is
 *  self-evident in the log. */
export function evaluateResourceAlert(
  snap: ResourceSnapshot,
  t: ResourceThresholds = DEFAULT_RESOURCE_THRESHOLDS,
): string | null {
  const reasons: string[] = []
  if (snap.procs.nproc > t.nprocWarn) reasons.push(`procs=${snap.procs.nproc}>${t.nprocWarn}`)
  if (snap.mem.availableMb < t.availMbWarn) {
    reasons.push(`availMb=${snap.mem.availableMb}<${t.availMbWarn}`)
  }
  if (reasons.length === 0) return null
  const top = snap.procs.top.map((p) => `${p.count}x ${p.name}`).join(", ")
  return `${reasons.join(" ")} | top: ${top} | anon=${snap.mem.anonMb}MB shmem=${snap.mem.shmemMb}MB`
}

/** Read a one-shot host snapshot from /proc, or null if /proc is unavailable
 *  (non-Linux). Reads each pid's `comm`; an unreadable pid (exited mid-scan) is
 *  skipped. */
export async function readHostSnapshot(): Promise<ResourceSnapshot | null> {
  let meminfo: string
  try {
    meminfo = await Bun.file("/proc/meminfo").text()
  } catch {
    return null // no procfs ⇒ not Linux ⇒ sampler is a no-op
  }
  const mem = parseMemInfoMb(meminfo)
  const names: string[] = []
  try {
    const { readdir } = await import("node:fs/promises")
    const entries = await readdir("/proc")
    for (const e of entries) {
      if (!/^\d+$/.test(e)) continue
      try {
        const comm = (await Bun.file(`/proc/${e}/comm`).text()).trim()
        if (comm.length > 0) names.push(comm)
      } catch {
        // pid exited between readdir and read — skip
      }
    }
  } catch {
    // /proc unreadable — fall back to mem-only snapshot
  }
  return { mem, procs: summarizeProcNames(names) }
}

export interface HostResourceSamplerHandle {
  stop: () => void
}

/** Start a periodic sampler. Each tick logs an info line; a threshold breach
 *  logs a WARN whose message names the dominant process. No-op (returns an
 *  inert handle) where /proc is absent. `nowMs`/`sampler` are injectable for
 *  tests. */
export function startHostResourceSampler(opts: {
  intervalMs: number
  log: (level: "info" | "warn", msg: string) => void
  thresholds?: ResourceThresholds
  sampler?: () => Promise<ResourceSnapshot | null>
}): HostResourceSamplerHandle {
  const sampler = opts.sampler ?? readHostSnapshot
  const thresholds = opts.thresholds ?? DEFAULT_RESOURCE_THRESHOLDS
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const tick = async (): Promise<void> => {
    if (stopped) return
    let snap: ResourceSnapshot | null = null
    try {
      snap = await sampler()
    } catch {
      snap = null
    }
    if (stopped) return
    if (snap === null) {
      stopped = true // non-Linux / unreadable — stop quietly, no busy loop
      return
    }
    const top = snap.procs.top.map((p) => `${p.count}x ${p.name}`).join(", ")
    const line =
      `[resource] procs=${snap.procs.nproc} availMb=${snap.mem.availableMb} ` +
      `freeMb=${snap.mem.freeMb} anonMb=${snap.mem.anonMb} | top: ${top}`
    const alert = evaluateResourceAlert(snap, thresholds)
    if (alert) opts.log("warn", `[resource] WARN ${alert}`)
    else opts.log("info", line)
    timer = setTimeout(() => void tick(), opts.intervalMs)
  }

  timer = setTimeout(() => void tick(), opts.intervalMs)
  return {
    stop: () => {
      stopped = true
      if (timer) clearTimeout(timer)
    },
  }
}
