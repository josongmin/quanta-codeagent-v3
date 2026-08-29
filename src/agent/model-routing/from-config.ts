/**
 * THE loop's single door to model routing (MR-02 final step).
 *
 * The loop used to read THREE slots — `stickyModelStore`, `modelCandidates` and
 * (for display) `effectiveModel` — in three separate functions
 * (`readStickyModelForMode`, `resolveActiveModelId`, `resolveSkillTurnOverride`),
 * each re-deriving the key, the precedence and the port lookup. That is the same
 * "assembled at every call site" shape that produced eight cross-surface defects
 * one layer up. The loop now asks ONE question of ONE owner.
 *
 * # The compatibility shim, and why it is not a fallback rule
 *
 * A host that never adopted the authority — an embedder, a test that wires
 * `{stickyModelStore, modelCandidates}` by hand, the headless in-memory default —
 * still has to work. Rather than teach the loop two shapes, this builds an
 * authority OVER the legacy slots, in ONE place, so there is exactly one
 * implementation of the rules and the legacy path is a construction detail rather
 * than a second code path through the turn.
 *
 * The shim is deliberately NOT the full session factory: it performs no boot
 * admission (there is no file to admit from — the caller already chose what is in
 * the store) and no eager candidate seeding. It answers the three questions the
 * loop asks, with the same precedence, off the slots it was given.
 *
 * Memoized per `config` OBJECT (a `WeakMap`), because the loop asks several times
 * per turn and a shim minted per call would hand out a fresh `revision` each time
 * — making "did the selection change?" unanswerable.
 */

import type { LLMPort, ModelCandidate, Provider } from "@/llm"
import { resolveLiveAgentMode } from "../mode"
import type { StickyModelStore } from "../sticky-model"
import { resolveRequestModel } from "./precedence"
import {
  type ModelOption,
  type ModelRequestSnapshot,
  type ModelRoutingAuthority,
  type ModelRoutingMode,
  type ModelSelectionResult,
  type ModelSelectionView,
  UnroutableModelError,
} from "./types"

/** The slice of `AgentConfig` routing needs. Structural, so this module does not
 *  depend on the full config type (and cannot drift with unrelated slots). */
export interface ModelRoutingConfigSlice {
  readonly llm: LLMPort
  readonly modelRouting?: ModelRoutingAuthority | undefined
  readonly stickyModelStore?:
    | {
        readonly store: StickyModelStore
        readonly provider?: string | undefined
        readonly effectiveModel?: (() => string | undefined) | undefined
      }
    | undefined
  readonly modelCandidates?: readonly ModelCandidate[] | undefined
  readonly mode?: string | undefined
  readonly planMode?: boolean | undefined
  readonly agentModeState?: { readonly get: () => ModelRoutingMode | undefined } | undefined
}

const shims = new WeakMap<object, ModelRoutingAuthority>()

/** Build an authority over the legacy slots. See the file header for what it
 *  deliberately does NOT do. */
const legacyShim = (config: ModelRoutingConfigSlice): ModelRoutingAuthority => {
  const bootModelId = config.llm.model ?? ""
  // The slot's provider wins over the port's — the surface that owns the store set
  // it, so the read key provably matches the write key. Absent BOTH ⇒ the legacy
  // bare-mode key, which reads still accept.
  const providerRaw = config.stickyModelStore?.provider ?? config.llm.provider
  const provider = (providerRaw ?? "") as Provider
  const mode = (): ModelRoutingMode => resolveLiveAgentMode(config as never)
  const keyFor = (m: ModelRoutingMode) => ({
    mode: m,
    ...(providerRaw !== undefined && providerRaw.length > 0 ? { provider: providerRaw } : {}),
  })
  const selectedFor = (m: ModelRoutingMode): string | undefined =>
    config.stickyModelStore?.store.peek(keyFor(m))
  const portFor = (id: string): LLMPort | undefined =>
    id === bootModelId ? config.llm : config.modelCandidates?.find((c) => c.id === id)?.port
  let revision = 0

  const view = (): ModelSelectionView => {
    const m = mode()
    const sel = selectedFor(m)
    return {
      modelId: sel !== undefined && sel.length > 0 ? sel : bootModelId,
      provider,
      mode: m,
      source: sel !== undefined && sel.length > 0 ? "session" : "boot",
      revision,
    }
  }
  const ids = (): readonly string[] => [
    ...new Set([bootModelId, ...(config.modelCandidates ?? []).map((c) => c.id)]),
  ]
  const write = async (
    m: ModelRoutingMode,
    modelId: string | undefined,
  ): Promise<ModelSelectionResult> => {
    const store = config.stickyModelStore?.store
    if (store === undefined) {
      return { ok: false, kind: "write-error", message: "no sticky-model store is wired" }
    }
    const res =
      modelId === undefined
        ? await store.unset(keyFor(m))
        : await store.set({ ...keyFor(m), modelId })
    if (!res.ok) return { ok: false, kind: "write-error", message: res.error.message }
    revision += 1
    return { ok: true, view: view() }
  }

  return {
    view,
    list: async (): Promise<readonly ModelOption[]> => {
      const current = view().modelId
      return ids().map((id) => ({
        id,
        isBootModel: id === bootModelId,
        isSelected: id === current,
      }))
    },
    select: async (modelId: string, m?: ModelRoutingMode): Promise<ModelSelectionResult> => {
      const id = modelId.trim()
      if (id.length === 0 || !ids().includes(id)) {
        return { ok: false, kind: "unknown-model", known: ids() }
      }
      return await write(m ?? mode(), id)
    },
    clear: async (m?: ModelRoutingMode): Promise<ModelSelectionResult> =>
      await write(m ?? mode(), undefined),
    resolveRequest: async (input): Promise<ModelRequestSnapshot> => {
      const m = mode()
      const sel = selectedFor(m)
      const chosen = resolveRequestModel({
        bootModelId,
        ...(sel !== undefined ? { selectedModelId: sel } : {}),
        ...(input.skillModel !== undefined ? { skillModel: input.skillModel } : {}),
      })
      const port = portFor(chosen.modelId)
      if (port === undefined) {
        // Same split as the real authority: an explicit SKILL requirement fails
        // closed; a session selection with no candidate degrades to the boot port,
        // which is the long-standing advisory behaviour for a bare-store host.
        if (chosen.source === "skill") throw new UnroutableModelError(chosen.modelId, ids())
        return {
          modelId: bootModelId,
          provider,
          port: config.llm,
          mode: m,
          source: "boot",
          selectionRevision: revision,
        }
      }
      return {
        modelId: chosen.modelId,
        provider,
        port,
        mode: m,
        source: chosen.source,
        selectionRevision: revision,
      }
    },
  }
}

/**
 * THE authority for this config — the wired one, or a shim over the legacy slots.
 *
 * Every loop-side model question goes through the result. Nothing in the turn path
 * should read `stickyModelStore` / `modelCandidates` directly again.
 */
export const modelRoutingFor = (config: ModelRoutingConfigSlice): ModelRoutingAuthority => {
  if (config.modelRouting !== undefined) return config.modelRouting
  const cached = shims.get(config as object)
  if (cached !== undefined) return cached
  const built = legacyShim(config)
  shims.set(config as object, built)
  return built
}
