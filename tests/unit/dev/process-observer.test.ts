/**
 * ★ The `ps` adapter the shard runner's every bound depends on.
 *
 * MEASURED DEFECT (2026-09-12): three call sites ran `Bun.spawnSync(["ps", …])`
 * with NO `timeout`, one of them twice per RSS sample. A synchronous spawn with
 * no timeout is an unbounded wait inside the JS event loop, so a `ps` that
 * wedges freezes the inactivity watchdog and the TERM→KILL deadline at the same
 * instant — every bound the runner has is downstream of the thing that hung.
 *
 * And `leaderIdentity` returned `string | undefined`, collapsing "the leader
 * exited" (safe to kill) with "we could not look" (no evidence at all). The
 * pid-recycle guard was therefore fully OFF whenever `ps` was unavailable —
 * exactly on the boxes sick enough to make pid recycling plausible.
 *
 * Everything below is either pure (no process tree needed) or a wiring proof
 * that the real argv and the real timeout behave as the pure code assumes.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  createProcessObserver,
  DEFAULT_POLL_SCHEDULE,
  hasRunningMemberRows,
  identityArgv,
  identityFromProbe,
  leaderIdentityFromSnapshot,
  nextPollDelay,
  type ProcessRow,
  type ProcessSnapshot,
  PS_SNAPSHOT_ARGV,
  parseIdentityRow,
  parseProcessRow,
  parseProcessRows,
  pollSchedule,
  pollTickCount,
  renderProcessRow,
  rowsInGroup,
  seededObserver,
  snapshotFromSpawnResult,
  treeRssKib,
  walkDescendants,
} from "../../../tools/dev/process-observer"

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..")

/** Verbatim rows from `ps -Ao pid=,ppid=,pgid=,stat=,rss=,pcpu=,etime=,lstart=,comm=`. */
const REAL_ROWS = [
  "    1     0     1 Ss    16416   1.5 03:26:38 Fri Sep 11 23:13:04 2026 /sbin/launchd",
  "  280     1   280 Ss     2576   0.0 01:15:36 Sat Sep 12 01:24:06 2026 /System/Library/CoreServices/diagnosticservicesd",
  "  318     1   318 Ss    32608   3.4 03:25:33 Fri Sep 11 23:14:09 2026 /usr/libexec/logd",
].join("\n")

const row = (over: Partial<ProcessRow> & Pick<ProcessRow, "pid">): ProcessRow => ({
  ppid: 1,
  pgid: over.pid,
  stat: "S",
  rssKib: 0,
  pcpu: "0.0",
  etime: "01:00",
  started: "Fri Sep 11 23:13:04 2026",
  comm: "/bin/sleep",
  ...over,
})

describe("process-observer — parsing one bounded `ps` snapshot", () => {
  test("a real darwin row parses into every column", () => {
    expect(parseProcessRow(REAL_ROWS.split("\n")[0] ?? "")).toEqual({
      pid: 1,
      ppid: 0,
      pgid: 1,
      stat: "Ss",
      rssKib: 16416,
      pcpu: "1.5",
      etime: "03:26:38",
      started: "Fri Sep 11 23:13:04 2026",
      comm: "/sbin/launchd",
    })
  })

  test("`comm` may contain spaces and still parses — it is the LAST column for that reason", () => {
    const line =
      "  900   1   900 S     4096   0.0 00:10 Fri Sep 11 23:13:04 2026 /Applications/Some App.app/Contents/MacOS/Some App"
    expect(parseProcessRow(line)?.comm).toBe("/Applications/Some App.app/Contents/MacOS/Some App")
    expect(parseProcessRow(line)?.pid).toBe(900)
  })

  test("a single-digit day still yields exactly five lstart tokens", () => {
    // `ps` pads the day, and the split collapses runs of whitespace, so the
    // column count is stable across the month.
    const line = "  901   1   901 S     2048   0.0 00:10 Fri Sep  1 23:13:04 2026 /bin/zsh"
    expect(parseProcessRow(line)?.started).toBe("Fri Sep 1 23:13:04 2026")
  })

  test("malformed rows are SKIPPED, never counted as zero", () => {
    const rows = parseProcessRows(
      [
        "PID  PPID PGID STAT   RSS %CPU ELAPSED STARTED COMMAND", // a header
        "ps: some warning about a vanished pid",
        REAL_ROWS.split("\n")[0] ?? "",
        "  -5    1     1 S     1024   0.0 00:10 Fri Sep 11 23:13:04 2026 /bin/bogus", // absurd pid
        "",
        REAL_ROWS.split("\n")[2] ?? "",
      ].join("\n"),
    )
    expect(rows.map((r) => r.pid)).toEqual([1, 318])
    // PAIRED CONTROL — a skipped row contributes nothing, and the survivors
    // keep their real values rather than being flattened to 0.
    expect(rows.map((r) => r.rssKib)).toEqual([16416, 32608])
  })

  test("a column-order change makes rows unparseable rather than plausible", () => {
    // Swap lstart and comm — every field would still "parse" as strings if the
    // shape were not checked, and the runner would silently read garbage.
    const drifted =
      "    1     0     1 Ss    16416   1.5 03:26:38 /sbin/launchd Fri Sep 11 23:13:04 2026"
    expect(parseProcessRow(drifted)).toBeUndefined()
  })
})

