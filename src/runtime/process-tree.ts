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
 * ROOT-PID VALIDITY is enforced HERE, in the primitive — callers need no guard
 * of their own (they used to hand-roll one, and one of the four forgot). A
 * `rootPid` that is not a POSITIVE INTEGER is refused before the walk starts.
 * MEASURED, with the shipped `parsePsTable` against a live `ps -A -o pid=,ppid=`:
 * `signalTree(0)` reached **596 of 596 process-table rows** — pid 1 (launchd) and
 * the measuring process INCLUDED. Because the ppid-walk climbs to launchd, pid 0
 * is not merely "the caller's process group"; it enumerates the WHOLE process
 * table, and `safeSend` swallows every error, so the self-nuke would be SILENT.
 * Negative roots are the POSIX signal-a-process-GROUP form, which this ppid-walk
 * adapter was deliberately never designed to deliver (see the (A) fast-path note
 * below). Bun keeps `proc.pid` positive after exit (measured), so no live path is
 * known to reach 0 — this is DEFENCE IN DEPTH, not a patched live exploit.
 *
 * We ship ONLY the portable **ppid-walk** adapter (RFC §2.1 (B)): a
 * process-group/negative-pgid fast-path (A) is deliberately NOT shipped because
 * we cannot confirm Bun.spawn establishes group leadership (no `detached`
 * option exposed) — guessing at setsid/pgid semantics risks signalling the
 * WRONG group. The ppid-walk needs no new deps (`ps` exists on macOS + Linux),
 * is what Cursor's proclist does, and is race-minimised with two snapshots:
 * pre-root-signal catches existing children before a fast wrapper can exit and
 * reparent them; post-root-signal catches children that appeared just before the
 * root was stopped.
 *
 * KNOWN LIMITATION (honest — verified by a real-process repro): a child that
 * DOUBLE-FORKS / daemonizes (`( cmd & )`, `disown`, an explicit `setsid`) escapes.
 * It reparents to init (ppid=1) at startup — BEFORE the `ps` snapshot — so it is
 * no longer reachable from `rootPid` in the ppid graph, and root-first signalling
 * cannot help because the detach already happened. This is inherent to EVERY
 * ppid-walk teardown (Cursor's proclist has the same gap); only an OS process
 * group (a negative-pgid kill, requiring spawn-time group leadership Bun does not
 * expose, and `setsid` which is absent on macOS) would catch it. The COMMON
 * agent case — a build/test/dev-server tree `bash → node → workers` that stays in
 * the ppid graph — IS reaped; the deliberately-detaching case is not. Do NOT
 * describe this killer as "orphan-proof".
 */

import { errMessage, logger } from "@/shared"

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
 *  already-dead tree is a successful no-op. A `rootPid` that is not a POSITIVE
 *  INTEGER is refused (logged, not thrown) by the primitive itself, so no caller
 *  needs its own `pid > 0` guard. */
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
 *   1. Read the process table once BEFORE root signal. This catches wrapper
 *      children that would otherwise be reparented to init if the root exits
 *      immediately on SIGTERM.
 *   2. Signal the ROOT — stops new forks.
 *   3. Read the process table once AFTER root signal and signal the union of
 *      pre/post descendants (deepest-reachable included — this is the
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
    // Refuse a root that is not a positive integer BEFORE any enumeration or
    // signal. pid 0 would signal the entire process table (measured: 596/596
    // rows incl. launchd and self); a negative pid is the POSIX process-GROUP
    // form this adapter does not implement; NaN/±Infinity/fractional pids are
    // meaningless to `process.kill`. Refusal is REPORTED, never thrown, so the
    // no-throw teardown contract holds. Reporting goes through this module's
    // ordinary `logger.warn` channel — the same one as the neighbouring
    // `read_descendants_failed` warn — which is NOT unconditionally visible:
    // `writeStderr` is a no-op until the composition root installs a terminal-IO
    // sink, and repeated warns on one label are rate-limited. So treat this as
    // "diagnosable where logging is wired", not as a guaranteed alarm; the
    // load-bearing part is the REFUSAL itself, which is unconditional.
    if (!Number.isInteger(rootPid) || rootPid <= 0) {
      logger.warn("process-tree.invalid_root_pid", { rootPid, signal })
      return
    }

    const descendantsBefore = readDescendants(rootPid, readTable)

    // Root first among signals — stop new forks before signalling descendants.
    safeSend(rootPid, signal)

    const descendantsAfter = readDescendants(rootPid, readTable)

    // Signal every descendant seen in either snapshot. The pre-snapshot is what
    // prevents a fast-exiting wrapper from laundering its children to ppid=1
    // before we ever enumerate them.
    const seen = new Set<number>()
    for (const pid of [...descendantsBefore, ...descendantsAfter]) {
      if (seen.has(pid)) continue
      seen.add(pid)
      safeSend(pid, signal)
    }
  }

  return { signalTree }
}

const readDescendants = (rootPid: number, readTable: ProcessTableProvider): number[] => {
  try {
    return descendantsOf(rootPid, readTable())
  } catch (e) {
    // Best-effort: a process table that cannot be read leaves us with no
    // descendants to signal, but the failure must be visible (not masked as a
    // genuinely empty tree) so a stuck enumerator is diagnosable.
    logger.warn("process-tree.read_descendants_failed", { rootPid, cause: errMessage(e) })
    return []
  }
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
