import { EFFORT_LEVELS, effortToTokenBudget } from "@/agent"
import {
  defaultGranularRegistry,
  type GranularRegistryPort,
} from "@/agent/checkpoint/granular-registry"
import {
  buildUsageBreakdownDefault,
  type ContextUsageBreakdown,
  type PromptAssembledSnapshot,
  snapshotToBreakdownInput,
} from "@/agent/context/usage-breakdown"
import {
  type ConversationCheckpointStore,
  defaultConversationCheckpointStore,
} from "@/agent/conversation-checkpoint"
import { buildMentionSymbolDeps } from "@/host/runtime/internal/mention-symbol-deps"
import type { Message } from "@/llm"
import { buildCostDashboard, GEN_AI_ATTRS, renderDashboardText } from "@/observability"
import type {
  RuntimeFacadeComposeOptions,
  RuntimeSideConversationArgs,
  RuntimeSideConversationResult,
} from "@/sdk/runtime"
import {
  loadSessionById,
  type SavedSession,
  type SessionEnvelopeRecord,
  saveSessionById,
} from "@/session"
import { errMessage, logger } from "@/shared"
import {
  type AtCandidateProvider,
  atAutocompleteEnabled,
  createCompositeAtProvider,
} from "../at-autocomplete"
import { runImageCmd } from "../image-cmd"
import type { ImageQueue } from "../image-queue"
import {
  createModeCycleStore,
  formatPostureMeta,
  type ModeCycleStore,
  modeCycleEnabled,
} from "../mode-cycle"
import { createPromptHistory, type PromptHistory } from "../prompt-history"
import type { RewindSlashState } from "../rewind-cmd"
import type { ConvCheckpointSlashState } from "../rewind-conv-cmd"
import type { SessionIoState } from "../session-cmd"
import { isSlashCommand, runSlashCommand, type SlashContext } from "../slash-commands"
import type { StatusBar } from "../status-bar"
import type { SegmentedUsageView } from "../status-line"
import { createTextInbox, type TextInbox } from "../text-inbox"
import type { CliFeatureConfig } from "./cli-feature-config"
import { type ContextUsageHolder, createContextUsageHolder } from "./context-usage-snapshot"
import { type ConvCheckpointWire, startConvCheckpointWire } from "./conv-checkpoint-wire"
import { type ComposerHandle, createComposerHandle } from "./ctx-adapters/composer-edit-adapter"
import { createPerToolSnapshotRecorder } from "./per-tool-snapshot-recorder"
import {
  createPlaybookTriggerSurfaceSeam,
  type PlaybookTriggerSurfaceSeam,
} from "./playbook-trigger-surface-seam"
import type { SessionLoopSinks } from "./session-loop"
import type { SessionSetupResult } from "./session-setup"
import { buildSkillsCallback } from "./skills-surface"
import { buildReplSlashCtx, type ReplaySlashState, type ReplSlashCtx } from "./slash-surface"

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
}

/** RFC-08 / ADR-0443 — build the mode-cycle store + its derived pill/hook when
 *  `QUANTA_MODE_CYCLE=1`. The store is the single source of truth: the pill
 *  meta and the shift+tab `onCycleMode` both project from it, and session-loop
 *  reads its `.current().permissionMode` for the next session. Absent knob ⇒
 *  `undefined` everywhere ⇒ byte-identical. */
const buildModeCycle = (
  env: NodeJS.ProcessEnv,
): Pick<PromptUxOpts, "modeCycle" | "modeMeta" | "onCycleMode"> => {
  if (!modeCycleEnabled(env)) return {}
  const store = createModeCycleStore()
  return {
    modeCycle: store,
    modeMeta: formatPostureMeta(store.current()),
    onCycleMode: () => ({ meta: formatPostureMeta(store.cycle()) }),
  }
}

/** RFC-12 / ADR-0439 — build the `@`-mention autocomplete provider when the
 *  feature is enabled (`QUANTA_AT_AUTOCOMPLETE=1`). File listing is live (cwd
 *  jail = the resolver root); symbol listing reuses the SAME lazy union-LSP
 *  port the agent loop's `@symbol` resolver uses (`buildMentionSymbolDeps`),
 *  so an installed language server lights both surfaces with one wire. Absent
 *  knob ⇒ `undefined` ⇒ `readLine` byte-identical. */
