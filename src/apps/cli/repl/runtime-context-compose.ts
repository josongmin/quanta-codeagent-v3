import {
  type ConfirmDecision,
  createOnConfirmReviewerPort,
  loadNamedAgents,
  mintActiveWorktreeSlot,
  type NamedAgentResolver,
} from "@/agent"
import type { ConversationCheckpointStore } from "@/agent/conversation-checkpoint"
import { createClassifierBackedAutoReview } from "@/agent/reviewer-port"
import type { SessionBootstrapResult } from "@/host/bootstrap"
import { wireSecurityRailsForOverlay } from "@/host/runtime/security-rails-wire"
import type { ResponsesContinuationStore } from "@/llm"
import {
  createPersistentTrustScopeRegistry,
  type PermissionStore,
  type ReviewerSandboxProfile,
  setAutoApprovalReviewObserver,
  type ToolAction,
  type TrustScopeRegistry,
} from "@/permission"
import type { PendingApprovalView } from "@/protocol/session"
import { resolveNetworkProxyFromEnv } from "@/runner/knobs/knobs/network-proxy"
import type { ApprovalDecisionResult } from "@/runner/orchestrate"
import { composeRuntimeBootstrapContext, type RuntimeContext } from "@/sdk/runtime"
import { gateOn, runtimeConfigFromEnv } from "@/shared"
import { decisionEmitterFromStream, type StreamPort } from "@/stream"
import type { WorktreeSlotHandle } from "@/tool"
import { buildShellSnapshotConfig, buildSummarizerLlm } from "../internal"
import {
  buildAdmissibility,
  ladderAutoReviewEnabled,
} from "./cli-admissibility-compose"
import {
  askLine,
  buildBackgroundConsentPort,
  buildCliApprovalPrompt,
  buildCliOnConfirm,
} from "./cli-approval-prompt"
import {
  createMidTurnApprovalChannel,
  type MidTurnApprovalChannel,
  registerMidTurnApprovalChannel,
} from "./mid-turn-approval-channel"
import { createCliPlanExitPort, createCliUserInputPort } from "./session-host-ports"

export interface ComposeCliRuntimeContextArgs {
  readonly boot: SessionBootstrapResult
  readonly turnStream: StreamPort
  readonly loadPermissionStore: () => Promise<PermissionStore | undefined>
  readonly sandboxProfile: ReviewerSandboxProfile
  readonly convStore?: ConversationCheckpointStore
  readonly responsesStore?: ResponsesContinuationStore
  readonly envSource?: Readonly<Record<string, string | undefined>>
}

export interface CliRuntimeContextBindings {
  readonly approvalPrompt: (approval: PendingApprovalView) => Promise<ApprovalDecisionResult>
  /** The in-turn approval input channel — the session loop flips `.active` +
   *  routes captured stdin lines into it around each turn so a mid-turn approval
   *  prompt reads the operator's answer without a second stdin reader. */
  readonly midTurnApprovalChannel: MidTurnApprovalChannel
  readonly runtimeContext: RuntimeContext
  /** UUX-4-04 — the loaded `PermissionStore` (the EXACT instance threaded
   *  into the admissibility gate), surfaced so the `/permission` inspector
   *  can report the grants that actually gate this session. `undefined`
   *  when the load failed (the gate then has no store either). */
  readonly permissionStore: PermissionStore | undefined
}

interface RuntimeConfirmSlot {
  current: (action: ToolAction) => Promise<boolean | ConfirmDecision>
}

const buildSessionMemoryAutoSummarizer = (
  boot: SessionBootstrapResult,
): ReturnType<typeof buildSummarizerLlm> => buildSummarizerLlm(boot.provider, boot.abort.signal)

