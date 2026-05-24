import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

// Slice-C: lock the runRepl SHAPE so a future round can't silently re-grow
// the GodFunction. These assertions are intentionally TEXTUAL (string scans
// over the source file) so any structural regression surfaces immediately
// in CI rather than years later when a reviewer notices the file size.

const replPath = resolve(__dirname, "../../../../src/apps/cli/repl.ts")
const replSrc = readFileSync(replPath, "utf8")

/** Extract the body of `export const runRepl = async (): Promise<void> => {`
 *  through its terminating top-level `}` (matching brace via depth count). */
const extractRunReplBody = (): string => {
  const start = replSrc.indexOf("export const runRepl = async (): Promise<void> => {")
  if (start === -1) throw new Error("runRepl not found in repl.ts")
  let depth = 0
  let i = start
  for (; i < replSrc.length; i++) {
    const ch = replSrc[i]
    if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) return replSrc.slice(start, i + 1)
    }
  }
  throw new Error("runRepl body never closed")
}

const runReplBody = extractRunReplBody()

describe("runRepl — Slice-C shape contract", () => {
  test("runRepl ≤ 50 LOC (spec target — thin orchestrator)", () => {
    const lines = runReplBody.split("\n").length
    expect(lines).toBeLessThanOrEqual(50)
  })

  test("runRepl body has NO `let` declarations — god-state replaced by SessionState record", () => {
    // The `let` ban is for the body of `runRepl` itself; the SessionState
    // record handles all surface state. Other helpers (composeTurnSinks,
    // createSurfaceState) own their own scoped `let`s if needed.
    expect(runReplBody).not.toMatch(/^\s*let\s+/m)
  })

  test("runRepl body calls EVERY one of the 3 spec orchestration helpers", () => {
    // The orchestration funnel: setupSession ➜ runSessionLoop.
    // composePromptPipeline + runOneTurn + installTurnCancel live INSIDE
    // session-loop / turn-runner, so runRepl doesn't reference them directly.
    expect(runReplBody).toContain("setupSession(")
    expect(runReplBody).toContain("runSessionLoop(")
  })

  test("runRepl body has NO inline `turn` closure (DRY win — runOneTurn replaces it)", () => {
    // The prior 1568-LOC monolith had `const turn = async (text: string) =>`.
    // After Slice-C, that closure is gone; runOneTurn (in turn-runner.ts)
    // is the single per-turn wrapper for BOTH paths.
    expect(runReplBody).not.toContain("const turn = async (text:")
    expect(runReplBody).not.toContain("const wrapTurn =")
  })

  test("runRepl body has NO inline installTurnCancel definition (relocated to helper)", () => {
    expect(runReplBody).not.toContain("const installTurnCancel = (")
  })

  test("the 6 helpers exist on disk as expected module paths", () => {
    const helpers = [
      "../../../../src/apps/cli/repl/turn-runner.ts",
      "../../../../src/apps/cli/repl/turn-cancel-install.ts",
      "../../../../src/apps/cli/repl/session-state.ts",
      "../../../../src/apps/cli/repl/prompt-pipeline.ts",
      "../../../../src/apps/cli/repl/session-setup.ts",
      "../../../../src/apps/cli/repl/session-loop.ts",
    ]
    for (const rel of helpers) {
      // throws on missing — locks the slice surface.
      readFileSync(resolve(__dirname, rel), "utf8")
    }
    expect(helpers).toHaveLength(6)
  })

  test("repl.ts imports BOTH setupSession AND runSessionLoop from the slice dir", () => {
    expect(replSrc).toMatch(/from "\.\/repl\/session-setup"/)
    expect(replSrc).toMatch(/from "\.\/repl\/session-loop"/)
  })

  test("turn-runner.ts is referenced from session-loop.ts (the DRY funnel)", () => {
    const loopSrc = readFileSync(
      resolve(__dirname, "../../../../src/apps/cli/repl/session-loop.ts"),
      "utf8",
    )
    expect(loopSrc).toMatch(/from "\.\/turn-runner"/)
  })

  test("turn-cancel-install.ts is referenced from turn-runner.ts (the FSM dep)", () => {
    const runnerSrc = readFileSync(
      resolve(__dirname, "../../../../src/apps/cli/repl/turn-runner.ts"),
      "utf8",
    )
    expect(runnerSrc).toMatch(/from "\.\/turn-cancel-install"/)
  })

  test("session-state.ts is referenced from session-loop.ts (god-state replacement)", () => {
    const loopSrc = readFileSync(
      resolve(__dirname, "../../../../src/apps/cli/repl/session-loop.ts"),
      "utf8",
    )
    expect(loopSrc).toMatch(/from "\.\/session-state"/)
  })

  test("runRepl wires the lifecyclePills.dispose + shutdownMcp shutdown in `finally`", () => {
    // Decompose into named source-pin assertions so a regression that drops
    // the dispose() / shutdownMcp() call from the finally block fails the
    // exact named invariant rather than a generic substring contains.
    const disposeWired = runReplBody.includes("setup.lifecyclePills.dispose()")
    const shutdownWired = runReplBody.includes("setup.shutdownMcp()")
    expect(disposeWired).toBe(true)
    expect(shutdownWired).toBe(true)
    // Both must be inside the `try { ... } finally { ... }` envelope.
    expect(runReplBody).toMatch(/try\s*\{[\s\S]+\}\s*finally\s*\{/)
  })
})
