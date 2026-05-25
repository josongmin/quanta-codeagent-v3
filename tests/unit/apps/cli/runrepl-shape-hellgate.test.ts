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
  test("runRepl stays at or under 65 LOC", () => {
    // RELAXED 50 → 65 post-CLI-01/04/05/06+ARCH-07 merge: the host now also
    // composes the execution-plane deps + conv-checkpoint store before
    // calling `composeSurfaceWires` (~12 LOC of legitimate composition). The
    // cap still prevents re-bloating the body with imperative turn logic.
    const lines = runReplBody.split("\n").length
    expect(lines).toBeLessThanOrEqual(65)
  })

  test("runRepl body has no let declarations", () => {
    expect(runReplBody).not.toMatch(/^\s*let\s+/m)
  })

  test("runRepl body calls the orchestration helpers", () => {
    expect(runReplBody).toContain("setupSession(")
    expect(runReplBody).toContain("runSessionLoop(")
  })

  test("runRepl body has no inline turn closure", () => {
    expect(runReplBody).not.toContain("const turn = async (text:")
    expect(runReplBody).not.toContain("const wrapTurn =")
  })

  test("runRepl body has no inline installTurnCancel definition", () => {
    expect(runReplBody).not.toContain("const installTurnCancel = (")
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