const buildBootstrapContextArgs = (args: {
  readonly boot: SessionBootstrapResult
  readonly turnStream: StreamPort
  readonly confirmSlot: RuntimeConfirmSlot
  readonly onConfirm: (action: ToolAction) => Promise<boolean | ConfirmDecision>
  readonly planExitPort: ReturnType<typeof createCliPlanExitPort>
  readonly userInputPort: ReturnType<typeof createCliUserInputPort>
  /** ADR-0296 PROMPT-mode consent gate (mid-turn approval channel). */
  readonly backgroundConsentPort: (info: {
    readonly command: string
    readonly elapsedMs: number
  }) => Promise<boolean>
  readonly summarizerLlm?: ReturnType<typeof buildSummarizerLlm>
  readonly sandboxProfile: ReviewerSandboxProfile
  readonly permissionStore: PermissionStore | undefined
  readonly autoReview: ReturnType<typeof createClassifierBackedAutoReview> | undefined
  /** ADR-0428 jun-02 wire — composition-root env view used for the DIRECT
   *  `QUANTA_NETWORK_PROXY` read (mirrors `resolveMemoryConfigFromEnv`). */
  readonly env: Readonly<Record<string, string | undefined>>
  /** F2 (round-2) — host-loaded named-agent resolver (`loadNamedAgents(cwd)`).
   *  Threaded onto the overlay so the per-turn AgentConfig carries it. Absent ⇒
   *  no `.quanta/agents` (or load fault) ⇒ overlay slot omitted (byte-identical). */
  readonly namedAgentResolver?: NamedAgentResolver
  /** ticket-11 (P8 worktree) — session-scoped active-worktree slot, minted at the
   *  comp-root ONLY when `QUANTA_WORKTREE_TOOL` is on. Threaded onto the overlay so
   *  the per-turn AgentConfig carries it; features.ts registers the worktree tools
   *  over it and dispatch projects its value onto the bash/edit edit-fence. Absent
   *  ⇒ tools unregistered + cwd byte-identical (default-OFF). */
  readonly activeWorktreeSlot?: WorktreeSlotHandle
  /** #20 (durable prefix grants) — persistent trust-scope registry + projectKey,
   *  wired ONLY when `QUANTA_TRUST_SCOPE` is on. Threaded onto the overlay so the
   *  per-turn AgentConfig carries `trustScope` and the gate consults durable
   *  grants. Absent ⇒ slot omitted (default-OFF, byte-identical). */
  readonly trustScope?: { registry: TrustScopeRegistry; projectKey: string }
  /** SECURITY-RAIL (a) — the per-session write-budget minted by
   *  {@link wireSecurityRailsForOverlay} when `QUANTA_WRITE_BUDGET` is on (+ cap).
   *  Threaded onto the overlay so the base carries it to per-turn dispatch (the
   *  (N+1)th untrusted write is rejected). Absent ⇒ slot omitted (default-OFF,
   *  byte-identical: no counter). */
  readonly writeBudget?: ReturnType<typeof wireSecurityRailsForOverlay>["writeBudget"]
}): Parameters<typeof composeRuntimeBootstrapContext>[0] => {
  const {
    boot,
    turnStream,
    confirmSlot,
    onConfirm,
    planExitPort,
    userInputPort,
    backgroundConsentPort,
    summarizerLlm,
    sandboxProfile,
    permissionStore,
    autoReview,
    env,
    namedAgentResolver,
    activeWorktreeSlot,
    trustScope,
    writeBudget,
  } = args
  // ADR-0428 jun-02 wire — DIRECT env read of `QUANTA_NETWORK_PROXY` (this
  // surface builds its base via the host overlay, not `applyKnobs`). Absent /
  // "0" / empty ⇒ `undefined` ⇒ overlay slot omitted ⇒ NO proxy, byte-identical.
  const networkProxy = resolveNetworkProxyFromEnv(env as NodeJS.ProcessEnv)
  const shellSnapshot = buildShellSnapshotConfig()
  return {
    boot,
    stream: turnStream,
    onConfirm,
    includeSearchPipeline: true,
    overlay: {
      // jun-10 HITL restructure — `interactive: true` declares the live
      // operator: the runtime approval controller delegates mid-turn asks to
      // the slot's surface confirm INLINE (no turn abort / re-run). Non-CLI
      // surfaces never set this and keep the deferred approvalRequest protocol.
      approvalProtocol: { confirmSlot, interactive: true },
      // D-1 (jul-10, UUX-1-03) — CLI/web HITL parity: with a live operator on a
      // TTY, always-confirm tools ASK even under bypass/acceptEdits (the web
      // daemon has seeded this since jun-10; the CLI's missing seed was the
      // split). Non-TTY (piped/headless CLI) keeps the legacy fallthrough —
      // a prompt nobody can answer would hang the pipeline.
      // KNOWN WIDTH (audit W3-D1): on this sandbox-less default composition,
      // bash's tier is always-confirm for EVERY command (needs-sandbox
      // conflation, see src/permission/pdp.ts), so bash now prompts under
      // acceptEdits/bypass too — same posture the web has carried since
      // jun-10. Burden mitigations: [a]lways-session grants + the
      // allowlistEscalated per-actionKey dedup. If this proves too noisy in
      // practice, the structural fix is splitting the needs-sandbox tier from
      // confirm:"sensitive" at the PDP, NOT reverting the seed.
      ...(process.stdin.isTTY === true ? { hitl: { enabled: true } } : {}),
      ...(summarizerLlm !== undefined ? { summarizerLlm } : {}),
      planExitPort,
      userInputPort,
      backgroundConsentPort,
      decisionEmitter: decisionEmitterFromStream(turnStream),
      admissibilityBuilder: ({ materializeReviewerAgent }) =>
        buildAdmissibility({
          boot,
          onConfirm,
          sandboxProfile,
          permissionStore,
          autoReview,
          materializeReviewerAgent: () => materializeReviewerAgent(boot),
        }),
      ...(shellSnapshot !== undefined ? { shellSnapshot } : {}),
      ...(networkProxy !== undefined ? { networkProxy } : {}),
      // F2 (round-2) — overlay the named-agent resolver when the surface loaded
      // a non-empty `.quanta/agents` registry. Absent ⇒ slot omitted ⇒ the
      // per-turn AgentConfig has no resolver (default-OFF byte-identical).
      ...(namedAgentResolver !== undefined ? { namedAgentResolver } : {}),
      // ticket-11 (P8 worktree) — overlay the session-scoped slot when
      // QUANTA_WORKTREE_TOOL minted one. Absent ⇒ slot omitted ⇒ worktree tools
      // unregistered + bash/edit cwd byte-identical (default-OFF).
      ...(activeWorktreeSlot !== undefined ? { activeWorktreeSlot } : {}),
      // #20 — overlay the persistent trust-scope registry when QUANTA_TRUST_SCOPE
      // wired one. Absent ⇒ slot omitted ⇒ gate's trustScopeGrants returns false
      // (default-OFF byte-identical).
      ...(trustScope !== undefined ? { trustScope } : {}),
      // SECURITY-RAIL (a) — overlay the per-session write-budget minted at the
      // comp-root when QUANTA_WRITE_BUDGET is on. Absent ⇒ slot omitted ⇒ no
      // counter (default-OFF byte-identical).
      ...(writeBudget !== undefined ? { writeBudget } : {}),
    },
  }
}

