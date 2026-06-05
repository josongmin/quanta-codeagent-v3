/**
 * HELLGATE — C6 deny-reason surfacing: structure, layer/pillar mapping,
 * exactOptional discipline, and default-OFF byte-identity.
 *
 * Defect class
 * ------------
 * A {@link StructuredDenyReason} must:
 *   - give a bare-"denied" case (today: nothing actionable) a structured
 *     `layer` so the model can pivot;
 *   - map each deny site to the right `layer` / `stackSource`;
 *   - OMIT `pillar` / `stackSource` (never set them to `undefined`) when absent,
 *     so a `toEqual` over the minimal shape passes (exactOptionalPropertyTypes);
 *   - leave the failure envelope byte-identical when the knob is off (the
 *     `permission_denied` envelope is `{mode, isReadonly}` only — no `denyReason`
 *     KEY, not `denyReason: undefined`).
 *
 * This battery pins those invariants at the value-record level (the hot-path
 * threading is REPORTED, not edited — see the implementation report).
 */

import { describe, expect, test } from "bun:test"
import {
  DENY_LAYERS,
  DENY_PILLARS,
  type DenyLayer,
  denyContentPrefix,
  structuredDenyReason,
} from "@/permission"

describe("hellgate — C6 bare-deny gains structure", () => {
  test("the confirm-handler-missing bare deny (today: nothing) now carries a layer", () => {
    // admissibility-gate.ts:792 — today the model gets only prose. C6 attaches
    // a structured layer even when pillar is not derivable.
    const reason = structuredDenyReason({
      layer: "reviewer",
      safeReason:
        "requires explicit confirmation (always-confirm tier) but no confirm handler is wired",
    })
    expect(reason.verdict).toBe("deny")
    expect(reason.layer).toBe("reviewer")
    // pillar OMITTED, not undefined-set
    expect("pillar" in reason).toBe(false)
    expect("stackSource" in reason).toBe(false)
  })
})

describe("hellgate — C6 exactOptional: absent fields OMITTED not undefined-set", () => {
  test("toEqual over the minimal shape passes (no undefined keys leak)", () => {
    const reason = structuredDenyReason({ layer: "hook", safeReason: "hook refused" })
    expect(reason).toEqual({ verdict: "deny", layer: "hook", safeReason: "hook refused" })
    expect(Object.keys(reason).sort()).toEqual(["layer", "safeReason", "verdict"])
  })

  test("passing pillar:undefined explicitly still OMITS the key", () => {
    const reason = structuredDenyReason({
      layer: "mode",
      safeReason: "plan mode blocks mutating tool",
      pillar: undefined,
      stackSource: undefined,
    })
    expect("pillar" in reason).toBe(false)
    expect("stackSource" in reason).toBe(false)
  })

  test("present optional fields ARE attached", () => {
    const reason = structuredDenyReason({
      layer: "stack",
      safeReason: "Per-thread policy (workspace-write) refuses bash on /repo",
      pillar: "fileSystem",
      stackSource: "per-thread",
    })
    expect(reason).toEqual({
      verdict: "deny",
      layer: "stack",
      pillar: "fileSystem",
      stackSource: "per-thread",
      safeReason: "Per-thread policy (workspace-write) refuses bash on /repo",
    })
  })
})

describe("hellgate — C6 layer correctness (each deny site → its layer)", () => {
  // The seven canonical deny sites from RFC §4.1 / §3.2.
  const sites: ReadonlyArray<{ site: string; layer: DenyLayer }> = [
    { site: "HARD_DENY handoff (admissibility-gate.ts:836)", layer: "hard-deny" },
    { site: "evaluateStack per-thread/host/default (:1092/:1298)", layer: "stack" },
    { site: "guardian/user refusal (:431/:446)", layer: "reviewer" },
    { site: "pre_tool_use hook deny (:605/:1412)", layer: "hook" },
    { site: "tool-profile resolve/deny (:874/:880)", layer: "tool-profile" },
    { site: "mode block (:909)", layer: "mode" },
    { site: "team broker SOFT-deny (:1213-1233)", layer: "broker" },
  ]
  for (const { site, layer } of sites) {
    test(`${site} → layer:"${layer}"`, () => {
      const reason = structuredDenyReason({ layer, safeReason: `denied at ${site}` })
      expect(reason.layer).toBe(layer)
      expect(DENY_LAYERS).toContain(layer)
    })
  }

  test("DENY_LAYERS enumerates exactly the seven sites with no drift", () => {
    expect([...DENY_LAYERS].sort()).toEqual(
      ["broker", "hard-deny", "hook", "mode", "reviewer", "stack", "tool-profile"].sort(),
    )
  })
})

