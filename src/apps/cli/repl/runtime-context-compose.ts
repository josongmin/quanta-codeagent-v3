import { join } from "node:path"
import {
  type ConfirmDecision,
  createOnConfirmReviewerPort,
  loadNamedAgents,
  mintActiveWorktreeSlot,
  type NamedAgentResolver,
} from "@/agent"
import type { ConversationCheckpointStore } from "@/agent/conversation-checkpoint"
import { createClassifierBackedAutoReview } from "@/agent/reviewer-port"
import { isWorkspaceTrusted } from "@/agent/workspace-trust"
import type { SessionBootstrapResult } from "@/host/bootstrap"
import { type AssemblerEnv, buildInteractiveTurnAssembler } from "@/host/runtime"
import type { MentionLiveSources } from "@/host/runtime/internal/mention-source-deps"
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
import {
  type HunkMutationJournalStore,
  makeDurableJournalStore,
} from "@/runner/hunk-mutation-journal"
import { resolveNetworkProxyFromEnv } from "@/runner/knobs/knobs/network-proxy"
import type { ApprovalDecisionResult } from "@/runner/orchestrate"
import { composeRuntimeBootstrapContext, type RuntimeContext } from "@/sdk/runtime"
import { listSessions, type SessionMeta, sessionsRoot } from "@/session"
import { gateOn, runtimeConfigFromEnv } from "@/shared"
import { decisionEmitterFromStream, type StreamPort } from "@/stream"
import type { WorktreeSlotHandle } from "@/tool"
import { buildShellSnapshotConfig, buildSummarizerLlm } from "../internal"
import type { McpServerInfo, McpSurfaceInfo } from "../mcp-cmd"
import { buildAdmissibility, ladderAutoReviewEnabled } from "./cli-admissibility-compose"
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
  /** RFC-def `/undo` — the durable hunk-mutation journal store, built ONLY when
   *  `QUANTA_HUNK_UNDO=1` (DESTRUCTIVE ⇒ default OFF). The SAME instance is
   *  threaded into the HITL approval prompt (so per-hunk applies persist a CAS
   *  undo receipt) AND surfaced to the `/undo` slash context (so it lists +
   *  reverts through the EXISTING journal). Absent ⇒ no durable store, no `/undo`
   *  slot, per-hunk apply byte-identical. */
  readonly hunkUndoStore: HunkMutationJournalStore | undefined
}

/** Build the durable hunk-mutation journal store when `QUANTA_HUNK_UNDO=1`.
 *  Reuses the EXISTING `makeDurableJournalStore` (atomic-writer-backed, no new
 *  ODB) under `<sessionsRoot>/hunk-journal`. Default OFF ⇒ `undefined` (no store
 *  wired anywhere; byte-identical). */
const buildHunkUndoStore = (
  env: Readonly<Record<string, string | undefined>>,
): HunkMutationJournalStore | undefined => {
  if (!runtimeConfigFromEnv(env).hunkUndo) return undefined
  return makeDurableJournalStore(join(sessionsRoot(), "hunk-journal"))
}

interface RuntimeConfirmSlot {
  current: (action: ToolAction) => Promise<boolean | ConfirmDecision>
}

const buildSessionMemoryAutoSummarizer = (
  boot: SessionBootstrapResult,
): ReturnType<typeof buildSummarizerLlm> => buildSummarizerLlm(boot.provider, boot.abort.signal)

/** RFC-12-2 WIRING — project the CLI's ALREADY-LIVE sources onto the host-only
 *  {@link MentionLiveSources} bundle for the `@mcp:` / `@thread:` mention kinds
 *  (`@subagent:` rides `namedAgentResolver`, threaded separately). NO new
 *  store/registry — owner reuse:
 *    - MCP: `boot.mcpSurface` (the `/mcp` `McpSurfaceInfo` the bootstrap built
 *      from `loadMcpTools` — server name → its bridged tools). Narrowed from the
 *      host-opaque `BootstrapMcpSurface` here (mirrors `mcpSurface` in
 *      session-setup). Absent / empty ⇒ `@mcp:` dark.
 *    - Thread: `listSessions` (the live session index). Absent / load-fault ⇒
 *      `@thread:` dark (the thunk is NO-THROW inside the wire).
 *  Returns `undefined` when NEITHER source is present so the overlay slot is
 *  omitted (byte-identical default). */
