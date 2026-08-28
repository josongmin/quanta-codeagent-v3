/**
 * The model switch on the HEADLESS / one-shot composition root — BOTH halves,
 * in ONE module (aug-28, findings L4 / #11).
 *
 * The two halves live here TOGETHER on purpose. They were split apart — the
 * store resolved inline in the `buildBaseFromArgs` keystone, the candidate list
 * resolved nowhere at all — and that separation IS the defect below: one half
 * shipped, the other was forgotten, and nothing failed loudly.
 *
 * THE DEFECT THIS CLOSES (measured, not inferred). `buildBaseFromArgs` — the
 * composition root behind `quanta -p` and every `apps/agent` mode preset — has
 * ALWAYS handed the base a `stickyModelStore` (`resolveStickyModelStore`: an
 * in-memory store by default, the fs-backed `~/.quanta/sticky-model.json` one
 * under `--sticky-model`), and NEVER handed it `modelCandidates`. The loop reads
 * BOTH halves every turn:
 *
 *   1. `skill-gate#readStickyModelForMode` reads the store, keyed
 *      `<provider>:<mode>` — the SAME file, and the SAME key, the interactive
 *      CLI's `/model` writes;
 *   2. `skill-gate#resolveSkillTurnOverride` resolves that id against
 *      `config.modelCandidates` to get a PORT.
 *
 * With half 2 absent, step 1 returned the operator's persisted pick and step 2
 * dropped it on the floor: `resolvePort` missed, `llm` fell back to
 * `config.llm`, and the one-shot run silently executed the BOOT model with no
 * warning on any surface (headless paints no banner, so nothing said so).
 * Verified end-to-end against the real root before this fix: with a pick on
 * disk, `readStickyModelForMode(base)` ⇒ `"gpt-4o"` while
 * `resolveSkillTurnOverride(base, undefined, "gpt-4o").llm === base.llm` (the
 * boot port).
 *
 * HOW IT IS CLOSED — the same shape the two LIVE surfaces use
 * (`apps/cli/repl/surface-compose/core-state.ts#buildModelSwitchWire` and
 * `apps/web-daemon/web-model-switch.ts`), through the SHARED wire
 * (`@/llm/model-catalog#buildModelCatalogWire`) rather than a third copy of
 * "which models can this session switch to":
 *
 *   - the persisted pick is read SYNCHRONOUSLY at mint (the store's own `peek`,
 *     which is the port's sync seam over `readStickyModelSnapshotSync`) and
 *     seeded as `extraIds`, so the pick's PORT exists before turn 1;
 *   - NO PROBE. `LLMPort.listModels` is never called here: a headless run must
 *     pay no boot-time network call, and nothing on this surface renders a
 *     picker that would want the live catalog. The wire's `refresh()` stays
 *     un-invoked (it is lazy by construction), so the candidate set is exactly
 *     "the pick that is already on disk".
 *   - INVARIANT B — the ports are built HERE (`tryCreateLLM` + the shared
 *     `decorateSwappableModelPort`), so a swapped-in model keeps bounded retry,
 *     the empty-stream circuit breaker and the progress heartbeat instead of
 *     streaming through a bare adapter;
 *   - INVARIANT A — the boot model is deliberately NOT a candidate; picking it
 *     misses and falls through to `config.llm`, the real session port.
 *
 * SLOT-ABSENT WHEN THERE IS NOTHING TO OFFER. The default one-shot run (no
 * `--sticky-model`, so an in-memory store that no surface ever writes; or no
 * pick on disk) yields NO candidate and the slot is OMITTED — byte-identical to
 * the pre-fix base for every such run, which is why the composition-slot
 * byte-identical hellgate's fingerprints are untouched. A host on this root that
 * later grows a PICKER (and therefore wants the lazy provider probe) must attach
 * the wire's live array unconditionally instead — it grows in place on `refresh`,
 * and an omitted slot cannot grow.
 */

