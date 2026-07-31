/**
 * T-02 — JS/TS test-runner routing for the Node CDP runtime. The Node runtime
 * runs the failing FILE under `node --inspect-brk` (ONE process, so CDP attaches
 * to the test process). Which entrypoint to run depends on the runner:
 *
 *  - node:test / plain file → run the file directly (it self-runs inline).
 *  - mocha → `mocha <file>` — mocha runs the source AS-IS in-process, so a CDP
 *            file:line breakpoint binds (VERIFIED end-to-end).
 *  - jest → DEGRADE (null): although `--runInBand` is single-process, jest
 *            TRANSFORMS the source (babel-jest) and runs it via `vm`, so a CDP
 *            `setBreakpointByUrl` on the original file URL does NOT bind to the
 *            executing (transformed) module — the breakpoint never hits. (Real
 *            e2e caught this: failure+static localize fine via the `●` parser,
 *            but runtime capture fails.) Failure+static still work for jest;
 *            sourcemap-aware runtime is a follow-up.
 *  - vitest → DEGRADE (null): worker pool/fork owns its own `--inspect-brk`;
 *            `node --inspect-brk` on the CLI attaches to the wrong process.
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
export const nodeInspectArgv = (
  runner: JsRunner,
  node: string,
  file: string,
  port: number,
): readonly string[] | null => {
  const brk = `--inspect-brk=${port}`
  switch (runner) {
    case "node":
      return [node, brk, file]
    case "mocha":
      return [node, brk, "node_modules/.bin/mocha", file]
    case "jest":
      return null // single-process but TRANSFORMS source ⇒ file:line bp won't bind
    case "vitest":
      return null // worker-pool / owns its own inspector — follow-up
  }
}
