/**
 * ★ CONTRACT — tools/pm Definition-of-Done judgment (the executable rule).
 *
 * `checkFeatureDoD` is the pure heart of `bun tools/pm/check.ts`. It must:
 *   - FAIL a claimed-wired (L3+) feature missing ANY of {catalog, tdd, e2e}.
 *   - PASS one that has all three (incl. recognizing `*-hellgate` / `*e2e*` as
 *     the e2e axis, whether listed under unit OR integration).
 *   - EXEMPT an honestly-held L1/L2 seam to a catalog-only bar (so scaffolding
 *     is not falsely failed for lacking an e2e) — UNLESS `--strict`.
 */

import { describe, expect, test } from "bun:test"
import type { Feature } from "../../tools/feature-catalog/schema"
import { checkFeatureDoD, heldToFullBar } from "../../tools/pm/definition-of-done"

/** Minimal Feature factory — only the fields the DoD reads. */
const feat = (over: {
  maturity?: string
  code?: string[]
  adrs?: (number | string)[]
  unit?: string[]
  integration?: string[]
}): Feature =>
  ({
    id: "test-feature",
    title: "t",
    section: 1,
    subsystem: "s",
    order: 0,
    maturity: over.maturity ?? "L3",
    status: "stable",
    owners: [],
    labels: [],
    depends_on: [],
    lifecycle_stage: "active",
    supersedes: [],
    ui_surfaces: [],
    monitoring: "n-a",
    modes: [],
    configurable: "n-a",
    telemetry_keys: [],
    config_refs: {},
    purpose: "p",
    evidence: {
      code: over.code ?? [],
      adrs: over.adrs ?? [],
      tests: { unit: over.unit ?? [], integration: over.integration ?? [], contract: [] },
    },
    knobs: [],
    deliberate_hold: null,
  }) as unknown as Feature

const FULL = {
  maturity: "L3",
  code: ["src/x.ts"],
  adrs: [1],
  unit: ["tests/unit/x.test.ts"],
  integration: ["tests/unit/x-e2e-hellgate.test.ts"],
}

describe("A. full-bar (L3+) features must clear all three axes", () => {
  test("A1 — all three present ⇒ pass", () => {
    const r = checkFeatureDoD(feat(FULL))
    expect(r.verdict).toBe("pass")
    expect(r.catalog.ok && r.tdd.ok && r.e2eHellgate.ok).toBe(true)
  })

  test("A2 — missing ADR ⇒ catalog fails ⇒ fail", () => {
    expect(checkFeatureDoD(feat({ ...FULL, adrs: [] })).verdict).toBe("fail")
  })

  test("A3 — no unit tests ⇒ tdd fails ⇒ fail", () => {
    expect(checkFeatureDoD(feat({ ...FULL, unit: [] })).verdict).toBe("fail")
  })

  test("A4 — only plain unit tests, no hellgate/e2e ⇒ e2e axis fails ⇒ fail", () => {
    const r = checkFeatureDoD(feat({ ...FULL, integration: [], unit: ["tests/unit/x.test.ts"] }))
    expect(r.e2eHellgate.ok).toBe(false)
    expect(r.verdict).toBe("fail")
  })

  test("A5 — a *-hellgate test under UNIT (not integration) still satisfies e2e", () => {
    const r = checkFeatureDoD(
      feat({ ...FULL, integration: [], unit: ["tests/unit/x-hellgate.test.ts"] }),
    )
    expect(r.e2eHellgate.ok).toBe(true)
    expect(r.verdict).toBe("pass")
  })
})

describe("B. seam exemption (L1/L2 ⇒ catalog-only) + strict override", () => {
  test("B1 — an L2 seam with only catalog evidence ⇒ pass (catalog-only bar)", () => {
    const r = checkFeatureDoD(feat({ maturity: "L2", code: ["src/x.ts"], adrs: [1] }))
    expect(r.fullBar).toBe(false)
    expect(r.verdict).toBe("pass")
  })

  test("B2 — same L2 seam under --strict ⇒ held to full bar ⇒ fail (no tests)", () => {
    const r = checkFeatureDoD(feat({ maturity: "L2", code: ["src/x.ts"], adrs: [1] }), true)
    expect(r.fullBar).toBe(true)
    expect(r.verdict).toBe("fail")
  })

  test("B3 — heldToFullBar: L3 always, L2 only under strict", () => {
    expect(heldToFullBar(feat({ maturity: "L3" }), false)).toBe(true)
    expect(heldToFullBar(feat({ maturity: "L2" }), false)).toBe(false)
    expect(heldToFullBar(feat({ maturity: "L2" }), true)).toBe(true)
  })
})