const buildAtProvider = (cwd: string, env: NodeJS.ProcessEnv): AtCandidateProvider | undefined => {
  if (!atAutocompleteEnabled(env)) return undefined
  const symbolDeps = buildMentionSymbolDeps(cwd, env)
  return createCompositeAtProvider({
    fileRoot: cwd,
    ...(symbolDeps.lsp !== undefined ? { symbolLookup: symbolDeps.lsp } : {}),
  })
}

/** Slice-C: UX opts (history + multiline + `@`-autocomplete) the prompt
 *  pipeline consumes. Default-ON history when the env knob is unset; explicit
 *  `=0` reverts to the no-history single-line path. ADR-0297: consumes the
 *  typed surface feature record + an INJECTED `cwd`/`env` (no `process.*`
 *  reads survive here — the host passes both). `@`-autocomplete is default-OFF
 *  (its own env knob, read off the injected `env`). */
export const buildPromptUx = (
  featureCfg: CliFeatureConfig,
  cwd: string,
  env: NodeJS.ProcessEnv,
): PromptUxOpts => {
  const { history, multiline } = featureCfg
  const promptHistoryOpts: Parameters<typeof createPromptHistory>[0] = {
    maxLines: history.maxLines,
    ...(history.filePath !== undefined ? { filePath: history.filePath } : {}),
  }
  const promptHistory = history.enabled ? createPromptHistory(promptHistoryOpts) : undefined
  const atProvider = buildAtProvider(cwd, env)
  return {
    ...(promptHistory !== undefined ? { promptHistory } : {}),
    multiline: multiline.enabled,
    ...(atProvider !== undefined ? { atProvider } : {}),
    ...buildModeCycle(env),
  }
}

interface CostPanelDeltaBaseline {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
}

export interface SurfaceState {
  readonly imageQueue: ImageQueue | undefined
  readonly rewindState: RewindSlashState | undefined
  history: readonly Message[]
  readonly costDeltaPrev: CostPanelDeltaBaseline
}

export const createSurfaceState = (args: {
  readonly imageQueue: ImageQueue | undefined
  readonly rewindState: RewindSlashState | undefined
  readonly history: readonly Message[]
}): SurfaceState => ({
  imageQueue: args.imageQueue,
  rewindState: args.rewindState,
  history: args.history,
  costDeltaPrev: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
})

/** Track R — build the `/replay` resolver+iterator pair. Default reader is
 *  lazy-imported so `@/session` is not pulled into the boot path for users
 *  who never type `/replay`. The composer un-wraps the {@link iterateSessionFile}
 *  `Result` shape into a bare `AsyncIterable<SessionEnvelopeRecord>` — decode
 *  errors are silently skipped (the projector inside `/inspect` surfaces
 *  warnings; `/replay` is a one-line-per-event view that simply omits the bad
 *  row). The resolver returns `undefined` when the path doesn't exist so the
 *  command renders "session <id> not found" + exit 1. */
const buildReplaySlashState = (): ReplaySlashState => ({
  resolveSession: async (id: string): Promise<string | undefined> => {
    const { sessionEnvelopePath } = await import("@/session")
    const path = sessionEnvelopePath(id)
    const file = Bun.file(path)
    return (await file.exists()) ? path : undefined
  },
  iterate: (path: string): AsyncIterable<SessionEnvelopeRecord> => {
    const inner = async function* (): AsyncIterable<SessionEnvelopeRecord> {
      const { iterateSessionFile } = await import("@/session")
      for await (const r of iterateSessionFile(path)) {
        if (r.ok) yield r.value
      }
    }
    return inner()
  },
})

/** ADR-0310/0294 — session-io adapter for `/session export|import`. Default
 *  adapter delegates to the existing `loadSessionById`/`saveSessionById`
 *  primitives (id-addressable V2 store). Every method is no-throw on the
 *  public surface — read failure surfaces as `null`; write failures bubble
 *  up to the slash, which already wraps them in typed `ctx.err` + exit 1. */
