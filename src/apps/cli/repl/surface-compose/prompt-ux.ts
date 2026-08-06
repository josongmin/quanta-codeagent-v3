import type { AgentMode, EffortLevel } from "@/agent"
import {
  buildMentionProviderListers,
  type MentionLiveSources,
} from "@/host/runtime/internal/mention-source-deps"
import { buildMentionSymbolDeps } from "@/host/runtime/internal/mention-symbol-deps"
import type { ModelEffortSupport } from "@/llm/provider-metadata"
import { gateOn, runtimeConfig } from "@/shared"
import {
  type AtCandidateProvider,
  atAutocompleteEnabled,
  createCompositeAtProvider,
} from "../../at-autocomplete"
import { nextSupportedEffort } from "../../effort-cycle"
import { loadKeybindings } from "../../keybindings/load"
import type { KeybindingMap } from "../../keybindings/types"
import {
  createModeCycleStore,
  formatPostureMeta,
  type ModeCycleStore,
  modeCycleEnabled,
} from "../../mode-cycle"
import { createPromptHistory, type PromptHistory } from "../../prompt-history"
import { buildExternalEditor, type ExternalEditorPort } from "../../raw-line-reader-editor"
import type { CliFeatureConfig } from "../cli-feature-config"

export interface PromptUxOpts {
  readonly promptHistory?: PromptHistory
  readonly multiline?: boolean
  readonly atProvider?: AtCandidateProvider
  /** RFC-08 / ADR-0443 — the turn-boundary mode store, present iff
   *  `QUANTA_MODE_CYCLE=1`. The host (session-loop) reads `.current()
   *  .permissionMode` for the next `createSession`; the prompt pipeline reads
   *  `modeMeta` + `onCycleMode` (derived from the same store) for the pill +
   *  shift+tab hook. Absent ⇒ no pill, shift+tab ignored (byte-identical). */
  readonly modeCycle?: ModeCycleStore
  readonly modeMeta?: string
  readonly onCycleMode?: () => { meta?: string } | undefined
  /** RFC-08 BUILD-1 — bound `effort-cycle` action hook. Present iff BOTH the
   *  keybinding layer is enabled (a chord CAN be bound) AND the host supplied the
   *  effort-cycle wire (slash `effort` + `model`). The callback reads the live
   *  model + current effort, computes the next supported tier via
   *  `nextSupportedEffort`, and calls the EXISTING `effort.set` (same store +
   *  pill as `/effort`). Owns NO store/model/config. Absent ⇒ a bound chord is
   *  inert (byte-identical). */
  readonly onCycleEffort?: () => void
  /** RFC-11 / ADR-0446 — external `$EDITOR` composition port. Present iff
   *  `QUANTA_EXTERNAL_EDITOR=1`. Absent ⇒ ctrl-x ctrl-e inert (byte-identical). */
  readonly openEditor?: ExternalEditorPort
  /** RFC-11 / ADR-0447 — loaded `~/.quanta/keybindings.json` map (merged over
   *  defaults). Present iff `QUANTA_KEYBINDINGS=1`. Absent ⇒ hardcoded keys
   *  (byte-identical). */
  readonly keybindings?: KeybindingMap
  /** jun-6 (Codex paste-burst) — large-paste coalescing threshold. Present iff
   *  `QUANTA_PASTE_BURST` is a positive integer (read via `runtimeConfig`).
   *  Absent ⇒ paste echoes inline (byte-identical). */
  readonly pasteBurst?: { readonly minChars: number }
  /** #10 (jun-11) — bracketed-paste mode. Present iff `QUANTA_BRACKETED_PASTE`
   *  is on (CLI-default-ON). Absent ⇒ byte-identical (pasted newline early-submits). */
  readonly bracketedPaste?: boolean
}

/** RFC-08 / ADR-0443 — build the mode-cycle store + its derived pill/hook when
 *  `QUANTA_MODE_CYCLE=1`. The store is the single source of truth: the pill
 *  meta and the shift+tab `onCycleMode` both project from it, and session-loop
 *  reads its `.current().permissionMode` for the next session. Absent knob ⇒
 *  `undefined` everywhere ⇒ byte-identical. */
