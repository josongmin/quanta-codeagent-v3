/**
 * ★ MR-00 — the model-routing CONTRACT.
 *
 * Two things live here:
 *
 *  1. EXHAUSTIVE tables for the two pure precedence rules (`resolveInitialSelection`,
 *     `resolveRequestModel`). These are the rules three composition roots each
 *     re-derived for themselves; a cross-surface audit found eight defects, every
 *     one of them a disagreement about one of these cells.
 *
 *  2. A non-vacuity + satisfiability proof for the shared CONFORMANCE SUITE
 *     (`tests/_support/model-routing-conformance.ts`). The suite is the acceptance
 *     gate for MR-02: every root must pass it, so it has to be demonstrably
 *     satisfiable and demonstrably toothy BEFORE any root is migrated onto it.
 *     The reference authority below is the smallest thing that satisfies it, built
 *     on the SAME production precedence functions the real implementation will use
 *     — so this file cannot drift into testing a private copy of the rules.
 *
 * The reference authority is TEST-ONLY. It is not a fallback, not a default, and
 * nothing in `src/` may import it.
 */

import { describe, expect, test } from "bun:test"
import {
  type ModelOption,
  type ModelRequestSnapshot,
  type ModelRoutingAuthority,
  type ModelRoutingMode,
  type ModelSelectionResult,
  type ModelSelectionView,
  resolveInitialSelection,
  resolveRequestModel,
  UnroutableModelError,
} from "@/agent/model-routing"
import type { LLMPort } from "@/llm"
import { isPlausibleModelSlug } from "@/llm/model-catalog"
import { AGENT_PROMPT_MODES } from "@/shared"
import {
  describeModelRoutingAuthorityContract,
  MODEL_ROUTING_CONFORMANCE_CASES,
  type ModelRoutingConformanceScenario,
} from "../../_support/model-routing-conformance"

// ── 1. the precedence tables ────────────────────────────────────────────────

describe("MR-00 · initial selection: pin > runnable persisted pick > boot", () => {
  const boot = "boot-model"
  const cases: ReadonlyArray<{
    readonly name: string
    readonly pinned: boolean
    readonly pick: string | undefined
    readonly expect: readonly [string, "boot" | "session"]
  }> = [
    { name: "no pick, no pin", pinned: false, pick: undefined, expect: [boot, "boot"] },
    { name: "pick, no pin", pinned: false, pick: "gpt-4o", expect: ["gpt-4o", "session"] },
    { name: "pick + PIN ⇒ pin wins", pinned: true, pick: "gpt-4o", expect: [boot, "boot"] },
    { name: "no pick + pin", pinned: true, pick: undefined, expect: [boot, "boot"] },
    // An empty string is "no preference", not a model name — it must never win, or
    // a display renders an empty model and the turn resolves nothing.
    { name: "empty pick is no preference", pinned: false, pick: "", expect: [boot, "boot"] },
    // A pick EQUAL to the boot model is reported as `boot`: same id, but the
    // source is what tells a report "nothing was selected" from "this exact model
    // was chosen", and it is what keeps the boot port from being duplicated.
    { name: "pick === boot ⇒ source boot", pinned: false, pick: boot, expect: [boot, "boot"] },
  ]
  for (const c of cases) {
    test(c.name, () => {
      const got = resolveInitialSelection({
        bootModelId: boot,
        pinned: c.pinned,
        ...(c.pick !== undefined ? { persistedPick: c.pick } : {}),
      })
      expect([got.modelId, got.source]).toEqual([...c.expect])
    })
  }
})

describe("MR-00 · per request: skill > session selection > boot", () => {
  const boot = "boot-model"
  const cases: ReadonlyArray<{
    readonly name: string
    readonly selected: string | undefined
    readonly skill: string | undefined
    readonly expect: readonly [string, "skill" | "session" | "boot"]
  }> = [
    { name: "nothing set", selected: undefined, skill: undefined, expect: [boot, "boot"] },
    { name: "session only", selected: "gpt-4o", skill: undefined, expect: ["gpt-4o", "session"] },
    { name: "skill only", selected: undefined, skill: "o3", expect: ["o3", "skill"] },
    { name: "skill beats session", selected: "gpt-4o", skill: "o3", expect: ["o3", "skill"] },
    { name: "empty skill is unset", selected: "gpt-4o", skill: "", expect: ["gpt-4o", "session"] },
    { name: "empty session is unset", selected: "", skill: undefined, expect: [boot, "boot"] },
    { name: "session === boot ⇒ boot", selected: boot, skill: undefined, expect: [boot, "boot"] },
    // A skill naming the boot model is still SKILL-sourced: it asserted a
    // requirement that happens to match, and a report must not erase that.
    { name: "skill === boot ⇒ skill", selected: undefined, skill: boot, expect: [boot, "skill"] },
  ]
  for (const c of cases) {
    test(c.name, () => {
      const got = resolveRequestModel({
        bootModelId: boot,
        ...(c.selected !== undefined ? { selectedModelId: c.selected } : {}),
        ...(c.skill !== undefined ? { skillModel: c.skill } : {}),
      })
      expect([got.modelId, got.source]).toEqual([...c.expect])
    })
  }

  test("an unroutable skill model is returned VERBATIM (the caller fails closed)", () => {
    // Substituting a fallback here is exactly the silent void-the-contract
    // behaviour this replaces: the precedence layer must not soften it.
    expect(resolveRequestModel({ bootModelId: boot, skillModel: "no-such" })).toEqual({
      modelId: "no-such",
      source: "skill",
    })
  })
})

