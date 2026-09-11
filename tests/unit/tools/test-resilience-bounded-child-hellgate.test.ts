/**
 * HELLGATE — the diagnostic child's lifecycle, against REAL processes.
 *
 * The thing under test is not "does a bound exist" but "does the bound reach
 * the GRANDCHILD". Every fixture here forks one, records both pids, and the
 * survivor count is read back from those pids with `ps -o stat=` — kernel
 * ground truth, not our own belief about what we killed.
 *
 * ## Paired control (this is what makes the assertions falsifiable)
 *
 * `signalGroup: () => {}` runs the identical code path with the SIGNAL removed
 * and nothing else changed. If the kill were decorative, the control would look
 * like the real run; it does not — the control measures 2 survivors and
 * `kill.kind === "survived"`, the real run measures 0 and `"emptied"`. Without
 * it, "survivors === 0" is satisfied by a fixture that never forked.
 *
 * ## Anti-vacuum floors
 *
 * Every case asserts the fixture actually did the dangerous thing before
 * asserting we contained it: two pids recorded (the grandchild exists), and for
 * the output case that the child produced strictly MORE than the cap.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DEFAULT_CHILD_LIMITS,
  deadlineBudgetMs,
  runBoundedChild,
} from "../../../tools/dev/bounded-child"

const ROOT = mkdtempSync(join(tmpdir(), "tvh15-bounded-"))
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

/**
 * Two REAL processes, each recording its OWN pid, and `exec` so the recorded
 * pid stays valid (the shell BECOMES the long-running job).
 *
 * The grandchild is a fresh `sh -c`, not a `( … ) &` subshell. MEASURED: in a
 * POSIX subshell `$$` still expands to the INVOKING shell's pid, so the
 * subshell form wrote the same pid twice — and "2 pids recorded" was a floor
 * that a fixture which never forked satisfied for free. The floor below now
 * asserts they are DISTINCT, which is the property it was always claiming.
 *
 * Each fixture prints `ready` AFTER recording both pids, and that ordering is
 * load-bearing twice over. It makes the pid file a happens-before of the first
 * observed byte, so a box at load 100 cannot have the inactivity deadline fire
 * before the fixture was scheduled (MEASURED: without it this file failed
 * intermittently under `bun test` with an EMPTY pid file while passing 8/8
 * standalone). And it makes the inactivity case assert the real contract — the
 * clock runs from the LAST BYTE, not from spawn.
 */
const HUNG = `#!/bin/sh
echo $$ >> "$1"
sh -c 'echo $$ >> "$1"; exec sleep 600' _ "$1" &
echo ready
exec sleep 600
`

const LOUD = `#!/bin/sh
echo $$ >> "$1"
sh -c 'echo $$ >> "$1"; while :; do echo loud-grandchild; done' _ "$1" &
echo ready
while :; do echo loud-parent; done
`

const script = (name: string, body: string): string => {
  const path = join(ROOT, name)
  writeFileSync(path, body)
  chmodSync(path, 0o755)
  return path
}

const HUNG_SH = script("hung.sh", HUNG)
const LOUD_SH = script("loud.sh", LOUD)

/** DISTINCT recorded pids — the parent and a genuinely separate grandchild. */
const distinctRecordedPids = (file: string): number => new Set(recordedPids(file)).size

const recordedPids = (file: string): readonly number[] => {
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isSafeInteger(pid) && pid > 0)
  } catch {
    return []
  }
}

/**
 * RUNNING recorded descendants, read from the kernel's own state letters.
 *
 * `kill(pid, 0)` is the wrong probe here and the difference is not academic: a
 * SIGKILLed process stays in the table as a ZOMBIE until its parent reaps it,
 * and `kill(pid, 0)` succeeds for a zombie. Measured — this test asserted 0 and
 * got 2, against a group the tool had correctly observed as emptied. A zombie
 * holds no fd, port or working directory, so it is not a survivor; `ps -o stat=`
 * is the only probe that can tell the two apart.
 */
const runningRecorded = (file: string): number => {
  const pids = recordedPids(file)
  if (pids.length === 0) return 0
  const probe = Bun.spawnSync(
    ["ps", "-o", "pid=,stat=", ...pids.flatMap((p) => ["-p", String(p)])],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  return probe.stdout
    .toString()
    .split("\n")
    .map((line) => line.trim().split(/\s+/u))
    .filter((fields) => fields.length >= 2 && !(fields[1] ?? "").startsWith("Z"))
    .filter((fields) => Number.isSafeInteger(Number(fields[0]))).length
}

const hardReap = (file: string): void => {
  for (const pid of recordedPids(file)) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // already gone
    }
  }
}

const LIMITS = {
  ...DEFAULT_CHILD_LIMITS,
  // Small on purpose: the cap assertions must hold for a child the scheduler is
  // starving, not only for one that gets a full core.
  maxStreamBytes: 4 * 1024,
  termGraceMs: 1_000,
  killGraceMs: 3_000,
}

