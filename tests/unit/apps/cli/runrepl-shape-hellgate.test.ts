// meta-test: locks the textual shape of src/apps/cli/repl.ts (no unit import —
// these assertions read the source as text on purpose).
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

// Lock the runRepl shape so a future round cannot silently re-grow the
// previous monolith. These assertions are textual on purpose.

const replPath = resolve(__dirname, "../../../../src/apps/cli/repl.ts")
const replSrc = readFileSync(replPath, "utf8")

const extractRunReplBody = (): string => {
  const marker = "export const runRepl = async (): Promise<void> => {"
  const start = replSrc.indexOf(marker)
  if (start === -1) throw new Error("runRepl not found in repl.ts")

  let depth = 0
  for (let i = start; i < replSrc.length; i++) {
    const ch = replSrc[i]
    if (ch === "{") depth += 1
    else if (ch === "}") {
      depth -= 1
      if (depth === 0) return replSrc.slice(start, i + 1)
    }
  }

  throw new Error("runRepl body never closed")
}

const runReplBody = extractRunReplBody()

describe("runRepl shape contract", () => {
  // NOTE: The "runRepl stays declarative" intent (no inline `let`, no inline
  // turn/installTurnCancel closures — i.e. runRepl delegates rather than
  // re-inlining the turn loop) is verified BEHAVIORALLY and far more robustly
  // by session-setup-hellgate.test.ts (boots setupSession, asserts each factory
  // was invoked + result shape) and session-loop-hellgate.test.ts (calls
  // runSessionLoop, asserts prompt driving + close). The former no-`let` /
  // no-inline-closure source-token greps were brittle style proxies (a
  // behavior-preserving refactor reddened them, a real regression slipped
  // through) and were removed in favour of those behavioral checks.

  test("runRepl body calls the orchestration helpers", () => {
    expect(runReplBody).toContain("setupSession(")
    expect(runReplBody).toContain("runSessionLoop(")
  })

  test("the six helper modules exist on disk", () => {
    const helpers = [
      "../../../../src/apps/cli/repl/turn-runner.ts",
      "../../../../src/apps/cli/repl/turn-cancel-install.ts",
      "../../../../src/apps/cli/repl/session-state.ts",
      "../../../../src/apps/cli/repl/prompt-pipeline.ts",
      "../../../../src/apps/cli/repl/session-setup.ts",
      "../../../../src/apps/cli/repl/session-loop.ts",
    ]
    for (const rel of helpers) {
      readFileSync(resolve(__dirname, rel), "utf8")
    }
    expect(helpers).toHaveLength(6)
  })

  test("repl.ts imports setupSession and runSessionLoop from the slice dir", () => {
    expect(replSrc).toMatch(/from "\.\/repl\/session-setup"/)
    expect(replSrc).toMatch(/from "\.\/repl\/session-loop"/)
  })

  test("session-loop.ts references turn-runner.ts", () => {
    const loopSrc = readFileSync(
      resolve(__dirname, "../../../../src/apps/cli/repl/session-loop.ts"),
      "utf8",
    )
    expect(loopSrc).toMatch(/from "\.\/turn-runner"/)
  })

  test("turn-runner.ts references turn-cancel-install.ts", () => {
    const runnerSrc = readFileSync(
      resolve(__dirname, "../../../../src/apps/cli/repl/turn-runner.ts"),
      "utf8",
    )
    expect(runnerSrc).toMatch(/from "\.\/turn-cancel-install"/)
  })

  test("session-loop.ts references session-state.ts", () => {
    const loopSrc = readFileSync(
      resolve(__dirname, "../../../../src/apps/cli/repl/session-loop.ts"),
      "utf8",
    )
    expect(loopSrc).toMatch(/from "\.\/session-state"/)
  })

  test("runRepl finally block invokes lifecycle exit calls", () => {
    expect(runReplBody.includes("setup.lifecyclePills.dispose()")).toBe(true)
    expect(runReplBody.includes("setup.shutdownMcp()")).toBe(true)
    expect(runReplBody).toMatch(/try\s*\{[\s\S]+\}\s*finally\s*\{/)
  })
})
