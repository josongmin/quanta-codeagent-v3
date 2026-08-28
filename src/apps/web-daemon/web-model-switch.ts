/**
 * Web-daemon model switch (aug-27) — makes `set_model` a REAL effect.
 *
 * Before this, the daemon's control-request `set_model` was an explicit
 * observability-only no-op: the port's own doc said "no live model-swap cell on
 * the daemon today", so a client could send the frame, see it echoed, and keep
 * talking to the old model. The CLI's `/model` had the same hole for a different
 * reason (see `@/llm/model-catalog`); this closes the web half through the SAME
 * two halves the loop actually consumes:
 *
 *   - `stickyModelStore` — the per-mode pick `skill-gate#readStickyModelForMode`
 *     reads at the top of EVERY turn. Deliberately the SAME on-disk file the CLI
 *     writes (`~/.quanta/sticky-model.json`): one user, one model preference, and
 *     ADR-0462 documents two store instances over one file as supported usage.
 *   - `modelCandidates` — the id→PORT list `resolveSkillTurnOverride` resolves the
 *     picked id against. Without it the store write lands but the swap finds no
 *     port and the turn silently runs the boot model.
 *
 * The candidate set is the provider's LIVE catalog (`LLMPort.listModels`), probed
 * LAZILY — the `/readout/model` route awaits `refresh()`, which is the moment a
 * client actually needs the list. Daemon boot pays no network call.
 *
 * Fail-open everywhere: a rejected probe leaves the boot candidate standing, and
 * a failed store write is logged, never thrown (the control drain treats a
 * throwing applier as a reason to abandon the whole drain).
 */

import { type AgentMode, resolveAgentMode } from "@/agent"
import {
  fsBackedStickyModelStore,
  readStickyModelSnapshotSync,
  type StickyModelStore,
  sessionScopedStickyModelStore,
  stickyModelKeyOf,
  stickyModelPathFrom,
} from "@/agent/sticky-model"
import { type LLMPort, type ModelCandidate, type Provider, tryCreateLLM } from "@/llm"
import { buildModelCatalogWire } from "@/llm/model-catalog"
import { decorateSwappableModelPort } from "@/runner/assemble"
import { errMessage, logger } from "@/shared"

export interface WebModelSwitchHandle {
  /** The store the base carries as `stickyModelStore` (loop reads it per turn). */
  readonly store: StickyModelStore
  /** The provider half of the sticky key — published so the base slot carries it
   *  and the loop's read key provably matches this switch's write key. */
  readonly provider: string
  /** SYNC "what the next turn will run" (aug-28) — the base slot's
   *  `effectiveModel`. `describe().modelSlug` is a sync projection and it feeds the
   *  `/state` + `/status` readouts, so without this they kept naming the daemon's
   *  BOOT model for the rest of the session after a `set_model`. */
  readonly effectiveModel: () => string | undefined
  /** The LIVE candidate array the base carries as `modelCandidates`. */
  readonly candidates: readonly ModelCandidate[]
  /** Candidate ids — the control-request model allowlist (read per drain, so a
   *  post-probe id is accepted without re-minting the port). */
  readonly ids: () => readonly string[]
  /** Lazy provider-catalog probe (memoized). Awaited by the `/model` readout. */
  readonly refresh: () => Promise<void>
  /** The model the NEXT turn will run: the persisted pick, else the boot model. */
  readonly current: () => Promise<string>
  /** The `set_model` effect leg: persist the pick for the mode this surface runs
   *  in. Synchronous + NO-THROW by contract (the control-effect applier cannot
   *  await and must never throw); the write is fire-and-forget and observed on
   *  the next turn's store read. */
  readonly applyModel: (model: string) => void
}

/**
 * The agent mode a web pick targets.
 *
 * It MUST match what the loop's consume side derives for this surface, or the
 * write lands on a key the read never looks at. The daemon sets neither
 * `config.mode` nor `config.planMode` and wires no `agentModeState`, so
 * `resolveLiveAgentMode` resolves to whatever `resolveAgentMode(undefined,
 * undefined)` gives — computed here through that same SSOT helper rather than
 * hardcoding the literal, so a future web plan-posture only has to pass its flag
 * in one place.
 */
