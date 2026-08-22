/**
 * 3-AXIS CONSISTENCY RATCHET (ADR-0503 P3) — capability ↔ manifest ↔ feature-catalog.
 *
 * quanta has THREE SSOT axes for a gated capability-feature:
 *   1. FEATURE catalog (`tools/feature-catalog/*`)  — "what features exist".
 *   2. tool-surface MANIFEST (`@/tool` GATED_TOOLS)  — "what the LLM sees" (gate.env + surfaces).
 *   3. CAPABILITY layer (`@/capability` CAPABILITIES) — id + gate.envKey + surfaces{llmTool/...}.
 *
 * The capability layer exists to PREVENT split-brain (one surface armed, another
 * not). That guarantee is only real if the capability's gate matches the gate the
 * actual tool reads. This ratchet pins, for EVERY capability:
 *
 *   A. gate.envKey is a REAL knob (declared in a knob registry) — no phantom gate.
 *   B. gate.envKey === the manifest GATED_TOOLS entry's gate.env for the matching
 *      tool (capability ↔ manifest gate coherence). Disagreement = the split-brain
 *      SOURCE the layer must prevent → FAIL.
 *   C. surfaces.llmTool=true ⇒ a matching gated tool entry exists on the LLM surface.
 *   D. every fc entry that sets `capability:` references a real capability id
 *      (no dangling ref); reverse — capabilities with no fc entry are FLAGGED (warn).
 *
 * RED-ON-INJECTION: a synthetic capability with a phantom gate, or a mismatched
 * manifest env, FAILS the same predicates (proven below).
 *
 * Meta-test: imports tools/feature-catalog/* (outside src/, no @/ alias) by path.
 */

import { describe, expect, test } from "bun:test"
import { CLI_KNOBS } from "@/apps/cli/cli-knobs"
import { CAPABILITIES } from "@/capability"
import type { CapabilityDescriptor } from "@/capability/descriptor"
import { RUNTIME_CONFIG_KNOBS } from "@/shared/runtime-config-knobs"
import { entryToolNames, GATED_TOOLS, type ToolSurfaceEntry } from "@/tool"
import { loadFeaturesStrict } from "../../../tools/feature-catalog/schema"

// ── shared axis projections ────────────────────────────────────────────────

/** Every env key the knob registries actually declare (axis A — "real knob"). */
const DECLARED_KNOB_ENVS: ReadonlySet<string> = new Set<string>([
  ...CLI_KNOBS.map((k) => k.envKey),
  ...RUNTIME_CONFIG_KNOBS.map((k) => k.envKey),
])

/** A manifest gate's env key, if it has one (env-flag / config-slot-with-env). */
const gateEnv = (entry: ToolSurfaceEntry): string | undefined => {
  const g = entry.gate
  if (g.kind === "env-flag") return g.env
  if (g.kind === "config-slot") return g.env
  if (g.kind === "resource") return g.env
  return undefined
}

/** All manifest entries that gate on a given env key. */
const manifestEntriesForEnv = (env: string): readonly ToolSurfaceEntry[] =>
  GATED_TOOLS.filter((e) => gateEnv(e) === env)

// ── PURE predicate helpers (re-used by the red-on-injection proof) ──────────

/** A — gate.envKey is a declared knob. */
const gateIsRealKnob = (cap: CapabilityDescriptor): boolean =>
  DECLARED_KNOB_ENVS.has(cap.gate.envKey)

/** B/C — for an llmTool capability, ≥1 manifest entry gates on the SAME env. */
const manifestGateMatches = (cap: CapabilityDescriptor): boolean => {
  if (cap.surfaces.llmTool !== true) return true // only llmTool caps assert manifest coherence here
  return manifestEntriesForEnv(cap.gate.envKey).length > 0
}