describe("process-observer — a snapshot that did not happen says so", () => {
  test("a spawn killed by its own timeout is `timeout`, not a failure or a success", () => {
    // MEASURED (Bun 1.3.14, darwin): `Bun.spawnSync` hitting `timeout` returns
    // exitCode null + signalCode SIGTERM. This is the case the module exists
    // for, so it must not collapse into "nonzero exit".
    expect(snapshotFromSpawnResult({ exitCode: null, signalCode: "SIGTERM", stdout: "" })).toEqual({
      kind: "unavailable",
      reason: "timeout",
      detail: "ps killed by SIGTERM before exiting",
    })
  })

  test("a spawn that threw is `spawn-error`", () => {
    const snapshot = snapshotFromSpawnResult({ error: new Error("ENOENT: ps") })
    expect(snapshot.kind).toBe("unavailable")
    expect(snapshot.kind === "unavailable" && snapshot.reason).toBe("spawn-error")
  })

  test("a nonzero exit is `nonzero-exit` and carries stderr", () => {
    const snapshot = snapshotFromSpawnResult({ exitCode: 127, stdout: "", stderr: "ps: not found" })
    expect(snapshot.kind === "unavailable" && snapshot.reason).toBe("nonzero-exit")
    expect(snapshot.kind === "unavailable" && snapshot.detail).toContain("ps: not found")
  })

  test("exit 0 with no parseable rows is UNAVAILABLE, not an empty machine", () => {
    // The fail-open this closes: `ok` with zero rows makes every process group
    // look drained and every worker tree look like it uses 0 bytes.
    expect(snapshotFromSpawnResult({ exitCode: 0, stdout: "" })).toEqual({
      kind: "unavailable",
      reason: "empty-output",
      detail: "ps exited 0 with no parseable rows (column format change or truncated output)",
    })
  })

  test("exit 0 with rows is the only `ok`", () => {
    const snapshot = snapshotFromSpawnResult({ exitCode: 0, stdout: REAL_ROWS })
    expect(snapshot.kind).toBe("ok")
    expect(snapshot.kind === "ok" && snapshot.rows).toHaveLength(3)
  })
})

