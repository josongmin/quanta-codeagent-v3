import { EFFORT_LEVELS, effortToTokenBudget, type SkillScopeView, type WorkingState } from "@/agent"
import {
  defaultGranularRegistry,
  type GranularRegistryPort,
} from "@/agent/checkpoint/granular-registry"
import {
  type ConversationCheckpointStore,
  defaultConversationCheckpointStore,
} from "@/agent/conversation-checkpoint"
import { type InboundMode, parseInboundMode } from "@/agent/inbound-mode"
import { createInterruptedTurnBuffer } from "@/agent/interrupted-turn"
import {
  defaultPlanQueueStore,
  type PlanQueueStore,
  type SendNowInjection,
} from "@/agent/plan-queue"
import { createShadowVerify } from "@/agent/shadow-verify"
import { createShadowVerifyAdapters } from "@/agent/shadow-verify-adapters"
import type { Message, StreamInput } from "@/llm"
import type { RadarStore } from "@/radar"
import { parseEnvFlag } from "@/runner/assemble"
import { isApprovedDecision } from "@/runner/orchestrate"
import type {
  RuntimeFacadeComposeOptions,
  RuntimeSideConversationArgs,
  RuntimeSideConversationResult,
} from "@/sdk/runtime"
import { errMessage, gateOn, type ItemStreamSink, itemStreamEnabled, logger } from "@/shared"
import { defaultShadowOdb, type ShadowOdb } from "@/storage"
import type { DreamSlashState } from "../dream-cmd"
import { DEFAULT_IDLE_MS } from "../idle-monitor"
import type { MemorySlashState } from "../memory-cmd"
import {
  createModeCycleStore,
  MODE_CYCLE,
  type ModeCycleStore,
  modeCycleEnabled,
} from "../mode-cycle"
import type { PermissionInspectSlashState } from "../permission-explain"
import type { ConvCheckpointSlashState } from "../rewind-conv-cmd"
import type { SessionIoState } from "../session-cmd"
import { createBrowserNetHolder } from "../slash/browser-net-cmd"
import type { SlashContext } from "../slash-commands"
import { createTextInbox, type TextInbox } from "../text-inbox"
import {
  type BackgroundTurnPortal,
  BG_TURN_ENV_GATE,
  createBackgroundTurnPortal,
} from "./background-turn-portal"
import type { ContextUsageHolder } from "./context-usage-snapshot"
import { type ConvCheckpointWire, startConvCheckpointWire } from "./conv-checkpoint-wire"
import {
  type ConversationActionSurface,
  createConversationActionSurface,
} from "./conversation-action-surface"
import { type ComposerHandle, createComposerHandle } from "./ctx-adapters/composer-edit-adapter"
import { createItemStore } from "./item-store"
import { buildPerToolCheckpointWire } from "./per-tool-checkpoint-wire"
import { createPerToolSnapshotRecorder } from "./per-tool-snapshot-recorder"
import {
  createPlaybookTriggerSurfaceSeam,
  type PlaybookTriggerSurfaceSeam,
} from "./playbook-trigger-surface-seam"
import type { SessionSetupResult } from "./session-setup"
import { buildSkillsCallback } from "./skills-surface"
import { buildReplSlashCtx, type ReplSlashCtx } from "./slash-surface"
import { buildSurfaceDispatch, buildVoiceLiveSlot } from "./surface-compose/dispatch"
import type { SurfaceState } from "./surface-compose/turn-sinks"
import {
  buildDefaultSessionIo,
  buildModelAdapterWire,
  buildRadarStore,
  buildReplaySlashState,
  buildRetryCandidates,
  extractApplyPatchPaths,
  radarTaskDurationThresholdMs,
  renderRetryEvent,
} from "./surface-compose/wire-builders"

// ── Public-surface re-exports ────────────────────────────────────────────────
// The cohesive clusters below were extracted into siblings under
// `surface-compose/` to keep this module under the god-module line budget. The
// ORIGINAL public surface is re-exported verbatim here so every importer stays
// byte-compatible (the split is structural only). Names this module also
// CONSUMES locally (`buildModelAdapterWire`/`buildRetryCandidates`/
// `extractApplyPatchPaths`/`SurfaceState`) are re-exported from their local
// imports below the import block to avoid a duplicate-binding conflict.
export { buildPromptUx, type PromptUxOpts } from "./surface-compose/prompt-ux"
export { composeTurnSinks, createSurfaceState } from "./surface-compose/turn-sinks"
export type { SurfaceState }
export { buildModelAdapterWire, buildRetryCandidates, extractApplyPatchPaths }

/** Opt-in env gate for this surface's feature knobs (QUANTA_WORKING_STATE /
 *  QUANTA_SHADOW / QUANTA_PER_TOOL_CHECKPOINT / etc.). Thin alias over the
 *  SHARED {@link parseEnvFlag} truth table (default OFF) so this surface no
 *  longer reimplements the env-flag semantics inline — the prior local copy
 *  diverged (unknown values were treated as truthy). One source of truth now. */
const isEnvTruthy = (raw: string | undefined): boolean => parseEnvFlag(raw, false)

/** A3 (jul-04 CLI-surfacing) — build the READ-ONLY `/kb` slash slot over the
 *  host-minted `ProjectsKbStore` (the SAME instance the `projects_kb` tool writes
 *  into). Maps `docCount ← store.size()` + `knowledge ← store.knowledge(false)` —
 *  the store's own body-FREE byte-budget accounting, NEVER a doc body. `undefined`
 *  store (gate off ⇒ tool not registered) ⇒ `undefined` slot ⇒ `/kb` "not wired"
 *  (default-OFF byte-identical). Module-scope so `composeSurfaceWires` stays under
 *  the cognitive-complexity budget (mirrors the other extracted slot helpers). */