import { type AgentMode, resolveAgentMode } from "@/agent"
import {
  fsBackedStickyModelStore,
  inMemoryStickyModelStore,
  type StickyModelStore,
  stickyModelPathFrom,
} from "@/agent/sticky-model"
import type { AssembleRequest } from "@/host/runtime/agent-config-assembler"
import { type LLMPort, type Provider, tryCreateLLM } from "@/llm"
import { buildModelCatalogWire } from "@/llm/model-catalog"
import { decorateSwappableModelPort } from "@/runner/assemble"

/** The base shape this slot contributes to (same alias the slot registry uses). */
type Base = AssembleRequest["base"]

/**
 * The agent mode a pick on THIS root targets.
 *
 * It MUST match what the loop's read side derives, or the seed lands for a key
 * the read never looks at. `buildBaseFromArgs` sets neither `mode` nor
 * `planMode` and wires no `agentModeState`, so the loop's
 * `resolveLiveAgentMode` collapses to `resolveAgentMode(undefined, undefined)`
 * — computed through that same SSOT helper here (rather than hardcoding
 * `"default"`) so a future one-shot plan posture is a one-place change.
 * Mirrors `web-model-switch.ts#webAgentMode`.
 */
const oneShotAgentMode = (): AgentMode => resolveAgentMode(undefined, undefined)

export const resolveModelCandidatesSlot = (args: {
  /** The boot port — the probe surface AND the boot model's port (invariant A). */
  readonly llm: LLMPort
  /** The provider the boot port was built for (`pickProvider(env)`). */
  readonly provider: Provider
  /** The ALREADY-RESOLVED sticky slot (`resolveStickyModelStore`) — the SAME
   *  store instance the base carries, so the seed is read through the exact port
   *  the loop will read through (an in-memory default store peeks empty ⇒ no
   *  candidate ⇒ no slot). */
  readonly stickyModelStore: { readonly store: StickyModelStore } | undefined
  /** The composition root's env view (carries an explicit `--provider` seed). */
  readonly env: NodeJS.ProcessEnv
  /** The root's REAL cancellation signal, threaded into each candidate port's
   *  bounded-retry decorator so Ctrl+C cancels a swapped turn too. Absent ⇒
   *  omitted (the decorator self-manages). */
  readonly signal: AbortSignal | undefined
}): Partial<Base> => {
  const store = args.stickyModelStore?.store
  if (store === undefined) return {}
  // The key the LOOP will compose: `stickyModelStore` carries no `provider`, so
  // `readStickyModelForMode` falls back to `config.llm.provider` — read the same
  // field here rather than `args.provider`, which would silently diverge for any
  // port whose `provider` field is absent (legacy key) or differs.
  const persisted = store.peek({
    mode: oneShotAgentMode(),
    ...(args.llm.provider !== undefined ? { provider: args.llm.provider } : {}),
  })
  if (persisted === undefined || persisted === "") return {}
  const catalog = buildModelCatalogWire({
    provider: args.provider,
    bootModel: args.llm.model ?? "",
    llm: args.llm,
    seeded: [],
    extraIds: [persisted],
    buildPort: (id: string) => {
      const inner = tryCreateLLM(args.provider, { model: id }, args.env)
      return inner === null
        ? null
        : decorateSwappableModelPort({
            inner,
            ...(args.signal !== undefined ? { signal: args.signal } : {}),
          })
    },
    env: args.env,
  })
  // EMPTY ⇒ omit the key (never `{ modelCandidates: [] }`): the pick was the boot
  // model (invariant A), an implausible slug, or an id no port could be built for
  // — all three already logged by the wire, and all three mean "nothing to swap
  // to", which is exactly what an absent slot says to the loop.
  return catalog.candidates.length > 0 ? { modelCandidates: catalog.candidates } : {}
}