/** S2 (jul-10, commit 8bb5eb7cf) — mint the FIFO ask-queue channel that lets a
 *  mid-turn approval read the operator's answer through the in-turn keystroke
 *  reader (no stdin fight) AND publish it so surfaces composed at a different
 *  layer (MCP elicitation / ask_user prompter io) route their mid-turn reads
 *  through the SAME line source instead of a second readline. Extracted from
 *  {@link composeCliRuntimeContext} verbatim (pure code motion). */
const wireAskQueue = (): MidTurnApprovalChannel => {
  // MID-TURN FIX — the channel that lets a mid-turn approval read the operator's
  // answer through the in-turn keystroke reader (no stdin fight). The session
  // loop flips `.active` + routes captured lines into it around each turn.
  const midTurnApprovalChannel = createMidTurnApprovalChannel()
  // WS-B (jul-10, UUX-1-05) — publish the channel so surfaces composed at a
  // different layer (MCP elicitation / ask_user prompter io) route their
  // mid-turn reads through the SAME line source instead of a second readline.
  registerMidTurnApprovalChannel(midTurnApprovalChannel)
  return midTurnApprovalChannel
}

/** SECURITY RAILS (jun-6, commit bc7202668) — wire the write-budget +
 *  sandbox-escalation anti-exfil rails onto the interactive REPL's runtime
 *  overlay path (NOT the host assembler), which was DARK here: `QUANTA_WRITE_BUDGET`
 *  / `QUANTA_SANDBOX_ESCALATION` gave zero protection on `quanta`. Route the SAME
 *  owner the assembler uses:
 *   - write-budget: the returned `writeBudget` is threaded onto the overlay so the
 *     base carries it to per-turn dispatch (the (N+1)th untrusted write is rejected).
 *   - sandbox-escalation: the handler is installed as a side-effect against the
 *     gate-shared `permissionStore` + the composed `onConfirm` authority.
 *  Both knobs off ⇒ writeBudget undefined (overlay slot omitted) + handler cleared
 *  ⇒ byte-identical to today (default-OFF). Extracted from
 *  {@link composeCliRuntimeContext} verbatim (pure code motion). */