const buildDefaultSessionIo = (): SessionIoState => ({
  readSession: async (id: string): Promise<SavedSession | null> => {
    try {
      const found = await loadSessionById(id)
      return found ?? null
    } catch (e) {
      logger.warn(`sessionIo.readSession failed: ${errMessage(e)}`)
      return null
    }
  },
  writeSession: async (id: string, session: SavedSession): Promise<void> => {
    try {
      // saveSessionById takes (meta, payload, provider). Reconstruct the
      // payload from the SavedSession the slash hands us. The slash rewrites
      // `meta.id` to `id` before calling so the two MUST agree here.
      const meta = session.meta.id === id ? session.meta : { ...session.meta, id }
      await saveSessionById(meta, {
        reason: session.reason,
        turns: session.turns,
        messages: session.messages,
      })
    } catch (e) {
      // Rethrow so the slash surfaces the error message — this matches the
      // contract documented in session-cmd.ts (the slash wraps in try/catch
      // and prints to ctx.err + exit 1).
      throw e instanceof Error ? e : new Error(String(e))
    }
  },
  mintNewId: (): string => crypto.randomUUID(),
})

/** ADR-0310 — bundle of REPL-side wires constructed once per session. The
 *  surface (`runRepl`) keeps the references alive so the loop can:
 *    - record turn snapshots into `convWire` (ADR-0292 turn-end auto-record),
 *    - attach the playbook-trigger handle into `playbookSeam` once the
 *      `ExternalPromptQueue` is born inside the loop (ADR-0293),
 *    - drain `textInbox` from the next-turn `PromptSource.next()` (ADR-0291),
 *    - mutate the surface's `composer` pending-text buffer from `/edit-message`
 *      (ADR-0291),
 *    - replace the live `history` binding from `/rewind-conv` (ADR-0292).
 *
 *  Default-OFF: knobs absent ⇒ every wire is built but the slots that gate the
 *  slash visibility (convCheckpoint, playbookSeam, the 8 ADR-0291 slots) are
 *  presence-spread so the projection is byte-identical to legacy when the
 *  operator did NOT opt in. */
export interface ReplSurfaceWires {
  readonly slashCtx: ReplSlashCtx
  /** ADR-0292 — surface-supplied state for `/rewind-conv`. Present iff the
   *  conv-checkpoint wire was constructed. */
  readonly convCheckpointSlot: ConvCheckpointSlashState | undefined
  /** ADR-0294 — surface-supplied session-io adapter for `/session`. Always
   *  wired in the REPL surface. */
  readonly sessionIo: SessionIoState
  /** Pre-composed dispatch closure that routes a slash command into the
   *  full augmented SlashContext (legacy + ADR-0291 + ADR-0292 + ADR-0294
   *  slots). Wires that aren't yet wired to runSlashCommand land here. */
  readonly dispatchSlash: (input: string) => Promise<boolean>
  /** ADR-0292 — turn-end auto-record wire. `null` ⇒ env knob is OFF; the
   *  loop's recordTurn hook is a no-op. */
  readonly convCheckpointWire: ConvCheckpointWire | null
  /** ADR-0292 — the shared store backing BOTH `convCheckpointWire` AND the
   *  `/fork-checkpoint` adapter (ADR-0291). One store per session. */
  readonly convStore: ConversationCheckpointStore
  /** ADR-0293 — seam the loop attaches the playbook-trigger handle to once
   *  it has the `ExternalPromptQueue` in hand. */
  readonly playbookSeam: PlaybookTriggerSurfaceSeam
  /** ADR-0291 — surface-owned mutable composer text holder. */
  readonly composerHandle: ComposerHandle
  /** ADR-0291 — surface-owned text inbox singleton. */
  readonly textInbox: TextInbox
  /** Constructor-time runtime composition inputs the loop threads into
   *  `runtimeContext.createRuntimeFacade(...)` so the public SDK surface stays
   *  immutable after bootstrap. */
  readonly runtimeFacadeCompose: RuntimeFacadeComposeOptions
  /** ADR-0292 — surface-side hook the loop uses to swap its live history
   *  binding when `/rewind-conv <tag>` restores a snapshot. Wired by the
   *  loop via a setter so the closure captures the loop-internal `let`
   *  history reference rather than the snapshot at compose time. */
  readonly setReplaceMessages: (fn: (msgs: ReadonlyArray<Message>) => Promise<void>) => void
  /** Runtime-owned `/side` starter slot. Installed by the loop once the live
   *  runtime session exists; until then `/side` keeps its historical
   *  "not wired" surface behavior. */
  readonly setSideConversationStart: (
    fn: ((args: RuntimeSideConversationArgs) => Promise<RuntimeSideConversationResult>) | undefined,
  ) => void
  /** Track D (runtime → REPL context wire) — the per-turn prompt-assembly sink
   *  the composition root wires into `AgentConfig.onPromptAssembled`. Each call
   *  retains the latest snapshot the `/context` slash renders via the
   *  `contextUsage` slot already wired into `slashCtx`. NOT wired here (the REPL
   *  surface does not own the AgentConfig — the runtime facade does); the
   *  integration layer hands this to config. Absent from config ⇒ the loop
   *  performs no capture (default-OFF byte-identical) and `/context` shows its
   *  fallback. */
  readonly promptAssembledSink: ContextUsageHolder["sink"]
}

