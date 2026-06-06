/**
 * Ratchet — security/capability-dangerous gates MUST use the STRICT env primitive
 * (`gateOnStrict` / `gateDisabledStrict` — exact literal `1`, fail-closed) and
 * never the lenient `gateOn` / `gateDisabled` (which also accept `on`/`true`/
 * `yes`). Loosening such a gate broadens activation of a dangerous capability on
 * a typo or loose spelling.
 *
 * This guard exists because exactly that regressed once: `QUANTA_LLM_CREDENTIAL_
 * TRUSTED` — the sole channel authorizing the credential-helper SHELL (arbitrary
 * command execution) — was silently migrated from strict `=== "1"` to loose
 * `gateOn`, while every other dangerous gate in the same commit kept the strict
 * primitive. Source-scan red-on-injection: flipping any pinned gate back to the
 * lenient primitive fails this test.
 *
 * To intentionally change a gate's strictness you must edit BOTH the wiring and
 * this list — a deliberate, reviewed security decision, never an incidental
 * migration.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const SRC = readFileSync(join(import.meta.dir, "../../src/shared/runtime-config.ts"), "utf8")

/** Gates whose ON form must be `gateOnStrict(env, "NAME")`. `why` documents the
 *  dangerous capability the gate activates (the reason loose spellings are unsafe). */
const STRICT_ON_GATES: ReadonlyArray<readonly [name: string, why: string]> = [
  ["QUANTA_LLM_CREDENTIAL_TRUSTED", "arbitrary command execution via the credential-helper shell"],
  ["QUANTA_CODE_MODE", "arbitrary in-VM code execution surface"],
  ["QUANTA_CODE_MODE_ONLY", "code-mode-only tool surface"],
  ["QUANTA_UNTRUSTED_ENVELOPE", "untrusted-content security envelope"],
  ["QUANTA_EXFIL_SCOUTING", "egress exfil-scouting security gate"],
  ["QUANTA_GLOB_WRITE_GUARD", "filesystem write guard"],
  ["QUANTA_EDIT_REPAIR_LOOP", "autonomous edit-repair loop"],
  ["QUANTA_SKILL_MCP_DEPS", "skill-declared MCP dependency activation"],
  ["QUANTA_BG_COMPACTION", "background compaction"],
]

/** Gates whose DISABLE form must be `gateDisabledStrict(env, "NAME")` — turning
 *  OFF a safety mechanism is at least as dangerous as turning ON a capability. */
const STRICT_DISABLE_GATES: ReadonlyArray<readonly [name: string, why: string]> = [
  ["QUANTA_FS_JAIL", "disabling the filesystem jail"],
  ["QUANTA_LOG_RATE_LIMIT", "disabling log rate limiting"],
]

const wiring = (fn: string, name: string): RegExp =>
  new RegExp(`${fn}\\(\\s*env,\\s*"${name}"\\s*\\)`)

describe("dangerous gates use the STRICT env primitive (ratchet)", () => {
  for (const [name, why] of STRICT_ON_GATES) {
    test(`${name} (${why}) wired with gateOnStrict, NOT loose gateOn`, () => {
      // strict wiring present
      expect(SRC).toMatch(wiring("gateOnStrict", name))
      // and the LOOSE form is absent (gateOnStrict\( does not match gateOn\( —
      // the char after "gateOn" is "S", not "(")
      expect(SRC).not.toMatch(wiring("gateOn", name))
    })
  }

  for (const [name, why] of STRICT_DISABLE_GATES) {
    test(`${name} (${why}) wired with gateDisabledStrict, NOT loose gateDisabled`, () => {
      expect(SRC).toMatch(wiring("gateDisabledStrict", name))
      expect(SRC).not.toMatch(wiring("gateDisabled", name))
    })
  }

  test("the strict-gate inventory is non-empty (guard is live, not vacuous)", () => {
    expect(STRICT_ON_GATES.length + STRICT_DISABLE_GATES.length).toBeGreaterThanOrEqual(11)
  })
})
