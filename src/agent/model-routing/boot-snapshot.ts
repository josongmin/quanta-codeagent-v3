/**
 * The ROOT-FACING factory (MR-02): read the durable file once, admit what this
 * session may adopt, and hand back a fully-assembled routing session.
 *
 * WHY THIS EXISTS RATHER THAN A HELPER THAT RETURNS PARTS. Three roots each did
 * this assembly by hand and each got a different subset right. The measured
 * consequences: the web daemon seeded its session cell from the RAW file (so a
 * hostile id reached `describe().modelSlug`, the `/state` readout and the attach
 * pill verbatim) and seeded candidate ports from the SCOPED key only while reads
 * accepted the legacy bare key (so a pre-migration pick was CLAIMED by every
 * display and RUN by none); the headless root wrapped no session scope at all
 * (so another process's `/model` landed mid-run against a frozen candidate list)
 * and honoured no explicit pin (so a persisted pick overrode `--model`).
 *
 * Every one of those is an assembly-order mistake, not a logic mistake — which is
 * why the fix is to remove the assembly from the roots. A root supplies only what
 * it alone knows (its port builder, its live mode, its boot selection) and gets
 * back an owner it cannot mis-wire.
 */

import type { LLMPort, ModelCandidate, Provider } from "@/llm"
import { buildModelCatalogWire, type ModelCatalogWire } from "@/llm/model-catalog"
import {
  fsBackedStickyModelStore,
  readStickyModelSnapshotSync,
  type StickyModelStore,
  sessionScopedStickyModelStore,
  stickyModelPathFrom,
} from "../sticky-model"
import { admitPersistedPicks, createModelRoutingAuthority } from "./authority"
import type { ModelOption, ModelRoutingAuthority, ModelRoutingMode } from "./types"

export interface ModelRoutingSessionArgs {
  /** The composition root's env view — the sticky path is derived from IT, never
   *  from the frozen global config, so a test-injected `QUANTA_CONFIG_DIR` moves
   *  the read and the write together. */
  readonly env: NodeJS.ProcessEnv
  /** Explicit path override (a test seam, and the one lever that can move the
   *  sticky file WITHOUT moving the config dir — which matters because the config
   *  dir is embedded in the rendered system prompt). */
  readonly path?: string
  readonly provider: Provider
  readonly bootModelId: string
  readonly bootPort: LLMPort
  readonly mode: () => ModelRoutingMode
  /** From `@/llm/boot-selection#resolveBootSelection` — the operator named a model
   *  for THIS invocation, so no persisted pick may seed the session. */
  readonly pinned: boolean
  /** THE port builder (invariant B): the root's, so a candidate carries the same
   *  credential/endpoint context and the same always-on wrappers as the boot port. */
  readonly buildPort: (id: string) => LLMPort | null
  /** Operator-configured extra candidates (`QUANTA_RETRY_MODELS`), already built. */
  readonly seeded?: readonly ModelCandidate[]
  /** Session teardown, composed with the catalog probe's own deadline. */
  readonly signal?: AbortSignal
  readonly describeOption?: (id: string) => Omit<ModelOption, "id" | "isBootModel" | "isSelected">
}

export interface ModelRoutingSession {
  readonly authority: ModelRoutingAuthority
  /** The SAME store instance the authority writes through — handed to
   *  `AgentConfig.stickyModelStore` during the migration window so the loop's
   *  existing read path keeps working unchanged. */
  readonly store: StickyModelStore
  /** The live candidate array, shared BY REFERENCE with
   *  `AgentConfig.modelCandidates` (also migration-window plumbing). */
  readonly candidates: readonly ModelCandidate[]
  /** Every offerable id (boot model first). Used by an allowlist / a picker. */
  readonly ids: () => readonly string[]
  /** Awaited by a picker before it lists: runs the lazy provider probe once. */
  readonly refresh: () => Promise<void>
  /** The catalog wire itself, for a surface that still passes it around during the
   *  migration window (the CLI's picker adapter). New code should use the
   *  authority's `list()` instead. */
  readonly catalog: ModelCatalogWire
  /** The SELECTED model, or `undefined` when nothing is selected.
   *
   *  `undefined` — not the boot model — because this feeds
   *  `stickyModelStore.effectiveModel`, and `effectiveModelOf` falls back to
   *  `config.llm.model` itself. A getter that eagerly answered the boot model
   *  would be claiming a preference nobody set. */
  readonly selectedModel: () => string | undefined
}

/**
 * Assemble one session's routing.
 *
 * The ORDER here is the part that was getting lost, so it is stated once:
 *   1. read the durable file SYNCHRONOUSLY (the store port is async and this mint
 *      is not; a resumed session needs the pick before its first turn);
 *   2. ADMIT — drop entries this session must not adopt (hostile id, hostile or
 *      out-of-scope key). The admitted map, not the raw file, is what seeds the
 *      session cell — otherwise a rejected entry still reaches every display that
 *      reads the store;
 *   3. build the catalog with EVERY admitted id eagerly seeded, so a shift+tab to
 *      another posture finds a port for that mode's pick without a probe;
 *   4. wrap the durable store in the session scope, seeded from the ADMITTED map;
 *   5. hand both to the authority, which decides precedence and runnability.
 */
export const createModelRoutingSession = (args: ModelRoutingSessionArgs): ModelRoutingSession => {
  const path = args.path ?? stickyModelPathFrom(args.env)
  const persisted = readStickyModelSnapshotSync({ path })
  const admitted = admitPersistedPicks(persisted, args.provider)
  /**
   * Canonical `<provider>:<mode>` seed for the session cell. Re-keyed from the
   * admitted map so a legacy bare entry is adopted under the key the loop reads,
   * and a rejected entry simply is not there.
   *
   * EMPTY under an explicit pin. The authority applies the pin itself, but during
   * the migration window the loop still reads the STORE (`stickyModelStore`), so a
   * seeded cell would hand it the pick regardless — measured: `quanta -p --model
   * gpt-5 --sticky-model` with a pick on disk still ran the pick. The pick is not
   * erased; it simply does not seed THIS session, exactly as the pin rule says.
   */
  const seed: Record<string, string> = {}
  if (!args.pinned) for (const [mode, id] of admitted) seed[`${args.provider}:${mode}`] = id

  const catalog = buildModelCatalogWire({
    provider: args.provider,
    bootModel: args.bootModelId,
    llm: args.bootPort,
    seeded: args.seeded ?? [],
    // A pinned session will not adopt any of them, so building their ports up
    // front is work nobody asked for; `select()` probes on demand if the operator
    // switches in-session anyway.
    extraIds: args.pinned ? [] : [...new Set(admitted.values())],
    buildPort: args.buildPort,
    ...(args.signal !== undefined ? { signal: args.signal } : {}),
    env: args.env,
  })

  const store = sessionScopedStickyModelStore({
    inner: fsBackedStickyModelStore({ path }),
    seed,
  })

  const authority = createModelRoutingAuthority({
    store,
    catalog,
    provider: args.provider,
    bootModelId: args.bootModelId,
    bootPort: args.bootPort,
    mode: args.mode,
    pinned: args.pinned,
    admitted,
    ...(args.describeOption !== undefined ? { describeOption: args.describeOption } : {}),
  })

  return {
    authority,
    catalog,
    store,
    candidates: catalog.candidates,
    ids: () => catalog.ids(),
    refresh: catalog.refresh,
    selectedModel: () => {
      const view = authority.view()
      return view.source === "session" ? view.modelId : undefined
    },
  }
}
