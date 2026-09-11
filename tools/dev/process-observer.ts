/**
 * `tools/dev/process-observer` — the ONE bounded way this runner looks at the
 * process table.
 *
 * # Why a module for `ps`
 *
 * Three call sites used to shell out to `ps` independently, none of them with a
 * timeout, and one of them twice per sample:
 *
 *   - `shard-rss.sampleTreeRssBytes` — `ps -Ao pid=,ppid=` then `ps -o rss= -p …`
 *   - `test-shard-lifecycle.groupHasRunningMember` — `ps -Ao pgid=,stat=`
 *   - `test-shard-lifecycle.leaderIdentity` — `ps -o lstart=,comm= -p …`
 *
 * `Bun.spawnSync` with no `timeout` is an unbounded wait on a foreign binary
 * inside the synchronous JS event loop. A `ps` that wedges (a stuck NFS mount,
 * a paused container, a box at load 100) stops the watchdog interval, the
 * inactivity timer and the TERM→KILL deadline at the same instant — every
 * bound this runner has is downstream of the thing that hung.
 *
 * The drain poll made it quantitative: 60s SIGTERM grace + 10s SIGKILL grace at
 * a flat 50ms poll is up to ~1,400 `ps` processes for ONE group, on a host that
 * is by construction already in trouble.
 *
 * So: one snapshot shape, one explicitly-bounded spawn, one call counter, and
 * pure parse/consume functions that need no process tree to test.
 *
 * # Why this column order
 *
 * MEASURED on darwin 24.6
 * (`ps -Ao pid=,ppid=,pgid=,stat=,rss=,pcpu=,etime=,lstart=,comm=`):
 *
 *     1     0     1 Ss    16416   1.5 03:26:38 Fri Sep 11 23:13:04 2026  /sbin/launchd
 *
 * `lstart` is five whitespace-separated tokens ("Fri Sep 11 23:13:04 2026") and
 * `comm` is an absolute path that MAY contain spaces. Neither is fixed-width,
 * so the parse can only be unambiguous if every variable-width column is at a
 * known offset from one end: the seven scalars lead, `lstart` is exactly five
 * tokens, and `comm` is "whatever is left". Putting `comm` anywhere but last,
 * or `lstart` anywhere but immediately before it, makes the row unparseable.
 * (Measured field counts on this host: 689 rows at exactly 13 tokens, the rest
 * higher — only ever because `comm` itself contains spaces.)
 *
 * `pcpu`/`etime` are carried because the watchdog's one confirmed diagnosis —
 * a worker spinning at 100% CPU in `kevent64` while holding one `<defunct>`
 * child — was readable only from those two columns.
 */

export interface ProcessRow {
  readonly pid: number
  readonly ppid: number
  readonly pgid: number
  /** Kernel state letters, e.g. `S`, `R+`, `Z`, `?E`. */
  readonly stat: string
  readonly rssKib: number
  /** `pcpu`: percent CPU, as `ps` rendered it. */
  readonly pcpu: string
  /** `etime`: elapsed wall time, as `ps` rendered it. */
  readonly etime: string
  /** `lstart`, normalised to single spaces — the process's start instant. */
  readonly started: string
  readonly comm: string
}

/**
 * Why a snapshot could not be taken.
 *
 * `empty-output` is not paranoia: `ps -A` on a live host always lists at least
 * this process, so a zero-row success is a column-format change or a truncated
 * pipe, not an empty machine. Reporting it as `ok` with no rows would make
 * every group look drained and every tree look like it used 0 bytes — the one
 * direction in which a wrong answer blesses a campaign whose workers are still
 * running.
 */
export type SnapshotUnavailableReason = "timeout" | "spawn-error" | "nonzero-exit" | "empty-output"

export type ProcessSnapshot =
  | { readonly kind: "ok"; readonly rows: readonly ProcessRow[] }
  | {
      readonly kind: "unavailable"
      readonly reason: SnapshotUnavailableReason
      readonly detail: string
    }

