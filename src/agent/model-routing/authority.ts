/**
 * THE `ModelRoutingAuthority` implementation (MR-02) — one owner, three roots.
 *
 * Before this, the interactive CLI, the web daemon and the headless root each
 * assembled the switch from loose slots and each made the same five decisions for
 * itself: the storage key, explicit-pin precedence, persisted-pick vetting,
 * candidate-port seeding, and session scoping. A cross-surface audit found eight
 * confirmed defects and every one was two roots disagreeing about one of those
 * five — a pick the web CLAIMED but could not run, a pin the headless root
 * ignored, a hostile id one root vetted and another rendered. Sharing a helper
 * that returns those five as fields would not have prevented any of them, because
 * the fields come apart again at the next assembly site. Sharing the OWNER does.
 *
 * WHAT IT OWNS
 *   - the durable store (session-scoped: this session reads its OWN cell, writes
 *     go through to disk for the NEXT session — so another surface's pick cannot
 *     land mid-turn while the displays here still name the old model);
 *   - the candidate catalog (id → decorated port), including the eager seed of a
 *     persisted pick so a resumed session can RUN it on turn 1 without a probe;
 *   - admission: which persisted entries a session may adopt at all;
 *   - the selection, and the revision that makes "changed back" distinguishable
 *     from "unchanged".
 *
 * WHAT IT DELIBERATELY DOES NOT OWN
 *   - the boot model (`@/llm/boot-selection#resolveBootSelection` — it needs env
 *     and the provider default table, and every root already resolves it before
 *     it can build the port this authority is handed);
 *   - port CONSTRUCTION (injected as `buildPort`, so a candidate carries the
 *     composition root's credential/endpoint context and its always-on wrappers);
 *   - the live mode (injected as a thunk: only the surface knows whether a
 *     shift+tab posture cell exists, and the key contains the mode).
 */

import type { LLMPort, ModelCandidate, Provider } from "@/llm"
import { isPlausibleModelSlug } from "@/llm/model-catalog"
import { logger } from "@/shared"
import {
  isStickyModelKeyInScope,
  parseStickyModelStorageKey,
  type StickyModelStore,
} from "../sticky-model"
import { resolveInitialSelection, resolveRequestModel } from "./precedence"
import {
  type ModelOption,
  type ModelRequestSnapshot,
  type ModelRoutingAuthority,
  type ModelRoutingMode,
  type ModelSelectionResult,
  type ModelSelectionView,
  UnroutableModelError,
} from "./types"

/** The catalog surface the authority consumes. Structural, so a root can pass its
 *  `buildModelCatalogWire` result directly and a test can pass a double without
 *  standing up a probe. */
export interface ModelRoutingCatalog {
  readonly candidates: readonly ModelCandidate[]
  readonly ids: () => readonly string[]
  readonly refresh: () => Promise<void>
}

export interface ModelRoutingAuthorityArgs {
  readonly store: StickyModelStore
  readonly catalog: ModelRoutingCatalog
  readonly provider: Provider
  readonly bootModelId: string
  /** The session's boot port. Resolving the boot model yields THIS object — the
   *  boot model is never duplicated as a second port (invariant A). */
  readonly bootPort: LLMPort
  /** The LIVE mode. A thunk because the shift+tab posture cell can change between
   *  turns, and the key contains the mode: a snapshot taken at mint would write
   *  one key and let the loop read another. */
  readonly mode: () => ModelRoutingMode
  /** The operator named a model for THIS invocation (`--model` / `QUANTA_MODEL`),
   *  so a persisted pick must not seed the session. */
  readonly pinned: boolean
  /**
   * The ADMITTED picks, `mode → modelId`, already filtered by
   * {@link admitPersistedPicks}.
   *
   * Admitted by the CALLER rather than here, and that is deliberate: the factory
   * also needs the admitted set (it seeds the session cell and the eager candidate
   * ports from it), and running the filter twice meant two places that had to stay
   * in step. They did — but only because both happened to call the same function,
   * which a guard could not detect: removing admission from one of them left the
   * other still filtering, so the defect it was supposed to catch stayed invisible.
   * One computation, one consumer chain.
   */
  readonly admitted: ReadonlyMap<ModelRoutingMode, string>
  /** Optional metadata for `list()` rows. Absent ⇒ bare ids (a picker degrades to
   *  the id rather than printing a claim it cannot support). */
  readonly describeOption?: (id: string) => Omit<ModelOption, "id" | "isBootModel" | "isSelected">
}

