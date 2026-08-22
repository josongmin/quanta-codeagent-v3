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
  regressionFailureCount,
} from "../../src/runner/batch/eval/acceptance-selector"
import type { RepairCandidateOutcome } from "../../src/runner/batch/eval/repair/types"

describe("regressionFailureCount — RegressionResult → acceptance count", () => {
  test("ran && pass ⇒ 0 (clean)", () => {
    expect(regressionFailureCount({ ran: true, pass: true, failed: [] })).toBe(0)
  })
  test("ran && !pass ⇒ failed-test count", () => {
    expect(regressionFailureCount({ ran: true, pass: false, failed: ["t1", "t2"] })).toBe(2)
  })
  test("!ran ⇒ +Infinity (SUSPECT, not 0 — a patch that breaks collection must not win)", () => {
    // The real bug: a patched tree where pytest can't collect (syntax error from the
    // patch) returns ran:false. Scoring 0 would let it WIN the min-regression bar.
    expect(regressionFailureCount({ ran: false, pass: false, failed: [] })).toBe(
      Number.POSITIVE_INFINITY,
    )
    // even pass:true (the oracle's no-tests-collected shape) with !ran ⇒ Infinity
    expect(regressionFailureCount({ ran: false, pass: true, failed: [] })).toBe(
      Number.POSITIVE_INFINITY,
    )
  })
})

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

  test("DUAL-GUARD ENGAGES: regression probe supplied ⇒ picks repro-pass + min-regression", async () => {
    const regrSeen: string[] = []
    const ports: ReproAcceptancePorts = {
      withCandidatePatch: async (patch, probe) => probe(`sandbox:${patch}`),
      reproResolvedOnSandbox: async () => true, // both pass repro
      regressionFailuresOnSandbox: async (sandbox) => {
        const patch = sandbox.replace("sandbox:", "")
        regrSeen.push(patch)
        return patch === "A" ? 0 : 3 // A has fewer regression failures
      },
    }
    const sel = buildReproAcceptanceSelector(true, ["r.py"], ports)
    const winner = await (sel as NonNullable<typeof sel>)([outcome("A"), outcome("B")])
    // dual-guard active ⇒ min-regression A wins (not a repro-only tie).
    expect(winner.run.patch).toBe("A")
    expect(regrSeen).toEqual(["A", "B"]) // the regression probe actually ran per candidate
  })

  test("regression null apply ⇒ +Infinity failures (loses the min bar)", async () => {
    const ports: ReproAcceptancePorts = {
      withCandidatePatch: async (patch, probe) =>
        patch === "BROKEN" ? null : probe(`sandbox:${patch}`),
      reproResolvedOnSandbox: async () => true,
      regressionFailuresOnSandbox: async () => 0,
    }
    const sel = buildReproAcceptanceSelector(true, ["r.py"], ports)
    const winner = await (sel as NonNullable<typeof sel>)([outcome("BROKEN"), outcome("OK")])
    expect(winner.run.patch).toBe("OK") // BROKEN: null apply ⇒ Infinity regression ⇒ loses
  })
})
