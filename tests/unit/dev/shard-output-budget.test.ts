/**
 * Output growth was the only liveness signal a chunk had.
 *
 * The watchdog decided with `spoolBytes !== lastSpoolBytes → "progressed"`, so
 * ANY byte written reset the 12-minute inactivity timer, and there was no total
 * wall bound at all. A worker stuck in a `console.log` loop — a retry that logs,
 * a readiness poll that prints, a test that dumps a diff every iteration — is
 * maximally "alive" under that rule and runs to the JOB timeout, which is the
 * outer boundary the watchdog exists to stay inside.
 *
 * Both the timeout diagnostic and the normal completion path also read the WHOLE
 * spool into memory. The spool is the complete stdout+stderr of up to 160 test
 * files, and the runner's own RSS is the thing being protected — so the reaction
 * to a pathological producer was to load everything it produced.
 */

import { describe, expect, test } from "bun:test"
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  describeWatchdogKill,
  isKill,
  type ShardWatchdogAction,
  type ShardWatchdogTick,
  shardWatchdogAction,
  spoolTailWindow,
} from "../../../tools/dev/shard-output-budget"

const tick = (overrides: Partial<ShardWatchdogTick> = {}): ShardWatchdogTick => ({
  spoolBytes: 1_000,
  lastSpoolBytes: 1_000,
  idleMs: 0,
  elapsedMs: 1_000,
  inactivityTimeoutMs: 12 * 60_000,
  totalWallTimeoutMs: 40 * 60_000,
  outputCapBytes: 512 * 1024 * 1024,
  alreadyKilling: false,
  ...overrides,
})

describe("shard watchdog bounds", () => {
  test("a chatty chunk can no longer outlive the inactivity window forever", () => {
    // The exact defect: every tick writes MORE bytes, so `progressed` was
    // returned indefinitely. Simulated as 200 ticks of a worker that appends on
    // every poll while doing nothing else.
    let bytes = 1_000
    let last = 0
    let elapsed = 0
    const actions: ShardWatchdogAction[] = []
    for (let poll = 0; poll < 200; poll += 1) {
      bytes += 8 * 1024 * 1024
      elapsed += 15_000
      const action = shardWatchdogAction(
        tick({ spoolBytes: bytes, lastSpoolBytes: last, idleMs: 0, elapsedMs: elapsed }),
      )
      actions.push(action)
      if (isKill(action)) break
      last = bytes
    }
    const final = actions.at(-1)
    expect(isKill(final ?? "waiting")).toBe(true)
    expect(final).toBe("kill-output-cap")

    // ANTI-VACUITY: it must have reported progress for a while first, or this is
    // a test of a watchdog that kills everything immediately.
    expect(actions.filter((action) => action === "progressed").length).toBeGreaterThan(10)
  })

  test("the absolute bounds are checked BEFORE the progress heuristic", () => {
    // The whole defect was a heuristic that could veto the bounds. A tick that
    // is over BOTH a bound and "progressing" must kill.
    expect(
      shardWatchdogAction(tick({ spoolBytes: 900, lastSpoolBytes: 100, outputCapBytes: 500 })),
    ).toBe("kill-output-cap")
    expect(
      shardWatchdogAction(
        tick({
          spoolBytes: 900,
          lastSpoolBytes: 100,
          elapsedMs: 60_000,
          totalWallTimeoutMs: 1_000,
        }),
      ),
    ).toBe("kill-total-wall")
  })

  test("a silent chunk still dies of inactivity, and says so", () => {
    const t = tick({ idleMs: 13 * 60_000 })
    const action = shardWatchdogAction(t)
    expect(action).toBe("kill-inactive")
    expect(describeWatchdogKill(action, t)).toContain("nothing written")
  })

  test("each kill names which bound was crossed", () => {
    const capped = tick({ spoolBytes: 900, outputCapBytes: 500 })
    expect(describeWatchdogKill("kill-output-cap", capped)).toContain("not evidence")
    const wall = tick({ elapsedMs: 99, totalWallTimeoutMs: 10 })
    expect(describeWatchdogKill("kill-total-wall", wall)).toContain("total wall")
    // The three messages must be distinguishable, or a kill notice says nothing
    // the previous one did not.
    const messages = new Set([
      describeWatchdogKill("kill-output-cap", capped),
      describeWatchdogKill("kill-total-wall", wall),
      describeWatchdogKill("kill-inactive", tick({ idleMs: 1 })),
    ])
    expect(messages.size).toBe(3)
  })

  test("a kill already in flight is not re-issued", () => {
    expect(shardWatchdogAction(tick({ alreadyKilling: true, idleMs: 99 * 60_000 }))).toBe(
      "already-killing",
    )
  })

  test("a healthy chunk is left alone", () => {
    expect(shardWatchdogAction(tick())).toBe("waiting")
    expect(shardWatchdogAction(tick({ spoolBytes: 2_000, lastSpoolBytes: 1_000 }))).toBe(
      "progressed",
    )
  })
})

describe("bounded spool tail", () => {
  test("the window is the END of the file, and never larger than it", () => {
    expect(spoolTailWindow(1_000, 100)).toEqual({ start: 900, length: 100 })
    expect(spoolTailWindow(50, 100)).toEqual({ start: 0, length: 50 })
    expect(spoolTailWindow(0, 100)).toEqual({ start: 0, length: 0 })
    expect(spoolTailWindow(100, 0)).toEqual({ start: 100, length: 0 })
  })

  test("reading through the window returns the tail, not the file", () => {
    // Executed against a real file, because the point is that the bytes NOT read
    // are never materialised — an arithmetic-only test would pass over a
    // `readFileSync` that then sliced.
    const root = mkdtempSync(join(tmpdir(), "quanta-spool-"))
    try {
      const path = join(root, "chunk.log")
      const head = "H".repeat(100_000)
      const tail = "TAILMARKER\n"
      writeFileSync(path, head + tail)

      const window = spoolTailWindow(head.length + tail.length, 64)
      const fd = openSync(path, "r")
      try {
        const buffer = Buffer.allocUnsafe(window.length)
        readSync(fd, buffer, 0, window.length, window.start)
        const text = buffer.toString("utf8")
        expect(text).toContain("TAILMARKER")
        expect(text.length).toBe(64)
        // ANTI-VACUITY: the file must genuinely be much larger than the window,
        // or "read the tail" is the same as "read the file".
        expect(readFileSync(path, "utf8").length).toBeGreaterThan(window.length * 100)
      } finally {
        closeSync(fd)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("the runner uses the bounds", () => {
  test("WIRING — no unbounded spool read and no single-signal watchdog remains", () => {
    const source = readFileSync(
      join(import.meta.dir, "..", "..", "..", "tools", "dev", "run-test-shards.ts"),
      "utf8",
    )
    // ANTI-VACUITY first: the markers must exist, or every `not.toContain` below
    // passes over a file that no longer says anything.
    expect(source).toContain("shardWatchdogAction(")
    expect(source).toContain("readSpoolTail(")
    expect(source).toContain("SHARD_TOTAL_WALL_TIMEOUT_MS")
    expect(source).toContain("SHARD_OUTPUT_CAP_BYTES")

    // The two reads that loaded the whole spool.
    expect(source).not.toContain('readFileSync(spoolPath, "utf8")')
    // …and the single-signal decision it replaced.
    expect(source).not.toContain("watchdogAction({")
  })
})