// ── 2. the conformance suite: satisfiable, and toothy ───────────────────────

/** Minimal in-memory authority — the smallest thing the contract admits. Built on
 *  the production precedence functions so the suite cannot be satisfied by a
 *  private re-derivation of the rules. */
const referenceAuthority = (scenario: ModelRoutingConformanceScenario) => {
  const port = (id: string): LLMPort => ({ model: id, stream: async function* () {} }) as LLMPort
  const bootPort = port(scenario.bootModelId)

  /** Key admission. A scoped key is in scope only for its own provider; a bare key
   *  is legacy and applies to any provider; the mode half must be a real prompt
   *  mode, which is what rejects a hostile key. */
  const modeOfKey = (raw: string): ModelRoutingMode | undefined => {
    const idx = raw.indexOf(":")
    const scoped = idx >= 0
    if (scoped && raw.slice(0, idx) !== scenario.provider) return undefined
    const mode = scoped ? raw.slice(idx + 1) : raw
    return (AGENT_PROMPT_MODES as readonly string[]).includes(mode)
      ? (mode as ModelRoutingMode)
      : undefined
  }
  const runnable = (id: string): boolean =>
    id === scenario.bootModelId || scenario.buildable.includes(id)
  const vetted = Object.entries(scenario.persisted).find(
    ([k, v]) => modeOfKey(k) === scenario.mode && isPlausibleModelSlug(v) && runnable(v),
  )

  const initial = resolveInitialSelection({
    bootModelId: scenario.bootModelId,
    pinned: scenario.pinned,
    ...(vetted !== undefined ? { persistedPick: vetted[1] } : {}),
  })
  let selected = initial.source === "session" ? initial.modelId : undefined
  let revision = 0
  const ports = new Map<string, LLMPort>([[scenario.bootModelId, bootPort]])
  for (const id of scenario.buildable) {
    // Admission before OFFERING, not just before seeding: an id that can have a
    // port built is not thereby fit to render. `tryCreateLLM` validates the
    // credential, never the slug, so plausibility is the only thing standing
    // between a provider/file-supplied string and a picker row.
    if (!ports.has(id) && isPlausibleModelSlug(id)) ports.set(id, port(id))
  }

  const view = (): ModelSelectionView => ({
    modelId: selected ?? scenario.bootModelId,
    provider: scenario.provider,
    mode: scenario.mode,
    source: selected !== undefined ? "session" : "boot",
    revision,
  })
  const authority: ModelRoutingAuthority = {
    view,
    list: async (): Promise<readonly ModelOption[]> =>
      [...ports.keys()].map((id) => ({
        id,
        isBootModel: id === scenario.bootModelId,
        isSelected: id === view().modelId,
      })),
    select: async (modelId: string): Promise<ModelSelectionResult> => {
      if (!ports.has(modelId)) {
        return { ok: false, kind: "unknown-model", known: [...ports.keys()] }
      }
      selected = modelId === scenario.bootModelId ? undefined : modelId
      revision += 1
      return { ok: true, view: view() }
    },
    clear: async (): Promise<ModelSelectionResult> => {
      selected = undefined
      revision += 1
      return { ok: true, view: view() }
    },
    resolveRequest: async (input): Promise<ModelRequestSnapshot> => {
      const chosen = resolveRequestModel({
        bootModelId: scenario.bootModelId,
        ...(selected !== undefined ? { selectedModelId: selected } : {}),
        ...(input.skillModel !== undefined ? { skillModel: input.skillModel } : {}),
      })
      const resolved = ports.get(chosen.modelId)
      if (resolved === undefined) throw new UnroutableModelError(chosen.modelId, [...ports.keys()])
      return {
        modelId: chosen.modelId,
        provider: scenario.provider,
        port: resolved,
        mode: scenario.mode,
        source: chosen.source,
        selectionRevision: revision,
      }
    },
  }
  return { authority, bootPort }
}

describe("MR-00 · the conformance suite is satisfiable and non-vacuous", () => {
  test("the suite declares every case the audit found a root disagreeing about", () => {
    // An anti-vacuity floor: a suite that silently lost cases would let a root
    // "conform" by answering fewer questions.
    expect(MODEL_ROUTING_CONFORMANCE_CASES.length).toBeGreaterThanOrEqual(14)
    expect(new Set(MODEL_ROUTING_CONFORMANCE_CASES).size).toBe(
      MODEL_ROUTING_CONFORMANCE_CASES.length,
    )
    for (const name of [
      "legacy bare key seeds the selection",
      "explicit pin beats a persisted pick",
    ]) {
      expect(MODEL_ROUTING_CONFORMANCE_CASES).toContain(name as never)
    }
  })
})

describeModelRoutingAuthorityContract("reference", async (scenario) =>
  Promise.resolve(referenceAuthority(scenario)),
)
