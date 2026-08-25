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

/** Live inputs consumed by the surface-owned slash dispatcher. */
type SurfaceDispatchArgs = {
  readonly sessionCwd: string
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
  /** RFC-03 C3 `/objective` — the CAS-guarded objective editor wire (built over
   *  the SAME store as `goal`). Present iff QUANTA_PROPOSE_GOAL is on AND the
   *  surface minted the store; absent ⇒ slot omitted ⇒ `/objective` prints "not
   *  wired" (default-OFF byte-identical). */
  /** RFC-05 E4 `/posture` — the posture selector wire over the SAME live
   *  `PostureControl` the host mutates. Present iff QUANTA_POSTURE_SELECTOR is on
   *  AND the bootstrap wired the control; absent ⇒ slot omitted ⇒ `/posture` prints
   *  "not wired" (default-OFF byte-identical). */
  readonly postureEditor?: SlashContext["postureEditor"]
  /** §9.6 `/presets` — the shared `StickyPresetResolver` (the SAME instance the
   *  loop's role→model resolution consults). Present iff the surface minted it;
   *  absent ⇒ slot omitted ⇒ `/presets` prints "not wired" (default-OFF
   *  byte-identical). */
  readonly presets?: SlashContext["presets"]
  /** RFC03-def `/skills review` — the review/approve surface for staged imported
   *  skills. Present iff a gated startup config-migration IMPORT staged one;
   *  absent ⇒ slot omitted ⇒ `/skills review` prints "no staged skill proposals"
   *  (default-OFF byte-identical — no import ⇒ no slot). */
  readonly skillReview?: SlashContext["skillReview"]
}

const optionalSlashSlot = <K extends keyof SlashContext>(
  key: K,
  value: SlashContext[K] | undefined,
): Partial<Pick<SlashContext, K>> =>
  value === undefined ? {} : ({ [key]: value } as Pick<SlashContext, K>)

const buildLiveSlashContext = (args: SurfaceDispatchArgs): SlashContext => {
  const retry = args.retry?.()
  const automation = args.automation?.()
  return {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    cwd: args.sessionCwd,
    ...projectReplSlashCtxToContract(args.slashCtx),
    ...optionalSlashSlot("model", args.modelAdapter),
    ...optionalSlashSlot("convCheckpoint", args.convCheckpointSlot),
    sessionIo: args.sessionIo,
    ...optionalSlashSlot("contextUsage", args.contextUsage),
    ...optionalSlashSlot("voiceLive", args.voiceLive),
    ...optionalSlashSlot("memory", args.memory),
    ...optionalSlashSlot("dream", args.dream),
    ...optionalSlashSlot("planQueue", args.planQueue),
    ...optionalSlashSlot("workingState", args.workingState),
    ...optionalSlashSlot("skillScope", args.skillScope),
    ...optionalSlashSlot("retry", retry),
    ...optionalSlashSlot("shadowOdb", args.shadowOdb),
    ...optionalSlashSlot("conversationActions", args.conversationActions),
    inboundMode: args.inboundMode,
    ...optionalSlashSlot("mode", args.mode),
    ...optionalSlashSlot("background", args.background),
    ...optionalSlashSlot("automation", automation),
    ...optionalSlashSlot("permissionInspect", args.permissionInspect),
    ...optionalSlashSlot("goal", args.goal),
    ...optionalSlashSlot("postureEditor", args.postureEditor),
    ...optionalSlashSlot("presets", args.presets),
    ...optionalSlashSlot("skillReview", args.skillReview),
  }
}

const dispatchImage = (
  input: string,
  sessionCwd: string,
  queue: ReplSlashCtx["imageQueue"],
): boolean => {
  if (queue === undefined) return false
  runImageCmd(input, {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    cwd: sessionCwd,
    queue,
  })
  return true
}

/** Route `/image` through its queue fast path and all other registered slash
 * commands through a freshly projected context. Optional slots are omitted,
 * never installed as literal `undefined`, and late-bound getters are resolved
 * once per invocation. */
export const buildSurfaceDispatch = (
  args: SurfaceDispatchArgs,
): ((input: string) => Promise<boolean>) => {
  return async (input: string): Promise<boolean> => {
    const head = input.split(/\s+/)[0] ?? ""
    if (!isSlashCommand(head)) return false
    if (head === "/image" && dispatchImage(input, args.sessionCwd, args.slashCtx.imageQueue))
      return true
    await runSlashCommand(input, buildLiveSlashContext(args))
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
