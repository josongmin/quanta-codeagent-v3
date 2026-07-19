import type { SkillScopeView, WorkingState } from "@/agent"
import type { InboundMode } from "@/agent/inbound-mode"
import type { PlanQueueStore } from "@/agent/plan-queue"
import type { ShadowOdb } from "@/storage"
import type { DreamSlashState } from "../../dream-cmd"
import { runImageCmd } from "../../image-cmd"
import type { MemorySlashState } from "../../memory-cmd"
import type { RetryWithSessionState } from "../../retry-with"
import type { ConvCheckpointSlashState } from "../../rewind-conv-cmd"
import type { SessionIoState } from "../../session-cmd"
import { isSlashCommand, runSlashCommand, type SlashContext } from "../../slash-commands"
import type { SegmentedUsageView } from "../../status-line"
import type { VoiceLiveCtx } from "../../voice-live-cmd"
import type { ConversationActionSurface } from "../conversation-action-surface"
import { projectSlashCtx, type ReplSlashCtx } from "../slash-surface"
import { buildVoiceLiveCtx, voiceLiveEnabled } from "../voice-live-wire"

/** Project the legacy + ADR-0291 ReplSlashCtx slots onto the
 *  `SlashContext` shape. Delegates to the SSOT {@link projectSlashCtx} in
 *  `slash-surface.ts` — the SAME projector the test-harness `dispatchReplSlash`
 *  uses — so the legacy + ADR-0291 slot mapping can never drift out of sync
 *  between the two files (there is now ONE copy, not two byte-synced ones).
 *  This slice then layers its ADR-0292/0294 augmentations (`convCheckpoint`,
 *  `sessionIo`, …) on top in {@link buildSurfaceDispatch}. */
const projectReplSlashCtxToContract = (c: ReplSlashCtx): Record<string, unknown> =>
  projectSlashCtx(c)

/** Build the surface's slash dispatch closure: routes `/image` directly to
 *  the image-queue command (same fast-path the legacy `dispatchReplSlash`
 *  did) and forwards all others to `runSlashCommand` with the FULL
 *  augmented `SlashContext`. Default-OFF: when the convCheckpoint /
 *  sessionIo slots are absent, the spread omits them ⇒ the slash command
 *  itself prints "not wired" (byte-identical with the pre-wire path). */