const webAgentMode = (): AgentMode => resolveAgentMode(undefined, false)

export const createWebModelSwitch = (args: {
  readonly env: Record<string, string | undefined>
  readonly provider: Provider
  /** The daemon's boot port — the probe surface AND the boot model's port. */
  readonly llm: LLMPort
}): WebModelSwitchHandle => {
  const bootModel = args.llm.model ?? ""
  // ONE path for the write and the boot read, derived from the INJECTED env (see
  // `stickyModelPathFrom`): the default resolver reads the FROZEN global runtime
  // config, so a daemon whose `QUANTA_CONFIG_DIR` resolved later would write to a
  // different file than it reads.
  const path = stickyModelPathFrom(args.env)
  const persistedSnapshot = readStickyModelSnapshotSync({ path })
  // SESSION-SCOPED reads + write-through persistence (same decorator the CLI uses):
  // a pick made on another surface applies to the NEXT daemon session, never
  // mid-session, so `/readout/model` and the turn can never disagree.
  const store = sessionScopedStickyModelStore({
    inner: fsBackedStickyModelStore({ path }),
    seed: persistedSnapshot,
  })
  // A pick already on disk (from the CLI, or a previous daemon run) needs its
  // PORT before the first turn: the catalog probe is lazy and a client may never
  // open the model panel, so without this the store read would return an id the
  // swap cannot resolve and the turn would silently run the boot model. The
  // snapshot read is the SYNC one for exactly this reason (the store port is
  // async and this mint is not).
  const persisted =
    persistedSnapshot[stickyModelKeyOf({ mode: webAgentMode(), provider: args.provider })]
  const catalog = buildModelCatalogWire({
    provider: args.provider,
    bootModel,
    llm: args.llm,
    seeded: [],
    // INVARIANT B (see `@/llm/model-catalog`) — the daemon builds the ports so a
    // picked model keeps bounded retry + the empty-stream breaker + the progress
    // heartbeat instead of streaming through a bare adapter.
    buildPort: (id: string) => {
      const inner = tryCreateLLM(args.provider, { model: id }, args.env as NodeJS.ProcessEnv)
      return inner === null ? null : decorateSwappableModelPort({ inner })
    },
    ...(persisted !== undefined ? { extraIds: [persisted] } : {}),
    env: args.env as NodeJS.ProcessEnv,
  })
  return {
    store,
    provider: args.provider,
    // Straight off the store, with the SAME key `applyModel` writes under — so the
    // readouts cannot report a model this switch is not about to run.
    effectiveModel: (): string | undefined =>
      store.peek({ mode: webAgentMode(), provider: args.provider }),
    candidates: catalog.candidates,
    ids: () => catalog.ids(),
    refresh: catalog.refresh,
    current: async (): Promise<string> => {
      const picked = await store.get({ mode: webAgentMode(), provider: args.provider })
      return picked !== undefined && picked.length > 0 ? picked : bootModel
    },
    applyModel: (model: string): void => {
      void store
        .set({ mode: webAgentMode(), provider: args.provider, modelId: model })
        .then((res) => {
          if (!res.ok) {
            logger.warn(`web-daemon set_model: sticky write failed — ${errMessage(res.error)}`)
          }
        })
        .catch((e: unknown) => {
          // The port contract says `set` never rejects; belt-and-braces so a
          // future impl change cannot surface as an unhandled rejection.
          logger.warn(`web-daemon set_model: sticky write threw — ${errMessage(e)}`)
        })
    },
  }
}

/** Render the `/model` readout body: the effective model, then every candidate
 *  (marked), then how to switch. Pure — the composition root awaits the probe and
 *  passes the resolved facts in. */
export const renderWebModelReadout = (args: {
  readonly current: string
  readonly ids: readonly string[]
}): string => {
  const lines: string[] = [`model  ${args.current.length > 0 ? args.current : "(none)"}`]
  if (args.ids.length === 0) {
    lines.push("  (no candidates — the provider catalog probe returned nothing)")
  } else {
    for (const id of args.ids) lines.push(`  ${id === args.current ? "*" : " "} ${id}`)
  }
  lines.push('switch: send a controlRequest frame { kind: "set_model", model: "<id>" }')
  return lines.join("\n")
}
