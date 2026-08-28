/**
 * Boot-time sticky-model resolution — ONE place, three consumers (aug-27).
 *
 * A `/model` pick persists to `~/.quanta/sticky-model.json`, so a FRESH session
 * must agree with it in three independent spots that all run before the first
 * turn:
 *   1. the welcome banner's `model` row (rendered in `repl.ts`, before the
 *      surface — and thus before the `/model` adapter — exists);
 *   2. the `/model` picker's `current()` + the status-line model source (the
 *      adapter's per-mode shadow is seeded from this snapshot);
 *   3. the CANDIDATE PORT for the persisted id — without it the loop's swap
 *      (`skill-gate#resolveSkillTurnOverride`) finds no port on turn 1 and
 *      silently runs the boot model while (1) and (2) claim otherwise.
 *
 * The mode derivation is the load-bearing part: it MUST match what the loop's
 * consume side reads — `resolveLiveAgentMode` (`@/agent/mode`), which prefers the
 * LIVE `agentModeState` cell (the CLI's shift+tab mode cycle, wired by
 * `session-loop/bootstrap.ts`) over `config.mode`/`config.planMode`. An earlier
 * version of this file named `resolveAgentMode(config.mode, config.planMode)` and
 * derived the key statically from `planMode`; that was wrong in BOTH directions
 * once the mode cycle (CLI-seeded default-ON) is in play:
 *   - shift+tab to PLAN then `/model X` ⇒ the write keyed `default`, the loop read
 *     `plan` ⇒ the pick never applied while every display claimed it had;
 *   - `--plan` ⇒ the write keyed `plan`, the loop read the cycle's rung.
 * So the derivation lives in ONE place ({@link liveAgentMode}) that mirrors
 * `resolveLiveAgentMode`'s precedence exactly, and every consumer takes it.
 *
 * No-throw / fail-open by construction: the snapshot reader swallows a missing,
 * unreadable, or corrupt file into an empty snapshot, so every consumer falls
 * back to the boot model.
 */

import { type AgentMode, resolveAgentMode } from "@/agent"
import {
  defaultStickyModelPath,
  readStickyModelSnapshotSync,
  stickyModelKeyOf,
  stickyModelPathFrom,
} from "@/agent/sticky-model"
import { isPlausibleModelSlug } from "@/llm/model-catalog"
import { logger } from "@/shared"

/**
 * The sticky-model file this surface reads AND writes — resolved from the
 * INJECTED env when the caller has one.
 *
 * Both halves must agree: the boot snapshot read and the `StickyModelStore` the
 * slash command writes through. Resolving them independently (one off the global
 * `runtimeConfig()`, one off an injected bag) would make a test-injected
 * `QUANTA_CONFIG_DIR` move only one of them — the store would then write to the
 * DEVELOPER's real `~/.quanta` while the read stayed hermetic. Passing `env`
 * keeps every composition (and every test) on ONE path.
 */
export const stickyModelFilePath = (env?: Record<string, string | undefined>): string =>
  env === undefined ? defaultStickyModelPath() : stickyModelPathFrom(env)

/** The live agent-mode cell this surface reads: the mode-cycle store's posture
 *  projection. Structural (not the concrete store type) so the resolver can be
 *  driven by a test or by a surface that has no cycle. */
export interface AgentModeCell {
  readonly current: () => { readonly agentMode: AgentMode }
}

/**
 * THE mode resolver for the surface's model wire — a mirror of the loop's
 * `resolveLiveAgentMode`: the LIVE cell wins, else `mode`/`planMode`. Every
 * writer/reader of the sticky key on this surface must go through this, or the
 * write and the read drift the moment the operator presses shift+tab.
 */
export const liveAgentMode = (args: {
  readonly planMode: boolean
  readonly agentModeCell?: AgentModeCell | undefined
}): (() => AgentMode) => {
  const fallback = resolveAgentMode(undefined, args.planMode)
  return () => args.agentModeCell?.current().agentMode ?? fallback
}

export interface StickyModelBootView {
  /** The whole `{ mode → modelId }` snapshot as read at boot. Seeds the
   *  `/model` adapter's per-mode sync shadow (so `current()` is right on a
   *  fresh session, for EVERY mode — not just the active one). */
  readonly snapshot: Readonly<Record<string, string>>
  /** The persisted model for the mode THIS session will run in, or `undefined`
   *  when there is no preference. */
  readonly modelId: string | undefined
  /** `modelId ?? bootModel` — what the surface should DISPLAY as the model this
   *  session runs. */
  readonly effectiveModel: (bootModel: string) => string
}

/** Read the persisted per-mode picks once, for the mode this session runs in.
 *  `planMode` is the CLI's `--plan` flag, the same input the loop's mode
 *  derivation gets. */
/**
 * The persisted picks this session may adopt, VETTED PER KEY (aug-28).
 *
 * Two things used to be checked only for the CURRENT mode's key while the whole
 * raw snapshot was handed on as the store's seed:
 *   - PLAUSIBILITY (the ANSI/OSC injection defense). A hostile id stored under
 *     another mode therefore sailed in and became the live pick the moment the
 *     operator pressed shift+tab — the mode cycle is default-ON, so that is
 *     ordinary use, not an exotic path.
 *   - PROVIDER SCOPE. A pick is `<provider>:<mode>`; entries for other providers
 *     must not seed this session at all (a bare-mode key is the legacy shape and
 *     applies to whatever provider reads it).
 *
 * Returns only the entries that pass both, so ONE filter feeds the store seed, the
 * candidate-port seed and the current-mode resolution.
 */
