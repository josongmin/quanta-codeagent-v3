import type { PlanStore } from "@/agent/plan/state"
import type { LLMPort, Message } from "@/llm"
import type { SessionEnvelopeRecord } from "@/session"
import type { BranchProgressTracker } from "../branch-search-progress"
import type { CostPanel } from "../cost-panel"
import type { HistorySessionState } from "../history-cmd"
import type { IdleMonitor } from "../idle-monitor"
import { runImageCmd } from "../image-cmd"
import type { ImageQueue } from "../image-queue"
import type { InspectSlashState } from "../inspect-cmd"
import { assembleConfig, type SessionDeps } from "../internal"
import type { McpSurfaceInfo } from "../mcp-cmd"
import type { RewindSlashState } from "../rewind-cmd"
import type { SideChatSessionState } from "../side-cmd"
import { isSlashCommand, runSlashCommand, type SkillRow } from "../slash-commands"
import type { WhySlashState } from "../why-cmd"
import type { DebugTracerHandle } from "./session-setup"

/** Adapter the REPL composer threads through to `/replay`. The slash command
 *  declares the same shape locally via `declare module` (replay-cmd.ts); this
 *  copy is the structural mirror — keeping it inline here avoids a cross-file
 *  type import where one would re-introduce a slice cycle. */
export interface ReplaySlashState {
  readonly resolveSession: (id: string) => Promise<string | undefined>
  readonly iterate: (path: string) => AsyncIterable<SessionEnvelopeRecord>
}

/** Shared REPL-side slash-context state. Threaded through
 *  {@link dispatchReplSlash} → `runSlashCommand`. Each field is independently
 *  optional so surfaces can omit unsupported adapters and keep the existing
 *  "not wired" behavior. */
export type ReplSlashCtx = Partial<{
  skills: () => Promise<SkillRow[]>
  idle: IdleMonitor
  imageQueue: ImageQueue
  rewindSession: RewindSlashState
  mcp: McpSurfaceInfo
  cost: () => string
  planSnapshot: () => import("@/agent/plan/types").Plan | null
  history: HistorySessionState
  branchSearch: () => import("../branch-search-progress").BranchProgressState
  /** `/side` SessionState FACTORY — built fresh on each invocation so the
   *  `messages` value reflects the live transcript rather than a stale
   *  snapshot captured when the REPL started. */
  side: () => SideChatSessionState
  /** ADR-0239 — debug-tracer runtime toggle. Present iff the boot gate
   *  (`QUANTA_DEBUG=1` + TTY) allocated the mutable proxy port; absent ⇒
   *  `/debug` slash prints "not wired" + the QUANTA_DEBUG hint. */
  debug: DebugTracerHandle
  /** ADR-0271 — `/why` meta-LLM reasoning query slot. Present iff the
   *  REPL surface has both an active sessionId and an active LLMPort
   *  (full session setup). Absent ⇒ `/why` prints "not wired in this
   *  surface" + exit 0. */
  why: WhySlashState
  /** Track I (ADR-0239 follow-up) — `/inspect <toolCallId>` surface
   *  wire. Present iff the REPL host has an active session id to point
   *  `findByToolCallId` at; absent ⇒ `/inspect` reports "no active
   *  session" and exits 1. */
  inspect: InspectSlashState
  /** Track R — `/replay <session-id>` surface wire. Present iff the
   *  composer can resolve a session id → JSONL path + iterate decoded
   *  envelopes; absent ⇒ `/replay` prints "not wired in this surface" +
   *  exit 0 (parity with the other surface-only commands). */
  replay: ReplaySlashState
}>

export interface BuildReplSlashCtxArgs {
  skillsCb: (() => Promise<SkillRow[]>) | undefined
  idleMonitor: IdleMonitor
  imageQueue: ImageQueue | undefined
  rewindState: RewindSlashState | undefined
  mcpSurface: McpSurfaceInfo | undefined
  costPanel: CostPanel | undefined
  planStore: PlanStore | undefined
  branchProgress: BranchProgressTracker | undefined
  /** Returns the live transcript reference so slash surfaces never read a
   *  stale `history` binding. */
  getHistory: () => readonly Message[]
  sessionDeps: SessionDeps
  abortSignal: AbortSignal
  /** ADR-0239 — debug-tracer surface handle. Absent ⇒ `/debug` prints
   *  "not wired" (boot-time tee was not allocated). */
  debugHandle: DebugTracerHandle | undefined
  /** ADR-0271 — active LLMPort for the `/why` meta-LLM reasoning query.
   *  Threaded straight from `SessionSetupResult.llm`. */
  llm: LLMPort
  /** ADR-0271 — active session id (envelope reader scope). */
  sessionId: string
  /** ADR-0271 — model identifier surfaced in the `/why` panel header. */
  model: string
  /** Track I — active session id for `/inspect`. Absent ⇒ command
   *  prints "no active session" + exit 1. */
  inspect: InspectSlashState | undefined
  /** Track R — `/replay` resolver+iterator pair. Absent ⇒ command
   *  prints "not wired in this surface" + exit 0. */
  replay: ReplaySlashState | undefined
}

