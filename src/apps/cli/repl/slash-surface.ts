import type { PlanStore } from "@/agent/plan/state"
import type { Message } from "@/llm"
import type { BranchProgressTracker } from "../branch-search-progress"
import type { CostPanel } from "../cost-panel"
import type { HistorySessionState } from "../history-cmd"
import type { IdleMonitor } from "../idle-monitor"
import { runImageCmd } from "../image-cmd"
import type { ImageQueue } from "../image-queue"
import { assembleConfig, type SessionDeps } from "../internal"
import type { McpSurfaceInfo } from "../mcp-cmd"
import type { RewindSlashState } from "../rewind-cmd"
import type { SideChatSessionState } from "../side-cmd"
import { isSlashCommand, runSlashCommand, type SkillRow } from "../slash-commands"
import type { DebugTracerHandle } from "./session-setup"

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
  }
}

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
  })
  return true
}