/** One `ps` invocation feeds RSS sampling, drain checks and leader identity. */
export const PS_SNAPSHOT_ARGV: readonly string[] = [
  "ps",
  "-Ao",
  "pid=,ppid=,pgid=,stat=,rss=,pcpu=,etime=,lstart=,comm=",
]

/**
 * Argv for a TARGETED identity read: the pid we care about, plus our OWN pid as
 * a sentinel.
 *
 * Two reasons it is not just `ps -A`. First cost: MEASURED on this host, a full
 * table read is ~77ms of BLOCKED event loop against ~41ms for a targeted one,
 * and worker spawn pays it with no other consumer to share it with. Paying 77ms
 * there measurably widened a window in which a just-spawned campaign driver had
 * not yet installed its SIGTERM handler.
 *
 * Second, and more important, the sentinel: `ps -p <gone-pid>` exits 1 with
 * empty output, which is indistinguishable from `ps` itself failing — the exact
 * ambiguity that produced the fail-open this module removes. Asking for our own
 * pid in the same call disambiguates it by construction: our own row is present
 * IFF the probe actually ran.
 *
 * MEASURED: `-o pid=,lstart=,comm= -p X` and `-Ao …,lstart=,comm=` return
 * byte-identical lstart/comm for the same pid (launchd, this process, and a
 * detached bun child), so identities recorded through either form compare.
 */
export const identityArgv = (pid: number, sentinelPid: number): readonly string[] => [
  "ps",
  "-o",
  "pid=,lstart=,comm=",
  "-p",
  String(pid),
  "-p",
  String(sentinelPid),
]

/** Default bound on a single `ps`. Small: `ps -A` is tens of milliseconds. */
export const DEFAULT_SNAPSHOT_TIMEOUT_MS = 2_000

const LSTART_TOKENS = 5
const SCALAR_TOKENS = 7

const isClockToken = (token: string): boolean => /^\d{1,2}:\d{2}:\d{2}$/u.test(token)
const isYearToken = (token: string): boolean => /^\d{4}$/u.test(token)

/** A non-negative integer column, or `undefined` for anything else. */
const wholeNumber = (field: string | undefined, min: number): number | undefined => {
  const value = Number.parseInt(field ?? "", 10)
  return Number.isSafeInteger(value) && value >= min ? value : undefined
}

/** A column that must be present and non-empty (`stat`, `pcpu`, `etime`). */
const requiredWord = (field: string | undefined): string | undefined =>
  field === undefined || field === "" ? undefined : field

type ScalarColumns = Omit<ProcessRow, "started" | "comm">

/** The seven leading fixed-arity columns, all-or-nothing. */
const parseScalarColumns = (fields: readonly string[]): ScalarColumns | undefined => {
  const pid = wholeNumber(fields[0], 1)
  const ppid = wholeNumber(fields[1], 0)
  const pgid = wholeNumber(fields[2], 0)
  const stat = requiredWord(fields[3])
  const rssKib = wholeNumber(fields[4], 0)
  const pcpu = requiredWord(fields[5])
  const etime = requiredWord(fields[6])
  if (pid === undefined || ppid === undefined || pgid === undefined) return undefined
  if (stat === undefined || rssKib === undefined) return undefined
  if (pcpu === undefined || etime === undefined) return undefined
  return { pid, ppid, pgid, stat, rssKib, pcpu, etime }
}

/**
 * Parse ONE `ps` row, or reject it.
 *
 * A row that does not parse is missing data, never zero — `undefined` here is
 * dropped by the caller rather than contributing a 0 KiB / empty-state member.
 * The `lstart` shape check is what turns a silent column-order change into a
 * visibly empty snapshot (`empty-output`) instead of plausible garbage.
 */
