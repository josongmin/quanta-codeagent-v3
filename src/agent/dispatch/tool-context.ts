import { gitWriteProtectReason } from "@/permission"
import { runtimeConfig } from "@/shared"
import type { WorkingStateHandle } from "@/tool"
import { type InterruptRouter, makeInterruptRouter, type ToolContext } from "@/tool"
import { bindWriteBudgetTurn } from "@/tool/_shared/write-budget"
import type { resolveCollaborationMode } from "../mode"
import { planStoreToMutator } from "../plan/mutator-adapter"
import { runPlanExitFlow } from "../plan-exit-flow"
import { materializeReviewerAgent } from "../tier1/reviewer-subagent"
import type { AgentConfig } from "../types"

/** jun-6 (RFC jun-6-tool-interrupt-behavior) — build the per-call interrupt
 *  router for a `block` tool when the knob is ON. Returns `undefined` when the
 *  knob is off OR the tool's declared `interruptBehavior()` is `"cancel"` (the
 *  common case) ⇒ the caller threads the raw signal + no seam (byte-identical).
 *  The watchdog scheduler is the real `setTimeout`/`clearTimeout` and the clock
 *  is `Date.now` (the composition root for the production seam); the cap comes
 *  from `runtimeConfig().criticalSectionMaxMs`. */
export const maybeBuildInterruptRouter = (
  config: AgentConfig,
  toolName: string,
): { router: InterruptRouter; signal: AbortSignal } | undefined => {
  if (!runtimeConfig().toolInterruptBlock) return undefined
  if (config.registry.interruptBehavior(toolName) !== "block") return undefined
  const derived = new AbortController()
  const router = makeInterruptRouter({
    source: config.signal,
    derived,
    now: Date.now,
    maxMs: runtimeConfig().criticalSectionMaxMs,
    scheduler: {
      schedule(ms, cb) {
        const id = setTimeout(cb, ms)
        return () => clearTimeout(id)
      },
    },
  })
  return { router, signal: derived.signal }
}

const buildRequestPlanExit = (
  config: AgentConfig,
  collabMode: ReturnType<typeof resolveCollaborationMode>,
): ToolContext["requestPlanExit"] => {
  const planExitPort = config.planExitPort
  return planExitPort !== undefined
    ? async (plan: string) => {
        const outcome = await runPlanExitFlow(collabMode, plan, planExitPort)
        config.onPlanExitOutcome?.({ plan, outcome })
        return outcome
      }
    : undefined
}

/** Build the plan-ENTRY requester — the inverse of {@link buildRequestPlanExit}.
 *  Gated on the SAME `planExitPort` slot (entry ships only when a clean exit is
 *  also wired). Fire-and-forget: it just relays the reason to
 *  `config.onPlanEnterRequest`; the loop flips mode at the next turn boundary. */
const buildEnterPlanMode = (config: AgentConfig): ToolContext["enterPlanMode"] =>
  config.planExitPort !== undefined
    ? (reason: string) => {
        config.onPlanEnterRequest?.({ reason })
      }
    : undefined

/** ADR-0416 sibling-identity fix — project the STABLE mailbox labels onto the
 *  ToolContext partial. Each label is omitted when its `AgentConfig` slot is
 *  absent (root session / legacy caller) so the subagent-mailbox tools fall
 *  back to the depth-derived label and the ctx stays byte-identical. Extracted
 *  from `buildToolContext` to keep that builder under the cognitive-complexity
 *  cap. */
const mailboxLabels = (
  config: AgentConfig,
): { agentLabel?: string; parentAgentLabel?: string } => ({
  ...(config.mailboxAgentId !== undefined ? { agentLabel: config.mailboxAgentId } : {}),
  ...(config.mailboxParentId !== undefined ? { parentAgentLabel: config.mailboxParentId } : {}),
})

