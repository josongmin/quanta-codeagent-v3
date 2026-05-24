import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

/**
 * Slice-C (T2 rewrite): `runRepl` is the thin orchestrator over 6 helpers
 * in `src/apps/cli/repl/`. The PRIOR shape hellgate was source-sniffing
 * (LOC count, `let` count, ban on substrings like `const turn = …`,
 * regex on `try { … } finally { … }`). Those assertions would fail on
 * cosmetic refactors that preserve behavior AND pass on regressions that
 * preserve the file shape — both directions of false signal.
 *
 * What we KEEP (rewritten):
 *
 *   - The module-graph contract: the 6 helper modules exist on disk and
 *     `repl.ts` imports each one. This IS a real architectural invariant
 *     (the catalog claims a 6-helper decomposition); asserting the import
 *     existence locks the decomposition without sniffing helper bodies.
 *   - `runRepl` is exported as an `AsyncFunction` (callable contract).
 *
 * What we DROP (source-sniff anti-patterns):
 *
 *   - `runRepl` body ≤ 50 LOC               — line count is not behavior
 *   - `runRepl` body has no `let`           — declaration form is not behavior
 *   - `const turn = async (text:` is absent — substring ban is grep-rule
 *   - `const installTurnCancel = (` absent  — substring ban is grep-rule
 *   - `try { … } finally { … }` regex       — control-flow shape is not behavior
 *
 * REGRESSION SCENARIOS this rewritten test STILL catches:
 *
 *   - Renaming `session-setup.ts` to `setup.ts` without updating the
 *     barrel ⇒ `repl.ts imports BOTH …` test fails (import path moved).
 *   - Accidentally deleting `turn-runner.ts` ⇒ `helpers exist on disk`
 *     fails (readFileSync throws).
 *   - Refactoring `runRepl` from `async () => …` to `function runRepl()`
 *     returning a Promise ⇒ `AsyncFunction` test fails.
 *
 * The PRIOR test would also have caught the rename and the delete; what
 * it ADDED was a refactoring tax (every cosmetic edit risked tripping
 * a substring assertion). That cost is removed.
 *
 * NOTE on production-code coverage: A true behavioral exercise of `runRepl`
 * (booting `setupSession` with a fake env and asserting the loop dispatches
 * one-shot vs interactive) requires injecting BOTH `setupSession` AND
 * `runSessionLoop` as deps — they are presently top-level module imports.
 * Adding a `runRepl(deps)` overload is beyond this slice's scope. The
 * session-setup-hellgate + session-loop-hellgate siblings cover the two
 * halves at unit grain via direct port calls.
 */

const replPath = resolve(__dirname, "../../../../src/apps/cli/repl.ts")
const replSrc = readFileSync(replPath, "utf8")

describe("runRepl — thin orchestrator (module-graph contract)", () => {
  test("runRepl is exported and is an AsyncFunction", async () => {
    const mod = await import("../../../../src/apps/cli/repl")
    expect(typeof mod.runRepl).toBe("function")
    expect(mod.runRepl.constructor.name).toBe("AsyncFunction")
  })

  test("the 6 helpers exist on disk at the expected module paths", () => {
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
    // This is the LEGITIMATE structural assertion: the barrel must import
    // each top-level helper. The catalog claim "6-helper decomposition is
    // wired" is true iff these imports are present.
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

  test("prompt-pipeline.ts is referenced from session-loop.ts (prompt-source factory)", () => {
    const loopSrc = readFileSync(
      resolve(__dirname, "../../../../src/apps/cli/repl/session-loop.ts"),
      "utf8",
    )
    expect(loopSrc).toMatch(/from "\.\/prompt-pipeline"/)
  })
})