export const parseProcessRow = (line: string): ProcessRow | undefined => {
  const fields = line.trim().split(/\s+/u)
  if (fields.length < SCALAR_TOKENS + LSTART_TOKENS) return undefined
  const scalars = parseScalarColumns(fields)
  if (scalars === undefined) return undefined
  const lstart = fields.slice(SCALAR_TOKENS, SCALAR_TOKENS + LSTART_TOKENS)
  if (!isClockToken(lstart[3] ?? "") || !isYearToken(lstart[4] ?? "")) return undefined
  return {
    ...scalars,
    started: lstart.join(" "),
    comm: fields.slice(SCALAR_TOKENS + LSTART_TOKENS).join(" "),
  }
}

export const parseProcessRows = (stdout: string): readonly ProcessRow[] => {
  const rows: ProcessRow[] = []
  for (const line of stdout.split("\n")) {
    const row = parseProcessRow(line)
    if (row !== undefined) rows.push(row)
  }
  return rows
}

/** What a bounded spawn can hand back. `error` is a spawn that never ran. */
export interface SpawnProbeResult {
  /** `null`/absent means the process never exited on its own — i.e. timeout. */
  readonly exitCode?: number | null | undefined
  readonly signalCode?: string | null | undefined
  readonly stdout?: string | undefined
  readonly stderr?: string | undefined
  /** Set when the spawn itself threw (no `ps` on PATH, EAGAIN, …). */
  readonly error?: unknown
}

const errorDetail = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * Turn a bounded spawn result into a snapshot.
 *
 * MEASURED (Bun 1.3.14, darwin): a `Bun.spawnSync` that hits its `timeout`
 * returns `exitCode: null` with `signalCode: "SIGTERM"`. That is the ONLY
 * signature distinguishing "we killed it for being slow" from "it failed", and
 * the two must not collapse: a timeout is the case this module exists for.
 */
export const snapshotFromSpawnResult = (result: SpawnProbeResult): ProcessSnapshot => {
  if (result.error !== undefined) {
    return { kind: "unavailable", reason: "spawn-error", detail: errorDetail(result.error) }
  }
  if (result.exitCode === null || result.exitCode === undefined) {
    return {
      kind: "unavailable",
      reason: "timeout",
      detail: `ps killed by ${result.signalCode ?? "unknown signal"} before exiting`,
    }
  }
  if (result.exitCode !== 0) {
    return {
      kind: "unavailable",
      reason: "nonzero-exit",
      detail: `ps exited ${result.exitCode}: ${(result.stderr ?? "").trim().slice(0, 200)}`,
    }
  }
  const rows = parseProcessRows(result.stdout ?? "")
  if (rows.length === 0) {
    return {
      kind: "unavailable",
      reason: "empty-output",
      detail: "ps exited 0 with no parseable rows (column format change or truncated output)",
    }
  }
  return { kind: "ok", rows }
}

/** One row of `ps -o pid=,lstart=,comm=`: pid, five lstart tokens, then comm. */
export const parseIdentityRow = (
  line: string,
): { readonly pid: number; readonly value: string } | undefined => {
  const fields = line.trim().split(/\s+/u)
  if (fields.length < 1 + LSTART_TOKENS) return undefined
  const pid = Number.parseInt(fields[0] ?? "", 10)
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined
  const lstart = fields.slice(1, 1 + LSTART_TOKENS)
  if (!isClockToken(lstart[3] ?? "") || !isYearToken(lstart[4] ?? "")) return undefined
  return { pid, value: `${lstart.join(" ")} ${fields.slice(1 + LSTART_TOKENS).join(" ")}` }
}

/**
 * Read a targeted identity probe, using the sentinel to tell "the pid is gone"
 * from "the probe did not run".
 *
 * The distinction IS the guard: `leader-exited` permits a kill, `unknown`
 * refuses one, and the old `string | undefined` return could not express the
 * difference.
 */