const buildMentionOwnerSources = (boot: SessionBootstrapResult): MentionLiveSources | undefined => {
  const surface = boot.mcpSurface as McpSurfaceInfo | undefined
  const mcpServers = surface?.servers
    ?.filter((s: McpServerInfo) => s.status === "connected")
    .map((s: McpServerInfo) => ({ name: s.name, tools: s.tools }))
  const hasMcp = mcpServers !== undefined && mcpServers.length > 0
  // The session-list thunk projects `SessionMeta` → the resolver/provider's
  // `ThreadSummary` shape (a structural subset). Always available (the session
  // index is a durable store); a load fault degrades to zero threads in the wire.
  const sessions = async () =>
    (await listSessions()).map((m: SessionMeta) => ({
      id: m.id,
      title: m.title,
      cwd: m.cwd,
      ...(m.gitBranch !== undefined ? { gitBranch: m.gitBranch } : {}),
      ...(m.threadSource !== undefined ? { threadSource: m.threadSource } : {}),
      // B4 lineage — carry the fork parentage so the `@thread:` resolver can scope
      // to the caller's lineage (self ∪ ancestors ∪ descendants). Metadata-only.
      ...(m.forkedFromId !== undefined ? { forkedFromId: m.forkedFromId } : {}),
    }))
  return {
    ...(hasMcp ? { mcpServers } : {}),
    sessions,
    // B4 lineage scope — the caller's OWN thread id (fail-closed if absent).
    ...(boot.sessionId !== undefined ? { selfThreadId: boot.sessionId } : {}),
  }
}

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
  /** RFC-12-2 WIRING — host-only mention owner sources for `@mcp:` / `@thread:`
   *  (built by {@link buildMentionOwnerSources} from `boot.mcpSurface` +
   *  `listSessions`). Threaded onto the overlay so the base carries it to
   *  `installCliMentionInjector`. Absent ⇒ overlay slot omitted (byte-identical). */
  readonly mentionOwnerSources?: MentionLiveSources
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
  /** SECURITY-RAIL (b) — the per-SESSION bash sandbox-escalation handler minted by
   *  {@link wireSecurityRailsForOverlay} when `QUANTA_SANDBOX_ESCALATION` is on (+
   *  a gate-shared permission store). Threaded onto the overlay so the base carries
   *  it to per-turn dispatch (a sandbox-blocked bash command routes through THIS
   *  session's onConfirm + store — never a sibling session's). Absent ⇒ slot
   *  omitted (default-OFF, byte-identical: the block surfaces as a plain failure). */
  readonly bashSandboxEscalation?: ReturnType<
    typeof wireSecurityRailsForOverlay
  >["bashSandboxEscalation"]
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
    mentionOwnerSources,
    activeWorktreeSlot,
    trustScope,
    writeBudget,
    bashSandboxEscalation,
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
      // RFC-01 A4 — wire the pending-question authority (minted under
      // `QUANTA_ATTENTION_NAV` by the lifecycle bundle) onto the per-turn
      // AgentConfig. PRESENT ⇒ the A3 producer routes `request_user_input`
      // through the broker (bound to the explicit `spawnedAsTaskId` owner) so the
      // `/attention` projection surfaces it; ABSENT (gate off) ⇒ slot omitted ⇒
      // `request_user_input` keeps the legacy `userInputPort` (byte-identical).
      ...(boot.lifecycleQuestionBroker !== undefined
        ? { questionBroker: boot.lifecycleQuestionBroker }
        : {}),
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
      // RFC-12-2 WIRING — overlay the host-only mention sources (mcp snapshot +
      // session thunk) so the per-turn AgentConfig's `installCliMentionInjector`
      // wires `@mcp:` / `@thread:` live. Absent ⇒ slot omitted ⇒ both dark.
      ...(mentionOwnerSources !== undefined ? { mentionOwnerSources } : {}),
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
      // SECURITY-RAIL (b) — overlay the per-SESSION sandbox-escalation handler
      // minted at the comp-root when QUANTA_SANDBOX_ESCALATION is on. Absent ⇒
      // slot omitted ⇒ a sandbox-blocked bash command surfaces as a plain failure
      // (default-OFF byte-identical).
      ...(bashSandboxEscalation !== undefined ? { bashSandboxEscalation } : {}),
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
 *  owner the assembler uses. BOTH rails are per-SESSION `AgentConfig` slots, so
 *  BOTH must be returned and threaded onto the overlay — a dropped slot is a rail
 *  that stays dark (there is no process-global back channel any more):
 *   - write-budget: the returned `writeBudget` is threaded onto the overlay so the
 *     base carries it to per-turn dispatch (the (N+1)th untrusted write is rejected).
 *   - sandbox-escalation: the returned `bashSandboxEscalation` handler (bound to the
 *     gate-shared `permissionStore` + the composed `onConfirm` authority, holding
 *     this session's ONE escalation cap) rides the overlay the same way.
 *  Both knobs off ⇒ both undefined (overlay slots omitted) ⇒ byte-identical to
 *  today (default-OFF). Extracted from {@link composeCliRuntimeContext}. */
const wireSecurityOverlay = (deps: {
  readonly envSource?: Readonly<Record<string, string | undefined>>
  readonly permissionStore: PermissionStore | undefined
  readonly onConfirm: (action: ToolAction) => Promise<boolean | ConfirmDecision>
}): ReturnType<typeof wireSecurityRailsForOverlay> =>
  wireSecurityRailsForOverlay(runtimeConfigFromEnv(deps.envSource ?? process.env), {
    permissionStore: deps.permissionStore,
    onConfirm: deps.onConfirm,
  })

/** Present-only projection of the two minted security-rail slots onto the
 *  bootstrap-context args. Each is omitted when its knob left it unminted, so
 *  both-off ⇒ `{}` ⇒ byte-identical (default-OFF). Extracted so
 *  {@link composeCliRuntimeContext} does not carry the two extra branches. */
const securityOverlaySlots = (
  rails: ReturnType<typeof wireSecurityRailsForOverlay>,
): Pick<
  Parameters<typeof buildBootstrapContextArgs>[0],
  "writeBudget" | "bashSandboxEscalation"
> => ({
  ...(rails.writeBudget !== undefined ? { writeBudget: rails.writeBudget } : {}),
  ...(rails.bashSandboxEscalation !== undefined
    ? { bashSandboxEscalation: rails.bashSandboxEscalation }
    : {}),
})

/** #20 (durable prefix grants) — hydrate the PERSISTENT trust-scope registry
 *  ONLY when `QUANTA_TRUST_SCOPE` is on (opt-in; NOT seeded default-ON like the
 *  other CLI gates — durable cross-session grants are a deliberate operator
 *  choice). Hydrated once (async comp-root) so the gate sees prior-session grants
 *  on turn 1. `boot.cwd` is the SESSION-RESOLVED jail root, used as BOTH the
 *  projectRoot (overlay file location) and the projectKey (grant lookup key) so
 *  mint + consult agree. Gate off ⇒ `undefined` ⇒ no [P] verb + the gate skips
 *  trust-scope (default-OFF, byte-identical). Extracted from
 *  {@link composeCliRuntimeContext} (god-fn ratchet) — pure code motion. */
export const hydrateTrustScope = async (
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<{ registry: TrustScopeRegistry; projectKey: string } | undefined> => {
  if (!gateOn(env, "QUANTA_TRUST_SCOPE")) return undefined
  // The overlay is `<cwd>/.quanta/project-grants.json`, a file a clone can carry, and its
  // records ALLOW tools. It is read only in a trusted folder; elsewhere the user's own
  // `~/.quanta/grants.json` still applies, keyed by this project.
  const registry = createPersistentTrustScopeRegistry(
    isWorkspaceTrusted(cwd) ? { projectRoot: cwd } : {},
  )
  await registry.hydrate()
  return { registry, projectKey: cwd }
}

const wireCliAutoReview = (
  boot: SessionBootstrapResult,
  turnStream: StreamPort,
  onConfirm: (action: ToolAction) => Promise<boolean | ConfirmDecision>,
) => {
  if (ladderAutoReviewEnabled()) {
    setAutoApprovalReviewObserver({
      observe: (event) => {
        const who = event.reviewer === "guardian_subagent" ? "guardian" : "auto-review"
        const what =
          event.phase === "started"
            ? "reviewing…"
            : event.allowed
              ? "approved (no prompt)"
              : "denied"
        turnStream.emit({
          type: "tool_progress",
          id: event.toolCallId ?? "",
          name: event.tool,
          message: `auto-reviewed by ${who}: ${what}`,
        })
      },
    })
  }
  if (boot.permission.classify === undefined) return undefined
  const userPort = createOnConfirmReviewerPort({ onConfirm })
  return createClassifierBackedAutoReview({
    classify: boot.permission.classify,
    userReview: userPort.userReview,
  })
}

const loadNamedAgentResolver = async (cwd: string) => {
  const namedAgents = await loadNamedAgents(cwd).catch(() => undefined)
  return namedAgents !== undefined && namedAgents.size > 0 ? namedAgents : undefined
}

const optionalRuntimeExecution = (
  args: ComposeCliRuntimeContextArgs,
  boot: SessionBootstrapResult,
) => {
  if (args.convStore === undefined && args.responsesStore === undefined) return {}
  return {
    execution: {
      history: boot.history,
      cwd: boot.cwd,
      envSource: args.envSource ?? process.env,
      ...(args.convStore !== undefined ? { convStore: args.convStore } : {}),
      ...(args.responsesStore !== undefined ? { responsesStore: args.responsesStore } : {}),
    },
  }
}

export const composeCliRuntimeContext = async (
  args: ComposeCliRuntimeContextArgs,
): Promise<CliRuntimeContextBindings> => {
  const { boot, turnStream, loadPermissionStore, sandboxProfile } = args
  // S2 — the FIFO ask-queue channel (mid-turn approval + cross-layer publish).
  const midTurnApprovalChannel = wireAskQueue()
  const trustScope = await hydrateTrustScope(boot.cwd, args.envSource ?? process.env)
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
  const autoReview = wireCliAutoReview(boot, turnStream, onConfirm)
  // T03 — when the agent reviewer is the chosen posture, surface each auto-review
  // as a `tool_progress` notice (keyed by the reviewed tool-call id) so the CLI
  // timeline + web card show "auto-reviewed by guardian: …" rather than the tool
  // silently running. Registered ONLY under the opt-in ⇒ default-OFF byte-identical
  // (no observer ⇒ the reviewer slice's emit is a no-op). The notice is best-effort:
  // `decisionEmitterFromStream`-style throw isolation lives in the sink itself.
  const permissionStore = await loadPermissionStore()
  // SECURITY RAILS — wire the write-budget + sandbox-escalation anti-exfil rails
  // onto this overlay path (see {@link wireSecurityOverlay}). Both knobs off ⇒
  // both per-session slots undefined ⇒ byte-identical to today (default-OFF).
  const securityRails = wireSecurityOverlay({
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
  const namedAgentResolver = await loadNamedAgentResolver(boot.cwd)
  // RFC-12-2 WIRING — build the host-only mention sources for `@mcp:` / `@thread:`
  // from the CLI's already-live MCP surface + session index (see
  // {@link buildMentionOwnerSources}). `@subagent:` rides `namedAgentResolver`.
  const mentionOwnerSources = buildMentionOwnerSources(boot)
  // ticket-11 (P8 worktree) — mint the session-scoped active-worktree slot ONLY
  // when `QUANTA_WORKTREE_TOOL` is on (see {@link mintActiveWorktreeSlot} in
  // `@/agent`). Gate off ⇒ undefined ⇒ worktree tools unregistered + bash/edit
  // cwd byte-identical (default-OFF). `boot.cwd` is the SESSION-RESOLVED jail root
  // the edit-fence keeps absolute writes within — the slot NEVER widens it.
  const activeWorktreeSlot = mintActiveWorktreeSlot(args.envSource ?? process.env, boot.cwd)
  const runtimeContext = await composeRuntimeBootstrapContext({
    // Use the same per-turn assembly authority as the web daemon. Besides
    // preventing capability drift, this mints the measured BudgetMeter required
    // before a default-ON autonomous goal attempt may reserve paid work.
    turnAssembler: buildInteractiveTurnAssembler(
      {},
      (args.envSource ?? process.env) as AssemblerEnv,
    ),
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
      ...(mentionOwnerSources !== undefined ? { mentionOwnerSources } : {}),
      ...(activeWorktreeSlot !== undefined ? { activeWorktreeSlot } : {}),
      ...(trustScope !== undefined ? { trustScope } : {}), // #20 durable
      ...securityOverlaySlots(securityRails),
    }),
    ...optionalRuntimeExecution(args, boot),
    memoryAuto: {
      env: args.envSource ?? process.env,
      logWarn: (msg: string) => process.stderr.write(`[memory-auto] ${msg}\n`),
    },
  })
  // RFC-def `/undo` — the durable journal store (gated). Threaded into the HITL
  // prompt so per-hunk applies persist a CAS undo receipt, and surfaced in the
  // bindings so the `/undo` slash context reverts through the SAME store.
  const hunkUndoStore = buildHunkUndoStore(args.envSource ?? process.env)
  return {
    approvalPrompt: buildApprovalPrompt(boot, midTurnApprovalChannel, hunkUndoStore),
    midTurnApprovalChannel,
    runtimeContext,
    // UUX-4-04 — surfaced for the `/permission` inspector (same instance the
    // admissibility gate received above).
    permissionStore,
    hunkUndoStore,
  }
}

/** Build the CLI HITL approval prompt, threading the (gated) durable journal
 *  store as `mutationJournal` so per-hunk applies persist a CAS undo receipt.
 *  Extracted so `composeCliRuntimeContext` stays under the god-function ceiling.
 *  Absent store ⇒ the `mutationJournal` field is omitted (byte-identical). */
const buildApprovalPrompt = (
  boot: SessionBootstrapResult,
  channel: MidTurnApprovalChannel,
  hunkUndoStore: HunkMutationJournalStore | undefined,
): ReturnType<typeof buildCliApprovalPrompt> =>
  buildCliApprovalPrompt({
    idleMonitor: boot.idleMonitor,
    rejectCounter: boot.rejectCounter,
    channel,
    cwd: boot.cwd, // session-resolved cwd for preflight/hunk reads in the shared prompt helpers
    ...(hunkUndoStore !== undefined ? { mutationJournal: hunkUndoStore } : {}),
  })

/** Test seam — never import in production. Exposes the HITL prompt builders so
 *  the e2e suite can drive the REAL CLI confirm/approval wording + verb routing
 *  against the real gate/controller without booting a full session. */
export const __testing = {
  buildCliOnConfirm,
  buildCliApprovalPrompt,
}

export { buildAdmissibility } from "./cli-admissibility-compose"