/**
 * ADMISSION — which persisted entries this session may adopt.
 *
 * Per KEY, and that is the whole point. Three independent checks, each of which
 * was measured missing on at least one root:
 *   1. the KEY must parse and be in scope for this provider (a hostile key, and
 *      another provider's pick, are both dropped);
 *   2. the VALUE must be a plausible provider slug — `tryCreateLLM` validates the
 *      CREDENTIAL, never the slug, so a port CAN be built for an ANSI-laden id and
 *      plausibility is the only thing between the file and a terminal;
 *   3. runnability is checked LATER, against the catalog, because only the
 *      catalog knows which ids a port exists for.
 *
 * The reason a dropped entry is reported without echoing itself: the key and the
 * value are both untrusted input, and the operator needs to know one was dropped,
 * not to receive it.
 */
export const admitPersistedPicks = (
  persisted: Readonly<Record<string, string>>,
  provider: Provider,
): ReadonlyMap<ModelRoutingMode, string> => {
  const scoped = new Map<ModelRoutingMode, string>()
  const legacy = new Map<ModelRoutingMode, string>()
  for (const [rawKey, value] of Object.entries(persisted)) {
    const key = parseStickyModelStorageKey(rawKey)
    // The `invalid` arm is discriminated explicitly rather than left to the scope
    // predicate: `isStickyModelKeyInScope` returns a boolean, so it cannot narrow
    // the union, and the compiler is right to refuse a `.mode` read after it.
    if (key.kind === "invalid") continue
    if (!isStickyModelKeyInScope(key, provider)) continue
    if (!isPlausibleModelSlug(value)) {
      logger.warn(
        `sticky-model: dropping a persisted pick whose id is not a plausible model slug ` +
          `(${value.length} chars) — it will not seed this session`,
      )
      continue
    }
    ;(key.kind === "scoped" ? scoped : legacy).set(key.mode, value)
  }
  // A SCOPED entry wins over a legacy bare one for the same mode: it is the more
  // specific statement, and it is what a post-migration write produces.
  return new Map<ModelRoutingMode, string>([...legacy, ...scoped])
}

/**
 * Capture the model for ONE request (extracted from the authority factory so the
 * factory stays under the god-function cap, and so the RESOLUTION — precedence,
 * one discovery attempt, the fail-closed split — reads as its own unit).
 */
const resolveRequestSnapshot = async (deps: {
  readonly args: ModelRoutingAuthorityArgs
  readonly mode: ModelRoutingMode
  readonly selected: string | undefined
  readonly skillModel: string | undefined
  readonly portFor: (id: string) => LLMPort | undefined
  readonly revision: number
}): Promise<ModelRequestSnapshot> => {
  const { args, mode, revision } = deps
  const chosen = resolveRequestModel({
    bootModelId: args.bootModelId,
    ...(deps.selected !== undefined ? { selectedModelId: deps.selected } : {}),
    ...(deps.skillModel !== undefined ? { skillModel: deps.skillModel } : {}),
  })
  let port = deps.portFor(chosen.modelId)
  if (port === undefined && chosen.source === "skill") {
    // One discovery attempt before failing closed, and ONLY for a skill override.
    // The happy path must never pay a probe round-trip on the first request of
    // every session; but a skill naming a model the provider DOES list should not
    // be refused merely because nobody opened a picker first.
    await args.catalog.refresh()
    port = deps.portFor(chosen.modelId)
  }
  if (port === undefined) {
    // FAIL-CLOSED, but ONLY for a SKILL override. A skill that declares `model:`
    // is stating a requirement; running the base model instead voids that contract
    // with no warning on any channel — the measured prior behaviour.
    //
    // A SESSION selection that cannot resolve degrades instead: admission already
    // refuses to adopt an unrunnable pick, so reaching here means a host wired a
    // bare store with no matching candidate — the long-standing advisory path.
    if (chosen.source === "skill") {
      throw new UnroutableModelError(chosen.modelId, args.catalog.ids())
    }
    return {
      modelId: args.bootModelId,
      provider: args.provider,
      port: args.bootPort,
      mode,
      source: "boot",
      selectionRevision: revision,
    }
  }
  // Captured, not re-read: everything downstream (llm_request, the completion
  // echo, cost attribution) reports THIS, so a selection made while the request is
  // in flight cannot retroactively rewrite what ran.
  return {
    modelId: chosen.modelId,
    provider: args.provider,
    port,
    mode,
    source: chosen.source,
    selectionRevision: revision,
  }
}

