/**
 * NIGHTLY — the ONE real-time canary for the `/goal` quiet window.
 *
 * # Why this waits, and why nothing else in the PR lane does
 *
 * The property is that thread A's ALREADY-ARMED continuation stays quiet across
 * a FULL quiet window after the operator attaches to thread B. The window is
 * clamped to a public 15 s minimum — `QUANTA_GOAL_QUIET_MS: 50` is raised to
 * 15,000 by the shipped policy, which the PR lane asserts separately by reading
 * the typed decision — so the wait cannot be shortened by configuration.
 *
 * And it cannot be replaced by a readiness predicate either. Every other fixed
 * sleep in the `/goal` suite was waiting for something the CLI eventually
 * PRINTS, and a predicate on that output is strictly better. This one waits for
 * something to NOT happen, on a session the operator is no longer attached to,
 * for which the surface exposes no typed decision: after the attach, `/goal`
 * reports on B, and B has no goal. There is no observable that says "A's arm was
 * cancelled". Elapsing the window is the observation.
 *
 * # What the PR lane keeps
 *
 * `tests/e2e-pty/cli-goal-pursuit-e2e.test.ts` runs the IDENTICAL three-process
 * scenario through `attachToSecondThread` and asserts the observable half — the
 * attached session is B and B has no goal, which is what regresses first if
 * `/fork attach` stops re-pointing the surface objective store. The union of the
 * two lanes is the pre-split case and their intersection is empty; the property
 * is checked against these two files by the guard in
 * `tests/unit/test-fixtures-do-not-leak-tmp.test.ts`.
 *
 * # The measurement
 *
 *     cli-goal-pursuit-e2e.test.ts   16 cases, 153.74 s wall (measured)
 *     awaited fixed sleeps in it     22,650 ms before, 6,650 ms after
 *     this single site               16,000 ms — 46% of the repository's total
 *
 * The suite's wall time is dominated by sixteen CLI boots, not by sleeps; the
 * 16 s is nevertheless the largest single awaited wait in the repository and the
 * only one that is pure dead time for a PR.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  attachToSecondThread,
  type GoalBooterPorts,
  makeGoalBooter,
  sleep,
  submitLine,
  T,
} from "./goal-pursuit-harness"
import { PTY_AVAILABLE, type PtyCli } from "./pty-harness"

describe.skipIf(!PTY_AVAILABLE)("CLI /goal quiet window — real-time canary (nightly)", () => {
  let sessionsDir: string
  let cwd: string
  let cli: PtyCli | undefined

  beforeEach(() => {
    sessionsDir = mkdtempSync(join(tmpdir(), "nightly-goal-sessions-"))
    cwd = mkdtempSync(join(tmpdir(), "nightly-goal-cwd-"))
  })

  afterEach(async () => {
    const current = cli
    current?.kill()
    if (current !== undefined) await Promise.race([current.exited, sleep(2_000)])
    cli = undefined
    rmSync(sessionsDir, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  })

  const ports: GoalBooterPorts = {
    cwd: () => cwd,
    sessionsDir: () => sessionsDir,
    setCli: (next) => {
      cli = next
    },
  }
  const booter = makeGoalBooter(ports)

  test("[case:goal-attach-cancels-pending-continuation] attach to thread B cancels thread A's pending continuation before its body can run", async () => {
    const attached = await attachToSecondThread(booter, ports, "A_CONTINUATION_MUST_NOT_RUN")
    // One full window plus a second of slack, written as a LITERAL so the
    // awaited-sleep inventory can see and charge it. Below 15,000 the case
    // cannot fail: the window has not elapsed, so "the continuation did not
    // run" is true of a correct implementation and a broken one alike.
    await sleep(16_000)
    expect(attached.screen()).not.toContain("A_CONTINUATION_MUST_NOT_RUN")
    await submitLine(attached, "/goal")
    await attached.waitFor("No goal set.", T)
  }, 180_000)
})