/** Project the LEGACY slots (pre-ADR-0291). Extracted so the combined
 *  projector below stays under biome's cognitive-complexity cap. */
const projectLegacy = (c: ReplSlashCtx): Record<string, unknown> => ({
  ...(c.skills !== undefined ? { skills: c.skills } : {}),
  ...(c.idle !== undefined ? { idle: c.idle } : {}),
  ...(c.rewindSession !== undefined ? { rewindSession: c.rewindSession } : {}),
  ...(c.mcp !== undefined ? { mcp: c.mcp } : {}),
  ...(c.cost !== undefined ? { cost: c.cost } : {}),
  ...(c.planSnapshot !== undefined ? { planSnapshot: c.planSnapshot } : {}),
  ...(c.history !== undefined ? { history: c.history } : {}),
  ...(c.branchSearch !== undefined ? { branchSearch: c.branchSearch } : {}),
  // `side` is exposed as a factory on ReplSlashCtx; the contract takes the
  // produced state, so call it here.
  ...(c.side !== undefined ? { side: c.side() } : {}),
  ...(c.debug !== undefined ? { debug: c.debug } : {}),
  ...(c.why !== undefined ? { why: c.why } : {}),
  ...(c.inspect !== undefined ? { inspect: c.inspect } : {}),
  ...(c.replay !== undefined ? { replay: c.replay } : {}),
  ...(c.effort !== undefined ? { effort: c.effort } : {}),
  ...(c.contextUsage !== undefined ? { contextUsage: c.contextUsage } : {}),
})

/** Project the ADR-0291 slots. Extracted so the combined projector below
 *  stays under biome's cognitive-complexity cap. */
const projectAdr0291 = (c: ReplSlashCtx): Record<string, unknown> => ({
  ...(c.planEdit !== undefined ? { planEdit: c.planEdit } : {}),
  ...(c.composerEdit !== undefined ? { composerEdit: c.composerEdit } : {}),
  ...(c.forkSession !== undefined ? { forkSession: c.forkSession } : {}),
  ...(c.perToolCheckpoint !== undefined ? { perToolCheckpoint: c.perToolCheckpoint } : {}),
  ...(c.profile !== undefined ? { profile: c.profile } : {}),
  ...(c.identity !== undefined ? { identity: c.identity } : {}),
  ...(c.focusChain !== undefined ? { focusChain: c.focusChain } : {}),
  ...(c.textInbox !== undefined ? { textInbox: c.textInbox } : {}),
})

/** Project the legacy + ADR-0291 ReplSlashCtx slots onto the
 *  `SlashContext` shape. Mirrors `projectSlashCtx` inside
 *  `slash-surface.ts` byte-for-byte (kept in sync — both files spread by
 *  presence so missing slots stay omitted under exactOptionalPropertyTypes).
 *  Extracted here so this slice can ALSO spread the ADR-0292/0294
 *  augmentations (`convCheckpoint`, `sessionIo`) onto the same payload —
 *  the original projection lives in a sibling file owned by another
 *  ADR-0291 track and is intentionally kept narrow to that track's slots. */
const projectReplSlashCtxToContract = (c: ReplSlashCtx): Record<string, unknown> => ({
  ...projectLegacy(c),
  ...projectAdr0291(c),
})

