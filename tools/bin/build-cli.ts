/**
 * Build the compiled CLI binary WITH its own identity baked in.
 *
 * # Why this is a script and not a longer `bun build` line
 *
 * The stamp needs three values computed before the build (commit, dirty, time),
 * and `package.json` scripts cannot compute them portably — a shell `$(…)`
 * substitution is not the same on every shell the repo is built from, and the
 * install script already learned that lesson elsewhere.
 *
 * # Why `--env` and not `--define`
 *
 * `bun build` has NO `--define` flag (measured, bun 1.3.14: it is absent from
 * `--help`, and passing it exits 0 while substituting nothing). An implementation
 * built on it produces an unstamped binary that reports success — the worst
 * possible failure for a provenance feature. `--env='QUANTA_BUILD_*'` inlines the
 * matching `process.env` reads as literals, which `build-stamp.ts` is written
 * against.
 *
 * # Ordering that matters
 *
 * The stamp is captured BEFORE anything else can touch the tree. `install-quanta-
 * cli.sh` bumps `package.json` and then builds; capturing after that bump would
 * make every single build read `dirty`, which is worse than no stamp because it is
 * a stamp that always lies in the same direction.
 *
 * Verify a stamped binary from OUTSIDE the repo. Inside it, `resolveVersion`'s
 * walk up to `package.json` succeeds and hides a missing stamp — the same trap
 * `compiled-binary-asset-parity` records for wasm assets.
 */
import { spawnSync } from "node:child_process"

const git = (...args: readonly string[]): string => {
  const r = spawnSync("git", [...args], { encoding: "utf8" })
  return r.status === 0 ? (r.stdout ?? "").trim() : ""
}

/** Empty when git is unavailable or this is not a checkout — the stamp is then
 *  absent rather than wrong, and `--version` renders exactly as it did before. */
const commit = git("rev-parse", "--short=12", "HEAD")
const dirty = git("status", "--porcelain") === "" ? "0" : "1"
const buildTime = new Date().toISOString()

if (commit === "") {
  // A silent unstamped build is the exact failure the stamp exists to prevent.
  // biome-ignore lint/suspicious/noConsole: build-tool operator output.
  console.warn("build-cli: no git commit resolved — building WITHOUT a build stamp")
}

const args = [
  "build",
  "--compile",
  "--minify",
  "--env=QUANTA_BUILD_*",
  "src/apps/cli/index.ts",
  "--outfile",
  "dist/agent",
]

const result = spawnSync("bun", args, {
  stdio: "inherit",
  env: {
    ...process.env,
    QUANTA_BUILD_COMMIT: commit,
    QUANTA_BUILD_DIRTY: dirty,
    QUANTA_BUILD_TIME: buildTime,
  },
})

if (result.status !== 0) process.exit(result.status ?? 1)
// The operator has to be able to read back what got baked in.
// biome-ignore lint/suspicious/noConsole: build-tool operator output.
console.log(
  `build-cli: dist/agent built · commit=${commit || "(none)"} dirty=${dirty} at ${buildTime}`,
)