describe("process-observer — pure consumers share ONE snapshot", () => {
  const tree = [
    row({ pid: 100, ppid: 1, pgid: 100, rssKib: 1024 }),
    row({ pid: 101, ppid: 100, pgid: 100, rssKib: 2048 }),
    row({ pid: 102, ppid: 100, pgid: 100, rssKib: 512 }),
    row({ pid: 103, ppid: 101, pgid: 100, rssKib: 256 }),
    row({ pid: 200, ppid: 1, pgid: 200, rssKib: 999_999 }),
  ]

  test("RSS sums the whole tree — the 7x undercount this replaced", () => {
    expect(treeRssKib(tree, 100)).toBe(1024 + 2048 + 512 + 256)
  })

  test("PAIRED CONTROL — an unrelated tree is not swept in", () => {
    expect(treeRssKib(tree, 200)).toBe(999_999)
    expect(walkDescendants(tree, 200)).toEqual([])
  })

  test("the descendant walk finds children and grandchildren", () => {
    expect([...walkDescendants(tree, 100)].sort((a, b) => a - b)).toEqual([101, 102, 103])
  })

  test("a cyclic or self-parented row cannot hang the watchdog", () => {
    const cyclic = [row({ pid: 100, ppid: 101 }), row({ pid: 101, ppid: 100 })]
    expect(walkDescendants(cyclic, 100)).toEqual([101])
  })

  test("the walk is bounded by maxNodes", () => {
    const chain = Array.from({ length: 50 }, (_, i) => row({ pid: 100 + i + 1, ppid: 100 + i }))
    expect(walkDescendants(chain, 100, 7)).toHaveLength(7)
  })

  test("pgid membership selects only that group", () => {
    expect(rowsInGroup(tree, 100).map((r) => r.pid)).toEqual([100, 101, 102, 103])
    expect(rowsInGroup(tree, 999)).toEqual([])
  })

  test("zombies and exiting members are not RUNNING; live states are", () => {
    // MEASURED: counting zombies as alive made the drain check report
    // "survived SIGKILL" over four `<defunct>` entries and refuse an otherwise
    // green 45-minute campaign.
    const dying = [
      row({ pid: 71030, pgid: 71030, stat: "Z" }),
      row({ pid: 71031, pgid: 71030, stat: "?E" }),
      row({ pid: 99999, pgid: 99999, stat: "S" }), // another group — must not leak in
    ]
    expect(hasRunningMemberRows(dying, 71030)).toBe(false)
    expect(
      hasRunningMemberRows([...dying, row({ pid: 71032, pgid: 71030, stat: "S" })], 71030),
    ).toBe(true)
    for (const stat of ["S", "R", "S+", "SN", "U", "Ss"]) {
      expect(hasRunningMemberRows([row({ pid: 5, pgid: 5, stat })], 5), stat).toBe(true)
    }
    // An empty group is drained.
    expect(hasRunningMemberRows(dying, 12345)).toBe(false)
  })

  test("the rendered row carries the two facts that diagnosed the one real hang", () => {
    // 100% CPU in the event loop while holding a `<defunct>` child.
    const rendered = renderProcessRow(
      row({
        pid: 4310,
        ppid: 4242,
        pgid: 4242,
        stat: "Z",
        pcpu: "99.7",
        etime: "11:37",
        comm: "(bun)",
      }),
    )
    expect(rendered).toBe("4242 4310 4242 Z 99.7 11:37 (bun)")
  })
})

describe("process-observer — leader identity distinguishes 'gone' from 'unknown'", () => {
  const alive: ProcessSnapshot = {
    kind: "ok",
    rows: [row({ pid: 4242, pgid: 4242, comm: "/usr/local/bin/bun" })],
  }

  test("a live leader yields an identity of start-instant + command", () => {
    expect(leaderIdentityFromSnapshot(alive, 4242)).toEqual({
      kind: "identity",
      value: "Fri Sep 11 23:13:04 2026 /usr/local/bin/bun",
    })
  })

  test("an observed table with no leader row is `leader-exited` — SAFE to kill", () => {
    expect(leaderIdentityFromSnapshot(alive, 9999)).toEqual({ kind: "leader-exited" })
  })

  test("★ an unavailable table is `unknown`, NEVER `leader-exited`", () => {
    // This is the whole defect. The old code returned `undefined` for both and
    // the caller read `undefined` as "safe to kill".
    const unknown = leaderIdentityFromSnapshot(
      { kind: "unavailable", reason: "timeout", detail: "ps never returned" },
      4242,
    )
    expect(unknown).toEqual({ kind: "unknown", reason: "timeout", detail: "ps never returned" })
    expect(unknown.kind).not.toBe("leader-exited")
  })
})