const buildModeCycle = (
  env: NodeJS.ProcessEnv,
  onPosture?: (agentMode: AgentMode) => void,
  // #13 — when the surface already built a mode-cycle store (so `/mode` mutates
  // the SAME instance the shift+tab pill + session-loop projection read), reuse
  // it instead of minting a second one (two stores would diverge). Absent ⇒
  // create one locally (legacy path for callers without the shared store).
  sharedStore?: ModeCycleStore,
): Pick<PromptUxOpts, "modeCycle" | "modeMeta" | "onCycleMode"> => {
  if (!modeCycleEnabled(env)) return {}
  const store = sharedStore ?? createModeCycleStore()
  // Paint the bottom status-bar pill at start too, so BOTH surfaces (the
  // input meta row + the status bar) agree from the first render (RFC-08 §4.3).
  onPosture?.(store.current().agentMode)
  return {
    modeCycle: store,
    modeMeta: formatPostureMeta(store.current()),
    onCycleMode: () => {
      const p = store.cycle()
      // Mirror the new posture's AgentMode onto the bottom status bar (the
      // existing `formatMode` pill renders plan/review/audit; default ⇒ hidden).
      onPosture?.(p.agentMode)
      return { meta: formatPostureMeta(p) }
    },
  }
}

/** RFC-08 BUILD-1 — the live owner wires the effort-cycle callback composes over.
 *  ALL three are EXISTING owners, projected as thunks so prompt-ux owns no state:
 *   - `currentModel()` — the live slash model wire's `current()` (adapter shadow,
 *     NOT boot `setup.model`), so a `/model` switch is reflected on the next press.
 *   - `effortSupport(id)` — the live wire's per-model reasoning-effort metadata.
 *   - `effort.get/set` — the SAME `EffortStore`-backed slash `effort` wire (its
 *     `set` also repaints the pill), so `/effort`, the chord, and the next LLM
 *     request all agree on one cell. */
export interface EffortCycleWire {
  readonly currentModel: () => string
  readonly effortSupport: (id: string) => ModelEffortSupport | undefined
  readonly effort: { readonly get: () => EffortLevel; readonly set: (level: EffortLevel) => void }
}

/** RFC-08 BUILD-1 — build the bound `effort-cycle` callback. Gated on BOTH the
 *  keybinding layer (a chord CAN be bound) AND the host supplying the wire.
 *  Absent either ⇒ `undefined` ⇒ a bound chord is inert (byte-identical). The
 *  callback owns no store/model/config: it reads the live model + current
 *  effort, computes the next SUPPORTED tier via the pure `nextSupportedEffort`
 *  leaf, and calls the EXISTING `effort.set` (same store + pill as `/effort`). */
const buildEffortCycle = (
  env: NodeJS.ProcessEnv,
  wire: EffortCycleWire | undefined,
): Pick<PromptUxOpts, "onCycleEffort"> => {
  if (wire === undefined || !gateOn(env, "QUANTA_KEYBINDINGS")) return {}
  return {
    onCycleEffort: () => {
      const model = wire.currentModel()
      const support = wire.effortSupport(model)
      const next = nextSupportedEffort(wire.effort.get(), support)
      wire.effort.set(next)
    },
  }
}

/** RFC-12 / ADR-0439 — build the `@`-mention autocomplete provider when the
 *  feature is enabled (`QUANTA_AT_AUTOCOMPLETE=1`). File listing is live (cwd
 *  jail = the resolver root); symbol listing reuses the SAME lazy union-LSP
 *  port the agent loop's `@symbol` resolver uses (`buildMentionSymbolDeps`),
 *  so an installed language server lights both surfaces with one wire. Absent
 *  knob ⇒ `undefined` ⇒ `readLine` byte-identical. */
const buildAtProvider = async (
  cwd: string,
  env: NodeJS.ProcessEnv,
  // RFC-12-2 WIRING — the CLI's LIVE mention sources (mcp snapshot + named-agent
  // registry + session thunk). Absent ⇒ the mcp/subagent/thread listers are
  // omitted ⇒ zero candidates for those kinds (byte-identical). The `@`-surface
  // as a whole still rides `QUANTA_AT_AUTOCOMPLETE` (the early return below).
  mentionSources?: MentionLiveSources,
): Promise<AtCandidateProvider | undefined> => {
  if (!atAutocompleteEnabled(env)) return undefined
  const symbolDeps = buildMentionSymbolDeps(cwd, env)
  // RFC-12-2 — the per-kind listers gate on `QUANTA_MENTION_{MCP,SUBAGENT,THREAD}`
  // inside the builder (provider parity with the resolver's downstream gate).
  const mentionListers =
    mentionSources !== undefined ? await buildMentionProviderListers(mentionSources, env) : {}
  return createCompositeAtProvider({
    fileRoot: cwd,
    ...(symbolDeps.lsp !== undefined ? { symbolLookup: symbolDeps.lsp } : {}),
    ...mentionListers,
  })
}

/** Slice-C: UX opts (history + multiline + `@`-autocomplete) the prompt
 *  pipeline consumes. Default-ON history when the env knob is unset; explicit
 *  `=0` reverts to the no-history single-line path. ADR-0297: consumes the
 *  typed surface feature record + an INJECTED `cwd`/`env` (no `process.*`
 *  reads survive here — the host passes both). `@`-autocomplete is default-OFF
 *  (its own env knob, read off the injected `env`). */
