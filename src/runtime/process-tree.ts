/**
 * D1 — `ProcessTreeKiller` (jun-7-naive-impl-hardening §2.1).
 *
 * WHY THIS EXISTS — every spawn site (`shell.ts`, `bash-bg-registry.ts`,
 * `pty-backend.ts`) drives a `bash -lc "<cmd>"` whose `<cmd>` typically forks
 * a real tree: `bash → node → vite-worker`. The legacy `proc.kill()` sends a
 * single SIGTERM to the DIRECT child PID (bash) only; the grandchildren are
 * reparented to init and LEAK (held ports, CPU, file locks). Codex uses a
 * `ProcessGroup` and Cursor a native proclist; here we extract the
 * process-enumeration + tree-signal EFFECT behind a closed port so the slice
 * stays fence-clean and the spawn sites all share ONE owner of tree lifetime.
 *
 * NO-THROW + IDEMPOTENT contract: `signalTree` is a best-effort teardown that
 * NEVER throws into a caller (an already-dead pid is fine), so it can be wired
 * straight into `escalatingKill`'s kill/grace closures without a guard.
 *
 * We ship ONLY the portable **ppid-walk** adapter (RFC §2.1 (B)): a
 * process-group/negative-pgid fast-path (A) is deliberately NOT shipped because
 * we cannot confirm Bun.spawn establishes group leadership (no `detached`
 * option exposed) — guessing at setsid/pgid semantics risks signalling the
 * WRONG group. The ppid-walk needs no new deps (`ps` exists on macOS + Linux),
 * is what Cursor's proclist does, and is race-minimised by signalling the root
 * FIRST (stops new forks before we enumerate the rest of the tree).
 */

export type TreeSignal = "SIGTERM" | "SIGKILL"

/** A single row of the OS process table: a pid and its parent pid. */
export interface ProcessRow {
  readonly pid: number
  readonly ppid: number
}

/** Closed port — enumerate the whole OS process table ONCE. The default
 *  adapter shells out to `ps -A -o pid=,ppid=`; tests inject a deterministic
 *  table (NO real `ps` in unit tests). MAY throw (e.g. `ps` missing); the
 *  killer degrades to signalling the root only in that case. */
export type ProcessTableProvider = () => readonly ProcessRow[]

/** Closed port — deliver one OS signal to one pid. The default adapter wraps
 *  `process.kill`; tests record the calls. MAY throw on an already-dead pid;
 *  the killer swallows it (no-throw contract). */
export type SignalSender = (pid: number, signal: TreeSignal) => void

/** Kill a process AND all of its descendants. Idempotent + no-throw — an
 *  already-dead tree is a successful no-op. */
export interface ProcessTreeKiller {
  signalTree(rootPid: number, signal: TreeSignal): void
}

/** Effects the ppid-walk adapter needs, both injected so the adapter is a pure
 *  testable unit (the only real-world effects are the `ps` exec + `process.kill`,
 *  supplied by {@link defaultPpidWalkKiller}). */
export interface PpidWalkDeps {
  readonly readTable: ProcessTableProvider
  readonly sendSignal: SignalSender
}

/**
 * Build the portable ppid-walk tree killer.
 *
 * Algorithm (race-minimised):
 *   1. Signal the ROOT first — a SIGTERM to the parent stops it spawning NEW
 *      children before we enumerate, shrinking the enumerate→kill race window.
 *   2. Read the process table ONCE and BFS the descendant graph from the root.
 *   3. Signal each descendant (deepest-reachable included — this is the
 *      grandchild the legacy single-PID kill leaked).
 *
 * Every `sendSignal` is wrapped so an already-dead pid (ESRCH) does not abort
 * the walk; a `readTable` failure degrades to "root only" (still better than
 * nothing). The whole method is no-throw.
 */