describe("process-observer — one observation, many consumers", () => {
  test("a seeded observer spends the snapshot in hand before spawning again", () => {
    let spawned = 0
    const base = createProcessObserver({
      spawn: () => {
        spawned += 1
        return { exitCode: 0, stdout: REAL_ROWS }
      },
    })
    const seed = base.snapshot() // 1 spawn
    const seeded = seededObserver(base, seed)
    expect(seeded.snapshot()).toBe(seed)
    expect(spawned).toBe(1) // the seed was reused, not re-taken
    seeded.snapshot()
    expect(spawned).toBe(2) // and the seam falls through afterwards
    expect(seeded.calls).toBe(base.calls)
  })

  test("the observer counts every call it makes", () => {
    const observer = createProcessObserver({ spawn: () => ({ exitCode: 0, stdout: REAL_ROWS }) })
    expect(observer.calls).toBe(0)
    observer.snapshot()
    observer.snapshot()
    expect(observer.calls).toBe(2)
  })
})

describe("process-observer — poll backoff is arithmetic, not a stopwatch", () => {
  test("delays grow geometrically and clamp at the ceiling", () => {
    const delays = [0, 1, 2, 3, 4, 5, 6, 7, 20].map((n) => nextPollDelay(n, DEFAULT_POLL_SCHEDULE))
    expect(delays).toEqual([50, 100, 200, 400, 800, 1600, 3000, 3000, 3000])
  })

  test("★ a 70-second wait costs ~34 observations, where a flat 50ms poll cost 1,400", () => {
    const term = pollTickCount(60_000, DEFAULT_POLL_SCHEDULE)
    const kill = pollTickCount(10_000, DEFAULT_POLL_SCHEDULE)
    expect(term).toBe(25)
    expect(kill).toBe(9)
    // The number the ticket names: 60s TERM + 10s KILL at 50ms.
    expect(70_000 / DEFAULT_POLL_SCHEDULE.initialMs).toBe(1_400)
    expect(term + kill).toBeLessThan(40)
    // ANTI-VACUUM FLOOR — a schedule that never polls would also be "under 40".
    expect(term).toBeGreaterThan(5)
  })

  test("a short wait still polls promptly — backoff must not blunt the fast case", () => {
    // A worker that dies immediately is the normal case; it is noticed in 50ms.
    expect(pollTickCount(50, DEFAULT_POLL_SCHEDULE)).toBe(1)
    expect(nextPollDelay(0, DEFAULT_POLL_SCHEDULE)).toBe(50)
  })
})

describe("process-observer — WIRING: the real argv and the real timeout", () => {
  test("the committed `ps` argv runs on this host and lists this process", async () => {
    // Without this the whole file could pass against a column layout `ps` never
    // produces. ANTI-VACUUM FLOOR: a real host has many processes.
    const observer = createProcessObserver()
    const snapshot = observer.snapshot()
    expect(PS_SNAPSHOT_ARGV[0]).toBe("ps")
    expect(snapshot.kind).toBe("ok")
    if (snapshot.kind !== "ok") return
    expect(snapshot.rows.length).toBeGreaterThan(20)
    const self = snapshot.rows.find((r) => r.pid === process.pid)
    expect(self).toBeDefined()
    expect(self?.rssKib).toBeGreaterThan(0)
    expect(self?.started).toMatch(/^\w{3} \w{3} \d{1,2} \d{1,2}:\d{2}:\d{2} \d{4}$/u)
    await Promise.resolve()
  })

  test("★ a `ps` that never returns is bounded by the observer, not by the caller", async () => {
    // The defect, executed: substitute a binary that never exits for `ps`. The
    // OLD code had no `timeout` here, so this call would block for 30 seconds
    // with the event loop — watchdog, inactivity timer and TERM→KILL deadline
    // — frozen behind it.
    const observer = createProcessObserver({ argv: ["sleep", "30"], timeoutMs: 400 })
    const startedAt = Date.now()
    const snapshot = observer.snapshot()
    const elapsedMs = Date.now() - startedAt
    expect(snapshot.kind).toBe("unavailable")
    expect(snapshot.kind === "unavailable" && snapshot.reason).toBe("timeout")
    expect(elapsedMs).toBeLessThan(5_000)
    // ANTI-VACUUM FLOOR — it really did wait for the timeout rather than
    // failing instantly for some unrelated reason.
    expect(elapsedMs).toBeGreaterThanOrEqual(300)
    await Promise.resolve()
  }, 15_000)
})