export const buildToolContext = (args: {
  config: AgentConfig
  workingState: WorkingStateHandle | undefined
  collabMode: ReturnType<typeof resolveCollaborationMode>
  toolCallId: string
  /** jun-6 tool-interrupt — when the dispatch seam built an interrupt router for
   *  a `block` tool (knob ON), it threads the derived suppressible signal + the
   *  critical-section seam here. ABSENT ⇒ the ctx uses the raw `config.signal`
   *  and carries NO `criticalSection` (byte-identical: a `block` tool behaves
   *  like `cancel`). */
  interrupt?: { signal: AbortSignal; criticalSection: ToolContext["criticalSection"] }
}): ToolContext => {
  const { config, workingState, collabMode, toolCallId, interrupt } = args
  const requestPlanExit = buildRequestPlanExit(config, collabMode)
  const enterPlanMode = buildEnterPlanMode(config)
  const reviewerAgent = materializeReviewerAgent(config)
  return {
    cwd: config.cwd,
    // jun-6 — a `block` tool (knob ON) runs over the DERIVED suppressible signal
    // so its critical section can withhold an in-flight ESC; otherwise the raw
    // upstream signal (byte-identical legacy).
    signal: interrupt?.signal ?? config.signal,
    ...(interrupt?.criticalSection !== undefined
      ? { criticalSection: interrupt.criticalSection }
      : {}),
    gitWriteGuard: gitWriteProtectReason,
    ...(config.depth !== undefined ? { depth: config.depth } : {}),
    // ADR-0416 sibling-identity fix — surface the STABLE per-agent mailbox
    // label (and the parent's) so the subagent-mailbox tools address each
    // sibling uniquely. ABSENT (root session / legacy caller) ⇒ omitted ⇒ the
    // tools fall back to the depth-derived label (byte-identical). Extracted to
    // a helper so this builder stays under the biome cognitive-complexity cap.
    ...mailboxLabels(config),
    ...(workingState !== undefined ? { workingState } : {}),
    ...(requestPlanExit !== undefined ? { requestPlanExit } : {}),
    ...(enterPlanMode !== undefined ? { enterPlanMode } : {}),
    ...(reviewerAgent !== undefined ? { reviewerAgent } : {}),
    ...(config.onShellEvent !== undefined ? { onShellEvent: config.onShellEvent } : {}),
    ...(config.planStore !== undefined
      ? { planMutator: planStoreToMutator(config.planStore) }
      : {}),
    ...(config.userInputPort !== undefined ? { requestUserInput: config.userInputPort } : {}),
    // ADR-0296 PROMPT mode — map the host consent port onto the ctx requester
    // the bash tool consults at the deadline. ABSENT ⇒ ctx field absent ⇒
    // `prompt` degrades to plain `background` (byte-identical default).
    ...(config.backgroundConsentPort !== undefined
      ? { requestBackgroundConsent: config.backgroundConsentPort }
      : {}),
    ...((): { shellSnapshot?: import("@/tool").ShellSnapshotRestoreSeam } => {
      const seam = config.shellSnapshotSession?.currentSeam()
      return seam !== undefined ? { shellSnapshot: seam } : {}
    })(),
    ...(config.sessionConfigPort !== undefined ? { sessionConfig: config.sessionConfigPort } : {}),
    // ADR-0474 — thread the per-session stale-read-guard state so `read` records
    // mtimes and `write`/`edit` block stale mutations. ABSENT ⇒ no tracking
    // (byte-identical default-OFF).
    ...(config.readFileState !== undefined ? { readFileState: config.readFileState } : {}),
    // ADR-0421 wire-finish — thread the fast-apply fallback port from
    // AgentConfig into the ToolContext so `apply_patch` actually receives it.
    // ABSENT ⇒ ctx field absent ⇒ apply_patch byte-identical (default-OFF).
    ...(config.fastApplyFallback !== undefined
      ? { fastApplyFallback: config.fastApplyFallback }
      : {}),
    // jun-7-misc 06 (ADR ≥0497) wire-finish — thread the model-based fast-apply
    // MERGE port from AgentConfig into the ToolContext so the `edit` tool's
    // merge rung actually receives it. ABSENT ⇒ ctx field absent ⇒ edit ladder
    // byte-identical (default-OFF).
    ...(config.fastApplyMerge !== undefined ? { fastApplyMerge: config.fastApplyMerge } : {}),
    // jun-26 edit-escalate — surface the auto-escalate-fuzzy flag so the `edit`
    // tool runs the whitespace-tolerant fuzzy ladder on an exact MISS even without
    // an explicit `fuzzy:true`. Gated by QUANTA_EDIT_AUTO_FUZZY. OFF (default) ⇒
    // flag omitted ⇒ edit ladder byte-identical (fuzzy only on input.fuzzy).
    ...(runtimeConfig().editAutoFuzzy ? { autoEscalateFuzzy: true } : {}),
    // ADR-0428 jun-02 wire — surface the LIVE proxy-env (bound loopback address)
    // so shell-class tools inject HTTP(S)_PROXY into the child spawn. ABSENT ⇒
    // omitted ⇒ `withProxyEnv` returns the same base env (byte-identical legacy).
    ...(config.proxyEnv !== undefined ? { proxyEnv: config.proxyEnv } : {}),
    // ADR-0455 — surface the DECLARED local-environment selection so shell-class
    // tools compose its vars / PATH-prepends over the scrubbed child env
    // (allowlist still governs). ABSENT (no config file / no env selected) ⇒
    // omitted ⇒ `applyLocalEnv` returns the same base env (byte-identical legacy).
    ...(config.localEnv !== undefined ? { localEnv: config.localEnv } : {}),
    // ADR-0440 wire-finish — surface the tool-diff capture sink + the current
    // call id so a file-mutating tool can feed its before/after to the canvas
    // emitter. ABSENT (gate OFF / non-canvas caller) ⇒ both fields omitted ⇒ no
    // tool captures anything, byte-identical legacy path.
    ...(config.onToolDiff !== undefined ? { toolDiff: config.onToolDiff, toolCallId } : {}),
    // H6 (jun-3-misc §3) — surface the passive-VCS event sink so the bash tool's
    // post-exec hook (`maybeEmitPassiveVcs`, gated by QUANTA_PASSIVE_VCS) can
    // forward a classified `VcsEvent` onto the host adapter (which emits a
    // `recovery` AgentEvent on the existing stream). ABSENT (knob off / non-
    // wiring host) ⇒ omitted ⇒ the hook resolves its noop and the bash post-exec
    // path is byte-identical (default-OFF). The producer `PassiveVcsEventSink` is
    // structurally assignable to the ctx-side `VcsEventSink` mirror.
    ...(config.vcsEventSink !== undefined ? { vcsEventSink: config.vcsEventSink } : {}),
    // C2 (jun-4-communicate-update.md) — surface the structured-progress sink so
    // the `communicate_update` tool can forward its typed mirror to the host
    // adapter (which emits a render-only `progress_update` AgentEvent on the
    // existing stream). ABSENT (knob off / non-wiring host) ⇒ omitted ⇒ the
    // tool's `?.emit` is a no-op and the dispatch path is byte-identical
    // (default-OFF). The `@/agent` config-side `ProgressSink` is the same
    // structural `@/tool` mirror.
    ...(config.progressSink !== undefined ? { progressSink: config.progressSink } : {}),
    // file_history_rewind — surface the per-file snapshot capture sink so the
    // write/edit tools record each new file version into the session history
    // store the `file_history_rewind` tool reads. ABSENT (QUANTA_FILE_HISTORY
    // off / non-wiring host) ⇒ omitted ⇒ `captureFileHistory` is a no-op and the
    // mutating path is byte-identical (default-OFF). The `@/agent` config-side
    // `FileHistorySink` is the same structural `@/tool` mirror.
    ...(config.fileHistory !== undefined ? { fileHistory: config.fileHistory } : {}),
    // code-mode (RFC jun-6-code-mode) — surface a per-cell dispatch port for the
    // `code_cell` tool, built by the factory keyed off THIS tool-call id so the
    // synthesized in-cell call ids (`cell_<callId>_<seq>`) are deterministic +
    // unique. The factory routes every in-cell call through the REAL dispatchTool
    // (structural no-bypass, §6.1). ABSENT (gate OFF / non-wiring host) ⇒ omitted
    // ⇒ the tool yields a typed not_wired failure, byte-identical default-OFF.
    ...(config.codeCellDispatchFactory !== undefined
      ? { codeCellDispatch: config.codeCellDispatchFactory(toolCallId) }
      : {}),
    // code-mode (RFC jun-6-code-mode, Phase 2) — surface the agent's ACTUAL
    // registered tool names so the `code_cell` cell binds `tools.<name>` for the
    // FULL surface (each STILL re-gated through the port above). The thunk reads
    // the LIVE registry at dispatch time. ABSENT (gate OFF / non-wiring host) ⇒
    // omitted ⇒ `@/codemode` falls back to the Phase-1 3-tool surface,
    // byte-identical default-OFF.
    ...(config.codeCellSurfaceTools !== undefined
      ? { codeCellSurface: config.codeCellSurfaceTools() }
      : {}),
    // jun-6 exfil-rail (b) — thread the glob-in-write-path guard ENABLEMENT
    // (the predicate itself is a pure leaf the write/edit tools own). Default-OFF
    // (`QUANTA_GLOB_WRITE_GUARD` unset) ⇒ the flag is omitted ⇒ write/edit accept
    // a glob path as a literal filename, byte-identical.
    ...(runtimeConfig().globWriteGuard ? { globWriteGuard: true } : {}),
    // jun-6 exfil-rail (a) — surface a TURN-BOUND write-budget port so write/edit
    // tally each mutation against the per-turn counter (the host minted the
    // session-long `SessionWriteBudget`; we bind the current turn so the count
    // resets at each turn boundary). ABSENT (knob off / no cap / non-wiring host)
    // ⇒ omitted ⇒ no counter, byte-identical (default-OFF).
    ...((): { writeBudget: NonNullable<ToolContext["writeBudget"]> } | Record<string, never> => {
      const budget = config.writeBudget
      const max = runtimeConfig().writeBudgetMax
      if (budget === undefined || max === undefined) return {}
      return { writeBudget: bindWriteBudgetTurn(budget, config.run?.turn ?? 0, max) }
    })(),
    // ticket-11 (P8 git-worktree agent tools) — thread BOTH worktree seams from
    // the session-scoped slot. `worktreeSlot` is the mutable handle the
    // enter/exit/status tools read+mutate; `activeWorktree` is the slot's CURRENT
    // value, surfaced for the bash/edit relative-cwd override (the edit-fence).
    // ABSENT (gate OFF / non-wiring host) ⇒ both omitted ⇒ the worktree tools
    // yield a typed not_wired failure (and are not registered anyway) AND bash/edit
    // cwd is `ctx.cwd` exactly as today (byte-identical default-OFF). The current
    // value is projected here so a worktree entered in an earlier turn is visible
    // to bash/edit in this turn.
    ...(config.activeWorktreeSlot !== undefined
      ? {
          worktreeSlot: config.activeWorktreeSlot,
          ...(():
            | { activeWorktree: NonNullable<ToolContext["activeWorktree"]> }
            | Record<string, never> => {
            const cur = config.activeWorktreeSlot.current()
            return cur !== undefined ? { activeWorktree: cur } : {}
          })(),
        }
      : {}),
  }
}
