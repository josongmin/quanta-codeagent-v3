/**
 * CAPABILITY PROBE BOOTSTRAP E2E HELLGATE (ADR-0503 P3 / RFC §4).
 *
 * The capability consistency probe is now ARMED at session bootstrap behind the
 * strict master gate `QUANTA_CAPABILITY_LAYER`. This hellgate locks the
 * bootstrap-runner contract end-to-end:
 *
 *   1. MASTER GATE OFF ⇒ `runCapabilityProbe` is a byte-identical NO-OP: it
 *      returns [] WITHOUT calling the injected legacy-gate lookup even once. This
 *      is the #1 invariant — an un-armed bootstrap adds ZERO behavior (no probe,
 *      no log). RED-ON-INJECTION: if the runner ran the sweep when the gate is
 *      off (touching the injected lookup / returning results), this test fails.
 *   2. MASTER GATE ON ⇒ the runner sweeps EVERY declared capability × EVERY
 *      surface it declares, producing one probe result per pair.
 *   3. SPLIT-BRAIN DETECTION ⇒ when the injected legacy gate DISAGREES with the
 *      unified resolver for a capability, the runner SURFACES it as
 *      `agrees === false` (the drift it exists to catch) — observe-only, it
 *      mutates nothing.
 *   4. The seed registry caps are all reachable and probed under the gate.
 *
 * The runner is the pure seam the bootstrap calls (src/host/bootstrap/
 * bootstrap-session.ts → probeCapabilityConsistency → runCapabilityProbe); the
 * legacy per-surface gate is INJECTED so split-brain semantics are testable.
 */

import { describe, expect, test } from "bun:test"
import { gateOn } from "@/shared"
import {
  allCapabilities,
  type CapabilityDescriptor,
  type Surface,
  resolveExposure,
  runCapabilityProbe,
} from "@/capability"

// The injected legacy gate the bootstrap uses for the seed registry (llmTool
// caps): the tool's own env gate. Mirrors probeCapabilityConsistency.
const realLegacyGate = (env: Record<string, string | undefined>) => (cap: CapabilityDescriptor) =>
  gateOn(env, cap.gate.envKey)

describe("capability probe bootstrap e2e (ADR-0503 P3 hellgate)", () => {
  test("MASTER GATE OFF ⇒ runCapabilityProbe is a byte-identical no-op (returns [], lookup never called)", () => {
    let lookupCalls = 0
    const spyGate = (_cap: CapabilityDescriptor, _surface: Surface): boolean => {
      lookupCalls += 1
      return true
    }
    // All seed-cap gates ON, but the MASTER gate is absent ⇒ still a full no-op.
    const env: Record<string, string | undefined> = {
      QUANTA_WORKFLOW: "1",
      QUANTA_ARTIFACT_STORE: "1",
      QUANTA_IMAGE_GEN: "1",
      QUANTA_OFFICE_AUTHORING: "1",
    }
    const probes = runCapabilityProbe(env, spyGate)
    expect(probes).toEqual([])
    // RED-ON-INJECTION: the injected lookup MUST NOT be touched when off.
    expect(lookupCalls).toBe(0)
  })

  test("MASTER GATE strict ⇒ only the literal '1' arms; loose/off spellings stay no-op", () => {
    let lookupCalls = 0
    const spyGate = (): boolean => {
      lookupCalls += 1
      return true
    }
    // gateOnStrict arms ONLY on the exact literal "1" — `on`/`true`/`yes`/` 1 `
    // are REFUSED (arming a cross-cutting layer is a deliberate =1, never a stray
    // truthy value). Every one of these leaves the layer un-armed ⇒ byte-identical.
    for (const v of ["0", "off", "false", "", "2", "yes", "on", "true", " 1 "]) {
      const probes = runCapabilityProbe({ QUANTA_CAPABILITY_LAYER: v }, spyGate)
      expect(probes).toEqual([])
    }
    // none of the off/bogus/loose values should have triggered the sweep
    expect(lookupCalls).toBe(0)
  })

  test("MASTER GATE ON ⇒ sweeps every declared capability × surface", () => {
    const env: Record<string, string | undefined> = {
      QUANTA_CAPABILITY_LAYER: "1",
      QUANTA_WORKFLOW: "1",
      QUANTA_ARTIFACT_STORE: "1",
      QUANTA_IMAGE_GEN: "1",
      QUANTA_OFFICE_AUTHORING: "1",
    }
    const probes = runCapabilityProbe(env, realLegacyGate(env))
    // One probe per (cap, declared-surface) pair across the whole registry.
    const declaredPairs = allCapabilities().reduce((n, cap) => {
      return (
        n +
        (["llmTool", "slash", "skill", "hook", "thinClient"] as Surface[]).filter(
          (s) => cap.surfaces[s] === true,
        ).length
      )
    }, 0)
    expect(probes.length).toBe(declaredPairs)
    expect(probes.length).toBeGreaterThan(0)
    // Every seed capability id is represented.
    const ids = new Set(probes.map((p) => p.capabilityId))
    for (const cap of allCapabilities()) expect(ids.has(cap.id)).toBe(true)
    // With the real legacy gate (same env read) every pair AGREES.
    for (const p of probes) {
      expect(p.agrees).toBe(true)
      const cap = allCapabilities().find((c) => c.id === p.capabilityId)
      expect(cap).toBeDefined()
      if (cap) expect(p.resolved).toBe(resolveExposure(cap, p.surface, env))
    }
  })

  test("MASTER GATE ON + synthetic split-brain ⇒ DETECTED + surfaced (agrees=false)", () => {
    // Master ON, but tool gates OFF ⇒ resolver says NOT exposed. Inject a legacy
    // gate that LIES (claims the legacy surface is ON) ⇒ the two DISAGREE: the
    // exact split-brain drift the probe exists to surface.
    const env: Record<string, string | undefined> = {
      QUANTA_CAPABILITY_LAYER: "1",
      // every seed tool gate is OFF (absent)
    }
    const lyingLegacyGate = (_cap: CapabilityDescriptor, _surface: Surface): boolean => true
    const probes = runCapabilityProbe(env, lyingLegacyGate)
    expect(probes.length).toBeGreaterThan(0)
    // resolver=false (gate off), injected legacy=true ⇒ split-brain on EVERY pair.
    const splitBrain = probes.filter((p) => !p.agrees)
    expect(splitBrain.length).toBe(probes.length)
    for (const p of splitBrain) {
      expect(p.resolved).toBe(false)
      expect(p.legacy).toBe(true)
      expect(p.agrees).toBe(false)
    }
  })

  test("MASTER GATE ON + targeted single-cap split-brain is attributable", () => {
    const env: Record<string, string | undefined> = {
      QUANTA_CAPABILITY_LAYER: "1",
      QUANTA_WORKFLOW: "1",
      QUANTA_ARTIFACT_STORE: "1",
      QUANTA_IMAGE_GEN: "1",
      QUANTA_OFFICE_AUTHORING: "1",
    }
    // Legacy gate disagrees ONLY for "image-gen" (claims OFF while resolver=ON).
    const target = "image-gen"
    const targetedGate = (cap: CapabilityDescriptor): boolean =>
      cap.id === target ? false : gateOn(env, cap.gate.envKey)
    const probes = runCapabilityProbe(env, targetedGate)
    const splitBrain = probes.filter((p) => !p.agrees)
    expect(splitBrain.length).toBe(1)
    expect(splitBrain[0]?.capabilityId).toBe(target)
    expect(splitBrain[0]?.resolved).toBe(true)
    expect(splitBrain[0]?.legacy).toBe(false)
  })
})