describe("bounded diagnostic child — deadlines reach the grandchild", () => {
  test("a hung child trips the INACTIVITY deadline and leaves zero descendants", async () => {
    const pidFile = join(ROOT, "hung-real.pids")
    const outcome = await runBoundedChild({
      cmd: [HUNG_SH, pidFile],
      cwd: ROOT,
      env: process.env,
      limits: { ...LIMITS, totalMs: 30_000, inactivityMs: 2_000 },
    })
    // ANTI-VACUUM FLOOR: the fixture really forked a grandchild, so "zero
    // survivors" is a statement about a tree and not about an empty file.
    expect(distinctRecordedPids(pidFile)).toBe(2)
    // The INACTIVITY bound fired, not the 30s total — the two are distinct
    // facts and collapsing them is how a silent child looks healthy.
    expect(outcome.status).toBe("timed-out")
    expect(outcome.deadline).toBe("inactivity")
    expect(outcome.kill?.kind).toBe("emptied")
    expect(outcome.survivors).toBe(0)
    expect(runningRecorded(pidFile)).toBe(0)
    expect(outcome.elapsedMs).toBeLessThanOrEqual(outcome.deadlineBudgetMs)
    hardReap(pidFile)
  }, 60_000)

  test("PAIRED CONTROL: with the group signal removed, the same run leaves the tree alive", async () => {
    const pidFile = join(ROOT, "hung-control.pids")
    const outcome = await runBoundedChild({
      cmd: [HUNG_SH, pidFile],
      cwd: ROOT,
      env: process.env,
      limits: { ...LIMITS, totalMs: 30_000, inactivityMs: 2_000 },
      // The ONLY difference from the case above.
      signalGroup: () => undefined,
    })
    expect(distinctRecordedPids(pidFile)).toBe(2)
    expect(outcome.status).toBe("timed-out")
    expect(outcome.deadline).toBe("inactivity")
    // Nothing was signalled, so the drain can only report survival.
    expect(outcome.kill?.kind).toBe("survived")
    expect(outcome.survivors).toBeGreaterThanOrEqual(1)
    // Both recorded descendants are still RUNNING (not zombies): the tree
    // outlived the call, which is exactly what the real case must not do.
    expect(runningRecorded(pidFile)).toBe(2)
    hardReap(pidFile)
  }, 60_000)

  test("an infinite-output child trips the TOTAL deadline, caps memory, and leaves zero descendants", async () => {
    const pidFile = join(ROOT, "loud-real.pids")
    const outcome = await runBoundedChild({
      cmd: [LOUD_SH, pidFile],
      cwd: ROOT,
      env: process.env,
      limits: { ...LIMITS, totalMs: 5_000, inactivityMs: 60_000 },
    })
    expect(distinctRecordedPids(pidFile)).toBe(2)
    expect(outcome.status).toBe("timed-out")
    expect(outcome.deadline).toBe("total")
    expect(outcome.kill?.kind).toBe("emptied")
    expect(outcome.survivors).toBe(0)
    expect(runningRecorded(pidFile)).toBe(0)
    // ANTI-VACUUM FLOOR: it really overran the cap (so `truncated` is not the
    // trivially-true answer for a child that printed nothing), and the
    // retained size is EXACTLY the cap rather than "small".
    expect(outcome.truncated).toBe(true)
    expect(outcome.stdout.length).toBe(LIMITS.maxStreamBytes)
    expect(outcome.elapsedMs).toBeLessThanOrEqual(outcome.deadlineBudgetMs)
    hardReap(pidFile)
  }, 60_000)

  test("both streams are drained concurrently — a full stderr cannot wedge stdout", async () => {
    // 1 MiB on EACH stream with a 64 KiB cap. A sequential drain blocks the
    // child in write(2) on whichever pipe it is not reading, and the call
    // would hit the deadline instead of exiting on its own.
    const both = script(
      "both.sh",
      `#!/bin/sh
i=0
while [ $i -lt 2000 ]; do
  printf '%s\\n' "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  printf '%s\\n' "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" 1>&2
  i=$((i + 1))
done
`,
    )
    const outcome = await runBoundedChild({
      cmd: [both],
      cwd: ROOT,
      env: process.env,
      limits: { ...LIMITS, totalMs: 45_000, inactivityMs: 45_000 },
    })
    // It EXITED on its own — no deadline was needed, which is the whole claim.
    expect(outcome.status).toBe("passed")
    expect(outcome.deadline).toBeUndefined()
    expect(outcome.exitCode).toBe(0)
    // Both caps filled: proof both handlers ran, not just the first.
    expect(outcome.stdout.length).toBe(LIMITS.maxStreamBytes)
    expect(outcome.stderr.length).toBe(LIMITS.maxStreamBytes)
    expect(outcome.truncated).toBe(true)
  }, 90_000)

  test("a child that cannot be spawned is typed, not thrown", async () => {
    const outcome = await runBoundedChild({
      cmd: [join(ROOT, "definitely-not-a-binary")],
      cwd: ROOT,
      env: process.env,
      limits: LIMITS,
    })
    expect(outcome.status).toBe("spawn-error")
    expect(outcome.spawnError ?? "").not.toBe("")
    expect(outcome.survivors).toBe(0)
  })
})

describe("the declared deadline is derived from the limits, not chosen", () => {
  // Each term is proven to CONTRIBUTE by moving it alone. A hard-coded budget
  // would pass a single equality check; it cannot pass five deltas.
  const base = DEFAULT_CHILD_LIMITS
  const deltas: readonly (readonly [keyof typeof base, number])[] = [
    ["totalMs", 1_000],
    ["termGraceMs", 250],
    ["killGraceMs", 500],
    ["watchdogPollMs", 50],
  ]
  for (const [field, delta] of deltas) {
    test(`${field} moves the budget by exactly its own delta`, () => {
      const moved = { ...base, [field]: base[field] + delta }
      expect(deadlineBudgetMs(moved) - deadlineBudgetMs(base)).toBe(delta)
    })
  }

  test("maxPollMs moves the budget by twice its delta (one drain stage each)", () => {
    const moved = { ...base, maxPollMs: base.maxPollMs + 100 }
    expect(deadlineBudgetMs(moved) - deadlineBudgetMs(base)).toBe(200)
  })

  test("inactivityMs does NOT move it — the total deadline is the ceiling", () => {
    const moved = { ...base, inactivityMs: base.inactivityMs + 10_000 }
    expect(deadlineBudgetMs(moved)).toBe(deadlineBudgetMs(base))
  })
})
