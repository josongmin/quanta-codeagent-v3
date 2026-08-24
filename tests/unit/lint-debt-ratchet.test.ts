/**
 * HELLGATE — the lint-debt ceiling is reachable from `bun test`.
 *
 * This repo gates growth with one-directional ratchets, and five of them are
 * `tests/unit/*-ratchet.test.ts`: god-code, silent-failure-growth, pm-dod, the
 * two default-off-ledger rails. Running `bun test tests/unit/` therefore catches
 * a regression in any of them.
 *
 * `lint:debt` was the exception. It lives only as a `package.json` script
 * (`tools/dev/lint-debt-ceiling.ts`), so a change sweep that ran the whole unit
 * suite — the thing every contributor and every agent actually does — could not
 * see it. Measured: it went RED on main (`noTemplateCurlyInString 24 > 22`)
 * while all five sibling ratchets stayed green, and the regression survived a
 * full `bun test tests/unit/` pass plus a `typecheck:all` pass.
 *
 * That is not a lint problem. It is a REACHABILITY problem: a guard nobody's
 * normal command can reach is a guard that only fires after the fact, in
 * someone else's session.
 *
 * This wraps the SHIPPED script — spawning it, not reimplementing its counting —
 * so the test can never drift from what `bun run lint:debt` reports. A
 * reimplementation would be a second authority, which is the failure mode the
 * ratchet itself exists to prevent.
 */

import { describe, expect, test } from "bun:test"

const REPO_ROOT = new URL("../../", import.meta.url).pathname

describe("lint-debt ceiling — reachable from the unit suite", () => {
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