export const createPpidWalkKiller = (deps: PpidWalkDeps): ProcessTreeKiller => {
  const { readTable, sendSignal } = deps

  const safeSend = (pid: number, signal: TreeSignal): void => {
    try {
      sendSignal(pid, signal)
    } catch {
      // already-dead pid / EPERM — best-effort teardown, never throw.
    }
  }

  const signalTree = (rootPid: number, signal: TreeSignal): void => {
    // 1) Root first — stop new forks before enumerating the rest of the tree.
    safeSend(rootPid, signal)

    // 2) Enumerate once. If `ps` is unavailable we degrade to root-only.
    let rows: readonly ProcessRow[]
    try {
      rows = readTable()
    } catch {
      return
    }

    // 3) Signal every descendant (BFS over the ppid graph) — the grandchild the
    // legacy single-PID kill leaked. Pure traversal extracted below.
    for (const pid of descendantsOf(rootPid, rows)) {
      safeSend(pid, signal)
    }
  }

  return { signalTree }
}

/** BFS the ppid-graph for every descendant of `rootPid` (root EXCLUDED — it is
 *  signalled first by the caller). Self-parent rows (`pid === ppid`) are skipped
 *  and a `seen` set guards against a malformed cyclic table. Pure. */
const descendantsOf = (rootPid: number, rows: readonly ProcessRow[]): number[] => {
  // pid → children adjacency.
  const childrenOf = new Map<number, number[]>()
  for (const row of rows) {
    if (row.ppid === row.pid) continue
    const bucket = childrenOf.get(row.ppid)
    if (bucket === undefined) childrenOf.set(row.ppid, [row.pid])
    else bucket.push(row.pid)
  }

  const out: number[] = []
  const seen = new Set<number>([rootPid])
  const queue: number[] = [rootPid]
  while (queue.length > 0) {
    const current = queue.shift() as number
    const kids = childrenOf.get(current)
    if (kids === undefined) continue
    for (const kid of kids) {
      if (seen.has(kid)) continue
      seen.add(kid)
      out.push(kid)
      queue.push(kid)
    }
  }
  return out
}

/** Parse `ps -A -o pid=,ppid=` output. Each non-empty line is two integers
 *  separated by whitespace (`ps` right-pads the columns). Malformed lines are
 *  skipped. Pure — exported for the drift-guard / portability test. */
export const parsePsTable = (raw: string): ProcessRow[] => {
  const rows: ProcessRow[] = []
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (trimmed === "") continue
    const parts = trimmed.split(/\s+/)
    if (parts.length < 2) continue
    const pid = Number.parseInt(parts[0] as string, 10)
    const ppid = Number.parseInt(parts[1] as string, 10)
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue
    rows.push({ pid, ppid })
  }
  return rows
}

/**
 * Default production killer — the ONLY effectful adapter. `readTable` execs
 * `ps -A -o pid=,ppid=` synchronously (portable on macOS + Linux, no new dep)
 * and `sendSignal` wraps `process.kill`. Built lazily by the composition root
 * (`shell.ts`, `bash-bg-registry.ts`) and injected into `escalatingKill`.
 *
 * `process.kill(pid, signal)` does NOT kill — it delivers the signal; the name
 * is a POSIX historical artifact. We pass the signal-NAME string, which Node
 * maps to the numeric signal.
 */
export const defaultPpidWalkKiller = (): ProcessTreeKiller =>
  createPpidWalkKiller({
    readTable: () => {
      // `ps -A -o pid=,ppid=` — `-A` = all processes, `=` suffix suppresses the
      // column headers, giving plain `<pid> <ppid>` lines on both macOS + Linux.
      const out = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid="])
      if (!out.success) return []
      return parsePsTable(out.stdout.toString())
    },
    sendSignal: (pid, signal) => {
      // process.kill delivers `signal` to `pid`; throws ESRCH for a dead pid,
      // which the killer's safeSend swallows.
      process.kill(pid, signal)
    },
  })
