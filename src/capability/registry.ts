/**
 * `@/capability/registry.ts` — the seed CAPABILITY registry (ADR-0503 P3).
 *
 * The single SSOT listing every cross-surface capability + the surfaces it
 * exposes on. PURE DATA. Seeded with REAL existing gated features (their gates
 * verified in source): the env keys here are declared in the knob registries
 * (`@/shared/runtime-config-knobs` / `apps/cli/cli-knobs`) so the completeness
 * ratchet stays green — this file references them, it does not invent new gates.
 *
 * `gate.envKey` MUST be a real `QUANTA_*` knob (the dangling-gate invariant): the
 * capability layer never owns the gate, it only maps gate → surfaces.
 */

import type { CapabilityDescriptor } from "./descriptor"

export const CAPABILITIES: readonly CapabilityDescriptor[] = Object.freeze([
  {
    // §25.1 declarative multi-agent workflow. Gate: QUANTA_WORKFLOW
    // (apps/cli/cli-knobs.ts + manifest config-slot subagent.enableWorkflow).
    // LLM tool only (`run_workflow`); it is not a slash/skill/hook surface.
    id: "workflow",
    gate: { envKey: "QUANTA_WORKFLOW" },
    surfaces: { llmTool: true },
    describe: "LLM-authored declarative multi-agent workflow (run_workflow tool).",
  },
  {
    // C1 Canvas / artifact persistence store. Gate: QUANTA_ARTIFACT_STORE
    // (runtime-config field artifactStore). Exposes the artifact_* LLM tools.
    id: "artifact-store",
    gate: { envKey: "QUANTA_ARTIFACT_STORE" },
    surfaces: { llmTool: true },
    describe: "Canvas artifact persistence store (artifact_* tools).",
  },
  {
    // H14a image generation tool. Gate: QUANTA_IMAGE_GEN (runtime-config field
    // imageGen). Exposes the image_gen LLM tool.
    id: "image-gen",
    gate: { envKey: "QUANTA_IMAGE_GEN" },
    surfaces: { llmTool: true },
    describe: "Image generation tool (image_gen).",
  },
  {
    // H14b Office document authoring. Gate: QUANTA_OFFICE_AUTHORING
    // (runtime-config field officeAuthoring). Exposes the office-authoring tools.
    id: "office-authoring",
    gate: { envKey: "QUANTA_OFFICE_AUTHORING" },
    surfaces: { llmTool: true },
    describe: "Office document authoring tools (docx/xlsx/pptx).",
  },
])

/** Every declared capability (the frozen seed registry). */
export const allCapabilities = (): readonly CapabilityDescriptor[] => CAPABILITIES