const buildKbSlashSlot = (
  store: SessionSetupResult["projectsKbStore"],
): import("../slash/kb-cmd").KbSlashState | undefined =>
  store !== undefined
    ? { docCount: () => store.size(), knowledge: () => store.knowledge(false) }
    : undefined

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
  /** `/queue` plan-queue store (surface-owned). Producers (playbook/voice/
   *  mid-turn capture) enqueue into THIS instance; the slash inspects/mutates
   *  it. Exposed so the loop can also enqueue/drain against the same store. */
  readonly planQueueStore: PlanQueueStore
  /** Install the `/queue` `sendNow` injection target once the loop owns its
   *  `ExternalPromptQueue`. Until installed, `sendNow` returns a typed
   *  "send-not-possible" (the entry is still removed — see `PlanQueueStore`). */
  readonly setPlanQueueSendNow: (
    fn: ((inj: SendNowInjection) => { ok: true } | { ok: false; reason: string }) | undefined,
  ) => void
  /** B2 (jul-04 CLI-surfacing) — install the `/cron` (+ `/schedule`/`/inbox`)
   *  automation slash slot once the loop mints the automation engine (the engine
   *  is born INSIDE `runSessionLoop`, after this bundle is built). The loop builds
   *  the thin `createCronSlashAdapter` over the live engine port and calls this
   *  setter; the dispatch closure reads the slot LIVE. Until installed ⇒ `/cron`
   *  prints "not wired" (default-OFF byte-identical). */
  readonly setAutomationSlash: (
    fn: import("../slash/cron-cmd").AutomationSlashState | undefined,
  ) => void
  /** §steer — the conversation-action surface (weave/interrupt sinks +
   *  activeTurnRef), present only when `QUANTA_CONVERSATION_ACTIONS=1`. Threaded
   *  to the session loop's in-turn reader for weave/interrupt routing. */
  readonly conversationActions?: ConversationActionSurface
  /** §steer — the session-mutable inbound delivery mode (queue|weave|interrupt),
   *  seeded from `QUANTA_INBOUND_MODE`. The session loop reads `.current` per
   *  mid-turn line; the `/inbound` slash mutates it. */
  readonly inboundMode: { current: InboundMode }
  /** #13 — the shared mode-cycle store (present iff `QUANTA_MODE_CYCLE` is on).
   *  Threaded into `buildPromptUx` so the shift+tab pill/hook reuses the SAME
   *  instance the `/mode` slash mutates + the session loop's per-turn
   *  `permissionModeState` projection reads. Absent ⇒ no mode-cycle (byte-
   *  identical). */
  readonly modeCycleStore?: ModeCycleStore
  /** Track D (runtime → REPL context wire) — the per-turn prompt-assembly sink
   *  the composition root wires into `AgentConfig.onPromptAssembled`. Each call
   *  retains the latest snapshot the `/context` slash renders via the
   *  `contextUsage` slot already wired into `slashCtx`. NOT wired here (the REPL
   *  surface does not own the AgentConfig — the runtime facade does); the
   *  integration layer hands this to config. Absent from config ⇒ the loop
   *  performs no capture (default-OFF byte-identical) and `/context` shows its
   *  fallback. */
  readonly promptAssembledSink: ContextUsageHolder["sink"]
  /** RFC-09 (B) / ADR-0445 — getter over the SAME retained per-turn usage
   *  snapshot the `/context` slash renders. The host binds the pre-compaction
   *  warning to this so NO second token heuristic is introduced. Returns
   *  `undefined` before the first turn. */
  readonly contextUsageView: ContextUsageHolder["view"]
  /** Ticket 18 (V1) — the background-turn portal (present iff `QUANTA_BG_TURN`).
   *  Threaded into the session loop's `backgroundPortal` dep so Ctrl+B can detach
   *  the running INTERACTIVE turn into it; the READ-ONLY `.view()` is wired into
   *  the `/background` slot above. Absent ⇒ Ctrl+B + `/background` are unwired
   *  (default-OFF byte-identical). */
  readonly backgroundPortal?: BackgroundTurnPortal
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
  // #13 — build the ONE mode-cycle store the whole surface shares (gated on
  // QUANTA_MODE_CYCLE). The shift+tab pill/hook (via buildPromptUx) AND the
  // `/mode` slash AND the session loop's per-turn permissionMode projection all
  // read THIS instance, so a `/mode acceptEdits` and a shift+tab agree. Absent
  // gate ⇒ undefined ⇒ `/mode` prints "not wired" + no shift+tab hook (byte-
  // identical). Exposed on the returned wires so buildPromptUx reuses it.
  const modeCycleStore: ModeCycleStore | undefined = modeCycleEnabled(envSource)
    ? createModeCycleStore()
    : undefined
  // #13 — `/mode` ctx slot over the shared store. SET jumps the rung AND repaints
  // the bottom status-bar pill (mirrors the shift+tab onPosture sink); the loop's
  // projection then applies the new permissionMode on the NEXT turn.
  const modeSlot: SlashContext["mode"] =
    modeCycleStore !== undefined
      ? {
          get: () => modeCycleStore.current().key,
          set: (key: string) => {
            const known = MODE_CYCLE.map((p) => p.key)
            if (!known.includes(key as (typeof known)[number])) {
              return { kind: "unknown" as const, known }
            }
            modeCycleStore.set(key as (typeof known)[number])
            setup.pills.update({ mode: modeCycleStore.current().agentMode })
            return "ok" as const
          },
          list: () => MODE_CYCLE.map((p) => p.key),
        }
      : undefined
  const granularRegistry: GranularRegistryPort = defaultGranularRegistry()
  let registryToolMapper: RuntimeFacadeComposeOptions["registryToolMapper"] | undefined
  // ADR-0309 Wire 3 — per-tool auto-record cadence. Env-gated:
  // `QUANTA_PER_TOOL_RECORD=on` ⇒ wrap every tool in the session registry
  // with a pre-execute snapshot recorder. Absent / any other value ⇒
  // tools execute byte-identical, registry stays empty.
  if (gateOn(envSource, "QUANTA_PER_TOOL_RECORD")) {
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
        // Conservative extractor — only the file-MUTATING tools yield a
        // `filesBefore` set for /rewind-tool restore. `read` is read-only:
        // it never mutates, so capturing its target over-snapshots without
        // any restore value (and could thrash the recorder) — excluded.
        if (toolName === "write" || toolName === "edit" || toolName === "scripted_replace") {
          const p = (input as { path?: unknown } | null)?.path
          return typeof p === "string" ? [p] : []
        }
        // apply_patch input is `{ patch }`, NOT `{ path }` — parse the V4A
        // directive headers so the targets a patch touches are snapshotted.
        if (toolName === "apply_patch") {
          const patch = (input as { patch?: unknown } | null)?.patch
          return typeof patch === "string" ? extractApplyPatchPaths(patch) : []
        }
        // Bash + non-file tools yield empty filesBefore.
        return []
      },
      logger,
    })
    registryToolMapper = (tool) => recorder.wrapTool(tool)
  }
  // Prompt-assembled + S3 reasoning holder — SINGLE SSOT for `/context`. The
  // loop's `onPromptAssembled` sink writes the latest assembled-prompt breakdown
  // each turn (and clears the prior turn's reasoning split); the surface stream
  // tee feeds `observeUsage` the live `usage` event's reasoning-token split; and
  // `/context` reads the merged segmented view via the `contextUsage` seam.
  //
  // This is `setup.contextUsageHolder` (created at setup so its `observeUsage`
  // could be teed onto the indicator port for the reasoning split). It REPLACES
  // the former `createPromptAssembledHolder` (no reasoning support) AND resolves
  // a latent structural rot: a SECOND `createContextUsageHolder` instance whose
  // `.sink` had NO loop consumer (inert) and whose `.view()` only fed the
  // pre-compaction warning. Now a single live holder backs `/context`, the
  // pre-compaction warning, and the S3 reasoning annotation.
  const contextUsageHolder = setup.contextUsageHolder
  // `/state` — working-state snapshot getter, installed by the loop's
  // `onWorkingStateReady` callback once features are built. Env-gated:
  // `QUANTA_WORKING_STATE` truthy ⇒ the loop builds the WorkingState session
  // (adds `update_working_state` + the L3 prompt block) AND publishes the
  // getter here; unset ⇒ feature OFF (config byte-identical) and the getter
  // stays undefined so `/state` renders an empty panel (NOT "not wired").
  let workingStateGet: (() => WorkingState | undefined) | undefined
  const workingStateEnabled = isEnvTruthy(envSource.QUANTA_WORKING_STATE)
  // ADR-0512 P3 `/state` skill-scope visibility — the loop's `onSkillScopeReady`
  // callback installs a live getter here once the session gate is built. Env-
  // gated `QUANTA_SKILL_SCOPE_V2`: ON ⇒ the loop fires the publisher AND `/state`
  // appends the active skill's visible/hidden tool partition; unset ⇒ feature OFF
  // (config byte-identical) and the getter stays undefined so `/state` omits the
  // skill-scope section (byte-identical to the working-state-only render).
  let skillScopeGet: (() => SkillScopeView | undefined) | undefined
  // E1: gate-vocab MUST match the loop's 5 consumers, which all read
  // `runtimeConfig().skillScopeV2 = gateOn(env, "QUANTA_SKILL_SCOPE_V2")`.
  // `gateOn` is default-OFF (unset / "" / unrecognized ⇒ OFF), whereas the
  // legacy `isEnvTruthy` (parseEnvFlag(raw,false)) treats `QUANTA_SKILL_SCOPE_V2=`
  // (empty) as TRUE — that split-brain installed the getter here while the loop
  // never fired the publisher, breaking the 'unset ⇒ byte-identical OFF'
  // invariant. Use `gateOn` on the injected hermetic `envSource` (NOT
  // `runtimeConfig().skillScopeV2`, which reads `process.env` and bypasses it).
  const skillScopeEnabled = gateOn(envSource, "QUANTA_SKILL_SCOPE_V2")
  // `/retry-with` — model candidates from `QUANTA_RETRY_MODELS` + the latest
  // per-turn stream input (captured via `onTurnStreamInput` when enabled). Both
  // default-OFF: empty candidates ⇒ slot omitted ⇒ "no model candidates
  // configured"; no capture hook installed ⇒ config byte-identical.
  const retryCandidates = buildRetryCandidates(envSource, setup.provider, setup.model)
  const retryEnabled = retryCandidates.length > 0
  let lastStreamInput: StreamInput | undefined
  // `/snapshot` — shadow object-DB. Env-gated `QUANTA_SHADOW`: builds ONE store
  // shared by the loop's auto-checkpoint (pre-destructive anchors) AND the
  // `/snapshot` slash (browse/restore/diff). Per-session cost (a shadow git dir
  // under ~/.quanta), so default-OFF. Absent ⇒ `/snapshot` prints "not
  // configured" + no checkpoint wrap (config byte-identical).
  const shadowOdb: ShadowOdb | undefined = isEnvTruthy(envSource.QUANTA_SHADOW)
    ? defaultShadowOdb()
    : undefined
  // ADR-0203/0205 — `/rewind-tool` per-tool-checkpoint wire. Gated on
  // QUANTA_PER_TOOL_CHECKPOINT and requires the shadow ODB (the files leg
  // rewinds against it). Builds ONE session-scoped granular policy whose
  // `.registry` is shared between the dispatch producer (threaded into
  // `shadowCheckpoint.granularPolicy` below) and the `/rewind-tool` consumer
  // (buildReplSlashCtx perToolRegistry/perToolRestorePort). Absent ⇒ slot
  // omitted ⇒ `/rewind-tool` prints "not wired" (byte-identical).
  const perToolCkpt =
    isEnvTruthy(envSource.QUANTA_PER_TOOL_CHECKPOINT) && shadowOdb !== undefined
      ? buildPerToolCheckpointWire({
          shadowOdb,
          conversationStore: convStore,
          workspace: process.cwd(),
        })
      : undefined
  // ADR-0400 `shadow_verify` tool — CLI parity with the web surface (which
  // already wires `shadowVerify`). Env-gated `QUANTA_SHADOW_VERIFY`; builds the
  // real worktree + V4A + LSP/test adapter triple (no I/O at construction) so
  // the loop registers the `shadow_verify` LLM tool. Absent ⇒ tool NOT
  // registered (byte-identical).
  const shadowVerify = isEnvTruthy(envSource.QUANTA_SHADOW_VERIFY)
    ? createShadowVerify(createShadowVerifyAdapters(process.cwd()))
    : undefined
  // Pre-compaction HITL — env-gated `QUANTA_PRECOMPACT_CONFIRM`. When the loop is
  // about to fold history, prompt the user via the SAME interactive approval
  // mechanism tool-confirmations use. Deny ⇒ defer one turn (never fold without
  // an answer). Absent ⇒ auto-approve (byte-identical legacy).
  const onPreCompact: NonNullable<RuntimeFacadeComposeOptions["onPreCompact"]> | undefined =
    isEnvTruthy(envSource.QUANTA_PRECOMPACT_CONFIRM)
      ? async (query) => {
          const approxK = Math.round(query.proposedSummaryTokens / 1000)
          const decision = await setup.approvalPrompt({
            approvalId: `precompact-${query.turnId}`,
            reason: `Compact ~${approxK}k tokens of history into a summary? (context ${Math.round(query.currentTokens / 1000)}k/threshold ${Math.round(query.threshold / 1000)}k)`,
            requestedAt: new Date().toISOString(),
          })
          // WS-A (jul-10, UUX-1-02) — the SSOT projection: a RICH approve
          // (`{decision:"approve", scope:"session"}`, the operator's "[a]lways"
          // answer) is an approve. The prior strict string equality against the
          // bare "approve" literal misread it as a deferral.
          return isApprovedDecision(decision) ? "approve" : "defer_one_turn"
        }
      : undefined
  // ADR-0071 — mid-turn typed control surface (/cancel + /summarize-now). Env-
  // gated `QUANTA_CONVERSATION_ACTIONS`; absent ⇒ undefined ⇒ neither the port
  // nor activeTurnRef is wired ⇒ the loop never polls (byte-identical).
  const conversationActions = isEnvTruthy(envSource.QUANTA_CONVERSATION_ACTIONS)
    ? createConversationActionSurface()
    : undefined
  // §11.5 — the session interrupted-turn restore buffer. Minted alongside the
  // conversation-action surface (interrupt/resume ride that surface). The loop
  // captures a partial turn into it on a conversation-action `cancel`, and a
  // `resume` re-injects it. Absent ⇒ no capture, resume is a no-op.
  const interruptedTurnBuffer =
    conversationActions !== undefined ? createInterruptedTurnBuffer() : undefined
  // §steer — session-mutable inbound delivery mode (queue | weave | interrupt),
  // seeded from QUANTA_INBOUND_MODE (default `queue`), mutated at runtime by the
  // `/inbound` slash. The session loop reads `.current` per mid-turn line; the
  // slash handler writes it. weave/interrupt are only EFFECTIVE when
  // `conversationActions` is also wired (else the loop degrades to queue).
  const inboundMode: { current: InboundMode } = {
    current: parseInboundMode(envSource.QUANTA_INBOUND_MODE) ?? "queue",
  }
  // Ticket 18 (V1) — background-turn portal. Env-gated `QUANTA_BG_TURN`: builds
  // the pure portal that backs Ctrl+B (detach the running turn) + `/background`
  // (manage detached turns). Absent ⇒ `undefined` ⇒ neither the loop's Ctrl+B
  // sink nor the `/background` slot is wired (default-OFF byte-identical). Zero
  // I/O at construction (pure registry).
  const backgroundPortal = gateOn(envSource, BG_TURN_ENV_GATE)
    ? createBackgroundTurnPortal()
    : undefined
  // ADR-0231 — radar proposal queue. Env-gated `QUANTA_RADAR`: builds ONE store
  // (JsonlFileRadarStore when `QUANTA_RADAR_FILE` is set, else in-memory) shared
  // by BOTH the `/radar` slash surface AND the loop's producer hook
  // (`AgentConfig.radar.store`) — a SINGLE instance, so a card the hook deposits
  // is visible to `/radar list` and an `/radar adopt` flips the SAME card the
  // loop sees. Absent gate ⇒ `undefined` ⇒ neither the slash slot nor the
  // producer block is wired (default-OFF byte-identical; zero sampling).
  const radarStore: RadarStore | undefined = buildRadarStore(envSource)
  // S1 (jul-04) `/browser-net` — mint ONE surface-owned net-capture holder, gated
  // on the SAME `QUANTA_BROWSER_NETWORK` env the `browser_network` tool rides. It
  // is threaded DOWN via `runtimeFacadeCompose.browserNet` (→ the runtime-context
  // snapshot → the per-turn base → `maybeWireBrowser` → `config.browser.netHolder`)
  // so a `browser_network` drain mirrors its METADATA-ONLY rows into THIS holder,
  // AND read UP by the `/browser-net` slash over the SAME instance (single-
  // instance, no split-brain). Absent gate ⇒ `undefined` ⇒ neither the compose
  // slot nor the ctx slot is wired ⇒ `/browser-net` prints "no browser capture
  // yet" (default-OFF byte-identical; the mirror can never populate because the
  // tool is unregistered too).
  const browserNetHolder = gateOn(envSource, "QUANTA_BROWSER_NETWORK")
    ? createBrowserNetHolder()
    : undefined
  const runtimeFacadeCompose: RuntimeFacadeComposeOptions = {
    // ADR-0231 — thread the producer block ONLY when the store is wired. The
    // idle source is adapted from the CLI idle monitor: when the monitor reports
    // idle, surface the resolved threshold as the idle-ms reading so the pure
    // heuristic's `idleMs >= idleThresholdMs` arm passes; otherwise 0 (declines).
    // This never fires silently — a non-idle monitor yields 0 ⇒ no proposal.
    ...(radarStore !== undefined
      ? {
          radar: {
            store: radarStore,
            idleThresholdMs: setup.idleMonitor.thresholdMs ?? DEFAULT_IDLE_MS,
            taskDurationThresholdMs: radarTaskDurationThresholdMs(envSource),
            idleMsForTurn: () =>
              setup.idleMonitor.isIdle() ? (setup.idleMonitor.thresholdMs ?? DEFAULT_IDLE_MS) : 0,
          } satisfies RuntimeFacadeComposeOptions["radar"],
        }
      : {}),
    granularRegistry,
    onPromptAssembled: contextUsageHolder.sink,
    ...(registryToolMapper !== undefined ? { registryToolMapper } : {}),
    ...(workingStateEnabled
      ? {
          workingState: { enabled: true },
          onWorkingStateReady: (get) => {
            workingStateGet = get
          },
        }
      : {}),
    ...(skillScopeEnabled
      ? {
          onSkillScopeReady: (get) => {
            skillScopeGet = get
          },
        }
      : {}),
    ...(retryEnabled
      ? {
          onTurnStreamInput: (input) => {
            lastStreamInput = input
          },
        }
      : {}),
    ...(shadowOdb !== undefined
      ? {
          shadowOdb,
          // Auto-anchor BEFORE destructive tools so `/snapshot` has restore
          // points without the user manually checkpointing.
          shadowCheckpoint: {
            mode: "pre-destructive" as const,
            // When /rewind-tool is on, hand the SAME session-scoped granular
            // policy to the dispatch wrap so its registry accumulates anchors.
            ...(perToolCkpt !== undefined ? { granularPolicy: perToolCkpt.policy } : {}),
          },
        }
      : {}),
    ...(onPreCompact !== undefined ? { onPreCompact } : {}),
    // Image-sanitization retry (ADR-0328) — resilience for image-bearing turns:
    // retry with a placeholder when the provider rejects an image. Env-gated
    // `QUANTA_IMAGE_SANITIZATION`; absent ⇒ llm unwrapped (byte-identical).
    ...(isEnvTruthy(envSource.QUANTA_IMAGE_SANITIZATION)
      ? { imageSanitizationRetry: { enabled: true } }
      : {}),
    // Per-turn git turn-diff (ADR-0125) — the loop builds the TurnDiffSession
    // and emits `turn_diff_updated`; the CLI timeline/debug renderers already
    // consume it. Env-gated `QUANTA_TURN_DIFF`; per-turn `git diff` spawn cost
    // when on, byte-identical when off.
    ...(isEnvTruthy(envSource.QUANTA_TURN_DIFF) ? { gitObservability: { enabled: true } } : {}),
    ...(conversationActions !== undefined
      ? {
          conversationActionPort: conversationActions.port,
          activeTurnRef: conversationActions.activeTurnRef,
        }
      : {}),
    ...(interruptedTurnBuffer !== undefined ? { interruptedTurnBuffer } : {}),
    ...(shadowVerify !== undefined ? { shadowVerify } : {}),
    // S1 (jul-04) `/browser-net` — DOWN-THREAD the surface net-capture holder so
    // the per-turn `maybeWireBrowser` attaches it to `config.browser.netHolder`.
    // Absent gate ⇒ omitted (byte-identical).
    ...(browserNetHolder !== undefined ? { browserNet: browserNetHolder } : {}),
  }
  // ADR-0292 — turn-end record wire. Env-gated: `QUANTA_CHECKPOINT_CONV=on`
  // wires the live wire; anything else leaves the slot `null` so the slash
  // prints "not wired" and the loop's recordTurn hook is a no-op.
  const convCheckpointWire = gateOn(envSource, "QUANTA_CHECKPOINT_CONV")
    ? startConvCheckpointWire({ store: convStore })
    : null
  // ADR-0291 — composer + text inbox: surface-owned mutable holders.
  const composerHandle = createComposerHandle("")
  const textInbox = createTextInbox()
  // ADR-0293 — playbook-trigger seam: attached by the loop AFTER it constructs
  // its `ExternalPromptQueue`. The seam is empty until then; `current()`
  // returns `null` and downstream stop/detach calls are no-ops.
  const playbookSeam = createPlaybookTriggerSurfaceSeam()

  // ADR-0292 + UUX-4-02/6-03 — the ONE live-history swap hook. The loop
  // registers the swap function once it has the surface-state binding; until
  // then a stub keeps the projection no-throw (a slash command never crashes
  // if the loop hasn't installed yet — it just degrades to its disk-only /
  // print-only behavior without a visible history swap).
  let replaceMessages: (msgs: ReadonlyArray<Message>) => Promise<void> = async () => {
    /* installed by the loop once it owns surfaceState */
  }
  // No-throw adapter around the loop-installed closure — the SINGLE seam
  // `/rewind-conv`, `/rewind` and `/rewind-tool` (task leg) all swap through
  // (`applyLiveHistorySwap` in live-history-swap.ts consumes it). A failing
  // swap surfaces via logger.warn, never as a surface crash.
  const liveHistorySwap = async (msgs: ReadonlyArray<Message>): Promise<void> => {
    try {
      await replaceMessages(msgs)
    } catch (e) {
      logger.warn(`live-history swap threw: ${errMessage(e)}`)
    }
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

  // `/queue` — surface-owned plan-queue store. The `sendNow` target is the
  // loop-owned `ExternalPromptQueue`, installed via `setPlanQueueSendNow` once
  // the loop is up; until then `sendNow` reports "send-not-possible" (and the
  // entry is removed, per the store contract).
  let planQueueSendNow:
    | ((inj: SendNowInjection) => { ok: true } | { ok: false; reason: string })
    | undefined
  const planQueueStore = defaultPlanQueueStore({
    sendNowSink: {
      inject: (inj) =>
        planQueueSendNow !== undefined
          ? planQueueSendNow(inj)
          : { ok: false, reason: "send target not installed yet" },
    },
  })
  const setPlanQueueSendNow = (
    fn: ((inj: SendNowInjection) => { ok: true } | { ok: false; reason: string }) | undefined,
  ): void => {
    planQueueSendNow = fn
  }

  // B2 (jul-04 CLI-surfacing) `/cron` — LATE-BIND automation slash slot. The
  // automation engine is minted INSIDE `runSessionLoop` (after this wire bundle
  // is built), so the `/cron`/`/schedule`/`/inbox` slot cannot be populated at
  // compose time. Mirror the `sendNowSink` / `setPlanQueueSendNow` precedent: a
  // surface-owned mutable slot the loop SETS once the engine exists, read LIVE by
  // the dispatch closure (which builds its ctx per-invocation). Until installed,
  // the slot is `undefined` ⇒ `/cron` prints "not wired" (default-OFF byte-
  // identical). No stale/null deref: the getter reads the current value each
  // dispatch, and the slash guards `ctx.automation === undefined`.
  let automationSlash: import("../slash/cron-cmd").AutomationSlashState | undefined
  const setAutomationSlash = (
    fn: import("../slash/cron-cmd").AutomationSlashState | undefined,
  ): void => {
    automationSlash = fn
  }

  // ADR-0294 — sessionIo: always wire from the V2 session store. The slash
  // remains the only consumer; tests inject their own ctx.sessionIo via the
  // typed slot.
  const sessionIo = buildDefaultSessionIo()

  // S2 unified-observability (jul-03) — the item-stream sink the `/activity`
  // fleet snapshot is pumped onto. PRESENCE-GATED at the composition root: minted
  // ONLY when `QUANTA_ITEM_STREAM` is on (the SAME env the session.v1 item plane
  // reads at `context-binding/base.ts`), so an absent slot ⇒ no fleet→item pump ⇒
  // the `/activity` render is byte-identical for the legacy default-OFF path. The
  // sink forwards each subagent item core onto the session's structured-log
  // observability plane (a real, always-present out-of-band wire) so a live
  // subagent lifecycle surfaces as a co-equal `subagent` item core carrying the
  // SAME `item-subagent-<id>` join key the projector's `subagent_cancel` arm and
  // both wire transports use. NO-THROW inside the pump (fail-silent) so a logging
  // hiccup can never break the `/activity` render. */
  // S2 (jul-03) — the sink is now a BOUNDED in-memory ItemStore (was
  // `logger.debug`-only, so `QUANTA_ITEM_STREAM` produced ZERO visible rows). The
  // store IS an `ItemStreamSink` (the fleet pump captures into it) AND a snapshot
  // source `/activity` renders as a "Subagent items" section. Still presence-gated
  // on `QUANTA_ITEM_STREAM` at the composition root ⇒ absent ⇒ no pump, no section
  // (byte-identical default-OFF). Kept as a `logger.debug` breadcrumb too so the
  // structured-log plane still sees each core.
  const itemStore = itemStreamEnabled(envSource) ? createItemStore() : undefined
  const itemStreamSink: ItemStreamSink | undefined =
    itemStore !== undefined
      ? {
          capture: (item) => {
            itemStore.capture(item)
            logger.debug(`item-stream fleet core: ${JSON.stringify(item)}`)
          },
        }
      : undefined

  // A3 (jul-04 CLI-surfacing) `/kb` — read-only accounting adapter over the SAME
  // `ProjectsKbStore` the `projects_kb` tool was registered over (minted once in
  // `buildTooling`, forwarded via `setup.projectsKbStore`). Extracted to a helper
  // so this composer stays under the cognitive-complexity budget. Absent store
  // (gate off) ⇒ `undefined` ⇒ slot omitted ⇒ `/kb` "not wired" (byte-identical).
  const projectsKbSlot = buildKbSlashSlot(setup.projectsKbStore)

  // B4 (jul-04 CLI-surfacing) `/mcp-resources` — read-only snapshot getter over
  // the SAME capture holder the `mcp_read_resource_dir` / `mcp_read_resource`
  // tools write into (minted once in `loadFeatures`, forwarded via
  // `setup.mcpResourceCapture`). Absent holder (gate off / no capable server ⇒
  // tools not registered) ⇒ `undefined` ⇒ slot omitted ⇒ `/mcp-resources` prints
  // "not wired" (byte-identical default-OFF). The holder's `CapturedResourceDir`
  // is structurally the slash's `McpResourceDirRecord` (metadata only, no bodies).
  const mcpResourcesSlot:
    | (() => readonly import("../slash/mcp-resources-cmd").McpResourceDirRecord[])
    | undefined =
    setup.mcpResourceCapture !== undefined
      ? () => setup.mcpResourceCapture?.snapshot() ?? []
      : undefined

  const slashCtx = buildReplSlashCtx({
    skillsCb: buildSkillsCallback(setup.skillsConfig),
    idleMonitor: setup.idleMonitor,
    // A3 (jul-04) `/kb` — read-only accounting over the SAME store the tool writes
    // into. Omitted when the gate is off (byte-identical).
    ...(projectsKbSlot !== undefined ? { projectsKb: projectsKbSlot } : {}),
    // B4 (jul-04) `/mcp-resources` — read-only snapshot over the SAME capture the
    // mcp fetch tools write into. Omitted when the holder is absent (byte-identical).
    ...(mcpResourcesSlot !== undefined ? { mcpResources: mcpResourcesSlot } : {}),
    // S1 (jul-04) `/browser-net` — read-only getter over the SAME net-capture
    // holder threaded DOWN into `config.browser.netHolder` (the `browser_network`
    // tool mirrors each drain into it). Omitted when the holder is absent
    // (QUANTA_BROWSER_NETWORK off) ⇒ `/browser-net` "not wired" (byte-identical).
    ...(browserNetHolder !== undefined ? { browserNet: () => browserNetHolder.get() } : {}),
    imageQueue: state.imageQueue,
    // UUX-4-02 — hand `/rewind` the ONE live-history swap seam so a confirmed
    // rewind updates the live REPL history, not just the on-disk transcript.
    rewindState:
      state.rewindState !== undefined
        ? { ...state.rewindState, replaceMessages: liveHistorySwap }
        : undefined,
    mcpSurface: setup.mcpSurface,
    costPanel: setup.costPanel,
    planStore: setup.planStore,
    branchProgress: setup.branchProgress,
    // Ticket 17 `/agents` — thread the session's lifecycle subagent registry
    // (already in hand for the lifecycle pills) so `/agents` reads live tasks.
    taskRegistry: setup.lifecycleTaskRegistry,
    // jun-15 P0-b `/activity` — the SAME Activity Spine store `run_workflow`
    // writes its live run into (threaded onto the subagent config via
    // buildTooling), so the slash view and the loop share ONE spine.
    activityStore: setup.lifecycleActivityStore,
    // S2 (jul-03) `/activity` — the item-stream sink the fleet snapshot is pumped
    // onto (presence-gated on QUANTA_ITEM_STREAM above). Absent ⇒ no pump
    // (byte-identical); the pump self-no-ops on an undefined sink.
    ...(itemStreamSink !== undefined ? { itemStreamSink } : {}),
    // S2 (jul-03) `/activity` — the bounded ItemStore snapshot getter (the SAME
    // store `itemStreamSink` captures onto). Absent ⇒ `/activity` omits the
    // "Subagent items" section (byte-identical default-OFF).
    ...(itemStore !== undefined ? { activityItems: () => itemStore.snapshot() } : {}),
    // ADR-0231 — `/radar` live store: the SAME instance wired into
    // `AgentConfig.radar.store` above, so the slash surface and the loop's
    // producer hook share ONE queue. Absent ⇒ slot omitted ⇒ "not wired".
    ...(radarStore !== undefined ? { radar: radarStore } : {}),
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
    // #17 (C3) — `/brief` session-posture wire over the SAME `BriefStore` the
    // loop's consume side reads (`AgentConfig.sessionBrief`, bound at the
    // composition root to this bootstrap store). A SET is observed by the NEXT
    // turn's prompt assembly (BRIEF_NOTICE splice). Mirrors the effort slot; no
    // pill segment exists for brief, so set() only mutates the store (the
    // `/brief` command echoes the new state to stdout itself).
    brief: {
      get: () => setup.briefStore.get(),
      set: (on) => setup.briefStore.set(on),
    },
    // ADR-0291 — 8 ctx adapters wired through optional upstream-port fields.
    // Each is presence-spread by `buildReplSlashCtx`, so absent ports omit
    // the slot entirely (default-OFF byte-identical).
    composerHandle,
    conversationStore: convStore,
    // `/rewind-tool` — the ADR-0203 per-tool-checkpoint registry (lookup-bearing)
    // + 3-way restore port, sharing the SAME granular policy instance threaded
    // into the dispatch producer (shadowCheckpoint.granularPolicy above).
    ...(perToolCkpt !== undefined
      ? {
          perToolRegistry: perToolCkpt.registry,
          perToolRestorePort: perToolCkpt.restore,
          // UUX-6-03 — `/rewind-tool`'s task leg swaps the restored
          // conversation into the live history through the same ONE seam.
          perToolReplaceMessages: liveHistorySwap,
        }
      : {}),
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
    // ADR-0462 — `/sticky-model` SET surface. REUSE the SAME store the loop's
    // CONSUME side reads (`config.stickyModelStore`, exposed via runtimeContext),
    // so a SET is observed by the loop AND the command is present ONLY when the
    // feature is actually active (`--sticky-model`). Absent ⇒ slot omitted ⇒
    // `/sticky-model` prints "not wired" — no silent black hole where a SET
    // succeeds but the loop never reads it.
    ...(setup.runtimeContext.stickyModelStore() !== undefined
      ? {
          stickyModelStore: setup.runtimeContext.stickyModelStore()?.store,
          // `<modelId>` tab-completion source: the resolvable ids in this
          // surface (current model + retry candidates), deduped. Convenience
          // only — `/sticky-model` accepts any id (unknown ⇒ consume-side
          // no-op), so this never gates input.
          stickyModelCandidateIds: [...new Set([setup.model, ...retryCandidates.map((c) => c.id)])],
        }
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
          // The ONE no-throw live-history swap adapter (see liveHistorySwap
          // above) — shared with `/rewind` + `/rewind-tool`.
          replaceMessages: liveHistorySwap,
        }
      : undefined

  // ADR-0442 — `/voice-live` builder. Gated on `QUANTA_VOICE_LIVE`; absent ⇒
  // `undefined` ⇒ the slot is omitted from the dispatched SlashContext and the
  // slash prints "not wired" (default-OFF byte-identical).
  const voiceLive = buildVoiceLiveSlot(envSource)

  // UUX-4-04 — `/permission` live store view. INJECTED from session setup
  // (`setup.permissionStore` — the EXACT loaded instance the admissibility
  // gate consults), never the singleton accessor (service-locator rule). A
  // failed load ⇒ `undefined` ⇒ slot omitted ⇒ the inspector renders its
  // stateless view — honest, since the gate has no store then either.
  const permissionInspect: PermissionInspectSlashState | undefined =
    setup.permissionStore !== undefined
      ? {
          store: setup.permissionStore,
          ...(typeof setup.sessionId === "string" && setup.sessionId.length > 0
            ? { threadId: setup.sessionId }
            : {}),
        }
      : undefined

  // `/memory` — wire the SAME store the loop reads (built once in tooling,
  // forwarded through setup.memoryStore). Absent store (`QUANTA_MEMORY=off`)
  // ⇒ slot omitted ⇒ the slash prints "not wired" (byte-identical).
  const memorySlot: MemorySlashState | undefined =
    setup.memoryStore !== undefined
      ? {
          store: setup.memoryStore,
          ...(setup.memoryEmbedder !== undefined ? { embedder: setup.memoryEmbedder } : {}),
        }
      : undefined

  // `/dream` (H16) — REUSE the SAME `CrossSessionDreamTrigger` the session-end
  // auto path fires (exposed via runtimeContext). Present only when the host
  // built one (`QUANTA_AUTO_DREAM=1`); absent ⇒ slot omitted ⇒ `/dream` prints
  // "not wired". The manual `/dream` then drives `trigger.dream()` (cadence-gate
  // override, lock + flag honored), sharing one consolidation core — no
  // duplicated consolidate/state/write-target.
  const dreamTrigger = setup.runtimeContext.dreamTrigger()
  const dreamSlot: DreamSlashState | undefined =
    dreamTrigger !== undefined ? { trigger: dreamTrigger } : undefined

  const dispatchSlash = buildSurfaceDispatch({
    slashCtx,
    convCheckpointSlot,
    sessionIo,
    // LIVE `/context` seam — the merged segmented view (prompt-assembly segments
    // + the S3 reasoning-token annotation). Reads the SAME `contextUsageHolder`
    // the loop's `onPromptAssembled` writes and the stream tee feeds reasoning
    // into, so `/context` shows "Reasoning" after a real OpenAI-Responses turn.
    contextUsage: () => contextUsageHolder.view(),
    ...(voiceLive !== undefined ? { voiceLive } : {}),
    ...(memorySlot !== undefined ? { memory: memorySlot } : {}),
    ...(dreamSlot !== undefined ? { dream: dreamSlot } : {}),
    // Ticket 18 (§V1) — thread the READ-ONLY portal view into `/background`.
    // Absent ⇒ slot omitted ⇒ "not wired" (default-OFF byte-identical).
    ...(backgroundPortal !== undefined ? { background: backgroundPortal.view() } : {}),
    planQueue: planQueueStore,
    workingState: () => workingStateGet?.(),
    // ADR-0512 P3 — `/state` skill-scope section. Getter is undefined until the
    // loop fires `onSkillScopeReady` (v2 ON), so unset ⇒ `() => undefined` ⇒
    // `/state` omits the section (byte-identical).
    skillScope: () => skillScopeGet?.(),
    retry: () =>
      retryEnabled && lastStreamInput !== undefined
        ? {
            candidates: retryCandidates,
            currentModelId: setup.model,
            // Read-only preview: re-stream against a COPY so the slash's
            // `dropLastAssistantMessage` never mutates the live transcript.
            messages: [...state.history],
            streamInput: lastStreamInput,
            signal: setup.abort.signal,
            onEvent: renderRetryEvent,
          }
        : undefined,
    ...(shadowOdb !== undefined ? { shadowOdb } : {}),
    ...(conversationActions !== undefined ? { conversationActions } : {}),
    inboundMode,
    // #13 — `/mode` posture slot over the shared store (omitted when the gate
    // is off ⇒ "not wired").
    ...(modeSlot !== undefined ? { mode: modeSlot } : {}),
    // Ticket 14 (§11.6) — build the `/model` picker adapter over the SAME sticky
    // store the loop's consume side reads (so a SET is observed by the loop), with
    // the boot model + retry candidates as the selectable id set. The mode-implicit
    // SET binding lives in `buildModelAdapterWire` (regression-pinned there).
    // Absent store ⇒ adapter omitted ⇒ `/model` prints "not wired".
    ...buildModelAdapterWire({
      stickyStore: setup.runtimeContext.stickyModelStore(),
      bootModel: setup.model,
      planMode: setup.planMode,
      candidateIds: [...new Set([setup.model, ...retryCandidates.map((c) => c.id)])],
    }),
    // B2 (jul-04) `/cron` — read the LATE-BOUND automation slash slot LIVE per
    // dispatch (the loop installs it via `setAutomationSlash` once the engine is
    // minted). Absent until installed ⇒ `/cron` prints "not wired".
    automation: () => automationSlash,
    // UUX-4-04 — `/permission` live store view (the SAME singleton the
    // admissibility gate loads in composeCliRuntimeContext) + the live
    // session id for per-thread grant lookups. Absent (store unavailable) ⇒
    // slot omitted ⇒ the stateless render (mode still live via ctx.mode).
    ...(permissionInspect !== undefined ? { permissionInspect } : {}),
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
    planQueueStore,
    setPlanQueueSendNow,
    // B2 (jul-04) — the loop calls this once it mints the automation engine to
    // install the live `/cron` slash slot (late-bind, mirrors setPlanQueueSendNow).
    setAutomationSlash,
    // §steer — the inbound delivery surface: the conversation-action surface (for
    // weave/interrupt sinks + activeTurnRef) and the mutable mode ref. Both are
    // threaded to the session loop's in-turn reader.
    ...(conversationActions !== undefined ? { conversationActions } : {}),
    inboundMode,
    // #13 — the shared mode-cycle store, threaded to buildPromptUx so the
    // shift+tab pill/hook reuses the SAME instance `/mode` mutates (and the
    // session loop projects). Absent ⇒ QUANTA_MODE_CYCLE off (byte-identical).
    ...(modeCycleStore !== undefined ? { modeCycleStore } : {}),
    promptAssembledSink: contextUsageHolder.sink,
    // RFC-09 (B) — expose the retained per-turn usage snapshot getter so the
    // host can bind the pre-compaction warning to the SAME token count the
    // status-line / `/context` use (no new heuristic). Returns `undefined`
    // before the first turn.
    contextUsageView: () => contextUsageHolder.view(),
    // Ticket 18 (V1) — the background-turn portal (present iff QUANTA_BG_TURN).
    // Threaded to the session loop for the Ctrl+B detach (its `.view()` is wired
    // into `/background` above). Spread by-presence so default-OFF omits it.
    ...(backgroundPortal !== undefined ? { backgroundPortal } : {}),
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
