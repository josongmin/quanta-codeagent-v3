/**
 * `tests/_helpers/js-runner-fixture` — a PINNED, BOUNDED, optionally
 * PRE-BUILT jest/mocha project for the `js-test-runner` capability group.
 *
 * # What this replaces
 *
 * Both `runtime-jest-real-e2e.test.ts` and `runtime-mocha-real-e2e.test.ts`
 * did their install like this, at MODULE SCOPE:
 *
 *     const r = Bun.spawnSync(["npm", "i", "--silent", "--no-audit",
 *                              "--no-fund", "jest"], { cwd: dir, … })
 *     const dir = REAL_E2E && has("npm", "--version") ? installJestProject() : null
 *
 * Three separate defects in four lines:
 *
 *   1. UNPINNED. `npm i jest` resolves to whatever is current the day the job
 *      runs. The two tests pin OPPOSITE contracts — jest transforms the source
 *      so a file:line CDP breakpoint cannot bind (runtime MUST be null), mocha
 *      runs in-process so it MUST capture `result = 10` — and a major bump can
 *      flip either. An unpinned install turns that into an unexplainable red
 *      with no version anywhere in the output.
 *   2. UNBOUNDED. No `timeout`. A registry that stalls hangs the serial
 *      `test:real-toolchain` lane forever, with no diagnostic.
 *   3. AT MODULE LOAD. The install ran while the module was being evaluated,
 *      before any test began. Module-load time is invisible to
 *      `tools/dev/unit-speed-budget.ts` (which reads per-CASE durations), so
 *      the cost was real and unmeasured.
 *
 * # The shape now
 *
 *   - versions come from `JS_RUNNER_FIXTURES` in the capability manifest and go
 *     into the receipt, so "jest passed" names an artifact.
 *   - `QUANTA_JS_RUNNER_FIXTURE_ROOT` lets a SETUP job pre-build the project
 *     once (`<root>/<runner>/node_modules/.bin/<runner>`); when it is present
 *     and complete the test performs ZERO network I/O.
 *   - the fallback install is `--save-exact <pkg>@<version>` under an explicit
 *     `timeout`, and it happens in a caller-invoked setup step, never at import.
 *   - a failed install is `failed-setup` (a THROW), never a skip: the capability
 *     was present, so a broken fixture is a defect in the lane.
 */

import { cpSync, existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  FIXTURE_INSTALL_TIMEOUT_MS,
  JS_RUNNER_FIXTURES,
} from "../../tools/dev/test-capability-manifest"
import { capabilitySetupFailed, probeBounded } from "./capability-lane"

export type JsRunnerName = keyof typeof JS_RUNNER_FIXTURES

export interface JsRunnerFixture {
  readonly dir: string
  readonly runner: JsRunnerName
  readonly version: string
  /** "prebuilt" when a setup job supplied it; "installed" when npm ran here. */
  readonly source: "prebuilt" | "installed"
  readonly receipt: Readonly<Record<string, string>>
}

const binPath = (dir: string, runner: JsRunnerName): string =>
  join(dir, "node_modules", ".bin", runner)

const prebuiltRoot = (runner: JsRunnerName): string | null => {
  const root = process.env.QUANTA_JS_RUNNER_FIXTURE_ROOT
  if (root === undefined || root === "") return null
  const candidate = join(root, runner)
  return existsSync(binPath(candidate, runner)) ? candidate : null
}

const npmVersion = (): string => {
  const npm = Bun.which("npm", { PATH: process.env.PATH ?? "" })
  if (npm === null) return "<missing>"
  const result = Bun.spawnSync([npm, "--version"], {
    stdout: "pipe",
    stderr: "ignore",
    timeout: 15_000,
  })
  return result.exitCode === 0 ? result.stdout.toString().trim() : "<unreadable>"
}

/**
 * Materialize the fixture. Call from `beforeAll`, never at module scope.
 *
 * `testFileName`/`testFileBody` are the failing test the caller drives; they are
 * written here so the project is complete in one place.
 */
export const prepareJsRunnerFixture = (input: {
  readonly runner: JsRunnerName
  readonly group: string
  readonly file: string
  readonly testFileName: string
  readonly testFileBody: string
}): JsRunnerFixture => {
  const version = JS_RUNNER_FIXTURES[input.runner]
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `qrt-${input.runner}-`)))
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify(
      {
        name: "quanta-runner-fixture",
        version: "0.0.0",
        private: true,
        // Pinned EXACTLY (no caret): the contract each test asserts is
        // version-specific, so a range would make the fixture non-reproducible.
        devDependencies: { [input.runner]: version },
      },
      null,
      2,
    )}\n`,
  )
  writeFileSync(join(dir, input.testFileName), input.testFileBody)

  const prebuilt = prebuiltRoot(input.runner)
  if (prebuilt !== null) {
    // A setup job already resolved and installed this exact version. Copy the
    // tree rather than re-resolving it: zero network, and the fixture the test
    // runs is byte-identical to the one the setup step produced.
    cpSync(join(prebuilt, "node_modules"), join(dir, "node_modules"), { recursive: true })
    return {
      dir,
      runner: input.runner,
      version,
      source: "prebuilt",
      receipt: {
        [`${input.runner}Version`]: version,
        npmVersion: npmVersion(),
        fixtureSource: `prebuilt:${prebuilt}`,
      },
    }
  }

  const npm = Bun.which("npm", { PATH: process.env.PATH ?? "" })
  if (npm === null) {
    return capabilitySetupFailed(
      input.group,
      input.file,
      "npm disappeared between the capability gate and the setup step",
    )
  }
  // BOUNDED. `Bun.spawnSync` honours `timeout` (verified on Bun 1.3.14), so a
  // stalled registry ends as a failed setup with a message instead of a hang.
  const install = probeBounded(
    [
      npm,
      "install",
      "--no-audit",
      "--no-fund",
      "--save-exact",
      "--prefer-offline",
      `${input.runner}@${version}`,
    ],
    FIXTURE_INSTALL_TIMEOUT_MS,
    dir,
  )
  if (!install.ok || !existsSync(binPath(dir, input.runner))) {
    return capabilitySetupFailed(
      input.group,
      input.file,
      install.timedOut
        ? `npm install ${input.runner}@${version} exceeded ${FIXTURE_INSTALL_TIMEOUT_MS}ms`
        : `npm install ${input.runner}@${version} failed (${install.stderr.trim()}); ` +
            `no ${binPath(dir, input.runner)}`,
      { [`${input.runner}Version`]: version },
    )
  }
  return {
    dir,
    runner: input.runner,
    version,
    source: "installed",
    receipt: {
      [`${input.runner}Version`]: version,
      npmVersion: npmVersion(),
      fixtureSource: "installed:registry",
    },
  }
}
