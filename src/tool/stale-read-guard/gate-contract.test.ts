import { describe, expect, test } from "bun:test"
import { gateOn } from "@/shared"
import { STALE_READ_GUARD_ENV, staleReadGuardEnabled } from "./gate"

/**
 * gate-doc-structural (SE-audit) — pin the documented gate contracts to the
 * READER behavior so a future doc/reader drift fails CI.
 *
 * Background: several gate docs claimed a STRICT one/on-only contract that the
 * canonical readers do NOT implement (loose `gateOn` vocab) or vice-versa. This
 * suite converts the whole CLASS to a single CI signal:
 *   (a) QUANTA_STALE_READ_GUARD — a DEFAULT-ON staleness/correctness guard that
 *       must honor the STANDARD kill-switch vocabulary (any falsy token
 *       disables), NOT a strict `=off`-only posture. The disable-via-falsy path
 *       is the red-on-injection: before the fix `=0`/`=false`/`=no` were
 *       silently ignored and the guard stayed ON.
 *   (b) followup_task gate / (c) env-probe gate — both route through the loose
 *       `gateOn` SSOT, so their readers accept the SAME vocab and the docs are
 *       corrected to match (asserted structurally below).
 */
describe("stale-read-guard gate contract (default-ON kill-switch vocab)", () => {
  test("unset ⇒ guard ON (default-ON)", () => {
    expect(staleReadGuardEnabled({})).toBe(true)
  })

  // Red-on-injection: the prior `gateDisabledStrict` reader honored ONLY `=off`,
  // so each of these falsy tokens would have left the guard ON (test FAILS).
  test.each([
    "off",
    "0",
    "false",
    "no",
    "OFF",
    " off ",
    "FALSE",
  ])("falsy token %p DISABLES the guard", (token) => {
    expect(staleReadGuardEnabled({ [STALE_READ_GUARD_ENV]: token })).toBe(false)
  })

  test("`=off` still disables (backward-compatible with the legacy kill-switch + bench opt-out)", () => {
    expect(staleReadGuardEnabled({ [STALE_READ_GUARD_ENV]: "off" })).toBe(false)
  })

  test.each([
    "1",
    "on",
    "true",
    "yes",
    "garbage",
    "",
  ])("non-falsy value %p keeps the guard ON", (token) => {
    expect(staleReadGuardEnabled({ [STALE_READ_GUARD_ENV]: token })).toBe(true)
  })
})

/**
 * Structural class guard: the gates whose DOCS describe the loose `gateOn`
 * vocabulary must actually resolve via `gateOn` (accept ALL truthy tokens, NOT
 * a strict literal `"1"`/`"on"`). If a reader were tightened back to a strict
 * `=== "1"` / `=== "on"` while the doc still claims loose vocab, this fails.
 */
describe("loose `gateOn` gates accept the full truthy vocabulary", () => {
  const GATE_ON_GATES = [
    // (b) followup_task — optional-ports `envGateOn` → gateOn (doc: manifest.ts followup_task note)
    "QUANTA_SUBAGENT_FOLLOWUP",
    // (c) env-probe — env-probe-wire `isGateOn` → gateOn (doc: probe.ts ProbeOpts.enabled)
    "QUANTA_ENABLE_ENV_PROBE",
  ]

  test.each(GATE_ON_GATES)("%s: every truthy token activates", (name) => {
    for (const token of ["1", "on", "true", "yes", "ON", " 1 "]) {
      expect(gateOn({ [name]: token }, name)).toBe(true)
    }
  })

  test.each(GATE_ON_GATES)("%s: unset / falsy / empty ⇒ OFF", (name) => {
    expect(gateOn({}, name)).toBe(false)
    for (const token of ["0", "off", "false", "no", ""]) {
      expect(gateOn({ [name]: token }, name)).toBe(false)
    }
  })
})
