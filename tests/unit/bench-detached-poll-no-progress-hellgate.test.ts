/**
 * jun-27 NO-PROGRESS (wedged-but-alive) abort — the third leg of hang detection,
 * wired into the detached poll loop.
 *
 * The hang class: a box made LLM calls for 77min yet completed NO turns on a
 * single case (throttle / stuck stream). Its ssh polls SUCCEEDED the whole time
 * (the box was alive), so the box-DEATH bound (consecutive poll FAILURES +
 * describe-instances) never fired, and `run.exit` never landed so the loop polled
 * a wedged box forever. The signal the operator actually had was "run.log stopped
 * growing". This wires {@link makeNoProgressWatchdog} into runBenchDetachedPoll:
 * progress() fires ONLY on real run.log growth; a frozen log past the idle budget
 * aborts to the SAME requeue path as box-death.
 *
 * TEETH (red-on-injection):
 *  - a FROZEN run.log (polls succeed, no new lines) past the budget must THROW the
 *    no-progress BoxDiedDuringRunError — NOT spin forever. This is the bug-catcher:
 *    the parse emits a spurious leading blank line per poll (the `echo MARK`
 *    newline), so a naive `seen` delta reads as progress EVERY poll and the
 *    watchdog never trips. Progress must key on NON-BLANK growth.
 *  - CONTROL: a run.log that keeps GROWING never trips (no false abort), even
 *    across many budget windows.
 *  - CONTROL: with NO budget set (the default) a frozen log NEVER aborts —
 *    byte-identical opt-in; a misconfig cannot kill a healthy box.
 *  - the abort must NOT consult the box-death liveness probe (aws) — no-progress
 *    is a DISTINCT signal from a vanished box.
 */
import { describe, expect, test } from "bun:test"
import { runBenchDetachedPoll } from "../../src/apps/bench/remote/box-session/detached-poll"
import { ok } from "./bench-spawn-testkit"

const MARK = "==XQ-RUN-EXIT-XQ=="
/** A SUCCESSFUL poll with NO exit sentinel and NO real new line — the wedged box.
 *  (Mirrors the existing box-death test's "not done yet" probe at line 125.) */
const FROZEN = ok(`\n${MARK}\n`)
/** A successful poll carrying one GENUINE new run.log line. */
const realLine = (n: number) => ok(`\n${MARK}\nreal log line ${n}\n`)
/** The run finished (exit 0). */
const DONE = ok(`0\n${MARK}\n`)

const isLaunch = (remote: string): boolean => remote.includes("setsid bash -c")

describe("detached poll — no-progress (wedged-but-alive) watchdog wiring", () => {
  test("a FROZEN run.log past the idle budget aborts (does NOT spin forever)", async () => {
    let t = 0
    let polls = 0
    await expect(
      runBenchDetachedPoll({
        iid: "django__django-11141",
        benchCmd: "bun run bench",
        runLog: "~/run.log",
        runExit: "~/run.exit",
        onLine: () => {},
        noProgressBudgetMs: 1000,
        now: () => t,
        sleep: async () => {
          t += 500 // each poll advances the injected clock 500ms (2 polls = budget)
        },
        pollIntervalMs: 1,
        // The box is ALIVE (polls succeed) but WEDGED — the liveness probe is the
        // box-DEATH path and must NOT be consulted for a no-progress abort.
        aws: async () => {
          throw new Error("aws liveness must not run for a LIVE-but-wedged box")
        },
        ssh: async (remote) => {
          if (isLaunch(remote)) return ok("LAUNCHED\n")
          polls += 1
          if (polls > 200) throw new Error(`SAFETY: watchdog never tripped after ${polls} frozen polls`)
          return FROZEN
        },
      }),
    ).rejects.toThrow(/no forward progress/)
  })

  test("CONTROL: a run.log that keeps GROWING never trips the watchdog", async () => {
    let t = 0
    let polls = 0
    const out = await runBenchDetachedPoll({
      iid: "django__django-11141",
      benchCmd: "bun run bench",
      runLog: "~/run.log",
      runExit: "~/run.exit",
      onLine: () => {},
      noProgressBudgetMs: 1000,
      now: () => t,
      sleep: async () => {
        t += 500
      },
      pollIntervalMs: 1,
      aws: async () => ok("running\n"),
      ssh: async (remote) => {
        if (isLaunch(remote)) return ok("LAUNCHED\n")
        polls += 1
        // a REAL new line every poll keeps progress fresh across many budget
        // windows; finish after 10 (clock 5000ms ≫ the 1000ms budget).
        return polls >= 10 ? DONE : realLine(polls)
      },
    })
    expect(out.code).toBe(0)
    expect(polls).toBeGreaterThanOrEqual(10)
  })

  test("growing run.log: EVERY real line reaches onLine exactly once (no cursor-drift skip)", async () => {
    // jun-27: the `echo MARK` newline made the parse emit a leading "" each poll,
    // over-counting `seen` so `tail -n +${seen+1}` SKIPPED real lines — the operator
    // log desynced from the box (froze at case 1 while the box ran case 7).
    const boxLines = ["▶ case-1", "■ case-1 ok", "▶ case-2", "■ case-2 ok", "▶ case-3"]
    let revealed = 0 // lines the box has written so far (one more per poll)
    const received: string[] = []
    const out = await runBenchDetachedPoll({
      iid: "i-grow",
      benchCmd: "b",
      runLog: "~/run.log",
      runExit: "~/run.exit",
      onLine: (l) => received.push(l.replace(/\n$/, "")),
      sleep: async () => {
        revealed = Math.min(revealed + 1, boxLines.length)
      },
      pollIntervalMs: 1,
      aws: async () => ok("running\n"),
      ssh: async (remote) => {
        if (isLaunch(remote)) return ok("LAUNCHED\n")
        const from = Number(remote.match(/tail -n \+(\d+)/)?.[1] ?? "1") // 1-indexed cursor
        const tail = boxLines.slice(0, revealed).slice(from - 1)
        const done = revealed >= boxLines.length && from > boxLines.length
        return ok(`${done ? "0" : ""}${MARK}\n${tail.map((l) => `${l}\n`).join("")}`)
      },
    })
    expect(out.code).toBe(0)
    expect(received).toEqual(boxLines) // in order, once each — no skip, dupe, or "" noise
  })

  test("CONTROL: with NO budget (default) a frozen log NEVER aborts (byte-identical opt-in)", async () => {
    let t = 0
    let polls = 0
    const out = await runBenchDetachedPoll({
      iid: "django__django-11141",
      benchCmd: "bun run bench",
      runLog: "~/run.log",
      runExit: "~/run.exit",
      onLine: () => {},
      // noProgressBudgetMs OMITTED ⇒ Infinity ⇒ off.
      now: () => t,
      sleep: async () => {
        t += 10 * 60_000 // jump 10min/poll — would trip ANY finite budget, but none is set
      },
      pollIntervalMs: 1,
      aws: async () => ok("running\n"),
      ssh: async (remote) => {
        if (isLaunch(remote)) return ok("LAUNCHED\n")
        polls += 1
        return polls >= 5 ? DONE : FROZEN
      },
    })
    expect(out.code).toBe(0)
  })
})