/** Build the surface's slash dispatch closure: routes `/image` directly to
 *  the image-queue command (same fast-path the legacy `dispatchReplSlash`
 *  did) and forwards all others to `runSlashCommand` with the FULL
 *  augmented `SlashContext`. Default-OFF: when the convCheckpoint /
 *  sessionIo slots are absent, the spread omits them ⇒ the slash command
 *  itself prints "not wired" (byte-identical with the pre-wire path). */
const buildSurfaceDispatch = (args: {
  readonly slashCtx: ReplSlashCtx
  readonly convCheckpointSlot: ConvCheckpointSlashState | undefined
  readonly sessionIo: SessionIoState
  /** Live `/context` seam — returns the latest assembled-prompt breakdown
   *  (written by the loop's `onPromptAssembled` sink) or `undefined` before
   *  the first turn assembles a prompt. */
  readonly contextUsage?: () => SegmentedUsageView | undefined
}): ((input: string) => Promise<boolean>) => {
  return async (input: string): Promise<boolean> => {
    const head = input.split(/\s+/)[0] ?? ""
    if (!isSlashCommand(head)) return false
    if (head === "/image" && args.slashCtx.imageQueue !== undefined) {
      runImageCmd(input, {
        out: (s) => process.stdout.write(s),
        err: (s) => process.stderr.write(s),
        cwd: process.cwd(),
        queue: args.slashCtx.imageQueue,
      })
      return true
    }
    const projected = projectReplSlashCtxToContract(args.slashCtx)
    const ctx: SlashContext = {
      out: (s) => process.stdout.write(s),
      err: (s) => process.stderr.write(s),
      cwd: process.cwd(),
      ...projected,
      // ADR-0292/0294 augmentations: spread by presence so absence omits the
      // slot entirely (default-OFF byte-identical under
      // exactOptionalPropertyTypes).
      ...(args.convCheckpointSlot !== undefined ? { convCheckpoint: args.convCheckpointSlot } : {}),
      sessionIo: args.sessionIo,
      // Live `/context` seam (Track D): when present, `/context` renders the
      // segmented breakdown from the latest assembled prompt instead of the
      // legacy placeholder. Absent ⇒ slot omitted ⇒ legacy fallback.
      ...(args.contextUsage !== undefined ? { contextUsage: args.contextUsage } : {}),
    }
    await runSlashCommand(input, ctx)
    return true
  }
}

/** Holder for the latest `/context` segmented breakdown. The loop's
 *  `onPromptAssembled` sink writes here each turn; the slash command reads via
 *  `current()`. Null until the first turn assembles a prompt (so `/context`
 *  shows its legacy "no prompt assembled yet" fallback at session start). */
interface PromptAssembledHolder {
  readonly sink: NonNullable<RuntimeFacadeComposeOptions["onPromptAssembled"]>
  current(): ContextUsageBreakdown | undefined
}

/** Convert the loop's canonical {@link PromptAssembledSnapshot} (assembled
 *  `SystemBlock[]` + the turn's `promptPolicy` presence flags + model) into a
 *  segmented {@link ContextUsageBreakdown} via the SSOT `snapshotToBreakdownInput`
 *  + `buildUsageBreakdownDefault` (the loop's OWN token estimator — NO second
 *  heuristic). `max` rides through the snapshot (0 ⇒ unknown window ⇒ the
 *  renderer degrades to a `?`-percent bar; segments + totals still render). */
const breakdownFromSnapshot = (snapshot: PromptAssembledSnapshot): ContextUsageBreakdown =>
  buildUsageBreakdownDefault(snapshotToBreakdownInput(snapshot))

/** Build the prompt-assembled holder + sink. Surface-owned mutable cell that
 *  the loop writes (via `onPromptAssembled`) and `/context` reads. */
const createPromptAssembledHolder = (model?: string): PromptAssembledHolder => {
  let latest: ContextUsageBreakdown | undefined
  return {
    sink: (snapshot) => {
      // Prefer the snapshot's own model id; fall back to the session model the
      // holder was built with (the loop passes `max: 0` + may omit model).
      const withModel: PromptAssembledSnapshot =
        snapshot.model === undefined && model !== undefined ? { ...snapshot, model } : snapshot
      latest = breakdownFromSnapshot(withModel)
    },
    current: () => latest,
  }
}