/** ADR-0236 / jun-11 (#4) — wire the sticky-model store slot (HALF ONE). The
 *  default is now an IN-MEMORY store so `/model` switches the model IN-SESSION
 *  out of the box (no `--sticky-model` flag required — previously this returned
 *  `undefined`, so `buildModelAdapterWire` returned `{}` and `/model` printed
 *  "not wired"). The store is INERT until set: an empty store's `get()` returns
 *  `undefined`, so the per-turn model resolver
 *  (`skill-gate#readStickyModelForMode`) falls back to the boot model —
 *  byte-identical for any surface that never calls `/model` (headless /
 *  one-shot included). `--sticky-model` upgrades to the fs-backed store
 *  (`~/.quanta/sticky-model.json`) for cross-session PERSISTENCE.
 *
 *  Lives beside {@link resolveModelCandidatesSlot} (aug-28) because the two are
 *  ONE feature: this half is read every turn, that half is what makes the read
 *  actionable. Re-exported from `agent-arg-builder` so every existing importer
 *  (and its unit test) resolves it unchanged.
 *
 *  Return type keeps `| undefined` so existing call-site undefined-guards stay
 *  valid (the default simply never returns it). */
export const resolveStickyModelStore = (
  stickyModel: boolean | undefined,
  /** The store FILE. Absent ⇒ the port's own default
   *  (`~/.quanta/sticky-model.json` off the frozen runtime config), which is what
   *  every pre-aug-28 caller got. The composition root passes an env-derived path
   *  (see {@link resolveModelSwitchSlots}) so a root whose `QUANTA_CONFIG_DIR`
   *  resolved late cannot read one file and write another. Ignored for the
   *  in-memory default (it has no file). */
  path?: string,
): { readonly store: StickyModelStore } | undefined => {
  // fs-backed construction is IO-free (it only computes its path; all fs access
  // is deferred to get/set/load), so it cannot throw here — a read-only fs or
  // corrupt home dir surfaces as a TYPED result at the call site (get/load
  // degrade to the global default; set returns a `StickyModelWriteError` that
  // `/sticky-model` renders). In-memory set/get round-trips in process and is
  // dropped on exit (no persistence) — exactly the session-scoped default.
  return {
    store:
      stickyModel === true
        ? fsBackedStickyModelStore(path !== undefined ? { path } : undefined)
        : inMemoryStickyModelStore(),
  }
}

/**
 * BOTH halves in ONE call — what the composition root actually uses.
 *
 * The keystone (`buildBaseFromArgs`) resolves the switch through this single
 * seam rather than calling the two resolvers separately, because "one half was
 * wired and the other was not" is precisely the defect this module exists to
 * close: with one call site there is no place for the halves to drift apart
 * again. Returns the two spread-ready slot values the base fold consumes.
 */
/** What the composition root must hand the switch: the boot port (to exclude the
 *  boot model and to read the loop's own provider off), the provider + env used
 *  to build candidate ports, the root's cancel signal, and the hermetic
 *  sticky-file seam. Declared HERE so the keystone's helper signature is one
 *  named type rather than a re-spelled inline bundle. */
export interface ModelSwitchInputs {
  readonly llm: LLMPort
  readonly provider: Provider
  readonly signal: AbortSignal | undefined
  /** Hermetic override for the sticky FILE (`CompositionSeams.stickyModelPath`).
   *  Absent ⇒ derived from `env`. */
  readonly stickyModelPath?: string | undefined
}

export const resolveModelSwitchSlots = (
  args: ModelSwitchInputs & {
    /** `--sticky-model` (fs-backed, cross-session) vs the in-memory default. */
    readonly stickyModel: boolean | undefined
    readonly env: NodeJS.ProcessEnv
  },
): {
  readonly stickyModelStore: { readonly store: StickyModelStore } | undefined
  readonly modelCandidatesSlot: Partial<Base>
} => {
  // `stickyModelPathFrom(env)` — NOT the port's frozen-config default: this root
  // HOLDS an env bag, and the read that seeds the candidate below must hit the
  // same file the store writes (see that helper's header).
  const stickyModelStore = resolveStickyModelStore(
    args.stickyModel,
    args.stickyModelPath ?? stickyModelPathFrom(args.env),
  )
  return {
    stickyModelStore,
    modelCandidatesSlot: resolveModelCandidatesSlot({
      llm: args.llm,
      provider: args.provider,
      stickyModelStore,
      env: args.env,
      signal: args.signal,
    }),
  }
}