export const identityFromProbe = (
  result: SpawnProbeResult,
  pid: number,
  sentinelPid: number,
): LeaderIdentity => {
  if (result.error !== undefined) {
    return { kind: "unknown", reason: "spawn-error", detail: errorDetail(result.error) }
  }
  if (result.exitCode === null || result.exitCode === undefined) {
    return {
      kind: "unknown",
      reason: "timeout",
      detail: `ps killed by ${result.signalCode ?? "unknown signal"} before exiting`,
    }
  }
  if (result.exitCode !== 0) {
    return {
      kind: "unknown",
      reason: "nonzero-exit",
      detail: `ps exited ${result.exitCode}: ${(result.stderr ?? "").trim().slice(0, 200)}`,
    }
  }
  const rows = (result.stdout ?? "")
    .split("\n")
    .map(parseIdentityRow)
    .filter((row): row is { readonly pid: number; readonly value: string } => row !== undefined)
  if (!rows.some((row) => row.pid === sentinelPid)) {
    return {
      kind: "unknown",
      reason: "empty-output",
      detail: `ps exited 0 without listing its own caller (pid ${sentinelPid})`,
    }
  }
  const target = rows.find((row) => row.pid === pid)
  return target === undefined
    ? { kind: "leader-exited" }
    : { kind: "identity", value: target.value }
}

/**
 * A bounded view of the process table that counts how often it was consulted.
 *
 * The counter is not telemetry: the poll loops below are asserted against it,
 * so "we backed off" is a measured property of a test run rather than a claim
 * in a comment.
 */
export interface ProcessObserver {
  /** Whole-table read, shared by RSS sampling, drain checks and identity. */
  snapshot(): ProcessSnapshot
  /** Targeted, cheaper read for the one case with no other consumer. */
  identity(pid: number): LeaderIdentity
  readonly calls: number
}

export type SpawnProbe = (argv: readonly string[], timeoutMs: number) => SpawnProbeResult

const bunSpawnProbe: SpawnProbe = (argv, timeoutMs) => {
  try {
    const result = Bun.spawnSync(argv as string[], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: timeoutMs,
    })
    return {
      exitCode: result.exitCode,
      signalCode: result.signalCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    }
  } catch (error) {
    // `Bun.spawnSync` THROWS on ENOENT rather than returning a failed result,
    // so a box without `ps` on PATH must not take the whole runner down.
    return { error }
  }
}

export interface ProcessObserverOptions {
  readonly timeoutMs?: number
  readonly argv?: readonly string[]
  readonly spawn?: SpawnProbe
  /** Sentinel pid for identity probes; defaults to this process. */
  readonly sentinelPid?: number
}

export const createProcessObserver = (options: ProcessObserverOptions = {}): ProcessObserver => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SNAPSHOT_TIMEOUT_MS
  const argv = options.argv ?? PS_SNAPSHOT_ARGV
  const spawn = options.spawn ?? bunSpawnProbe
  const sentinelPid = options.sentinelPid ?? process.pid
  let calls = 0
  return {
    snapshot(): ProcessSnapshot {
      calls += 1
      return snapshotFromSpawnResult(spawn(argv, timeoutMs))
    },
    identity(pid: number): LeaderIdentity {
      calls += 1
      return identityFromProbe(spawn(identityArgv(pid, sentinelPid), timeoutMs), pid, sentinelPid)
    },
    get calls(): number {
      return calls
    },
  }
}

let shared: ProcessObserver | undefined

/** Process-wide observer, so the runner's whole `ps` budget is one number. */
export const defaultProcessObserver = (): ProcessObserver => {
  shared ??= createProcessObserver()
  return shared
}

/**
 * Hand back an already-taken snapshot ONCE, then fall through to `base`.
 *
 * This is how a caller that has just looked at the table (to check identity)
 * passes that same observation into a poll loop instead of spawning a second
 * `ps` to learn the same thing a millisecond later. `calls` still reads through
 * to `base`, because the seed was counted when it was taken.
 */
