/**
 * ★ Three rails spawned children with no deadline at all.
 *
 * TVH P1-6. `bounded-child.ts` was written FOR the gate runner — its own
 * docstring names `tools/dev/gate.ts` and explains why the shell form exists —
 * and then nothing called it. Meanwhile:
 *
 *   - `gate.ts` ran every gate as `Bun.spawnSync(["sh", "-c", gate.run])`, so
 *     a wedged gate blocked the whole campaign with no bound and no diagnosis.
 *   - `worktree-pollution-guard.ts` sits BETWEEN the gate and `test:full:ci`
 *     and spawned its child the same way, which would have defeated a gate
 *     deadline even after one was added.
 *   - `verification-matrix-cli.ts` did `await proc.exited` with nothing beside
 *     it: a wedged worker held its runner slot until the hosted job's own limit
 *     killed everything, reported as "the job timed out" and naming no chunk.
 *
 * These tests are structural because the alternative is hanging a suite for
 * four hours to prove a four-hour bound exists. The BOUND itself is behavioural
 * — `runBoundedChild`'s own tests kill real process groups — so what is left to
 * prove here is that these three call it and that the numbers are shared.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  CAPTURE_TIMEOUT_MS,
  DEFAULT_CHILD_LIMITS,
  runBoundedCapture,
  runBoundedChild,
} from "../../../tools/dev/bounded-child"

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..")
const source = (rel: string): string => readFileSync(resolve(REPO_ROOT, rel), "utf8")

/** The rails whose child is a LONG one: a gate, a guard, a matrix worker. */
const RAILS = [
  "tools/dev/gate.ts",
  "tools/dev/worktree-pollution-guard.ts",
  "tools/dev/verification-matrix-cli.ts",
] as const

/**
 * Every verification rail that starts a child at all, long or short.
 *
 * An audit found that the guard below banned two SPELLINGS and not the shape:
 * `Bun.spawnSync({…})` and `await proc.exited`. So these survived, in the same
 * three rails the ban was written for and in six of their siblings:
 *
 *   gate.ts                     `Bun.spawnSync(["git", …])` — array form
 *   verification-matrix-cli.ts  `proc.exited` inside a `Promise.all`
 *   unit-speed-budget.ts        `Bun.spawnSync({cmd:["bun","test",…]})`, the
 *                               gate that RE-RUNS a suspect test file
 *   scan-reach-baseline.ts      the harvest child itself, plus three git reads
 *   verification-{campaign,receipt,receipt-probe}.ts, test-shard-receipt.ts
 *
 * Each decides a verdict from a child's output, so each could wedge a campaign
 * with no bound, no output and no diagnosis. The ban is now on the CALL, not on
 * a spelling of it.
 */
const CHILD_RAILS = [
  ...RAILS,
  "tools/dev/verification-campaign.ts",
  "tools/dev/verification-receipt.ts",
  "tools/dev/verification-receipt-probe.ts",
  "tools/dev/test-shard-receipt.ts",
  "tools/dev/unit-speed-budget.ts",
  "tools/dev/scan-reach-baseline.ts",
] as const

