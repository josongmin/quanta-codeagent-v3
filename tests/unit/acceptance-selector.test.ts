/**
 * Driver-side acceptance selector factory — gating + sandbox-port composition.
 * Hermetic: fakes `withCandidatePatch` (records applied patches, returns the probe
 * result) + `reproResolvedOnSandbox`. Pins the OFF cases (⇒ legacy) and that the
 * built selector runs the repro probe THROUGH withCandidatePatch per candidate.
 */

import { describe, expect, test } from "bun:test"
import {
  buildReproAcceptanceSelector,
  type ReproAcceptancePorts,
} from "../../src/runner/batch/eval/acceptance-selector"
import type { RepairCandidateOutcome } from "../../src/runner/batch/eval/repair/types"

const outcome = (patch: string): RepairCandidateOutcome => ({
  run: { patch, turns: 1 },
  validator: { ok: false },
  adopt: async () => {},
})

/** Fake ports: withCandidatePatch applies the patch (records it) then runs the
 *  probe with a per-patch sandbox; reproResolvedOnSandbox resolves iff the sandbox
 *  encodes the fixing patch. */
const fakePorts = (
  resolvesOn: (patch: string) => boolean,
  applied: string[],
): ReproAcceptancePorts => ({
  withCandidatePatch: async (patch, probe) => {
    applied.push(patch)
    return probe(`sandbox:${patch}`) // sandbox carries the applied patch
  },
  reproResolvedOnSandbox: async (sandbox) => resolvesOn(sandbox.replace("sandbox:", "")),
})

describe("buildReproAcceptanceSelector — gating + composition", () => {
  test("OFF: enabled=false ⇒ undefined (legacy selection)", () => {
    const sel = buildReproAcceptanceSelector(
      false,
      ["repro.py"],
      fakePorts(() => true, []),
    )
    expect(sel).toBeUndefined()
  })

  test("OFF: empty reproSources ⇒ undefined (no oracle ⇒ legacy)", () => {
    const sel = buildReproAcceptanceSelector(
      true,
      [],
      fakePorts(() => true, []),
    )
    expect(sel).toBeUndefined()
  })

  test("ON: scores each candidate's repro THROUGH withCandidatePatch; picks the resolver", async () => {
    const applied: string[] = []
    const sel = buildReproAcceptanceSelector(
      true,
      ["repro.py"],
      fakePorts((patch) => patch === "P2", applied),
    )
    expect(sel).toBeDefined()
    const winner = await (sel as NonNullable<typeof sel>)([
      outcome("P1"),
      outcome("P2"),
      outcome("P3"),
    ])
    expect(winner.run.patch).toBe("P2") // the repro-resolving candidate
    expect(applied).toEqual(["P1", "P2", "P3"]) // each applied once via withCandidatePatch
  })

  test("ON: a null withCandidatePatch (failed apply) degrades that candidate to not-resolved", async () => {
    const applied: string[] = []
    const ports: ReproAcceptancePorts = {
      withCandidatePatch: async (patch, probe) => {
        applied.push(patch)
        if (patch === "BAD") return null // failed apply ⇒ degrade
        return probe(`sandbox:${patch}`)
      },
      reproResolvedOnSandbox: async (sandbox) => sandbox === "sandbox:GOOD",
    }
    const sel = buildReproAcceptanceSelector(true, ["r.py"], ports)
    const winner = await (sel as NonNullable<typeof sel>)([outcome("BAD"), outcome("GOOD")])
    expect(winner.run.patch).toBe("GOOD") // BAD degraded (null ⇒ false), GOOD wins
    expect(applied).toEqual(["BAD", "GOOD"])
  })
})
