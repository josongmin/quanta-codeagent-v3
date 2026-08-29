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
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { assertScanPopulation } from "./_shared/scan-population"

const REPO_ROOT = join(import.meta.dir, "..", "..")
const read = (p: string): string => readFileSync(join(REPO_ROOT, p), "utf8")
// The `runSessionLoop` god-fn split (b17ce99aa) moved the driver call out of
// `session-loop.ts` into a `session-loop/*.ts` lane; aggregate the entrypoint +
// every lane so the "drives THROUGH the shared driver" pin follows the code.
const SESSION_LOOP_REL = "src/apps/cli/repl/session-loop"
/** Enumerated ONCE: the floor and the aggregate read the same list. */
const sessionLoopSliceFiles = (): string[] =>
  readdirSync(join(REPO_ROOT, SESSION_LOOP_REL)).filter((f) => f.endsWith(".ts"))

const readSessionLoopAggregate = (): string =>
  [`${SESSION_LOOP_REL}.ts`, ...sessionLoopSliceFiles().map((f) => `${SESSION_LOOP_REL}/${f}`)]
    .map(read)
    .join("\n")

const DRIVER = "src/runner/orchestrate/session-turn-driver.ts"

describe("session turn-driver thin-surface hellgate (ADR-0303)", () => {
  test("ANTI-VACUITY: the session-loop slice was actually read", () => {
    // The aggregate is one concatenated blob; a slice file that went unread is
    // simply absent from it, and the surface it holds reads as thin.
    const dir = join(REPO_ROOT, SESSION_LOOP_REL)
    assertScanPopulation(
      sessionLoopSliceFiles().map((f) => join(dir, f)),
      dir,
      {
        id: "tests/unit/session-turn-driver-thin-surface-hellgate.test.ts#session-loop-slice",
        topLevelOnly: true,
        collectable: (f) => f.endsWith(".ts"),
      },
    )
  })

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
    const loop = readSessionLoopAggregate()
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