/** Build a fresh per-session wire bundle. Pure — no I/O, no env reads beyond
 *  the explicit `envSource` parameter; all upstream-port presence is gated
 *  on dedicated env knobs (see `resolveReplToolProfile`/`...IdentityMode...`/
 *  `...FocusChainTracker`). The CLI host calls this ONCE per session and
 *  passes the bundle into `runSessionLoop`. */
export const composeSurfaceWires = (
  setup: SessionSetupResult,
  state: SurfaceState,
  envSource: NodeJS.ProcessEnv,
  opts?: { readonly convStore?: ConversationCheckpointStore },
): ReplSurfaceWires => {
  const convStore = opts?.convStore ?? defaultConversationCheckpointStore()
  const granularRegistry: GranularRegistryPort = defaultGranularRegistry()
  let registryToolMapper: RuntimeFacadeComposeOptions["registryToolMapper"] | undefined
  // ADR-0309 Wire 3 — per-tool auto-record cadence. Env-gated:
  // `QUANTA_PER_TOOL_RECORD=on` ⇒ wrap every tool in the session registry
  // with a pre-execute snapshot recorder. Absent / any other value ⇒
  // tools execute byte-identical, registry stays empty.
  if (envSource.QUANTA_PER_TOOL_RECORD === "on") {
    const recorder = createPerToolSnapshotRecorder({
      registry: granularRegistry,
      readFile: async (path: string): Promise<string | null> => {
        try {
          const { readFile } = await import("node:fs/promises")
          return await readFile(path, "utf8")
        } catch {
          return null
        }
      },
      getCurrentMessages: () => state.history,
      getCurrentTurn: () => state.history.length,
      extractPaths: (toolName: string, input: unknown): readonly string[] => {
        // Conservative extractor — only the common file-mutating tools
        // declare a `path` (read/write/edit/scripted_replace/apply_patch).
        // Bash + non-file tools yield empty filesBefore.
        if (
          toolName === "read" ||
          toolName === "write" ||
          toolName === "edit" ||
          toolName === "scripted_replace"
        ) {
          const p = (input as { path?: unknown } | null)?.path
          return typeof p === "string" ? [p] : []
        }
        return []
      },
      logger,
    })
    registryToolMapper = (tool) => recorder.wrapTool(tool)
  }
  // Prompt-assembled holder — the loop's `onPromptAssembled` sink writes the
  // latest assembled-prompt breakdown here each turn; `/context` reads it via
  // the `contextUsage` seam below. Mirrors the `granularRegistry` compose idiom:
  // the sink is published on `runtimeFacadeCompose` and threaded into
  // `createRuntimeFacade({ compose })` by the session loop.
  const promptAssembled = createPromptAssembledHolder(setup.model)
  const runtimeFacadeCompose: RuntimeFacadeComposeOptions = {
    granularRegistry,
    onPromptAssembled: promptAssembled.sink,
    ...(registryToolMapper !== undefined ? { registryToolMapper } : {}),
  }
  // ADR-0292 — turn-end record wire. Env-gated: `QUANTA_CHECKPOINT_CONV=on`
  // wires the live wire; anything else leaves the slot `null` so the slash
  // prints "not wired" and the loop's recordTurn hook is a no-op.
  const convCheckpointWire =
    envSource.QUANTA_CHECKPOINT_CONV === "on" ? startConvCheckpointWire({ store: convStore }) : null
  // ADR-0291 — composer + text inbox: surface-owned mutable holders.
  const composerHandle = createComposerHandle("")
  const textInbox = createTextInbox()
  // Track D (runtime → REPL context wire) — surface-owned holder for the latest
  // per-turn prompt snapshot. `view()` backs the `/context` `contextUsage` slot;
  // `sink` is returned as `promptAssembledSink` for the integration layer to
  // wire into `AgentConfig.onPromptAssembled`.
  const contextUsageHolder = createContextUsageHolder()
  // ADR-0293 — playbook-trigger seam: attached by the loop AFTER it constructs
  // its `ExternalPromptQueue`. The seam is empty until then; `current()`
  // returns `null` and downstream stop/detach calls are no-ops.
  const playbookSeam = createPlaybookTriggerSurfaceSeam()

  // ADR-0292 — `/rewind-conv <tag>` swap hook. The loop registers the swap
  // function once it has the surface-state binding; until then a stub keeps
  // the projection no-throw (the slash command never crashes if the loop
  // hasn't installed yet — it just degrades to "restored N messages" without
  // a visible history swap).
  let replaceMessages: (msgs: ReadonlyArray<Message>) => Promise<void> = async () => {
    /* installed by the loop once it owns surfaceState */
  }
  let sideConversationStart:
    | ((args: RuntimeSideConversationArgs) => Promise<RuntimeSideConversationResult>)
    | undefined
  const setReplaceMessages = (fn: (msgs: ReadonlyArray<Message>) => Promise<void>): void => {
    replaceMessages = fn
  }
  const setSideConversationStart = (
    fn: ((args: RuntimeSideConversationArgs) => Promise<RuntimeSideConversationResult>) | undefined,
  ): void => {
    sideConversationStart = fn
  }

  // ADR-0294 — sessionIo: always wire from the V2 session store. The slash
  // remains the only consumer; tests inject their own ctx.sessionIo via the
  // typed slot.
  const sessionIo = buildDefaultSessionIo()

  const slashCtx = buildReplSlashCtx({
    skillsCb: buildSkillsCallback(setup.skillsConfig),
    idleMonitor: setup.idleMonitor,
    imageQueue: state.imageQueue,
    rewindState: state.rewindState,
    mcpSurface: setup.mcpSurface,
    costPanel: setup.costPanel,
    planStore: setup.planStore,
    branchProgress: setup.branchProgress,
    getHistory: () => state.history,
    startSideConversation: async (args) => {
      if (sideConversationStart === undefined) {
        throw new Error("side chat not wired in this surface")
      }
      return await sideConversationStart(args)
    },
    isSideConversationWired: () => sideConversationStart !== undefined,
    abortSignal: setup.abort.signal,
    debugHandle: setup.debugHandle,
    llm: setup.llm,
    sessionId: setup.sessionId,
    model: setup.model,
    inspect:
      typeof setup.sessionId === "string" && setup.sessionId.length > 0
        ? { sessionId: setup.sessionId }
        : undefined,
    replay: buildReplaySlashState(),
    effort: {
      get: () => setup.effortStore.get(),
      set: (lvl) => {
        setup.effortStore.set(lvl)
        setup.pills.update({ effort: lvl })
      },
      levels: EFFORT_LEVELS,
      budgetTokens: effortToTokenBudget,
    },
    // ADR-0291 — 8 ctx adapters wired through optional upstream-port fields.
    // Each is presence-spread by `buildReplSlashCtx`, so absent ports omit
    // the slot entirely (default-OFF byte-identical).
    composerHandle,
    conversationStore: convStore,
    ...(setup.runtimeContext.toolProfileState() !== undefined
      ? { toolProfileState: setup.runtimeContext.toolProfileState() }
      : {}),
    ...(setup.runtimeContext.identityModeState() !== undefined
      ? {
          identityModeState: setup.runtimeContext.identityModeState(),
          onIdentityModeChange: setup.refreshSystemPrompt,
        }
      : {}),
    ...(setup.runtimeContext.focusChain() !== undefined
      ? { focusChain: setup.runtimeContext.focusChain() }
      : {}),
    textInbox,
    // Track D — `/context` live segmented usage getter over the surface-retained
    // snapshot. Always wired in the REPL surface; before the first turn the
    // getter returns undefined ⇒ `/context` shows its fallback.
    contextUsage: () => contextUsageHolder.view(),
  })

  // ADR-0292 — extended slot for `/rewind-conv`. Built when the conv wire
  // is active; the slash falls through to "not wired" when null.
  const convCheckpointSlot: ConvCheckpointSlashState | undefined =
    convCheckpointWire !== null
      ? {
          wire: convCheckpointWire,
          // No-throw guard around the loop-installed swap closure. The loop
          // calls `setReplaceMessages` once it owns the surface-state
          // binding; before that, `replaceMessages` is a no-op stub.
          replaceMessages: async (msgs: ReadonlyArray<Message>): Promise<void> => {
            try {
              await replaceMessages(msgs)
            } catch (e) {
              logger.warn(`convCheckpoint.replaceMessages threw: ${errMessage(e)}`)
            }
          },
        }
      : undefined

  const dispatchSlash = buildSurfaceDispatch({
    slashCtx,
    convCheckpointSlot,
    sessionIo,
    contextUsage: () => promptAssembled.current(),
  })

  return {
    slashCtx,
    convCheckpointSlot,
    sessionIo,
    dispatchSlash,
    convCheckpointWire,
    convStore,
    playbookSeam,
    composerHandle,
    textInbox,
    runtimeFacadeCompose,
    setReplaceMessages,
    setSideConversationStart,
    promptAssembledSink: contextUsageHolder.sink,
  }
}

