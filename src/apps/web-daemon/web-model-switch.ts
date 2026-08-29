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
import type { ControlApplyResult } from "@/agent/control-request"
import { createModelRoutingSession, type ModelRoutingAuthority } from "@/agent/model-routing"
import type { StickyModelStore } from "@/agent/sticky-model"
import { type LLMPort, type ModelCandidate, type Provider, tryCreateLLM } from "@/llm"
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
  readonly applyModel: (model: string) => Promise<ControlApplyResult>
  /** MR-02 — THE routing owner. The loose members above are migration-window
   *  plumbing for `AgentConfig.stickyModelStore` / `modelCandidates`; new callers
   *  should reach for this. */
  readonly routing: ModelRoutingAuthority
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
  // MR-02 — the SHARED routing session owns every decision this function used to
  // make by hand, and three of them were wrong here:
  //   - the session cell was seeded from the RAW file, so a hostile persisted id
  //     reached `describe().modelSlug`, the `/state` readout and the `quanta
  //     attach` pill verbatim (the pill renders it unescaped);
  //   - the eager candidate seed read the SCOPED key only while every read
  //     accepted the legacy bare key, so a pre-migration `/model` pick was CLAIMED
  //     by the readout and the SDK while the turn ran the boot model;
  //   - nothing here honoured an explicit boot pin.
  // The factory does all of it, identically to the CLI and the headless root, and
  // the shared conformance suite is what proves "identically".
  const session = createModelRoutingSession({
    env: args.env as NodeJS.ProcessEnv,
    provider: args.provider,
    bootModelId: bootModel,
    bootPort: args.llm,
    mode: webAgentMode,
    // The daemon has no per-invocation model flag today, so nothing pins it. When
    // one is added it comes from `resolveBootSelection(...).pinned`, not a literal.
    pinned: false,
    // INVARIANT B — the daemon builds the ports so a picked model keeps bounded
    // retry + the empty-stream breaker + the progress heartbeat instead of
    // streaming through a bare adapter.
    buildPort: (id: string) => {
      const inner = tryCreateLLM(args.provider, { model: id }, args.env as NodeJS.ProcessEnv)
      return inner === null ? null : decorateSwappableModelPort({ inner })
    },
  })
  const store = session.store
  return {
    store,
    provider: args.provider,
    routing: session.authority,
    // The SELECTED model (undefined when nothing is selected) — `effectiveModelOf`
    // supplies the boot fallback, so answering the boot model here would claim a
    // preference nobody set.
    effectiveModel: session.selectedModel,
    candidates: session.candidates,
    ids: session.ids,
    refresh: session.refresh,
    current: async (): Promise<string> => session.authority.view().modelId,
    applyModel: async (model: string): Promise<ControlApplyResult> => {
      // AWAITED (MR-03): the control drain runs at the TOP of a turn, so the write
      // has to land before that turn reads the selection. Fire-and-forget here
      // meant the turn ran the OLD model while the end-of-turn echo — reading a
      // by-then-updated cell — reported the NEW one, and the client's poll said
      // "applied". Through the AUTHORITY, which validates against the live catalog
      // and publishes only after the durable write settles.
      try {
        const res = await session.authority.select(model)
        if (res.ok) return { ok: true }
        const reason =
          res.kind === "write-error"
            ? `sticky write failed — ${res.message}`
            : `model not in this session's catalog`
        logger.warn(`web-daemon set_model: not applied — ${reason}`)
        return { ok: false, reason }
      } catch (e: unknown) {
        // The authority's mutations are no-throw by contract; belt-and-braces so a
        // future impl change surfaces as an honest rejection, never as a thrown
        // applier (which would abandon the whole drain).
        const reason = errMessage(e)
        logger.warn(`web-daemon set_model: apply threw — ${reason}`)
        return { ok: false, reason }
      }
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