describe("top-level children are bounded", () => {
  test("every rail runs its child through the one primitive", () => {
    for (const rail of RAILS) {
      const body = source(rail)
      expect({ rail, bounded: body.includes("runBoundedChild(") }).toEqual({ rail, bounded: true })
      expect({ rail, limits: body.includes("limits: {") }).toEqual({ rail, limits: true })
    }
  })

  /** Comments and docstrings stripped: a guard that reads prose finds its own
   *  explanation of the defect and calls it the defect. */
  const codeOnly = (body: string): string =>
    body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1")

  test("codeOnly actually removes prose and keeps code", () => {
    // ANTI-VACUITY: a stripper that returned "" would make the arm below pass
    // for every rail forever.
    expect(codeOnly("const a = 1 // await proc.exited")).toContain("const a = 1")
    expect(codeOnly("const a = 1 // await proc.exited")).not.toContain("proc.exited")
    expect(codeOnly("/* Bun.spawnSync({ */ const b = 2")).not.toContain("spawnSync")
    expect(codeOnly("/* Bun.spawnSync({ */ const b = 2")).toContain("const b = 2")
    // A URL's `//` is not a comment start.
    expect(codeOnly('const u = "https://x/y"')).toContain("https://x/y")
  })

  test("no verification rail spawns a child any other way", () => {
    // Not two spellings — the CALL. `Bun.spawnSync({…})` was banned while
    // `Bun.spawnSync([…])` sat four lines away in the same file, and
    // `await proc.exited` was banned while `proc.exited` inside a `Promise.all`
    // was the same unbounded wait with different punctuation.
    for (const rail of CHILD_RAILS) {
      const body = codeOnly(source(rail))
      expect({ rail, raw: /Bun\.spawn(Sync)?\s*\(/.test(body) }).toEqual({ rail, raw: false })
      expect({ rail, awaited: /proc\.exited/.test(body) }).toEqual({ rail, awaited: false })
      // ANTI-VACUITY: a rail that stopped starting children would satisfy the
      // two bans above by doing nothing, and the list would then guard a set of
      // files with nothing to guard.
      expect({
        rail,
        bounded: /runBounded(Child|Capture)\s*\(/.test(body),
      }).toEqual({ rail, bounded: true })
    }
    // ...and the list itself cannot be quietly emptied.
    expect(CHILD_RAILS.length).toBeGreaterThanOrEqual(9)
  })

  /**
   * The short-capture ceiling, behaviourally.
   *
   * Structural arms cannot tell a real bound from a named constant that is
   * never passed, and this is the one bound in the module that a test can prove
   * in under a second.
   */
  test("a short capture is killed at its ceiling, and a fast one is not", () => {
    // `sleep 3`, not `sleep 30`: on the FAILING side of this arm the child runs
    // to completion, and a probe that takes longer than the unit speed ceiling
    // would report two problems while only having one.
    const slow = runBoundedCapture({ command: ["bash", "-c", "sleep 3"], timeoutMs: 600 })
    expect({
      timedOut: slow.timedOut,
      exitCode: slow.exitCode,
      signalCode: slow.signalCode,
    }).toEqual({ timedOut: true, exitCode: null, signalCode: "SIGTERM" })
    // No wall assertion here on purpose. `exitCode: null` with `SIGTERM` IS the
    // proof that the ceiling fired: a child that ran to completion reports 0,
    // which is exactly how the mutant that drops the `timeout:` option fails.
    // Asserting elapsed time would add a clock this claim does not need.

    // PAIRED CONTROL: without this, a capture that always reported `timedOut`
    // would satisfy the arm above.
    const quick = runBoundedCapture({ command: ["bash", "-c", "echo hi; echo err >&2"] })
    expect({
      timedOut: quick.timedOut,
      exitCode: quick.exitCode,
      stdout: quick.stdout,
      stderr: quick.stderr,
    }).toEqual({ timedOut: false, exitCode: 0, stdout: "hi\n", stderr: "err\n" })

    // The discard sink returns empty text rather than throwing or hanging: a
    // caller that reads the verdict from a junit file must be able to refuse
    // the buffer this module's own docstring measured at 1,936 MB.
    const ignored = runBoundedCapture({ command: ["bash", "-c", "echo hi"], capture: "ignore" })
    expect({ stdout: ignored.stdout, exitCode: ignored.exitCode }).toEqual({
      stdout: "",
      exitCode: 0,
    })
    expect(CAPTURE_TIMEOUT_MS).toBe(120_000)
  })

  test("the gate and the guard it spawns declare the SAME bounds", () => {
    // The guard sits between the gate and the suite, so a looser bound there
    // would be the one that actually decides and the gate's would be
    // decoration.
    const gate = source("tools/dev/gate.ts")
    const guard = source("tools/dev/worktree-pollution-guard.ts")
    expect(gate).toContain("const GATE_INACTIVITY_MS = 12 * 60_000")
    expect(gate).toContain("const GATE_TOTAL_MS = 4 * 60 * 60_000")
    expect(guard).toContain("const GUARD_INACTIVITY_MS = 12 * 60_000")
    expect(guard).toContain("const GUARD_TOTAL_MS = 4 * 60 * 60_000")
  })

  test("the matrix worker's bound is DERIVED from the chunk, not picked", () => {
    // A fixed number here would be a guess about a population that varies by
    // an order of magnitude between chunks.
    const matrix = source("tools/dev/verification-matrix-cli.ts")
    expect(matrix).toContain("chunk.testTimeoutMs * Math.max(1, chunk.files.length)")
    expect(matrix).toContain("chunk.testTimeoutMs * 2")
  })

  test("a deadline kill is REPORTED, not left as a bare non-zero exit", () => {
    // Otherwise a hung gate reads as an ordinary failure of whatever it last
    // printed, which sends the reader to the wrong place entirely.
    for (const rail of RAILS) {
      const body = source(rail)
      expect({ rail, says: body.includes('=== "timed-out"') }).toEqual({ rail, says: true })
      expect({ rail, names: body.includes("deadline") }).toEqual({ rail, names: true })
    }
  })

  test("the gate's bounds are far above the default, on purpose", () => {
    // ANTI-VACUITY, and the reason the numbers are declared rather than
    // inherited: the primitive's 120s/30s default would kill `lint` and every
    // suite gate. A rail that silently took the defaults would be "bounded"
    // and unusable.
    expect(DEFAULT_CHILD_LIMITS.totalMs).toBe(120_000)
    expect(DEFAULT_CHILD_LIMITS.inactivityMs).toBe(30_000)
    expect(12 * 60_000).toBeGreaterThan(DEFAULT_CHILD_LIMITS.inactivityMs)
    expect(4 * 60 * 60_000).toBeGreaterThan(DEFAULT_CHILD_LIMITS.totalMs)
  })
})

describe("live output survives the bound", () => {
  test("a forwarded stream is uncapped while the retained copy is capped", async () => {
    // Piping without forwarding would have traded an operator's view of a
    // 45-minute campaign for the deadline. Both halves are asserted here
    // because keeping only one of them is the tempting half-fix.
    const forwarded: string[] = []
    const outcome = await runBoundedChild({
      shell: "printf 'abcdefghij'; printf 'klmnopqrst' >&2",
      cwd: REPO_ROOT,
      env: process.env,
      limits: { totalMs: 30_000, inactivityMs: 10_000, maxStreamBytes: 4 },
      onStdout: (text) => forwarded.push(text),
    })
    expect(outcome.status).toBe("passed")
    // Retained: capped and reported as truncated.
    expect(outcome.stdout).toBe("abcd")
    expect(outcome.truncated).toBe(true)
    // Forwarded: every byte.
    expect(forwarded.join("")).toBe("abcdefghij")
  }, 30_000)

  test("a child with no forwarder still records its output", async () => {
    // PAIRED CONTROL: forwarding is additive, not a replacement for retention.
    const outcome = await runBoundedChild({
      shell: "echo retained-only",
      cwd: REPO_ROOT,
      env: process.env,
      limits: { totalMs: 30_000, inactivityMs: 10_000 },
    })
    expect(outcome.status).toBe("passed")
    expect(outcome.stdout).toContain("retained-only")
  }, 30_000)
})
