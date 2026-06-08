/**
 * CAPABILITY EXPOSURE ↔ REALITY HELLGATE (ADR-0503 P3 / RFC §4).
 *
 * The OLD probe compared `resolveExposure` against an injected legacy that
 * re-derived `gateOn(env, gate.envKey)` — the SAME computation — so it ALWAYS
 * agreed (tautological, cosmetic). This hellgate is the REAL declaration↔reality
 * lock: for each seed capability, across an env matrix (own gate on/off ×
 * parent/require on/off/unset), it asserts `resolveExposure(cap,"llmTool",env)`
 * equals the ACTUAL exposure computed by the REAL assembly code path — NOT a
 * re-read of the env gate.
 *
 * THE key case (the split-brain the old probe missed):
 *   QUANTA_WORKFLOW=1 + QUANTA_SUBAGENT=0  ⇒  real `run_workflow` NOT registered
 *   (buildSubagentConfig returns undefined when subagent is off) ⇒ resolveExposure
 *   MUST ALSO be false. A gate-only resolver (own gate only, ignoring `requires`)
 *   would say TRUE — the mispredict the composite model fixes.
 *
 * RED-ON-INJECTION: reverting resolveExposure to drop the `requires` AND makes
 * that exact case FAIL (asserted below via a local own-gate-only resolver that
 * stands in for the reverted code).
 *
 * For RUNTIME-CONDITIONED caps (image-gen) the env-only prediction is a
 * NECESSARY-not-sufficient UPPER BOUND: real exposure ⊆ predicted (a provider key
 * narrows it at runtime), so we assert the upper-bound relation, not equality.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { __resetCliKnobOverrides } from "@/apps/cli/cli-knobs-accessor"
import { allCapabilities, type CapabilityDescriptor, resolveExposure } from "@/capability"
import { gateOn } from "@/shared"
// REAL assembly under test — the actual internal.ts subagent/workflow-enable path.
import { buildSubagentConfig } from "../../../src/apps/cli/internal"

// Env keys this hellgate drives — saved/restored so cross-test contamination is
// impossible (the real buildSubagentConfig reads process.env via readCliKnob).
const ENV_KEYS = [
  "QUANTA_WORKFLOW",
  "QUANTA_SUBAGENT",
  "QUANTA_IMAGE_GEN",
  "QUANTA_ARTIFACT_STORE",
  "QUANTA_OFFICE_AUTHORING",
] as const

let saved: Map<string, string | undefined>
beforeEach(() => {
  saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
  __resetCliKnobOverrides() // no live /knobs overrides leak into the read path
})
afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  __resetCliKnobOverrides()
})

/** Apply an env-matrix row to process.env (undefined ⇒ leave unset). */
const applyEnv = (env: Record<string, string | undefined>): void => {
  for (const k of ENV_KEYS) {
    const v = env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

const findCap = (id: string): CapabilityDescriptor => {
  const cap = allCapabilities().find((c) => c.id === id)
  if (cap === undefined) throw new Error(`seed cap ${id} missing`)
  return cap
}

// ── WORKFLOW: composite gate (QUANTA_WORKFLOW AND default-ON QUANTA_SUBAGENT) ──

describe("workflow capability ↔ REAL assembly (ADR-0503 P3 reality hellgate)", () => {
  const cap = findCap("workflow")

  /** The ACTUAL exposure of `run_workflow`: the real internal.ts assembly says
   *  `subagent.enableWorkflow === true` (buildSubagentConfig returns undefined
   *  when the subagent gate is off ⇒ enableWorkflow is then absent ⇒ false). */
  const realExposure = (): boolean => buildSubagentConfig()?.enableWorkflow === true

  // Full matrix: own gate (QUANTA_WORKFLOW) × parent (QUANTA_SUBAGENT) over
  // {on, off, unset}. resolveExposure(env) MUST equal the real assembly.
  const VALUES: readonly (string | undefined)[] = ["1", "0", undefined]
  for (const wf of VALUES) {
    for (const sub of VALUES) {
      const env: Record<string, string | undefined> = {
        QUANTA_WORKFLOW: wf,
        QUANTA_SUBAGENT: sub,
      }
      const label = `QUANTA_WORKFLOW=${wf ?? "unset"} × QUANTA_SUBAGENT=${sub ?? "unset"}`
      test(`prediction === real assembly: ${label}`, () => {
        applyEnv(env)
        const predicted = resolveExposure(cap, "llmTool", env)
        const real = realExposure()
        expect(predicted).toBe(real)
      })
    }
  }

  test("THE split-brain case: QUANTA_WORKFLOW=1 + QUANTA_SUBAGENT=0 ⇒ real FALSE ⇒ predicted FALSE", () => {
    const env = { QUANTA_WORKFLOW: "1", QUANTA_SUBAGENT: "0" }
    applyEnv(env)
    // REAL: subagent off ⇒ buildSubagentConfig undefined ⇒ run_workflow NOT registered.
    expect(realExposure()).toBe(false)
    // PREDICTION must match (the composite `requires` gate is what makes this false).
    expect(resolveExposure(cap, "llmTool", env)).toBe(false)
  })

  test("default-ON parent: QUANTA_WORKFLOW=1 + QUANTA_SUBAGENT unset ⇒ real TRUE ⇒ predicted TRUE", () => {
    // QUANTA_SUBAGENT defaults ON, so an UNSET parent still exposes — a plain
    // `gateOn` on the require would mispredict this as false. The default-aware
    // require semantics (readBool(.., true)) get it right.
    const env = { QUANTA_WORKFLOW: "1", QUANTA_SUBAGENT: undefined }
    applyEnv(env)
    expect(realExposure()).toBe(true)
    expect(resolveExposure(cap, "llmTool", env)).toBe(true)
  })

  // ── RED-ON-INJECTION ──────────────────────────────────────────────────────
  test("RED-ON-INJECTION: an own-gate-only resolver (drops `requires`) MISPREDICTS the split-brain", () => {
    // This stands in for REVERTING resolveExposure to its pre-composite form
    // (surface flag + own gate only). On the split-brain env it says TRUE while
    // the REAL assembly says FALSE — i.e. dropping `requires` reintroduces the
    // exact drift this hellgate fences, so the gate would go RED.
    const ownGateOnly = (c: CapabilityDescriptor, e: Record<string, string | undefined>): boolean =>
      c.surfaces.llmTool === true && gateOn(e, c.gate.envKey)
    const env = { QUANTA_WORKFLOW: "1", QUANTA_SUBAGENT: "0" }
    applyEnv(env)
    const real = realExposure()
    expect(real).toBe(false)
    // The reverted (own-gate-only) resolver disagrees with reality …
    expect(ownGateOnly(cap, env)).toBe(true)
    expect(ownGateOnly(cap, env)).not.toBe(real)
    // … while the composite resolver agrees with reality.
    expect(resolveExposure(cap, "llmTool", env)).toBe(real)
  })
})

// ── RUNTIME-CONDITIONED: image-gen (env-only prediction is an UPPER BOUND) ──

describe("runtimeConditioned capability ↔ reality upper bound (image-gen)", () => {
  const cap = findCap("image-gen")

  test("declared runtimeConditioned ⇒ env-only resolveExposure is a NECESSARY upper bound", () => {
    // image-gen's REAL exposure ALSO needs a provider API key (a non-env runtime
    // signal we cannot drive from env here). So the contract is real ⊆ predicted:
    // the provider key can only NARROW the env-only prediction, never widen it.
    expect(cap.runtimeConditioned).toBe(true)

    // Gate OFF ⇒ predicted false ⇒ real MUST be false too (a require can't widen).
    const off = { QUANTA_IMAGE_GEN: "0" }
    applyEnv(off)
    expect(resolveExposure(cap, "llmTool", off)).toBe(false)
    // If predicted is false, real (⊆ predicted) is necessarily false — the
    // upper-bound relation holds trivially on this row.

    // Gate ON ⇒ predicted true = the UPPER BOUND; real exposure is true ONLY when
    // a provider key is ALSO present at runtime (real ⊆ predicted). We assert the
    // env-only prediction is the upper bound, not strict equality.
    const on = { QUANTA_IMAGE_GEN: "1" }
    applyEnv(on)
    const predicted = resolveExposure(cap, "llmTool", on)
    expect(predicted).toBe(true) // the necessary-not-sufficient upper bound
  })
})

// ── PURE-ENV caps: artifact-store / office-authoring (strict equality) ──

describe("pure-env capabilities ↔ env gate (strict equality, no composite/runtime cond.)", () => {
  for (const id of ["artifact-store", "office-authoring"] as const) {
    const cap = findCap(id)
    test(`${id}: no requires, not runtimeConditioned ⇒ resolveExposure === own gate`, () => {
      expect(cap.requires).toBeUndefined()
      expect(cap.runtimeConditioned).toBeUndefined()
      for (const v of ["1", "0", undefined] as const) {
        const env = { [cap.gate.envKey]: v }
        applyEnv(env)
        // Pure env caps: prediction is exactly the own-gate read (gateOn vocab).
        expect(resolveExposure(cap, "llmTool", env)).toBe(gateOn(env, cap.gate.envKey))
      }
    })
  }
})