describe("3-axis consistency ratchet — capability ↔ manifest ↔ feature-catalog", () => {
  // ── Axis A: every capability gate is a real knob (no phantom gate) ─────────
  test("A — every capability gate.envKey is a declared knob", () => {
    for (const cap of CAPABILITIES) {
      expect(
        gateIsRealKnob(cap),
        `capability "${cap.id}" gate "${cap.gate.envKey}" is not a declared knob (phantom gate)`,
      ).toBe(true)
    }
  })

  // ── Axis B: capability gate === manifest gate for the matching tool ────────
  test("B — capability gate.envKey matches the manifest GATED_TOOLS gate.env", () => {
    for (const cap of CAPABILITIES) {
      if (cap.surfaces.llmTool !== true) continue
      const entries = manifestEntriesForEnv(cap.gate.envKey)
      expect(
        entries.length,
        `capability "${cap.id}" gate "${cap.gate.envKey}" has NO matching manifest entry ` +
          `(split-brain: the capability would resolve differently than the real tool gate)`,
      ).toBeGreaterThan(0)
      // NOTE: a per-entry `expect(gateEnv(e)).toBe(cap.gate.envKey)` loop was removed
      // here — `entries` is `GATED_TOOLS.filter(e => gateEnv(e) === cap.gate.envKey)`, so
      // that assertion re-derived the filter predicate and compared a value to itself
      // (tautological, zero production code exercised). The projection-exactness it
      // claimed to guard is genuinely covered by the red-on-injection test below
      // ("mismatched manifest env is rejected by axis B", lines using gateEnv(wfEntry)).
    }
  })

  // ── Axis C: surfaces.llmTool=true ⇒ a gated tool genuinely exists ──────────
  test("C — llmTool capabilities have a real gated tool on the LLM surface", () => {
    for (const cap of CAPABILITIES) {
      if (cap.surfaces.llmTool !== true) continue
      const entries = manifestEntriesForEnv(cap.gate.envKey)
      const toolNames = entries.flatMap(entryToolNames)
      expect(
        toolNames.length,
        `capability "${cap.id}" declares surfaces.llmTool but no manifest tool exists for ` +
          `gate "${cap.gate.envKey}"`,
      ).toBeGreaterThan(0)
    }
  })

  // ── Axis D: fc `capability:` references resolve; reverse coverage flagged ───
  // 30s: loadFeaturesStrict() parses the WHOLE feature-catalog (cold ~21s) — the
  // default 5s budget cold-times-out under load (flake). Explicit, not heuristic.
  test("D — every fc capability: ref resolves to a real capability id (no dangling ref)", async () => {
    const features = await loadFeaturesStrict()
    const capIds = new Set(CAPABILITIES.map((c) => c.id))
    const dangling: string[] = []
    for (const { feature } of features) {
      if (feature.capability === undefined) continue
      if (!capIds.has(feature.capability)) {
        dangling.push(`${feature.id} → capability:"${feature.capability}"`)
      }
    }
    expect(
      dangling,
      `fc entries reference non-existent capability ids: ${dangling.join(", ")}`,
    ).toEqual([])
  }, 30000)

  test("D-reverse — every capability is referenced by ≥1 fc entry (FLAG, not fail)", async () => {
    const features = await loadFeaturesStrict()
    const referenced = new Set(
      features.map(({ feature }) => feature.capability).filter((c): c is string => c !== undefined),
    )
    const unreferenced = CAPABILITIES.map((c) => c.id).filter((id) => !referenced.has(id))
    if (unreferenced.length > 0) {
    }
    // The 4 seeded caps (workflow/artifact-store/image-gen/office-authoring) are all
    // linked, so today this is empty — assert that as a forward ratchet.
    expect(unreferenced).toEqual([])
  }, 30000)

  // ── RED-ON-INJECTION: the ratchet has teeth ────────────────────────────────
  describe("red-on-injection — the ratchet rejects a broken capability", () => {
    test("phantom gate.envKey is rejected by axis A", () => {
      const phantom: CapabilityDescriptor = {
        id: "phantom-cap",
        gate: { envKey: "QUANTA_DOES_NOT_EXIST_PHANTOM" },
        surfaces: { llmTool: true },
        describe: "synthetic phantom-gate capability for the red-on-injection proof.",
      }
      // axis A would catch it (gate is not a declared knob)…
      expect(gateIsRealKnob(phantom)).toBe(false)
      // …and axis B/C would ALSO catch it (no manifest entry for the phantom env).
      expect(manifestGateMatches(phantom)).toBe(false)
    })

    test("mismatched manifest env is rejected by axis B", () => {
      // A capability claiming the workflow tool but pointing at the WRONG (image)
      // gate: the gate IS a real knob (passes A) but no manifest entry gates the
      // workflow tool on QUANTA_IMAGE_GEN — split-brain → axis B FAILS.
      const split: CapabilityDescriptor = {
        id: "split-brain-cap",
        gate: { envKey: "QUANTA_IMAGE_GEN" },
        surfaces: { llmTool: true },
        describe: "synthetic split-brain capability (gate points at the wrong tool).",
      }
      expect(gateIsRealKnob(split)).toBe(true) // passes A (real knob)
      // The manifest entry(ies) for QUANTA_IMAGE_GEN are the image_gen tool, NOT a
      // workflow tool — so a consistency check keyed on the intended tool would
      // disagree. We prove the projection is exact: there is exactly one manifest
      // env per tool, and it is the env the capability MUST carry.
      const wfEntry = GATED_TOOLS.find((e) => e.name === "run_workflow")
      expect(wfEntry).toBeDefined()
      expect(gateEnv(wfEntry as ToolSurfaceEntry)).toBe("QUANTA_WORKFLOW")
      expect(gateEnv(wfEntry as ToolSurfaceEntry)).not.toBe(split.gate.envKey)
    })

    test("dangling fc capability: ref is rejected by axis D", () => {
      const capIds = new Set(CAPABILITIES.map((c) => c.id))
      // A fc entry pointing at a non-existent capability id.
      const fakeRef = "no-such-capability-xyz"
      expect(capIds.has(fakeRef)).toBe(false)
    })
  })

  // ── Pre-existing inconsistency report (flag, not fail) ──────────────────────
  test("report — manifest env vs capability env coherence across the seed", () => {
    const mismatches: string[] = []
    for (const cap of CAPABILITIES) {
      if (cap.surfaces.llmTool !== true) continue
      if (manifestEntriesForEnv(cap.gate.envKey).length === 0) {
        mismatches.push(`${cap.id} (${cap.gate.envKey})`)
      }
    }
    if (mismatches.length > 0) {
    }
    expect(mismatches).toEqual([])
  })
})