export const buildSurfaceDispatch = (args: {
  readonly slashCtx: ReplSlashCtx
  readonly convCheckpointSlot: ConvCheckpointSlashState | undefined
  readonly sessionIo: SessionIoState
  /** Live `/context` seam — returns the latest assembled-prompt breakdown
   *  (written by the loop's `onPromptAssembled` sink) or `undefined` before
   *  the first turn assembles a prompt. */
  readonly contextUsage?: () => SegmentedUsageView | undefined
  /** ADR-0442 `/voice-live` builder. Present only when the opt-in gate is set
   *  (`QUANTA_VOICE_LIVE`); resolves a constructed live `VoiceLiveCtx` (or
   *  `undefined` on a non-TTY host). Absent ⇒ slot omitted ⇒ the slash prints
   *  "not wired" (byte-identical default-OFF). */
  readonly voiceLive?: () => Promise<VoiceLiveCtx | undefined>
  /** `/memory` store slot. Present iff a durable store was built (default-ON
   *  volatile `InMemoryStore`); absent ⇒ the slash prints "not wired". */
  readonly memory?: MemorySlashState | undefined
  /** `/dream` (H16) manual-trigger slot. Present iff the host wired the live
   *  cross-session dream trigger (`QUANTA_AUTO_DREAM=1`); REUSES the SAME trigger
   *  instance the session-end auto path fires (no duplicated consolidation
   *  logic). Absent ⇒ the slash prints "not wired" (default-OFF byte-identical). */
  readonly dream?: DreamSlashState | undefined
  /** `/queue` plan-queue store. Surface-owned; always present in the REPL so
   *  inspect/mutate/sendNow resolve (empty until a producer enqueues). */
  readonly planQueue?: PlanQueueStore | undefined
  /** `/state` working-state snapshot getter. Always wired (returns undefined
   *  when `QUANTA_WORKING_STATE` is off ⇒ `/state` renders an empty panel). */
  readonly workingState?: (() => WorkingState | undefined) | undefined
  /** ADR-0512 P3 — `/state` skill-scope getter. Returns the active skill's
   *  visible/hidden tool partition, or undefined when `QUANTA_SKILL_SCOPE_V2` is
   *  off / no skill is scoping ⇒ `/state` omits the skill-scope section. */
  readonly skillScope?: (() => SkillScopeView | undefined) | undefined
  /** `/retry-with` session-state factory. Returns the live re-stream state
   *  (candidates + last stream input + stdout renderer) or undefined when the
   *  feature is off or no turn has streamed yet ⇒ slot omitted. */
  readonly retry?: (() => RetryWithSessionState | undefined) | undefined
  /** `/snapshot` shadow object-DB (SAME instance the loop checkpoints into).
   *  Present only when `QUANTA_SHADOW` is on ⇒ otherwise slot omitted and the
   *  slash prints "shadow store not configured". */
  readonly shadowOdb?: ShadowOdb | undefined
  /** ADR-0071 mid-turn control surface. Present only when
   *  QUANTA_CONVERSATION_ACTIONS is on; absent ⇒ /cancel + /summarize-now
   *  print "not wired". */
  readonly conversationActions?: ConversationActionSurface | undefined
  /** §steer — the session-mutable inbound delivery mode ref, so `/inbound`
   *  reads/sets it (the SAME ref the session loop reads per mid-turn line).
   *  Always present (the REPL seeds it `queue`). */
  readonly inboundMode: { current: InboundMode }
  /** #13 — `/mode` posture wire over the shared mode-cycle store. Present iff
   *  `QUANTA_MODE_CYCLE` is on; absent ⇒ slot omitted ⇒ `/mode` prints "not
   *  wired" (default-OFF byte-identical). */
  readonly mode?: SlashContext["mode"]
  /** Ticket 14 (§11.6) — `/model` interactive-picker adapter over the SAME
   *  sticky-model store the loop reads. Present iff a sticky store was wired;
   *  absent ⇒ `/model` prints "not wired in this surface" (default-OFF). */
  readonly modelAdapter?: SlashContext["model"]
  /** Ticket 18 (§V1) — READ-ONLY background-turn portal view for `/background`.
   *  Present iff `QUANTA_BG_TURN` is on; absent ⇒ slot omitted ⇒ `/background`
   *  prints "not wired" (default-OFF byte-identical). */
  readonly background?: SlashContext["background"]
  /** B2 (jul-04) — LATE-BOUND `/cron` (alias `/schedule`) + `/inbox` automation
   *  slash slot. Read as a GETTER (not a value) because the automation engine is
   *  minted INSIDE `runSessionLoop`, after this dispatch is built — the loop
   *  installs the adapter via a surface setter and this getter resolves it LIVE
   *  per invocation. Returns `undefined` until installed ⇒ `/cron` prints "not
   *  wired" (default-OFF byte-identical). */
  readonly automation?: () => SlashContext["automation"]
  /** UUX-4-04 — `/permission` live permission-store view (the SAME singleton
   *  the admissibility gate consults) + the live thread id. Absent ⇒ slot
   *  omitted ⇒ the inspector renders its stateless (store-free) view. */
  readonly permissionInspect?: import("../../permission-explain").PermissionInspectSlashState
  /** `/goal` (Codex parity) — the shared objective store + thread id. Present iff
   *  the surface minted the store; absent ⇒ slot omitted ⇒ `/goal` prints "not
   *  wired" (default-OFF byte-identical). */
  readonly goal?: SlashContext["goal"]
  /** §9.6 `/presets` — the shared `StickyPresetResolver` (the SAME instance the
   *  loop's role→model resolution consults). Present iff the surface minted it;
   *  absent ⇒ slot omitted ⇒ `/presets` prints "not wired" (default-OFF
   *  byte-identical). */
  readonly presets?: SlashContext["presets"]
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
      // Ticket 14 (§11.6) — `/model` picker adapter. Absent ⇒ slot omitted ⇒
      // the command prints "not wired" (parity with /sticky-model default-OFF).
      ...(args.modelAdapter !== undefined ? { model: args.modelAdapter } : {}),
      ...(args.convCheckpointSlot !== undefined ? { convCheckpoint: args.convCheckpointSlot } : {}),
      sessionIo: args.sessionIo,
      // Live `/context` seam (Track D): when present, `/context` renders the
      // segmented breakdown from the latest assembled prompt instead of the
      // legacy placeholder. Absent ⇒ slot omitted ⇒ legacy fallback.
      ...(args.contextUsage !== undefined ? { contextUsage: args.contextUsage } : {}),
      // ADR-0442 `/voice-live` builder. Present only when the opt-in gate is
      // set; absent ⇒ slot omitted ⇒ the slash prints "not wired" (byte-
      // identical default-OFF).
      ...(args.voiceLive !== undefined ? { voiceLive: args.voiceLive } : {}),
      // `/memory` store slot: present iff a durable store was built. Absent ⇒
      // slot omitted ⇒ the slash prints "memory store not wired".
      ...(args.memory !== undefined ? { memory: args.memory } : {}),
      // `/dream` (H16) manual-trigger slot: present iff the host wired the live
      // cross-session dream trigger. Absent ⇒ slot omitted ⇒ the slash prints
      // "auto-dream not wired in this surface" (default-OFF byte-identical).
      ...(args.dream !== undefined ? { dream: args.dream } : {}),
      // `/queue` plan-queue store: surface-owned, always present in the REPL.
      ...(args.planQueue !== undefined ? { planQueue: args.planQueue } : {}),
      // `/state` working-state snapshot getter: always wired (empty when the
      // feature is off ⇒ renders an empty panel instead of "not wired").
      ...(args.workingState !== undefined ? { workingState: args.workingState } : {}),
      // ADR-0512 P3 — `/state` skill-scope getter: wired only when v2 is on (the
      // getter yields undefined until the loop publishes ⇒ section omitted,
      // byte-identical).
      ...(args.skillScope !== undefined ? { skillScope: args.skillScope } : {}),
      // `/retry-with` re-stream state: present only when the feature is on AND a
      // turn has streamed (so there is a stream input to replay).
      ...(() => {
        const retry = args.retry?.()
        return retry !== undefined ? { retry } : {}
      })(),
      // `/snapshot` shadow store: present only when QUANTA_SHADOW is on.
      ...(args.shadowOdb !== undefined ? { shadowOdb: args.shadowOdb } : {}),
      // `/cancel` + `/summarize-now` mid-turn control surface.
      ...(args.conversationActions !== undefined
        ? { conversationActions: args.conversationActions }
        : {}),
      // `/inbound` mode ref (always present in the REPL — seeded queue).
      inboundMode: args.inboundMode,
      // #13 — `/mode` posture wire. Present only when QUANTA_MODE_CYCLE is on;
      // absent ⇒ slot omitted ⇒ `/mode` prints "not wired" (default-OFF).
      ...(args.mode !== undefined ? { mode: args.mode } : {}),
      // Ticket 18 (§V1) — `/background` read-only portal view. Present only when
      // QUANTA_BG_TURN is on; absent ⇒ slot omitted ⇒ "not wired" (default-OFF).
      ...(args.background !== undefined ? { background: args.background } : {}),
      // B2 (jul-04) — `/cron` late-bound automation slot, resolved LIVE per
      // dispatch (the loop installs it once the engine is minted). Undefined
      // until installed ⇒ `/cron` prints "not wired" (default-OFF byte-identical).
      ...(() => {
        const automation = args.automation?.()
        return automation !== undefined ? { automation } : {}
      })(),
      // UUX-4-04 — `/permission` live store view. Absent ⇒ stateless render.
      ...(args.permissionInspect !== undefined
        ? { permissionInspect: args.permissionInspect }
        : {}),
      // `/goal` (Codex parity) — shared objective store + thread id. Absent ⇒
      // slot omitted ⇒ `/goal` prints "not wired" (default-OFF byte-identical).
      ...(args.goal !== undefined ? { goal: args.goal } : {}),
      // §9.6 `/presets` — shared sticky preset resolver (SAME instance the loop
      // consults for role→model). Absent ⇒ slot omitted ⇒ `/presets` prints
      // "not wired" (default-OFF byte-identical).
      ...(args.presets !== undefined ? { presets: args.presets } : {}),
    }
    await runSlashCommand(input, ctx)
    return true
  }
}