const wireSecurityOverlay = (deps: {
  readonly envSource?: Readonly<Record<string, string | undefined>>
  readonly permissionStore: PermissionStore | undefined
  readonly onConfirm: (action: ToolAction) => Promise<boolean | ConfirmDecision>
}): ReturnType<typeof wireSecurityRailsForOverlay>["writeBudget"] => {
  const { writeBudget } = wireSecurityRailsForOverlay(
    runtimeConfigFromEnv(deps.envSource ?? process.env),
    { permissionStore: deps.permissionStore, onConfirm: deps.onConfirm },
  )
  return writeBudget
}

export const composeCliRuntimeContext = async (
  args: ComposeCliRuntimeContextArgs,
): Promise<CliRuntimeContextBindings> => {
  const { boot, turnStream, loadPermissionStore, sandboxProfile } = args
  // S2 — the FIFO ask-queue channel (mid-turn approval + cross-layer publish).
  const midTurnApprovalChannel = wireAskQueue()
  // #20 (durable prefix grants) — wire the PERSISTENT trust-scope registry ONLY
  // when `QUANTA_TRUST_SCOPE` is on (opt-in; NOT seeded default-ON like the other
  // CLI gates — durable cross-session grants are a deliberate operator choice).
  // Hydrated once here (async comp-root) so the gate sees prior-session grants on
  // turn 1. `boot.cwd` is the SESSION-RESOLVED jail root, used as BOTH the
  // projectRoot (overlay file location) and the projectKey (grant lookup key) so
  // mint + consult agree. Absent ⇒ undefined ⇒ no [P] verb + gate skips trust-
  // scope (default-OFF, byte-identical).
  const trustScopeEnv = args.envSource ?? process.env
  const trustScope = gateOn(trustScopeEnv, "QUANTA_TRUST_SCOPE")
    ? await (async (): Promise<{ registry: TrustScopeRegistry; projectKey: string }> => {
        const registry = createPersistentTrustScopeRegistry({ projectRoot: boot.cwd })
        await registry.hydrate()
        return { registry, projectKey: boot.cwd }
      })()
    : undefined
  const surfaceOnConfirm = buildCliOnConfirm({
    idleMonitor: boot.idleMonitor,
    rejectCounter: boot.rejectCounter,
    channel: midTurnApprovalChannel,
    cwd: boot.cwd, // #19
    ...(trustScope !== undefined ? { trustScope } : {}), // #20 durable
  })
  const confirmSlot: RuntimeConfirmSlot = {
    current: surfaceOnConfirm,
  }
  const onConfirm = async (action: ToolAction): Promise<boolean | ConfirmDecision> =>
    await confirmSlot.current(action)
  const autoReviewUserPort = createOnConfirmReviewerPort({ onConfirm })
  const autoReview =
    boot.permission.classify !== undefined
      ? createClassifierBackedAutoReview({
          classify: boot.permission.classify,
          userReview: autoReviewUserPort.userReview,
        })
      : undefined
  // T03 — when the agent reviewer is the chosen posture, surface each auto-review
  // as a `tool_progress` notice (keyed by the reviewed tool-call id) so the CLI
  // timeline + web card show "auto-reviewed by guardian: …" rather than the tool
  // silently running. Registered ONLY under the opt-in ⇒ default-OFF byte-identical
  // (no observer ⇒ the reviewer slice's emit is a no-op). The notice is best-effort:
  // `decisionEmitterFromStream`-style throw isolation lives in the sink itself.
  if (ladderAutoReviewEnabled()) {
    setAutoApprovalReviewObserver({
      observe: (ev) => {
        const who = ev.reviewer === "guardian_subagent" ? "guardian" : "auto-review"
        const what =
          ev.phase === "started" ? "reviewing…" : ev.allowed ? "approved (no prompt)" : "denied"
        turnStream.emit({
          type: "tool_progress",
          id: ev.toolCallId ?? "",
          name: ev.tool,
          message: `auto-reviewed by ${who}: ${what}`,
        })
      },
    })
  }
  const permissionStore = await loadPermissionStore()
  // SECURITY RAILS — wire the write-budget + sandbox-escalation anti-exfil rails
  // onto this overlay path (see {@link wireSecurityOverlay}). Both knobs off ⇒
  // writeBudget undefined + handler cleared ⇒ byte-identical to today (default-OFF).
  const securityWriteBudget = wireSecurityOverlay({
    ...(args.envSource !== undefined ? { envSource: args.envSource } : {}),
    permissionStore,
    onConfirm,
  })
  const planExitPort = createCliPlanExitPort({
    ask: (p) => askLine(midTurnApprovalChannel, p, "plan-exit"),
  })
  const userInputPort = createCliUserInputPort({
    ask: (p) => askLine(midTurnApprovalChannel, p, "user-input"),
    stream: turnStream,
  })
  // ADR-0296 PROMPT mode — see {@link buildBackgroundConsentPort}. Bound to the
  // SAME mid-turn approval channel the inline confirm uses. Default-OFF for
  // kill/background modes (never invoked), byte-identical when unread.
  const backgroundConsentPort = buildBackgroundConsentPort(midTurnApprovalChannel)
  const summarizerLlm = buildSessionMemoryAutoSummarizer(boot)
  // F2 (round-2) — load `.quanta/agents` (+ native dir) ONCE per session at this
  // async composition root, using the SESSION-RESOLVED `boot.cwd` (the jailed /
  // resume-switched cwd the surface already settled on — NOT raw `process.cwd()`).
  // Threaded onto the runtime overlay so the interactive REPL's per-turn
  // AgentConfig carries `namedAgentResolver`, giving the primary surface the same
  // named-agent resolution the headless `apps/agent` surface has. FAIL-OPEN +
  // default-OFF: a thrown loader ⇒ `undefined`; an empty registry (no agent dir)
  // ⇒ slot stays absent ⇒ no resolver set ⇒ byte-identical to today.
  const namedAgents = await loadNamedAgents(boot.cwd).catch(() => undefined)
  const namedAgentResolver =
    namedAgents !== undefined && namedAgents.size > 0 ? namedAgents : undefined
  // ticket-11 (P8 worktree) — mint the session-scoped active-worktree slot ONLY
  // when `QUANTA_WORKTREE_TOOL` is on (see {@link mintActiveWorktreeSlot} in
  // `@/agent`). Gate off ⇒ undefined ⇒ worktree tools unregistered + bash/edit
  // cwd byte-identical (default-OFF). `boot.cwd` is the SESSION-RESOLVED jail root
  // the edit-fence keeps absolute writes within — the slot NEVER widens it.
  const activeWorktreeSlot = mintActiveWorktreeSlot(args.envSource ?? process.env, boot.cwd)
  const runtimeContext = await composeRuntimeBootstrapContext({
    ...buildBootstrapContextArgs({
      boot,
      turnStream,
      confirmSlot,
      onConfirm,
      planExitPort,
      userInputPort,
      backgroundConsentPort,
      ...(summarizerLlm !== undefined ? { summarizerLlm } : {}),
      sandboxProfile,
      permissionStore,
      autoReview,
      env: args.envSource ?? process.env,
      ...(namedAgentResolver !== undefined ? { namedAgentResolver } : {}),
      ...(activeWorktreeSlot !== undefined ? { activeWorktreeSlot } : {}),
      ...(trustScope !== undefined ? { trustScope } : {}), // #20 durable
      ...(securityWriteBudget !== undefined ? { writeBudget: securityWriteBudget } : {}),
    }),
    ...(args.convStore !== undefined || args.responsesStore !== undefined
      ? {
          execution: {
            history: boot.history,
            cwd: boot.cwd,
            envSource: args.envSource ?? process.env,
            ...(args.convStore !== undefined ? { convStore: args.convStore } : {}),
            ...(args.responsesStore !== undefined ? { responsesStore: args.responsesStore } : {}),
          },
        }
      : {}),
    memoryAuto: {
      env: args.envSource ?? process.env,
      logWarn: (msg: string) => process.stderr.write(`[memory-auto] ${msg}\n`),
    },
  })
  return {
    approvalPrompt: buildCliApprovalPrompt({
      idleMonitor: boot.idleMonitor,
      rejectCounter: boot.rejectCounter,
      channel: midTurnApprovalChannel,
      cwd: boot.cwd, // session-resolved cwd for preflight/hunk reads in the shared prompt helpers
    }),
    midTurnApprovalChannel,
    runtimeContext,
    // UUX-4-04 — surfaced for the `/permission` inspector (same instance the
    // admissibility gate received above).
    permissionStore,
  }
}

/** Test seam — never import in production. Exposes the HITL prompt builders so
 *  the e2e suite can drive the REAL CLI confirm/approval wording + verb routing
 *  against the real gate/controller without booting a full session. */
export const __testing = {
  buildCliOnConfirm,
  buildCliApprovalPrompt,
}

export { buildAdmissibility } from "./cli-admissibility-compose"
