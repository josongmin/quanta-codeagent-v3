/**
 * CAPABILITY EXPOSURE E2E HELLGATE (ADR-0503 P3 / RFC §4).
 *
 * The single cross-surface exposure resolver must be the ONE place a feature's
 * surface gating is decided — killing split-brain drift (tool on / slash off).
 * This hellgate locks the end-to-end contract:
 *
 *   1. surfaces{llmTool:true, slash:false} + gate ON
 *        ⇒ resolveExposure(llmTool)=true, resolveExposure(slash)=false
 *   2. gate OFF ⇒ ALL surfaces false
 *   3. QUANTA_CAPABILITY_LAYER OFF ⇒ byte-identical no-op: the consistency PROBE
 *      (the only live wiring) returns undefined and asserts NOTHING, so the legacy
 *      per-surface gates are authoritative and untouched.
 *   4. RED-ON-INJECTION: loosening resolveExposure to IGNORE the surface flag (the
 *      split-brain bug we are fencing) makes the assertions FAIL.
 *
 * Also locks the master-gate consistency probe: when QUANTA_CAPABILITY_LAYER is
 * ON, resolveExposure MUST AGREE with the legacy per-surface gate read for a
 * capability (a drift detector that never mutates behavior).
 */

import { describe, expect, test } from "bun:test"
import type { CapabilityDescriptor, Surface } from "@/capability"
import { probeExposureConsistency, resolveExposure } from "@/capability"
import { gateOn } from "@/shared"

const cap: CapabilityDescriptor = {
  id: "split-brain-cap",
  gate: { envKey: "QUANTA_SPLIT_BRAIN_CAP" },
  surfaces: { llmTool: true, slash: false },
  describe: "tool exposed, slash deliberately not — the split-brain fence",
}

describe("capability exposure e2e (ADR-0503 P3 hellgate)", () => {
  test("surfaces{llmTool:true,slash:false} + gate ON ⇒ tool true, slash false", () => {
    const env = { QUANTA_SPLIT_BRAIN_CAP: "1" }
    expect(resolveExposure(cap, "llmTool", env)).toBe(true)
    expect(resolveExposure(cap, "slash", env)).toBe(false)
  })

  test("gate OFF ⇒ ALL surfaces false", () => {
    for (const env of [
      { QUANTA_SPLIT_BRAIN_CAP: "0" },
      { QUANTA_SPLIT_BRAIN_CAP: "off" },
      {} as Record<string, string | undefined>,
    ]) {
      const all: Surface[] = ["llmTool", "slash", "skill", "hook", "thinClient"]
      for (const s of all) expect(resolveExposure(cap, s, env)).toBe(false)
    }
  })

  // ── MASTER GATE: QUANTA_CAPABILITY_LAYER ──────────────────────────────────

  test("QUANTA_CAPABILITY_LAYER OFF ⇒ probe is a byte-identical no-op (returns undefined)", () => {
    // Layer off ⇒ probe declines to assert anything; legacy gates stay authoritative.
    const env = { QUANTA_SPLIT_BRAIN_CAP: "1" }
    expect(probeExposureConsistency(cap, "llmTool", env)).toBeUndefined()
    expect(probeExposureConsistency(cap, "slash", env)).toBeUndefined()
  })

  test("QUANTA_CAPABILITY_LAYER ON ⇒ probe AGREES with legacy per-surface gate", () => {
    // When ON, the probe cross-checks resolveExposure against the legacy gate read.
    // For an EXPOSED surface the legacy gate (gateOn) and resolveExposure agree;
    // the probe returns { resolved, legacy, agrees } with agrees === true.
    const env = { QUANTA_CAPABILITY_LAYER: "1", QUANTA_SPLIT_BRAIN_CAP: "1" }
    const legacyToolGate = gateOn(env, cap.gate.envKey)
    const probe = probeExposureConsistency(cap, "llmTool", env)
    expect(probe).toBeDefined()
    expect(probe?.legacy).toBe(legacyToolGate)
    expect(probe?.resolved).toBe(resolveExposure(cap, "llmTool", env))
    expect(probe?.agrees).toBe(true)
  })

  test("QUANTA_CAPABILITY_LAYER ON ⇒ probe FLAGS split-brain on a non-exposed surface", () => {
    // slash is NOT exposed ⇒ resolveExposure=false, but the legacy gate (env) is
    // ON ⇒ they DISAGREE. The probe surfaces this as agrees=false (the drift it
    // exists to catch). It still does not MUTATE behavior — it only reports.
    const env = { QUANTA_CAPABILITY_LAYER: "1", QUANTA_SPLIT_BRAIN_CAP: "1" }
    const probe = probeExposureConsistency(cap, "slash", env)
    expect(probe).toBeDefined()
    expect(probe?.resolved).toBe(false)
    expect(probe?.legacy).toBe(true)
    expect(probe?.agrees).toBe(false)
  })

  // ── RED-ON-INJECTION ──────────────────────────────────────────────────────

  test("loosening resolveExposure to ignore the surface flag would FAIL this gate", () => {
    // The fence: a gate-only resolver (ignores surfaces[surface]) would report a
    // non-exposed surface as exposed when the gate is on — the split-brain bug.
    const env = { QUANTA_SPLIT_BRAIN_CAP: "1" }
    const looseResolve = (
      c: CapabilityDescriptor,
      _s: Surface,
      e: Record<string, string | undefined>,
    ) => gateOn(e, c.gate.envKey) // BUG: ignores the surface flag
    // The correct resolver says slash=false; the loose one says slash=true.
    expect(resolveExposure(cap, "slash", env)).toBe(false)
    expect(looseResolve(cap, "slash", env)).toBe(true)
    // Asserting the correct contract would catch the loosening (these differ).
    expect(resolveExposure(cap, "slash", env)).not.toBe(looseResolve(cap, "slash", env))
  })
})
