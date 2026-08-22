import type { InboundMode } from "@/agent/inbound-mode"
import type { Message } from "@/llm"
import type {
  RuntimeFacadeComposeOptions,
  RuntimeSideConversationArgs,
  RuntimeSideConversationResult,
} from "@/sdk/runtime"
import type { ConvCheckpointWire } from "../conv-checkpoint-wire"
import type { ConversationActionSurface } from "../conversation-action-surface"
import type { InTurnReaderStdin } from "../in-turn-reader"
import type { PlaybookTriggerSurfaceSeam } from "../playbook-trigger-surface-seam"
import type { DispatchSlash } from "../prompt-pipeline"
import type { SessionSetupResult } from "../session-setup"
import type { SessionSwitchReceipt } from "./session-switch"
import type { SessionLoopSinks } from "./types"

/** Dependencies for `runSessionLoop`. Every dep is EXPLICIT so the loop owns
 *  ZERO closure captures over the surface state. Kept in a dedicated module so
 *  the entrypoint (`session-loop.ts`) and the extracted `bootstrap`/branch
 *  helpers share the SAME shape without a cyclic import. */
export interface RunSessionLoopDeps {
  readonly setup: SessionSetupResult
  /** Slash dispatcher the prompt pipeline calls on every `/<cmd>` line.
   *  Returns true iff the input was routed (loop `continue`s); false ⇒
   *  forward as the next model prompt. */
  readonly dispatchSlash: DispatchSlash
  /** Per-turn renderers + side-effects. */
  readonly sinks: SessionLoopSinks
  /** Optional UX hooks (history-file / multiline / `@`-autocomplete). */
  readonly ux?: {
    readonly promptHistory?: import("../../prompt-history").PromptHistory
    readonly multiline?: boolean
    readonly atProvider?: import("../../at-autocomplete").AtCandidateProvider
    /** RFC-08 / ADR-0443 — turn-boundary mode store (drives the next session's
     *  permissionMode) + the derived pill meta + shift+tab hook. Absent ⇒
     *  byte-identical (permissionMode stays the runtime default). */
    readonly modeCycle?: import("../../mode-cycle").ModeCycleStore
    readonly modeMeta?: string
    readonly onCycleMode?: () => { meta?: string } | undefined
    /** RFC-11 / ADR-0446 — external `$EDITOR` composition port (ctrl-x ctrl-e).
     *  Absent ⇒ byte-identical. */
    readonly openEditor?: import("../../raw-line-reader-editor").ExternalEditorPort
    /** RFC-11 / ADR-0447 — loaded keybinding map (merged over defaults).
     *  Absent ⇒ byte-identical. */
    readonly keybindings?: import("../../keybindings/types").KeybindingMap
  }
  /** Optional image queue the prompt pipeline drains per turn. */
  readonly imageQueue?: import("../../image-queue").ImageQueue
  /** Optional text inbox the prompt pipeline drains per turn (ADR-0291).
   *  When present + non-empty, the drained entries are prepended to the
   *  user's literal text in the very next turn. Absent ⇒ pipeline behaves
   *  byte-identically (no drain, no preamble). */
  readonly textInbox?: import("../../text-inbox").TextInbox
  /** ADR-0528 L2 (auto-reinject) — prompts seeded into the live
   *  `ExternalPromptQueue` BEFORE the interactive loop starts, so they win the
   *  prompt-source race and run as the FIRST turn(s). The host uses it to
   *  re-inject an accepted crash-resume `offer.resumeMessage`. Absent/empty ⇒
   *  no push, byte-identical. Interactive-only (one-shot ignores it). */
  readonly seedPrompts?: readonly string[]
  /** Optional once-only `process.once('exit', ...)` registrar — keeps the
   *  loop from coupling to the process module directly so tests can stub it. */
  readonly registerExitTeardown?: (cb: () => void) => void
  /** ADR-0292 — turn-end auto-record wire. When present, the loop calls
   *  `recordTurn(messages)` after each successful turn completion (post-
   *  final-LLM-text, pre-next-prompt). Absent ⇒ no record, no allocation
   *  beyond the dep slot (default-OFF byte-identical). */
  readonly convCheckpointWire?: ConvCheckpointWire | null
  /** ADR-0292 — surface-side hook the loop registers so `/rewind-conv <tag>`
   *  can mutate the live `history` binding. Called once before the
   *  interactive driver starts. Absent ⇒ `/rewind-conv` restore still
   *  succeeds against the store but the surface transcript stays stale. */
  readonly registerReplaceMessages?: (fn: (msgs: ReadonlyArray<Message>) => Promise<void>) => void
  /** UUX-4-07 — `/fork` switch install slot (mirrors registerReplaceMessages).
   *  The loop installs `performSessionSwitch` bound to its live kernel session,
   *  its surface-state binding, and the facade-aliased `SessionMeta` (see
   *  `./session-loop/session-switch.ts` for the persist-repoint mechanism).
   *  Absent ⇒ `/fork` keeps mint-and-stay behavior (byte-identical). */
  readonly registerSessionSwitch?: (
    fn: (sessionId: string) => Promise<SessionSwitchReceipt>,
  ) => void
  /** Runtime-owned `/side` starter slot. The loop installs the live session
   *  method once the runtime session exists; slash surfaces read it lazily at
   *  invocation time so they never capture a stale or pre-session closure. */
  readonly registerSideConversationStart?: (
    fn: ((args: RuntimeSideConversationArgs) => Promise<RuntimeSideConversationResult>) | undefined,
  ) => void
  /** `/queue` `sendNow` target install. The loop wires this to push the
   *  follow-up text into the live `ExternalPromptQueue` so a "send now" lands
   *  at the next turn boundary. Absent ⇒ `sendNow` reports "send-not-possible". */
  readonly registerPlanQueueSendNow?: (
    fn:
      | ((inj: { readonly text: string }) => { ok: true } | { ok: false; reason: string })
      | undefined,
  ) => void
  /** B2 (jul-04 CLI-surfacing) — `/cron` automation slash slot install. The loop
   *  mints the automation engine (`liveAutomationSlot`) and, when present, builds
   *  the thin `createCronSlashAdapter` over its port + installs it here so
   *  `/cron`/`/schedule`/`/inbox` list/create/read against the LIVE engine. Absent
   *  engine ⇒ never called ⇒ the slot stays undefined ⇒ `/cron` prints "not
   *  wired" (default-OFF byte-identical). */
  readonly registerAutomationSlash?: (
    fn: import("../../slash/cron-cmd").AutomationSlashState | undefined,
  ) => void
  /** Constructor-time runtime composition payload threaded into
   *  `runtimeContext.createRuntimeFacade(...)`. Keeps the public SDK surface
   *  immutable after bootstrap while still letting the CLI supply
   *  session-owned adapters. */
  readonly runtimeFacadeCompose?: RuntimeFacadeComposeOptions
  /** ADR-0293 — playbook-trigger seam the loop attaches to once it owns the
   *  `ExternalPromptQueue` (the queue is the sink target). Absent ⇒ no
   *  trigger wire is constructed (default-OFF byte-identical). */
  readonly playbookSeam?: PlaybookTriggerSurfaceSeam
  /** ADR-0293 — operator-supplied CLI flag echo. The same env precedence
   *  (`QUANTA_PLAYBOOK_TRIGGER=on` wins over flag=false) is enforced
   *  inside `maybeStartPlaybookTriggerWire`. */
  readonly playbookCliFlag?: boolean
  /** L5 M-11 — THIS session's search-wire teardown (delta-scan `setInterval` +
   *  indexer). The host passes `boot.tooling.searchPipelineDispose` so session
   *  close releases the wire THIS session built, threaded per-session instead
   *  of via a module singleton (so two concurrent sessions each dispose their
   *  OWN wire). Absent ⇒ no wire was built (kill-switch / lexical-only);
   *  nothing is registered (default-OFF byte-identical). */
  readonly searchPipelineDispose?: () => void
  /** RFC-09 (A) — completion-notify port (ADR-0444). When present: the loop
   *  calls `onTurnComplete` after each finished turn (slow-turn gate lives in
   *  the adapter), threads it into the prompt pipeline for the idle path, and
   *  registers `dispose` on the close stack so the terminal title is restored
   *  on teardown. Absent ⇒ no notify calls, no close-stack entry
   *  (default-OFF byte-identical). */
  readonly notify?: import("../../notify").NotificationPort
  /** RFC-09 (A) — short cwd label for the notify title. */
  readonly notifyCwdBasename?: string
  /** RFC-09 (B) — pre-compaction warning provider. Threaded into the prompt
   *  pipeline; a non-empty return is painted as a one-line preamble before the
   *  prompt. Absent ⇒ no preamble (default-OFF byte-identical). */
  readonly contextWarning?: () => string
  /** #8 — the live plan-queue store the surface owns (the SAME store `/queue`
   *  reads). Threaded so the loop can build the mid-turn capture facade over it
   *  when `QUANTA_MIDTURN_CAPTURE=1`. Absent ⇒ no capture wire (default-OFF
   *  byte-identical). */
  readonly planQueueStore?: import("@/agent/plan-queue").PlanQueueStore
  /** `/goal` (Codex "Pursuing goal" parity) — the surface-owned objective store
   *  (the SAME instance `/goal` mutates). When present, the loop arms the idle
   *  goal-continuation ticker over it, gated by `QUANTA_GOAL_ENFORCE`. Absent ⇒
   *  no ticker (default-OFF byte-identical). */
  readonly objectiveStore?: import("@/objective").ObjectivePort
  /** #8 last-mile (jun-6) — the live stdin source for the CONCURRENT in-turn
   *  keystroke reader (closed-port DI; the host binds `process.stdin`, tests bind
   *  a fake). Only consumed when the mid-turn-capture wire is PRESENT
   *  (`QUANTA_MIDTURN_CAPTURE=1` + a plan-queue store + a thread id). Absent ⇒ no
   *  reader is ever started ⇒ stdin stays detached during the turn, byte-identical
   *  to today (the SACRED default-OFF invariant). */
  readonly inTurnStdin?: InTurnReaderStdin
  /** §steer — the conversation-action surface (weave `pushUserMessage` /
   *  interrupt `pushCancel` + the live `activeTurnRef`). Threaded so a mid-turn
   *  line can be WOVEN into the current turn or INTERRUPT it (vs the default
   *  next-turn queue). Present only when `QUANTA_CONVERSATION_ACTIONS=1`. Absent
   *  ⇒ every mode degrades to the queue path (byte-identical). */
  readonly conversationActions?: ConversationActionSurface
  /** §steer — the session-mutable inbound delivery mode (`queue` default).
   *  Mutated by `/inbound`. Absent or `queue` ⇒ the existing next-turn capture
   *  path (byte-identical). `weave`/`interrupt` route through `handleInboundLine`
   *  (only effective when `conversationActions` is also present). */
  readonly inboundMode?: { current: InboundMode }
  /** Ticket 18 (V1) — the background-turn portal (present iff `QUANTA_BG_TURN`).
   *  When wired AND the WEAVE guard allows it, the INTERACTIVE turn passes
   *  `onMovedToBackground` to `runOneTurn` so Ctrl+B detaches the running turn
   *  into this portal (the body keeps streaming; the loop returns to a fresh
   *  prompt). Absent ⇒ Ctrl+B is unwired ⇒ the turn path is byte-identical
   *  (default-OFF). The one-shot path NEVER wires it (no prompt to return to). */
  readonly backgroundPortal?: import("../background-turn-portal").BackgroundTurnPortal
}
