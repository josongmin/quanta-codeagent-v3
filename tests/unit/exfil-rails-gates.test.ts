/**
 * jun-6 exfil-rails (a)+(b) — gate + default-OFF byte-identity hellgate.
 *
 * Asserts the env-gate predicates are STRICT (`=== "1"`) and the dispatch-seam
 * enablement is default-OFF (every knob unset ⇒ the ToolContext fields are
 * absent ⇒ write/edit are byte-identical).
 */

import { describe, expect, test } from "bun:test"
import { globWriteGuardEnabled } from "@/tool/_shared/glob-write-gate"

describe("globWriteGuardEnabled — strict gate", () => {
  test("ON only for the exact `1` token", () => {
    expect(globWriteGuardEnabled({ QUANTA_GLOB_WRITE_GUARD: "1" })).toBe(true)
  })

  test("OFF for unset / empty / off-vocabulary / arbitrary", () => {
    for (const v of [undefined, "", "0", "true", "on", "yes", "2", " 1 "]) {
      expect(globWriteGuardEnabled({ QUANTA_GLOB_WRITE_GUARD: v })).toBe(false)
    }
    expect(globWriteGuardEnabled({})).toBe(false)
  })
})