export const createModelRoutingAuthority = (
  args: ModelRoutingAuthorityArgs,
): ModelRoutingAuthority => {
  const admitted = args.admitted
  const runnable = (id: string): boolean =>
    id === args.bootModelId || args.catalog.ids().includes(id)

  /**
   * THE live selection, per MODE — the single source after construction.
   *
   * Seeded ONCE here, for EVERY admitted mode, and never consulted against the
   * boot snapshot again. That is load-bearing: an earlier draft fell back to the
   * snapshot whenever a mode had no live entry, so `clear()` deleted the entry and
   * the very next `view()` resurrected the pick from disk — a clear that reported
   * success and undid itself. The conformance suite caught it.
   *
   * Per MODE because shift+tab changes which pick is active mid-session; one cell
   * would leak one posture's choice into another's.
   */
  const selected = new Map<ModelRoutingMode, string>()
  for (const [mode, id] of admitted) {
    const initial = resolveInitialSelection({
      bootModelId: args.bootModelId,
      pinned: args.pinned,
      // Only a RUNNABLE pick may seed. An unrunnable one would leave the loop on
      // the boot model while every display announced the pick — the campaign's
      // defining defect, one axis over.
      ...(runnable(id) ? { persistedPick: id } : {}),
    })
    if (initial.source === "session") selected.set(mode, initial.modelId)
  }
  let revision = 0

  const selectedFor = (mode: ModelRoutingMode): string | undefined => selected.get(mode)

  const view = (): ModelSelectionView => {
    const mode = args.mode()
    const sel = selectedFor(mode)
    return {
      modelId: sel ?? args.bootModelId,
      provider: args.provider,
      mode,
      source: sel !== undefined ? "session" : "boot",
      revision,
    }
  }

  const portFor = (id: string): LLMPort | undefined =>
    id === args.bootModelId ? args.bootPort : args.catalog.candidates.find((c) => c.id === id)?.port

  const write = async (
    mode: ModelRoutingMode,
    modelId: string | undefined,
  ): Promise<ModelSelectionResult> => {
    const key = { mode, provider: args.provider }
    const res =
      modelId === undefined
        ? await args.store.unset(key)
        : await args.store.set({ ...key, modelId })
    if (!res.ok) return { ok: false, kind: "write-error", message: res.error.message }
    // Publish ONLY after the durable write settled: a view that moved first would
    // name a model the next session will not find on disk.
    if (modelId === undefined) selected.delete(mode)
    else selected.set(mode, modelId)
    revision += 1
    return { ok: true, view: view() }
  }

  return {
    view,
    list: async (): Promise<readonly ModelOption[]> => {
      await args.catalog.refresh()
      const current = view().modelId
      return args.catalog.ids().map((id) => ({
        id,
        isBootModel: id === args.bootModelId,
        isSelected: id === current,
        ...(args.describeOption?.(id) ?? {}),
      }))
    },
    select: async (modelId: string, mode?: ModelRoutingMode): Promise<ModelSelectionResult> => {
      const id = modelId.trim()
      // REFRESH FIRST. The catalog knows the boot model, the operator's configured
      // extras and any persisted pick eagerly; everything else arrives from the
      // lazy provider probe. Leaving that to the caller made "can I pick this?"
      // depend on whether the surface happened to list first — `/model gpt-4o`
      // typed straight out is a perfectly ordinary thing to do, and it was
      // rejected as unknown. The probe is memoized on success and deadline-bounded
      // (`MODEL_CATALOG_PROBE_TIMEOUT_MS`), so this costs one round-trip per
      // session at most, and a failed probe still leaves the seeded set usable.
      if (id.length > 0 && !args.catalog.ids().includes(id)) await args.catalog.refresh()
      const known = args.catalog.ids()
      if (id.length === 0 || !known.includes(id)) {
        // Fail CLOSED: an id nothing can run must not persist, or every later
        // session announces a model no turn could execute.
        return { ok: false, kind: "unknown-model", known }
      }
      // The boot model is PERSISTED like any other choice (see
      // `resolveInitialSelection`): treating it as a clear would lose the
      // distinction the moment the session's boot model changes.
      return await write(mode ?? args.mode(), id)
    },
    clear: async (mode?: ModelRoutingMode): Promise<ModelSelectionResult> =>
      await write(mode ?? args.mode(), undefined),
    resolveRequest: async (input): Promise<ModelRequestSnapshot> => {
      const mode = args.mode()
      return await resolveRequestSnapshot({
        args,
        mode,
        selected: selectedFor(mode),
        skillModel: input.skillModel,
        portFor,
        revision,
      })
    },
  }
}