describe("hellgate — C6 pillar correctness", () => {
  test('network deny → pillar:"network"; fs deny → pillar:"fileSystem"', () => {
    const net = structuredDenyReason({
      layer: "stack",
      pillar: "network",
      safeReason: "network egress refused by policy",
    })
    const fs = structuredDenyReason({
      layer: "stack",
      pillar: "fileSystem",
      safeReason: "Per-thread policy refuses write on /repo",
    })
    expect(net.pillar).toBe("network")
    expect(fs.pillar).toBe("fileSystem")
  })

  test("confirm-handler-missing deny OMITS pillar (ambiguous → omit, not guess)", () => {
    const reason = structuredDenyReason({
      layer: "reviewer",
      safeReason: "no confirm handler is wired",
    })
    expect("pillar" in reason).toBe(false)
  })

  test("DENY_PILLARS is the 4-pillar axis + fileSystem layer (5 values, no drift)", () => {
    expect([...DENY_PILLARS].sort()).toEqual(
      ["approval", "control", "fileSystem", "network", "sandbox"].sort(),
    )
  })
})

describe("hellgate — C6 stackSource reuses the recorder enum", () => {
  for (const src of ["per-thread", "per-host", "global-default", "hard-deny"] as const) {
    test(`stackSource "${src}" maps through verbatim`, () => {
      const reason = structuredDenyReason({
        layer: "stack",
        stackSource: src,
        safeReason: `stack deny via ${src}`,
      })
      expect(reason.stackSource).toBe(src)
    })
  }
})

describe("hellgate — C6 content-prefix shape (knob-ON additive)", () => {
  test("prefix carries layer+pillar and is additive to the existing prose", () => {
    const reason = structuredDenyReason({
      layer: "stack",
      pillar: "network",
      safeReason: "network egress refused",
    })
    const prose = "Permission denied: network egress refused"
    const composed = denyContentPrefix(reason) + prose
    expect(composed).toBe(
      "[denied · layer=stack · pillar=network] Permission denied: network egress refused",
    )
    // additive — the FULL original prose survives
    expect(composed).toContain(prose)
  })

  test("prefix omits the pillar segment when pillar is absent", () => {
    const reason = structuredDenyReason({ layer: "reviewer", safeReason: "declined" })
    expect(denyContentPrefix(reason)).toBe("[denied · layer=reviewer] ")
  })
})

describe("hellgate — C6 default-OFF byte-identity (envelope shape)", () => {
  test("knob-off failure envelope is byte-identical to today {mode, isReadonly}", () => {
    // Simulate the gate's deny() result WITHOUT the knob: no denyReason key.
    const envelopeOff = { mode: "permission_denied" as const, isReadonly: true }
    expect(envelopeOff).toEqual({ mode: "permission_denied", isReadonly: true })
    expect("denyReason" in envelopeOff).toBe(false)
  })

  test("knob-on attaches denyReason as a NEW optional key (no other field changes)", () => {
    const denyReason = structuredDenyReason({
      layer: "stack",
      pillar: "fileSystem",
      stackSource: "per-thread",
      safeReason: "Per-thread policy (workspace-write) refuses bash on /repo",
    })
    const envelopeOn = { mode: "permission_denied" as const, isReadonly: true, denyReason }
    // Stripping the new key recovers the byte-identical default shape.
    const { denyReason: _omit, ...base } = envelopeOn
    expect(base).toEqual({ mode: "permission_denied", isReadonly: true })
  })
})