export const buildPromptUx = async (
  featureCfg: CliFeatureConfig,
  cwd: string,
  env: NodeJS.ProcessEnv,
  /** RFC-08 — optional sink the host wires to `pills.update({mode})` so a
   *  shift+tab posture change also repaints the bottom status-bar pill. Absent
   *  ⇒ only the input meta-row pill updates (still correct, just one surface). */
  onPosture?: (agentMode: AgentMode) => void,
  // #13 — the surface-owned mode-cycle store (from `composeSurfaceWires`) so the
  // shift+tab cycle and `/mode` share ONE instance. Absent ⇒ buildModeCycle
  // mints its own (legacy / test path).
  modeCycleStore?: ModeCycleStore,
  // RFC-08 BUILD-1 — the live effort-cycle owner wire (slash `effort` + `model`).
  // Absent ⇒ no `onCycleEffort` ⇒ a bound `effort-cycle` chord is inert.
  effortCycle?: EffortCycleWire,
  // RFC-12-2 WIRING — the CLI's LIVE mention sources (mcp snapshot + named-agent
  // registry + session thunk) for the `@mcp:` / `@subagent:` / `@thread:`
  // autocomplete listers. Absent ⇒ those kinds contribute zero candidates
  // (byte-identical). Rides `QUANTA_AT_AUTOCOMPLETE` + the per-kind knobs.
  mentionSources?: MentionLiveSources,
): Promise<PromptUxOpts> => {
  const { history, multiline } = featureCfg
  const promptHistoryOpts: Parameters<typeof createPromptHistory>[0] = {
    maxLines: history.maxLines,
    ...(history.filePath !== undefined ? { filePath: history.filePath } : {}),
  }
  const promptHistory = history.enabled ? createPromptHistory(promptHistoryOpts) : undefined
  const atProvider = await buildAtProvider(cwd, env, mentionSources)
  // RFC-11 — external editor (A) + keybindings (B). Both default-OFF; each
  // gated on its own env knob, read off the injected `env` (no `process.*`).
  const openEditor = externalEditorEnabled(env)
    ? buildExternalEditor({ env, onWarn: (line) => process.stderr.write(`${line}\n`) })
    : undefined
  const keybindings = await buildKeybindingMap(env)
  // jun-6 paste-burst — read the threshold from the frozen runtime-config (the
  // SINGLE env touchpoint; no new `env.QUANTA_*` gate here). Absent / invalid ⇒
  // undefined ⇒ the reader echoes a paste inline (byte-identical).
  const pasteBurstMinChars = runtimeConfig().pasteBurstMinChars
  // #10 — bracketed-paste gate (CLI-default-ON via CLI_FEATURE_GATES). Read off
  // the injected `env` (no `process.*`); OFF ⇒ slot omitted ⇒ byte-identical.
  const bracketedPaste = gateOn(env, "QUANTA_BRACKETED_PASTE")
  return {
    ...(promptHistory !== undefined ? { promptHistory } : {}),
    multiline: multiline.enabled,
    ...(atProvider !== undefined ? { atProvider } : {}),
    ...buildModeCycle(env, onPosture, modeCycleStore),
    ...buildEffortCycle(env, effortCycle),
    ...(openEditor !== undefined ? { openEditor } : {}),
    ...(keybindings !== undefined ? { keybindings } : {}),
    ...(pasteBurstMinChars !== undefined ? { pasteBurst: { minChars: pasteBurstMinChars } } : {}),
    ...(bracketedPaste ? { bracketedPaste: true } : {}), // #10
  }
}

/** RFC-11 / ADR-0446 — `QUANTA_EXTERNAL_EDITOR=1` gate. Default OFF; only the
 *  literal `"1"` enables (mirrors the strict opt-in posture of the new RFC-11
 *  layers — bad/absent value ⇒ off ⇒ byte-identical). */
const externalEditorEnabled = (env: NodeJS.ProcessEnv): boolean =>
  gateOn(env, "QUANTA_EXTERNAL_EDITOR")

/** RFC-11 / ADR-0447 — `QUANTA_KEYBINDINGS=1` gate. When set, load + merge
 *  `~/.quanta/keybindings.json` over the defaults; any load defect degrades to
 *  the default map (no-throw) and warnings are echoed to stderr. Absent ⇒
 *  `undefined` ⇒ the reader runs its hardcoded if-chain (byte-identical). */
const buildKeybindingMap = async (env: NodeJS.ProcessEnv): Promise<KeybindingMap | undefined> => {
  if (!gateOn(env, "QUANTA_KEYBINDINGS")) return undefined
  const { map, warnings } = await loadKeybindings()
  for (const w of warnings) process.stderr.write(`keybindings: ${w}\n`)
  return map
}
