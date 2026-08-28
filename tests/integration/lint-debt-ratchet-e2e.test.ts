/**
 * The `lint:debt` ceiling, actually RUN — the reachability half of
 * `tests/unit/lint-debt-ratchet.test.ts`.
 *
 * `lint:debt` lives only as a `package.json` script
 * (`tools/dev/lint-debt-ceiling.ts`), so a change sweep that ran a test suite —
 * the thing every contributor and every agent actually does — could not see it.
 * Measured: it went RED on main (`noTemplateCurlyInString 24 > 22`) while all
 * five sibling `*-ratchet.test.ts` guards stayed green, and the regression
 * survived a full `bun test tests/unit/` pass plus a `typecheck:all` pass.
 *
 * This wraps the SHIPPED script — spawning it, not reimplementing its counting —
 * so it can never drift from what `bun run lint:debt` reports. A
 * reimplementation would be a second authority, which is the failure mode the
 * ratchet itself exists to prevent.
 *
 * WHY tests/integration AND NOT tests/unit. It shells out to biome across
 * ~7,200 files: measured 9,297ms on an idle machine and 20,868ms under load,
 * against a per-test unit budget of 8,529ms (`tools/dev/unit-speed-budget.json`)
 * that may only ever go DOWN. That budget's own error text names the remedy —
 * "Move it to tests/integration or fake the slow dependency" — and faking is
 * ruled out by the second-authority argument above. `bun run test` (the
 * documented pre-push gate) and the CI pyramid both run tests/integration, so
 * reachability is kept; only the budget scope changes.
 */

import { describe, expect, test } from "bun:test"

const REPO_ROOT = new URL("../../", import.meta.url).pathname

describe("lint-debt ceiling — the shipped script actually runs green", () => {
  test(
    "`lint:debt` passes (no new lint debt; fix the site, never raise the ceiling)",
    () => {
      const run = Bun.spawnSync({
        cmd: ["bun", "run", "tools/dev/lint-debt-ceiling.ts"],
        cwd: REPO_ROOT,
      })
      const stdout = new TextDecoder().decode(run.stdout)
      const stderr = new TextDecoder().decode(run.stderr)
      // Surface the script's own diagnosis on failure — the ceiling file names
      // the offending rule and both numbers, which is what the fixer needs.
      expect({ exitCode: run.exitCode, report: `${stdout}${stderr}`.trim() }).toEqual({
        exitCode: 0,
        report: expect.stringContaining("lint-debt:") as unknown as string,
      })
    },
    { timeout: 180_000 },
  )
})
