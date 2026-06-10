/**
 * T-02 — JS/TS test-runner routing for the Node CDP runtime. The Node runtime
 * runs the failing FILE under `node --inspect-brk` (ONE process, so CDP attaches
 * to the test process). Which entrypoint to run depends on the runner:
 *
 *  - node:test / plain file → run the file directly (it self-runs inline).
 *  - jest  → `jest --runInBand <file>` — `--runInBand` keeps tests in the MAIN
 *            process (no worker pool), so the inspector attaches to them.
 *  - mocha → `mocha <file>` — mocha runs in-process by default.
 *  - vitest → DEGRADE (null): vitest runs tests in a worker pool/fork and owns
 *            its own `--inspect-brk` on the worker, so `node --inspect-brk` on the
 *            CLI process would attach to the wrong process. Worker-inspector
 *            handling is a follow-up (same multi-process shape as js-debug).
 *
 * Pure functions (no IO) so the routing is unit-testable without installing any
 * runner; the caller reads package.json + spawns.
 */

export type JsRunner = "node" | "jest" | "mocha" | "vitest"

/** Pick the JS runner from a package.json's (dev)dependencies. Unknown / no
 *  package.json ⇒ "node" (run the file directly). NEVER throws. */
export const detectJsRunner = (pkgJson: string | null): JsRunner => {
  if (pkgJson === null) return "node"
  let pkg: { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> }
  try {
    pkg = JSON.parse(pkgJson)
  } catch {
    return "node"
  }
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
  // Precedence: vitest > jest > mocha (a repo with several keeps the primary).
  if ("vitest" in deps) return "vitest"
  if ("jest" in deps) return "jest"
  if ("mocha" in deps) return "mocha"
  return "node"
}

/** Build the SINGLE-PROCESS `node --inspect-brk` argv for the runner, or `null`
 *  when the runner can't be driven single-process (vitest). `file` is the
 *  absolute failing-test file. */
export const nodeInspectArgv = (runner: JsRunner, node: string, file: string, port: number): readonly string[] | null => {
  const brk = `--inspect-brk=${port}`
  switch (runner) {
    case "node":
      return [node, brk, file]
    case "jest":
      // --runInBand ⇒ tests run in THIS process (no workers) → inspector attaches.
      return [node, brk, "node_modules/.bin/jest", "--runInBand", file]
    case "mocha":
      return [node, brk, "node_modules/.bin/mocha", file]
    case "vitest":
      return null // worker-pool / owns its own inspector — follow-up
  }
}
