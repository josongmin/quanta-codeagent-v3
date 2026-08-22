/** LSP server RSS watchdog — bound a Node language server's TOTAL resident
 *  memory so it can never OOM-kill the host.
 *
 *  WHY (jun-28 xarray box-OOM): the per-server `--max-old-space-size` cap
 *  (server-mem-budget) bounds only V8's OLD-SPACE heap. pyright analysing a
 *  dependency-heavy repo (xarray → numpy/pandas/dask/scipy source under
 *  `useLibraryCodeForTypes`) balloons memory OUTSIDE that heap — V8 external /
 *  ArrayBuffer / native — so RSS climbed to the full box and the kernel
 *  OOM-killer took the bench process (exit 137, NOT Node's own exit 247 heap
 *  OOM, which proves the overflow is off old-space). `--max-old-space-size`
 *  cannot see that memory; this watchdog can.
 *
 *  WHAT: poll the server PID's RSS; if it exceeds the budget, SIGKILL just that
 *  server. The pool catches the dead transport, the workspace degrades to
 *  no-LSP for that cwd (the agent still has grep/read/bash), and the BOX
 *  survives — exactly the "no host should be OOM-able by a language server"
 *  guarantee the heap cap aimed at but could not complete. pyright's warm-up
 *  indexing ramps over ~tens of seconds, so a sub-second poll catches the climb
 *  long before it reaches box RAM (no instantaneous multi-GB spike to miss).
 */

/** Default RSS budget (MB) per language server. Chosen to sit ABOVE what a
 *  healthy pyright uses on the largest repos that currently PASS (django /
 *  matplotlib / sklearn warm without OOM, well under this) and BELOW the point
 *  where two capped servers (PYRIGHT_MAX_LIVE_WORKSPACES) plus the bench process
 *  approach a 32GB box: 2 × 8GB + headroom < 32GB. Flat literal so the
 *  magic-number scan does not trip. */
export const DEFAULT_LSP_RSS_BUDGET_MB = 8_192

const POLL_INTERVAL_MS = 750

/** Resolve the per-server RSS budget (MB) from `QUANTA_LSP_RSS_BUDGET_MB`.
 *  - unset / empty / non-numeric ⇒ {@link DEFAULT_LSP_RSS_BUDGET_MB} (DEFAULT-ON,
 *    so the box-OOM is prevented without operator action).
 *  - `0` ⇒ `0` (explicit opt-out — no watchdog).
 *  - positive integer ⇒ that value. Negative ⇒ the safe default (never uncapped
 *    by accident). */
export function resolveLspRssBudgetMb(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = env.QUANTA_LSP_RSS_BUDGET_MB
  if (raw === undefined || raw.trim() === "") return DEFAULT_LSP_RSS_BUDGET_MB
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return DEFAULT_LSP_RSS_BUDGET_MB
  if (parsed === 0) return 0
  if (parsed < 0) return DEFAULT_LSP_RSS_BUDGET_MB
  return parsed
}

/** Reads a process's current RSS in MB, or null if it cannot be read (process
 *  gone / unsupported platform). MUST sum the whole process TREE: pyright is a
 *  Python launcher (`pyright-langserver`) that SPAWNS the real Node langserver
 *  as a CHILD (measured on the bench box: wrapper pid ~21MB stays flat while the
 *  node child balloons to box RAM). Watching only the root pid would never see
 *  the OOM. */
export type RssSamplerMb = (pid: number) => Promise<number | null>

interface PsRow {
  pid: number
  ppid: number
  rssKb: number
}

/** Parse `ps -eo pid=,ppid=,rss=` output. Skips malformed lines. Exported for
 *  the unit test of the tree-sum logic (no live `ps`). */
export function parsePsRows(psOutput: string): PsRow[] {
  const rows: PsRow[] = []
  for (const line of psOutput.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/)
    if (!m) continue
    rows.push({
      pid: Number.parseInt(m[1] as string, 10),
      ppid: Number.parseInt(m[2] as string, 10),
      rssKb: Number.parseInt(m[3] as string, 10),
    })
  }
  return rows
}

/** Sum RSS (KB) of `rootPid` plus ALL its descendants, or null if `rootPid` is
 *  absent from the snapshot (process gone). BFS over the ppid graph; a `seen`
 *  set guards against a cycle (PID reuse) so it always terminates. */
export function sumProcessTreeRssKb(rows: readonly PsRow[], rootPid: number): number | null {
  const byParent = new Map<number, PsRow[]>()
  const self = new Map<number, PsRow>()
  for (const r of rows) {
    self.set(r.pid, r)
    const list = byParent.get(r.ppid) ?? []
    list.push(r)
    byParent.set(r.ppid, list)
  }
  if (!self.has(rootPid)) return null
  let total = 0
  const seen = new Set<number>()
  const queue: number[] = [rootPid]
  while (queue.length > 0) {
    const pid = queue.shift() as number
    if (seen.has(pid)) continue
    seen.add(pid)
    const row = self.get(pid)
    if (row) total += row.rssKb
    for (const child of byParent.get(pid) ?? []) {
      if (!seen.has(child.pid)) queue.push(child.pid)
    }
  }
  return total
}

const readRssMbDefault: RssSamplerMb = async (pid: number): Promise<number | null> => {
  try {
    // One snapshot of every process, then sum the subtree rooted at `pid`. Tree
    // sum (not `/proc/<pid>/statm`) is REQUIRED: pyright's ballooning Node heap
    // lives in a CHILD of the spawned launcher. `ps -e` works on Linux + macOS.
    const proc = Bun.spawn(["ps", "-eo", "pid=,ppid=,rss="], {
      stdout: "pipe",
      stderr: "ignore",
    })
    const out = await new Response(proc.stdout).text()
    const rssKb = sumProcessTreeRssKb(parsePsRows(out), pid)
    if (rssKb === null) return null
    return rssKb / 1024
  } catch {
    // ps unavailable / process gone
  }
  return null
}

export interface LspRssWatchdogHandle {
  /** Stop polling (idempotent). Call on server exit/stop. */
  stop: () => void
}

/** Start an RSS watchdog over `pid`. When RSS first exceeds `budgetMb`, calls
 *  `onExceed(rssMb)` EXACTLY ONCE and stops polling (the caller kills the
 *  server). `budgetMb <= 0` ⇒ a no-op handle (watchdog disabled). The poll loop
 *  self-terminates when the sampler returns null (process gone). */
export function startLspRssWatchdog(opts: {
  pid: number
  budgetMb: number
  onExceed: (rssMb: number) => void
  intervalMs?: number
  sampler?: RssSamplerMb
}): LspRssWatchdogHandle {
  if (!Number.isFinite(opts.budgetMb) || opts.budgetMb <= 0) {
    return { stop: () => {} }
  }
  const sampler = opts.sampler ?? readRssMbDefault
  const intervalMs = opts.intervalMs ?? POLL_INTERVAL_MS
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const tick = async (): Promise<void> => {
    if (stopped) return
    const rss = await sampler(opts.pid)
    if (stopped) return
    if (rss === null) {
      // process gone — nothing left to guard
      stopped = true
      return
    }
    if (rss > opts.budgetMb) {
      stopped = true
      opts.onExceed(rss)
      return
    }
    timer = setTimeout(() => void tick(), intervalMs)
  }

  timer = setTimeout(() => void tick(), intervalMs)
  return {
    stop: () => {
      stopped = true
      if (timer) clearTimeout(timer)
    },
  }
}