describe("process-observer — the TARGETED identity probe carries its own witness", () => {
  const SELF = 4242
  const TARGET = 4310
  const both =
    "  4242 Fri Sep 11 23:13:04 2026 /usr/local/bin/bun\n" +
    "  4310 Fri Sep 11 23:20:00 2026 /bin/sleep\n"
  const onlySelf = "  4242 Fri Sep 11 23:13:04 2026 /usr/local/bin/bun\n"

  test("the argv asks for the target AND this process", () => {
    expect(identityArgv(TARGET, SELF)).toEqual([
      "ps",
      "-o",
      "pid=,lstart=,comm=",
      "-p",
      "4310",
      "-p",
      "4242",
    ])
  })

  test("a row parses into pid and start-instant + command", () => {
    expect(parseIdentityRow("  4310 Fri Sep 11 23:20:00 2026 /bin/sleep")).toEqual({
      pid: 4310,
      value: "Fri Sep 11 23:20:00 2026 /bin/sleep",
    })
    expect(parseIdentityRow("ps: some warning")).toBeUndefined()
  })

  test("target present → identity", () => {
    expect(identityFromProbe({ exitCode: 0, stdout: both }, TARGET, SELF)).toEqual({
      kind: "identity",
      value: "Fri Sep 11 23:20:00 2026 /bin/sleep",
    })
  })

  test("★ sentinel present, target absent → leader-exited (a real observation)", () => {
    expect(identityFromProbe({ exitCode: 0, stdout: onlySelf }, TARGET, SELF)).toEqual({
      kind: "leader-exited",
    })
  })

  test("★ sentinel ABSENT → unknown, never leader-exited", () => {
    // `ps -p <gone>` exits 1 with empty output, which is indistinguishable from
    // `ps` failing. The sentinel is what removes that ambiguity: no witness
    // row, no conclusion. Reading this as "leader exited" is precisely the
    // fail-open that let a kill land on an unidentified group.
    const noWitness = identityFromProbe({ exitCode: 0, stdout: "" }, TARGET, SELF)
    expect(noWitness).toEqual({
      kind: "unknown",
      reason: "empty-output",
      detail: "ps exited 0 without listing its own caller (pid 4242)",
    })
    expect(noWitness.kind).not.toBe("leader-exited")
    expect(identityFromProbe({ exitCode: 1, stdout: "" }, TARGET, SELF).kind).toBe("unknown")
    expect(identityFromProbe({ exitCode: null, signalCode: "SIGTERM" }, TARGET, SELF).kind).toBe(
      "unknown",
    )
    expect(identityFromProbe({ error: new Error("ENOENT") }, TARGET, SELF).kind).toBe("unknown")
  })

  test("★ WIRING — the targeted probe and the full snapshot agree, byte for byte", async () => {
    // The catastrophic divergence this guards: spawn records identity through
    // the targeted form and the kill compares it against the full-table form.
    // If the two rendered the same process differently, EVERY group would look
    // recycled and NOTHING would ever be killed — a silent, total process leak
    // that no other test here would notice.
    const observer = createProcessObserver()
    const targeted = observer.identity(process.pid)
    const snapshot = observer.snapshot()
    expect(targeted.kind).toBe("identity")
    expect(snapshot.kind).toBe("ok")
    if (targeted.kind !== "identity" || snapshot.kind !== "ok") return
    expect(leaderIdentityFromSnapshot(snapshot, process.pid)).toEqual(targeted)
    // ANTI-VACUUM FLOOR — a real, non-empty identity was compared.
    expect(targeted.value.length).toBeGreaterThan(10)
    await Promise.resolve()
  }, 15_000)

  test("a live process asked for by the WRONG pid reads as leader-exited, not unknown", async () => {
    // PAIRED CONTROL for the sentinel: the probe genuinely ran (our own row is
    // there), so an absent target is real information.
    const observer = createProcessObserver()
    // 1 is launchd; ask about a pid that certainly is not running by using our
    // own pid as the sentinel and a pid we just reaped.
    const reaped = Bun.spawnSync(["sh", "-c", "echo $$"], { stdout: "pipe" })
    const gone = Number.parseInt(reaped.stdout.toString().trim(), 10)
    expect(Number.isSafeInteger(gone)).toBe(true)
    expect(observer.identity(gone)).toEqual({ kind: "leader-exited" })
    await Promise.resolve()
  }, 15_000)
})

