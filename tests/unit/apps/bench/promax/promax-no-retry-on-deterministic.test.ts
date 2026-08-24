/**
 * PMX-04 — A DETERMINISTIC FAILURE MUST NOT BE RETRIED ON A FRESH BOX.
 *
 * MEASURED, and it cost a box: the ProMax canary's bootstrap refused at
 * `campaign-root` (`mkdir: cannot create directory '/opt/quanta': Permission
 * denied`). `runRelaunchAttempt` catches EVERY error, logs it, and returns `{}` —
 * which the loop reads as "nothing resolved, relaunch". So the run printed
 *
 *     ⚠️ 7/7 instance(s) lost (spot reclaim / ssh-255) — relaunching…
 *
 * launched a SECOND box, hit the identical refusal, and reported
 * `LOST 7 (box-loss)`. A permanent configuration error was laundered into box
 * death and bought hardware to learn it twice.
 *
 * A `FamilyBootstrapError` is a refusal on a DECLARED precondition — a wrong
 * path, an unverified digest, an interpreter below the floor. A fresh box refuses
 * identically by construction. Retrying it is not resilience, it is spend.
 *
 * The loop STOPS rather than throwing, so whatever earlier attempts did earn is
 * still reported — and the operator sees the real cause instead of "box-loss".
 */
import { describe, expect, test } from "bun:test"
import { FamilyBootstrapError } from "@/apps/bench/remote/box-session/family-bootstrap-exec"
import { runWithRelaunch } from "@/apps/bench/remote/full"

describe("relaunch stops on a deterministic failure", () => {
  test("🔴 a FamilyBootstrapError is attempted ONCE, not relaunched", async () => {
    let attempts = 0
    const out = await runWithRelaunch(
      () => ({
        run: async () => {
          attempts += 1
          throw new FamilyBootstrapError('bootstrap step "campaign-root" FAILED (exit 1)')
        },
      }),
      { expected: ["a-1", "b-2"], maxRelaunch: 1, onLog: () => {} },
    )
    expect(attempts, "a permanent refusal was retried on a fresh box").toBe(1)
    expect(out.attempts).toBe(1)
  })

  test("🔴 the operator is told the REAL cause, not `box-loss`", async () => {
    const logs: string[] = []
    await runWithRelaunch(
      () => ({
        run: async () => {
          throw new FamilyBootstrapError('bootstrap step "campaign-root" FAILED (exit 1)')
        },
      }),
      { expected: ["a-1"], maxRelaunch: 1, onLog: (m) => logs.push(m) },
    )
    const all = logs.join("\n")
    expect(all).toMatch(/campaign-root/)
    // …and it does NOT claim a spot reclaim
    expect(all).not.toMatch(/spot reclaim/)
  })

  test("PAIRED CONTROL: a NON-deterministic failure is still relaunched", async () => {
    let attempts = 0
    await runWithRelaunch(
      () => ({
        run: async () => {
          attempts += 1
          throw new Error("ssh exit 255: connection reset")
        },
      }),
      { expected: ["a-1"], maxRelaunch: 1, onLog: () => {} },
    )
    expect(attempts, "a transient box death stopped being retried").toBe(2)
  })

  test("PAIRED CONTROL: a clean run still reports its results", async () => {
    const out = await runWithRelaunch(
      () => ({
        run: async () => ({ resolved: ["a-1"], unresolved: [], errored: [], emptyPatch: [] }),
      }),
      { expected: ["a-1"], maxRelaunch: 1, onLog: () => {} },
    )
    expect(out.resolved).toEqual(["a-1"])
    expect(out.attempts).toBe(1)
  })
})