export const vetPersistedPicks = (
  snapshot: Readonly<Record<string, string>>,
  provider?: string,
): Readonly<Record<string, string>> => {
  const out: Record<string, string> = {}
  for (const [key, id] of Object.entries(snapshot)) {
    const scoped = key.includes(":")
    if (scoped && (provider === undefined || !key.startsWith(`${provider}:`))) continue
    if (!isPlausibleModelSlug(id)) {
      logger.warn(
        `sticky-model: ignoring an implausible persisted model id at key "${key}" ` +
          `(${id.length} chars) — it will not seed this session`,
      )
      continue
    }
    out[key] = id
  }
  return out
}

/**
 * Keep only the picks a PORT exists for (aug-28), per key.
 *
 * A pick whose port could not be built (another provider's slug, a model this
 * credential no longer has) must not seed the session: the loop would fall back to
 * the boot model while the picker, banner and status line all announced the pick —
 * the same "displays disagree with the turn" failure this campaign exists to close.
 *
 * PER KEY, and that is the whole point of the function. The check used to be
 * all-or-nothing: one unrunnable entry replaced the WHOLE snapshot with `{}`, which
 * erased a perfectly good pick for another mode from the store seed, from
 * `/sticky-model list` and from every display — punishing an entry that had nothing
 * to do with the failure. Extracted (rather than inlined at the composition root)
 * because that root has credentials for its own provider, so the "plausible but
 * unbuildable" case is unreachable from a surface test: the filter has to be
 * testable on its own or it is not tested at all.
 */
export const vetRunnablePicks = (
  snapshot: Readonly<Record<string, string>>,
  switchable: readonly string[],
  onDropped?: (key: string, id: string) => void,
): Readonly<Record<string, string>> => {
  const out: Record<string, string> = {}
  for (const [key, id] of Object.entries(snapshot)) {
    if (switchable.includes(id)) out[key] = id
    else onDropped?.(key, id)
  }
  return out
}

export const resolveStickyModelBoot = (args: {
  readonly planMode: boolean
  /** Composition-root env, used to resolve the store path
   *  ({@link stickyModelFilePath}). Absent ⇒ the global default path. */
  readonly env?: Record<string, string | undefined>
  /** Explicit path override; wins over `env`. */
  readonly path?: string
  /** The LIVE agent-mode cell (the mode cycle). Absent ⇒ `planMode` decides.
   *  Passing it is what keeps the boot read on the SAME key the loop will use. */
  readonly agentModeCell?: AgentModeCell | undefined
  /**
   * aug-28 PRECEDENCE — the operator pinned the model for THIS invocation
   * (`QUANTA_MODEL` / `--model`). An explicit per-invocation flag must beat a
   * stored preference: `QUANTA_MODEL=x quanta "…"` in CI/cron/a git hook otherwise
   * ran whatever a human last picked with `/model`, and the one-shot path paints
   * no banner, so nothing said so. The pick is not erased — it just does not seed
   * THIS session (and `/model` still works in-session).
   */
  readonly explicitPin?: boolean
  /** The session's provider — part of the sticky key (see `StickyModelKey`), so a
   *  pick made under another provider is simply not read here. */
  readonly provider?: string
}): StickyModelBootView => {
  if (args.explicitPin === true) {
    return { snapshot: {}, modelId: undefined, effectiveModel: (bootModel) => bootModel }
  }
  const path = args.path ?? stickyModelFilePath(args.env)
  // Vetted PER KEY (see `vetPersistedPicks`): the returned `snapshot` is what
  // seeds the store, so an entry this session must not adopt cannot ride along in
  // it for another mode to pick up on the next shift+tab.
  const snapshot = vetPersistedPicks(readStickyModelSnapshotSync({ path }), args.provider)
  const mode = liveAgentMode({
    planMode: args.planMode,
    ...(args.agentModeCell !== undefined ? { agentModeCell: args.agentModeCell } : {}),
  })()
  const persisted =
    snapshot[
      stickyModelKeyOf({
        mode,
        ...(args.provider !== undefined ? { provider: args.provider } : {}),
      })
    ]
  // aug-28 SECURITY — the file is an UNTRUSTED input (any local process, and the
  // agent's OWN bash tool, can write it) and this value is rendered raw into the
  // welcome banner at first paint. A measured hostile value carried ANSI/OSC + a
  // newline: it cleared the screen, set the terminal title, and forged a top-level
  // "Approve destructive action?" line. The rejection happens in
  // `vetPersistedPicks` above — for EVERY key, not just this mode's — so the
  // banner, the status line, `/model`'s header, the store seed and the eager
  // candidate seed are all protected by one check.
  const modelId = persisted
  return {
    snapshot,
    modelId,
    effectiveModel: (bootModel: string): string =>
      modelId !== undefined && modelId.length > 0 ? modelId : bootModel,
  }
}