/**
 * LC-13 — the `maxMs >= initialMs` invariant lived as a `Math.max` repeated at
 * each call site, so it protected the two callers that remembered it and no
 * one else.
 *
 * The failure is not an error and not a slowdown, which is why it stayed open:
 * with `maxMs < initialMs` every attempt returns `maxMs`, so a schedule written
 * to mean "poll rarely" executes as "poll far more often" and spends exactly
 * the snapshot budget this module was built to bound — the same budget a
 * 70-second drain cut from ~1,400 observations to ~35.
 */
describe("pollSchedule", () => {
  test("an inverted pair is clamped, not silently honoured as a faster poll", () => {
    const inverted = pollSchedule({ initialMs: 3_000, maxMs: 50 })
    expect(inverted).toEqual({ initialMs: 3_000, maxMs: 3_000, factor: 2 })

    // The defect, stated as cost: over a 70-second window the unclamped pair
    // buys far more observations than the schedule it was written to describe.
    const raw = { initialMs: 3_000, maxMs: 50, factor: 2 }
    expect(pollTickCount(70_000, raw)).toBeGreaterThan(1_000)
    expect(pollTickCount(70_000, inverted)).toBeLessThanOrEqual(30)
  })

  test("a factor below 1 backs OFF rather than accelerating", () => {
    // factor 0: attempt 0 still yields 50ms (`0 ** 0 === 1`), and every attempt
    // after it yields 0, which `nextPollDelay`'s 1ms floor turns into a 1ms
    // spin — 1 + 950 observations to cover one second.
    expect(pollTickCount(1_000, { initialMs: 50, maxMs: 3_000, factor: 0 })).toBe(951)
    expect(pollSchedule({ factor: 0 }).factor).toBe(1)
    expect(pollSchedule({ factor: 0.5 }).factor).toBe(1)
    expect(pollTickCount(1_000, pollSchedule({ factor: 0 }))).toBe(20)
  })

  test("values that cannot terminate a loop throw instead of clamping", () => {
    // `pollTickCount` accumulates NaN and `elapsed < windowMs` never holds.
    for (const initialMs of [Number.NaN, Number.POSITIVE_INFINITY, 0, -50]) {
      expect(() => pollSchedule({ initialMs }), `initialMs ${initialMs}`).toThrow(
        /positive finite number/,
      )
    }
    // A non-finite ceiling has a safe reading — "no ceiling beyond the first
    // interval" — so it clamps rather than aborting a drain in progress.
    expect(pollSchedule({ initialMs: 50, maxMs: Number.NaN })).toEqual({
      initialMs: 50,
      maxMs: 50,
      factor: 2,
    })
    expect(pollSchedule({ factor: Number.NaN }).factor).toBe(1)
  })

  test("the defaults survive the constructor unchanged", () => {
    // ANTI-VACUITY: a constructor that returned a constant would satisfy the
    // clamping arms above too.
    expect(pollSchedule()).toEqual(DEFAULT_POLL_SCHEDULE)
    expect(pollSchedule({ initialMs: 10, maxMs: 200, factor: 3 })).toEqual({
      initialMs: 10,
      maxMs: 200,
      factor: 3,
    })
  })

  test("both production drains build their schedule through it", () => {
    // The repeated `Math.max` is what made LC-13 reachable. A third caller must
    // inherit the invariant instead of re-deriving it.
    for (const file of ["tools/dev/test-shard-lifecycle.ts", "tools/dev/bounded-child.ts"]) {
      const source = readFileSync(resolve(REPO_ROOT, file), "utf8")
      expect({ file, uses: source.includes("pollSchedule(") }).toEqual({ file, uses: true })
      expect({ file, rederives: /Math\.max\([^)]*[Ii]nitialMs/.test(source) }).toEqual({
        file,
        rederives: false,
      })
    }
  })
})