/** Legacy entry — retained for back-compat with tests / call sites that
 *  only need the slash ctx and not the full wire bundle. Forwarding shim
 *  over `composeSurfaceWires`. */
export const composeSurfaceSlashCtx = (
  setup: SessionSetupResult,
  state: SurfaceState,
  envSource: NodeJS.ProcessEnv,
): ReturnType<typeof buildReplSlashCtx> => composeSurfaceWires(setup, state, envSource).slashCtx

const foldCostPanelDelta = (
  panel: {
    incrementTurn: (delta: {
      inputTokens: number
      outputTokens: number
      cacheReadTokens: number
    }) => void
  },
  snap: { counters: Record<string, number> },
  prev: CostPanelDeltaBaseline,
): void => {
  const curIn = snap.counters[GEN_AI_ATTRS.usage.inputTokens] ?? 0
  const curOut = snap.counters[GEN_AI_ATTRS.usage.outputTokens] ?? 0
  const curCache = snap.counters[GEN_AI_ATTRS.usage.cacheReadInputTokens] ?? 0
  const dIn = Math.max(0, curIn - prev.inputTokens)
  const dOut = Math.max(0, curOut - prev.outputTokens)
  const dCache = Math.max(0, curCache - prev.cacheReadTokens)
  prev.inputTokens = curIn
  prev.outputTokens = curOut
  prev.cacheReadTokens = curCache
  panel.incrementTurn({ inputTokens: dIn, outputTokens: dOut, cacheReadTokens: dCache })
}