export const seededObserver = (base: ProcessObserver, seed: ProcessSnapshot): ProcessObserver => {
  let pending: ProcessSnapshot | undefined = seed
  return {
    snapshot(): ProcessSnapshot {
      if (pending === undefined) return base.snapshot()
      const first = pending
      pending = undefined
      return first
    },
    identity: (pid: number) => base.identity(pid),
    get calls(): number {
      return base.calls
    },
  }
}

// ---------------------------------------------------------------------------
// Pure consumers. Every one of these takes rows, so the arithmetic is testable
// without a process tree and every consumer can share ONE snapshot.
// ---------------------------------------------------------------------------

/**
 * Every descendant of `root`, breadth-first and bounded.
 *
 * Bounded because this runs inside a watchdog tick: a cyclic or self-parented
 * row (`ps` is not a consistent snapshot — rows are read as processes change)
 * must not be able to spin here.
 */
export const walkDescendants = (
  edges: readonly { readonly pid: number; readonly ppid: number }[],
  root: number,
  maxNodes = 512,
): readonly number[] => {
  const childrenOf = new Map<number, number[]>()
  for (const edge of edges) {
    const siblings = childrenOf.get(edge.ppid) ?? []
    siblings.push(edge.pid)
    childrenOf.set(edge.ppid, siblings)
  }
  const out: number[] = []
  const queue = [root]
  const seen = new Set<number>([root])
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

/** RSS of `root` plus every descendant, in KiB. Absent pids contribute nothing. */
export const treeRssKib = (rows: readonly ProcessRow[], root: number, maxNodes = 512): number => {
  const wanted = new Set<number>([root, ...walkDescendants(rows, root, maxNodes)])
  let total = 0
  for (const row of rows) {
    if (wanted.has(row.pid)) total += row.rssKib
  }
  return total
}

export const rowsInGroup = (rows: readonly ProcessRow[], pgid: number): readonly ProcessRow[] =>
  rows.filter((row) => row.pgid === pgid)

/**
 * A member is live unless the kernel has it in Z (zombie) or E (exiting).
 *
 * MEASURED on the first full-suite campaign that reached the end: counting
 * zombies as alive made the drain check report "survived SIGKILL" over four
 * `<defunct>` entries and refuse an otherwise green 45-minute run. A zombie is
 * a reaped-pending table entry — unkillable by definition, holding no fd, port
 * or working directory — so waiting for one is waiting forever.
 */
export const isRunningState = (stat: string): boolean =>
  !stat.startsWith("Z") && !stat.includes("E")

export const hasRunningMemberRows = (rows: readonly ProcessRow[], pgid: number): boolean =>
  rowsInGroup(rows, pgid).some((row) => isRunningState(row.stat))

/**
 * Identity of a process group's LEADER — and, crucially, whether we KNOW it.
 *
 * A pgid is a recycled pid. Between a group emptying and the registry noticing,
 * the OS can hand that pid to an unrelated process which then leads a group
 * with the same number; a campaign that kills by pgid alone would SIGKILL a
 * stranger's tree. A full suite spawns thousands of processes, so this is
 * narrow but not fanciful, and the blast radius is someone else's work.
 *
 * The old shape returned `string | undefined` and collapsed two opposite facts
 * into `undefined`: "the leader has exited" (SAFE to kill — anything left in
 * the group is our own descendant, and a recycled pid would itself be alive and
 * caught by the comparison) and "we could not look" (NOT safe — there is no
 * evidence at all). With `ps` unavailable the old code took the safe branch for
 * both, which turned the recycle guard entirely off exactly when the box was
 * sick enough to make recycling likely.
 */
export type LeaderIdentity =
  | { readonly kind: "identity"; readonly value: string }
  | { readonly kind: "leader-exited" }
  | {
      readonly kind: "unknown"
      readonly reason: SnapshotUnavailableReason
      readonly detail: string
    }

export const leaderIdentityFromSnapshot = (
  snapshot: ProcessSnapshot,
  pgid: number,
): LeaderIdentity => {
  if (snapshot.kind === "unavailable") {
    return { kind: "unknown", reason: snapshot.reason, detail: snapshot.detail }
  }
  const leader = snapshot.rows.find((row) => row.pid === pgid)
  if (leader === undefined) return { kind: "leader-exited" }
  return { kind: "identity", value: `${leader.started} ${leader.comm}` }
}

/** One `ps` row rendered the way a human reads a hung worker's group. */
export const renderProcessRow = (row: ProcessRow): string =>
  `${row.pgid} ${row.pid} ${row.ppid} ${row.stat} ${row.pcpu} ${row.etime} ${row.comm}`

// ---------------------------------------------------------------------------
// Poll backoff. Pure, so the snapshot budget of a long drain is an arithmetic
// fact a test can assert instead of a stopwatch measurement.
// ---------------------------------------------------------------------------

export interface PollSchedule {
  readonly initialMs: number
  readonly maxMs: number
  readonly factor: number
}

/**
 * 50ms → 3s geometric backoff.
 *
 * The first ticks stay cheap so a group that dies immediately (the normal case)
 * is still noticed in 50ms; the tail flattens so a 70-second survivor costs ~35
 * observations instead of ~1,400. `pollTickCount` below turns that into a
 * number a test pins.
 */
export const DEFAULT_POLL_SCHEDULE: PollSchedule = { initialMs: 50, maxMs: 3_000, factor: 2 }

/**
 * Build a schedule that cannot poll faster than it was asked to.
 *
 * The invariant `maxMs >= initialMs` was held by a `Math.max` REPEATED at each
 * of the two call sites, so a third caller inherited nothing. An inverted pair
 * does not error and does not slow down — `nextPollDelay` returns `maxMs` on
 * every attempt, so `{ initialMs: 3_000, maxPollMs: 50 }` reads as "poll
 * rarely" and executes as "poll 60x more often", spending the snapshot budget
 * this module exists to bound. A `factor` below 1 is the same defect in the
 * other term: delays shrink with each attempt instead of backing off.
 *
 * Clamped, not rejected, because the only caller is a process-group drain and
 * an exception there abandons the cleanup. The values that CANNOT be clamped
 * into a terminating loop do throw: a non-finite or non-positive `initialMs`
 * makes `pollTickCount` accumulate NaN and spin forever.
 */
export const pollSchedule = (overrides: Partial<PollSchedule> = {}): PollSchedule => {
  const initialMs = overrides.initialMs ?? DEFAULT_POLL_SCHEDULE.initialMs
  if (!Number.isFinite(initialMs) || initialMs <= 0) {
    throw new Error(`poll schedule: initialMs must be a positive finite number, got ${initialMs}`)
  }
  const requestedMax = overrides.maxMs ?? DEFAULT_POLL_SCHEDULE.maxMs
  const maxMs = Number.isFinite(requestedMax) ? Math.max(initialMs, requestedMax) : initialMs
  const requestedFactor = overrides.factor ?? DEFAULT_POLL_SCHEDULE.factor
  const factor = Number.isFinite(requestedFactor) ? Math.max(1, requestedFactor) : 1
  return { initialMs, maxMs, factor }
}

export const nextPollDelay = (attempt: number, schedule: PollSchedule): number => {
  const raw = schedule.initialMs * schedule.factor ** Math.max(0, attempt)
  return Math.max(1, Math.round(Math.min(schedule.maxMs, raw)))
}

/**
 * How many observations a wait of `windowMs` costs under this schedule.
 *
 * This is the same arithmetic the real loop performs, so an assertion on it is
 * an assertion on the loop — and `pollTickCount` growing is how a future "just
 * poll a bit faster" edit gets caught.
 */
export const pollTickCount = (windowMs: number, schedule: PollSchedule): number => {
  let elapsed = 0
  let ticks = 0
  while (elapsed < windowMs) {
    ticks += 1
    elapsed += nextPollDelay(ticks - 1, schedule)
  }
  return ticks
}
