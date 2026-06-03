/**
 * ADR-0303 — session turn-driver thin-surface hellgate.
 *
 * Pins the hoist of the `append → turn.run → resolve-approval → loop`
 * turn-completion primitive OUT of the CLI surface into `@/runner/orchestrate`,
 * so the approval-resolution loop is defined exactly ONCE and both the CLI and
 * headless funnel through it. Before this, the CLI owned the loop while headless
 * re-implemented the turn primitive WITHOUT the approval loop (a divergence).
 *
 * Guards against regression to surface-local re-implementation:
 *   1. the shared driver lives below src/apps/** (in @/runner) and is terminal-free,
 *   2. the CLI session-loop drives turns THROUGH it (no inline approval loop),
 *   3. headless drives turns THROUGH it (gaining the approval loop).
 */
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const REPO_ROOT = join(import.meta.dir, "..", "..")
const read = (p: string): string => readFileSync(join(REPO_ROOT, p), "utf8")

const DRIVER = "src/runner/orchestrate/session-turn-driver.ts"

describe("session turn-driver thin-surface hellgate (ADR-0303)", () => {
  test("the shared driver lives in @/runner and owns the approval-resolution loop", () => {
    expect(existsSync(join(REPO_ROOT, DRIVER))).toBe(true)
    const src = read(DRIVER)
    // the reusable loop: append → turn.run → (approvalRequest) respond → loop
    expect(src).toContain("export const runSessionTurn")
    expect(src).toContain("session.input.append")
    expect(src).toContain("session.turn.run")
    expect(src).toContain("approvalRequest")
    expect(src).toContain("session.approval.respond")
    // surface-agnostic: NO terminal / readline / render deps may leak in
    expect(src).not.toContain("node:readline")
    expect(src).not.toContain("node:tty")
    expect(src).not.toContain("process.std")
    expect(src).not.toContain("@/apps/")
  })

  test("the CLI session-loop drives turns THROUGH the shared driver, not an inline loop", () => {
    const loop = read("src/apps/cli/repl/session-loop.ts")
    expect(loop).toContain("driveSessionTurn")
    // the inline approval-resolution helpers must NOT be re-introduced in the surface
    expect(loop).not.toContain("const resolvePendingApproval")
    expect(loop).not.toContain("const requireTurnPayload")
  })

  test("headless drives turns THROUGH the shared driver (shares the approval loop)", () => {
    const headless = read("src/apps/headless/index.ts")
    expect(headless).toContain("session-turn-driver")
    expect(headless).toContain("driveSessionTurn")
    // headless must NOT hand-roll a bare single `turn.run` without the driver
    expect(headless).not.toContain("bridge.session.turn.run(")
  })
})