const foldCostPanelIfWired = (
  panel:
    | {
        incrementTurn: (delta: {
          inputTokens: number
          outputTokens: number
          cacheReadTokens: number
        }) => void
      }
    | undefined,
  metrics: { snapshot: () => { counters: Record<string, number> } } | undefined,
  prev: CostPanelDeltaBaseline,
): void => {
  if (panel === undefined || metrics === undefined) return
  foldCostPanelDelta(panel, metrics.snapshot(), prev)
}

const snapshotAndFlushLifecyclePills = (setup: SessionSetupResult): void => {
  if (setup.lifecycleTaskRegistry !== undefined) {
    const running = setup.lifecycleTaskRegistry.pendingIds().length
    const total = setup.lifecycleTaskRegistry.list().length
    setup.lifecyclePills.update({ subagent: { running, total } })
  }
  if (setup.lifecycleFollowUpQueue !== undefined) {
    setup.lifecyclePills.update({ followUp: { queued: setup.lifecycleFollowUpQueue.size() } })
  }
  setup.lifecyclePills.flush()
}

const renderTurnError = (error: unknown, statusBar: StatusBar): void => {
  const msg = errMessage(error)
  process.stderr.write(`\n\x1b[31merror:\x1b[0m ${msg}\n`)
  statusBar.transient(`error: ${msg.slice(0, 120)}`, 4000)
}

export const composeTurnSinks = (
  setup: SessionSetupResult,
  state: SurfaceState,
): SessionLoopSinks => {
  const { model, slog, metrics, turnSummary, statusBar } = setup
  return {
    renderTurnDashboard: (): void => {
      if (!metrics) return
      const snap = metrics.snapshot()
      slog.info("metrics.snapshot", { snapshot: snap })
      process.stderr.write(`${renderDashboardText(buildCostDashboard(snap, { model }))}\n`)
      foldCostPanelIfWired(setup.costPanel, metrics, state.costDeltaPrev)
    },
    renderAndResetSummary: (outcome): void => {
      state.history = outcome.messages
      const summary = turnSummary.render(outcome as Parameters<typeof turnSummary.render>[0])
      if (summary !== "") process.stderr.write(summary)
      turnSummary.reset()
    },
    flushLifecyclePills: (): void => {
      snapshotAndFlushLifecyclePills(setup)
    },
    renderTurnError: (error): void => renderTurnError(error, statusBar),
  }
}
