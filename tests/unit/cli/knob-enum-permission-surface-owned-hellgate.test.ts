/**
 * Hellgate — `/knobs set QUANTA_PERMISSION=…` checks the mode set, and `@/config`
 * does not import `@/permission` to do it.
 *
 * The set was added (27d7735ef) inside `@/config/knob-catalog.ts` by importing
 * `ALL_PERMISSION_MODES` from `@/permission`. That broke the `@/config` slice
 * deny-list, and the commit carried no test of the gate it claimed to close. The set
 * now lives in the CLI wire, which composes the registries anyway.
 *
 * Driven through the ASSEMBLED `knobsCmd` (no stubbed wire), so the gate that runs is
 * the one production runs. `QUANTA_PERMISSION` is also a security-boundary knob, so a
 * VALID mode is refused by the next gate; that difference is what proves the enum gate
 * ran first for an invalid one.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { __resetCliKnobOverrides } from "../../../src/apps/cli/cli-knobs-accessor"
import { buildKnobCatalog, knobEnumValues } from "../../../src/apps/cli/knob-catalog-wire"
import "../../../src/apps/cli/knobs-bootstrap" // registry side-effect, as production does
import { knobsCmd } from "../../../src/apps/cli/slash-commands-knobs"
import type { SlashContext } from "../../../src/apps/cli/slash-contract"
import { knobEnumValues as configKnobEnumValues } from "../../../src/config/knob-catalog"
import { ALL_PERMISSION_MODES } from "../../../src/permission"

const setKnob = async (pair: string): Promise<{ code: number; err: string }> => {
  let err = ""
  const ctx = {
    out: () => {},
    err: (c: string) => {
      err += c
    },
    cwd: "/tmp",
  } as unknown as SlashContext
  const code = await knobsCmd.run(["set", pair], ctx)
  return { code: code as number, err }
}

afterEach(() => {
  __resetCliKnobOverrides()
})

describe("QUANTA_PERMISSION enum gate is surface-owned", () => {
  test("the catalog declares it an enum, so the membership gate applies", () => {
    expect(buildKnobCatalog().get("QUANTA_PERMISSION")?.kind).toBe("enum")
  })

  test("the wire's set is the closed union; @/config's own map has none", () => {
    expect(knobEnumValues("QUANTA_PERMISSION")).toEqual([...ALL_PERMISSION_MODES])
    expect(configKnobEnumValues("QUANTA_PERMISSION")).toBeUndefined()
    // …and the config-owned sets still pass through the wire.
    expect(knobEnumValues("QUANTA_LOG_LEVEL")).toEqual(configKnobEnumValues("QUANTA_LOG_LEVEL"))
  })

  test("a spelling outside the set is rejected by the enum gate, naming the set", async () => {
    const r = await setKnob("QUANTA_PERMISSION=bypassPermissions")
    expect(r.code).toBe(1)
    expect(r.err).toContain(`must be one of {${ALL_PERMISSION_MODES.join(", ")}}`)
  })

  test("a valid mode passes the enum gate and meets the security-boundary refusal", async () => {
    const r = await setKnob("QUANTA_PERMISSION=bypass")
    expect(r.code).toBe(1)
    expect(r.err).not.toContain("must be one of")
    expect(r.err).toContain("security-boundary knob")
  })
})