/** ADR-0442 — build the `/voice-live` ctx builder when the opt-in gate is set
 *  (`QUANTA_VOICE_LIVE`). Returns `undefined` (so the slot is omitted, default-
 *  OFF byte-identical) when the knob is unset. When set, returns a thunk that
 *  constructs a live `VoiceLiveCtx` on demand — the actual `@/realtime` /
 *  `@/voice` / `@/auth` composition is owned by `voice-live-wire.ts`; this just
 *  injects the production clock, the TTY probe, and the raw-mode keypress stdin
 *  (built lazily inside the wire only on a TTY host). Construction is deferred
 *  to first `/voice-live` so the boot path never spawns a recorder/transport
 *  for a user who never types the command. The OpenAI bearer is resolved INSIDE
 *  the wire (composition root) and threaded into the session as a value — the
 *  realtime slice never reads env/auth itself. */
export const buildVoiceLiveSlot = (
  envSource: NodeJS.ProcessEnv,
): (() => Promise<VoiceLiveCtx | undefined>) | undefined => {
  if (!voiceLiveEnabled(envSource)) return undefined
  return () => {
    // A raw-mode keypress reader requires an interactive STDIN; that is the
    // relevant TTY probe for live voice (the recorder + the key loop both bind
    // to stdin). `process.stdin.isTTY` is the injected host signal here — the
    // surface fence bans `process.stdout/stderr.isTTY` + `process.env`, neither
    // of which this reads (the env is the injected `envSource` parameter).
    const isTty = process.stdin.isTTY === true
    return buildVoiceLiveCtx({
      env: envSource,
      isTty,
      now: () => Date.now(),
      ...(isTty
        ? { keypressStdin: process.stdin as unknown as import("../voice-live-wire").KeypressStdin }
        : {}),
    })
  }
}