/** Compose the REPL-owned slash adapters into one explicit surface object. */
export const buildReplSlashCtx = (args: BuildReplSlashCtxArgs): ReplSlashCtx => {
  const {
    skillsCb,
    idleMonitor,
    imageQueue,
    rewindState,
    mcpSurface,
    costPanel,
    planStore,
    branchProgress,
    getHistory,
    sessionDeps,
    abortSignal,
    debugHandle,
    llm,
    sessionId,
    model,
    inspect,
    replay,
  } = args
  return {
    ...(skillsCb !== undefined ? { skills: skillsCb } : {}),
    idle: idleMonitor,
    ...(imageQueue !== undefined ? { imageQueue } : {}),
    ...(rewindState !== undefined ? { rewindSession: rewindState } : {}),
    ...(mcpSurface !== undefined ? { mcp: mcpSurface } : {}),
    ...(costPanel !== undefined ? { cost: () => costPanel.renderDetailed() } : {}),
    ...(planStore !== undefined
      ? { planSnapshot: (): import("@/agent/plan/types").Plan | null => planStore.current() }
      : {}),
    ...(branchProgress !== undefined ? { branchSearch: () => branchProgress.snapshot() } : {}),
    history: { messages: getHistory },
    side: (): SideChatSessionState => ({
      deps: sessionDeps,
      assembleConfig,
      messages: getHistory(),
      signal: abortSignal,
    }),
    // ADR-0239 — `/debug` runtime toggle. Absent ⇒ slash prints "not wired".
    ...(debugHandle !== undefined ? { debug: debugHandle } : {}),
    // ADR-0271 — `/why` meta-LLM reasoning query. Always wired in the
    // REPL surface (LLM + sessionId are required for the loop to start).
    why: { sessionId, llm, model },
    // Track I — `/inspect` active session wire. Absent ⇒ slash exits 1.
    ...(inspect !== undefined ? { inspect } : {}),
    // Track R — `/replay` resolver+iterator. Absent ⇒ slash prints "not wired".
    ...(replay !== undefined ? { replay } : {}),
  }
}

/** Map the surface-owned {@link ReplSlashCtx} into the contract shape that
 *  {@link runSlashCommand} expects. Extracted from {@link dispatchReplSlash}
 *  so the dispatcher stays under biome's cognitive-complexity budget —
 *  every adapter is a 1:1 spread, no branching beyond "absent ⇒ omit". */
const projectSlashCtx = (slashCtx: ReplSlashCtx | undefined): Record<string, unknown> => ({
  ...(slashCtx?.skills !== undefined ? { skills: slashCtx.skills } : {}),
  ...(slashCtx?.idle !== undefined ? { idle: slashCtx.idle } : {}),
  ...(slashCtx?.rewindSession !== undefined ? { rewindSession: slashCtx.rewindSession } : {}),
  ...(slashCtx?.mcp !== undefined ? { mcp: slashCtx.mcp } : {}),
  ...(slashCtx?.cost !== undefined ? { cost: slashCtx.cost } : {}),
  ...(slashCtx?.planSnapshot !== undefined ? { planSnapshot: slashCtx.planSnapshot } : {}),
  ...(slashCtx?.history !== undefined ? { history: slashCtx.history } : {}),
  ...(slashCtx?.branchSearch !== undefined ? { branchSearch: slashCtx.branchSearch } : {}),
  ...(slashCtx?.side !== undefined ? { side: slashCtx.side() } : {}),
  ...(slashCtx?.debug !== undefined ? { debug: slashCtx.debug } : {}),
  ...(slashCtx?.why !== undefined ? { why: slashCtx.why } : {}),
  ...(slashCtx?.inspect !== undefined ? { inspect: slashCtx.inspect } : {}),
  ...(slashCtx?.replay !== undefined ? { replay: slashCtx.replay } : {}),
})

/** Try to handle `input` as an in-REPL slash command. Returns true iff the
 *  input was routed and consumed by the slash surface; false means the
 *  caller must forward it to the model path. `isSlashCommand` rejects path-
 *  like strings so legacy file-resume tokens still fall through. */
export const dispatchReplSlash = async (
  input: string,
  slashCtx?: ReplSlashCtx,
): Promise<boolean> => {
  const head = input.split(/\s+/)[0] ?? ""
  if (!isSlashCommand(head)) return false
  if (head === "/image" && slashCtx?.imageQueue !== undefined) {
    runImageCmd(input, {
      out: (s) => process.stdout.write(s),
      err: (s) => process.stderr.write(s),
      cwd: process.cwd(),
      queue: slashCtx.imageQueue,
    })
    return true
  }
  await runSlashCommand(input, {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    cwd: process.cwd(),
    ...projectSlashCtx(slashCtx),
  })
  return true
}
