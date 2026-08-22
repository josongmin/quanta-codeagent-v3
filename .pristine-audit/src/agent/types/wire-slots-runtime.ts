/**
 * AgentConfig wire slots — runtime/proxy/env + shadow-ODB/checkpoint + subagent/multi-agent + observability-sink cluster (networkProxy … writeBudget).
 *
 * EXTRACTED from `src/agent/types.ts` (god-module split, fix-on-sight per
 * AGENTS.md SE-metrics). `AgentConfig` `extends` this interface so every
 * field below stays on the public `AgentConfig` surface BYTE-IDENTICALLY via
 * declaration-merging — no consumer of `@/agent/types` changes. Field shapes
 * MUST stay byte-identical to the prior inline declarations; adding/renaming a
 * field here is a CONTRACT CHANGE. All members are default-OFF when absent
 * (RFC §1.2).
 */

import type { LocalEnvSelection } from "@/runtime/local-env"
import type { NetworkProxyConfig, ProxyEnvInput } from "@/runtime/network-proxy"
import type { ShadowOdb } from "@/storage"
import type { AutoBackgroundConfig } from "../auto-background"
import type { ProgressLine } from "../branch-search"
import type { CheckpointTriggerMode, DestructivenessOracle } from "../checkpoint-policy"
import type { SessionForker } from "../fork-session"
import type { ShadowVerifyPort } from "../shadow-verify"
import type { BackgroundSubagentScheduler } from "../subagent-background"
import type { MailboxPort } from "../subagent-mailbox"
import type { TurnRegistrySnapshotRef } from "../turn-registry-snapshot"

export interface WireSlotsRuntimeConfig {
  /**
   * ADR-0428 socket-level egress proxy. When set with `enabled: true`, a
   * composition root constructs a `LoopbackEgressProxy` over this allowlist and
   * threads `withProxyEnv(baseEnv, {address})` into every child spawn so a
   * subprocess's OWN sockets are funneled through the SAME `isHostAllowed`
   * decision the tool-arg dispatch guard uses — closing the subprocess egress
   * bypass. Absent / `enabled:false` ⇒ NO proxy constructed, child env
   * byte-identical to the pre-slice path. Closed `NetworkProxyConfig` lives in
   * `@/runtime/network-proxy`; wired by the `network-proxy` knob.
   */
  networkProxy?: NetworkProxyConfig
  /**
   * ADR-0428 jun-02 wire — the LIVE, resolved proxy-env handle produced AFTER a
   * composition root (or `runAgent`) constructs + `listen()`s the
   * `LoopbackEgressProxy` from {@link networkProxy}. Carries the bound loopback
   * `address` (+ `noProxy`); `runAgent` sets it on the per-session config clone
   * so the dispatch seam can surface it on `ToolContext.proxyEnv` and the bash
   * tool injects `HTTP_PROXY`/`HTTPS_PROXY` into the child spawn. NOT operator-
   * set: `networkProxy` is the static config, this is its runtime materialization.
   * Absent ⇒ no proxy bound ⇒ child env byte-identical (legacy path).
   */
  proxyEnv?: ProxyEnvInput
  /**
   * ADR-0455 — the DECLARED local-environment selection for this session, the
   * runtime materialization of a loaded `.quanta/environment.toml`. A
   * composition root (`runAgent` / the CLI) calls `loadLocalEnvConfig(cwd, …)`
   * then `selectEnvironment(config, name?)` and sets the resulting
   * `{ vars, pathPrepend }` here; the dispatch seam surfaces it on
   * `ToolContext.localEnv` and the bash tool composes it over the scrubbed
   * child env (allowlist still governs). To SWITCH environments the operator /
   * agent re-selects a different declared name and the per-session config clone
   * carries the new selection. Absent (no config file, or no env selected) ⇒
   * child env byte-identical to the pre-slice path (default-OFF). Closed shape
   * `LocalEnvSelection` lives in `@/runtime/local-env`.
   */
  localEnv?: LocalEnvSelection
  /**
   * ADR-0116 Shadow git ODB seam (ADR-0108 keystone). When set AND
   * `branchSearch` is also wired, `buildBranchSearchTool` constructs a
   * `BranchSearchAnchor` from `shadowOdbAnchor(shadowOdb, cwd)` and threads
   * it into `runBranchSearch` so each candidate gets a quantified
   * `delta` from the parent workspace snapshot. Absent ⇒ anchor not built,
   * branch-search emits candidates with `delta` OMITTED (byte-identical to
   * pre-ADR-0116). Top-level (not nested under `branchSearch`) because
   * future consumers (review/rewind) will also read this slot.
   */
  shadowOdb?: ShadowOdb
  /**
   * ADR-0121 auto-checkpoint policy — when set AND `shadowOdb` is also wired,
   * `wireCheckpointedEffectChannel` wraps the dispatch `EffectChannel` with
   * `withAutoCheckpoint` so a configurable policy auto-anchors via
   * `ShadowOdb.registerHead` BEFORE / AFTER tool calls (Cline / Hermes /
   * Codex / Cursor patterns surfaced as a closed 3-arm enum).
   *
   * Default-OFF: absent ⇒ the wrap helper returns the inner channel
   * unchanged (byte-identical for every legacy caller). Separate from
   * `shadowOdb` so the storage port and the policy are decoupled — a
   * caller may set `shadowOdb` for `branch_search` / `shadow_rewind` /
   * `shadow_snapshots` consumers without auto-checkpointing every tool call.
   *
   * `mode` selects the policy (`"off"` | `"pre-destructive"` | `"per-mutating"`;
   *  the `"per-turn"` arm was removed in ALBB-21 as an unwired dead path);
   *  `oracle` overrides the default destructiveness oracle (which trusts
   *  `Tool.isReadOnly()`).
   */
  shadowCheckpoint?: {
    mode: CheckpointTriggerMode
    oracle?: DestructivenessOracle
    /** ADR-0203 — when set, the dispatch wrap uses THIS granular policy
     *  instance (instead of building a fresh `defaultCheckpointPolicy`) and
     *  calls `recordAnchorSha` with the `ShadowOdb.registerHead` SHA so the
     *  policy's `.registry` accumulates tag→SHA entries for `/rewind-tool`.
     *  Absent ⇒ byte-identical legacy turn-grain behaviour. */
    granularPolicy?: import("../per-tool-checkpoint").GranularCheckpointPolicy
  }
  /**
   * ADR-0400 Shadow Verify port slot (sibling of ADR-0396 wave-1 port). When
   * set, `buildShadowVerifyBlock` registers the `shadow_verify` LLM tool
   * bound to this port. Absent ⇒ tool NOT registered (default-OFF, byte-
   * identical for every legacy caller — RFC §1.2). The composition root
   * builds the port via `createShadowVerifyAdapters(cwd)` +
   * `createShadowVerify(deps)` (real worktree + V4A + LSP/test adapters);
   * tests may inject a fake port directly.
   */
  shadowVerify?: ShadowVerifyPort
  /**
   * ADR-0140 background-subagent caller wire (sibling to ADR-0130 helper).
   * When set, `buildSubagentBgBlock` registers the 3 `subagent_fork` /
   * `subagent_poll` / `subagent_await` tools bound to this scheduler.
   * Absent ⇒ tools NOT registered (default-OFF, byte-identical for every
   * legacy caller — RFC §1.2). Top-level (not nested under `subagent`)
   * because the background scheduler is INTENT-DISTINCT from the legacy
   * sequential subagent runner (ADR-0011): a caller may wire one without
   * the other.
   */
  subagentBackground?: { readonly scheduler: BackgroundSubagentScheduler }
  /**
   * ADR-0416 managed-subagent mailbox (Codex `multi_agents_v2.send_message`).
   * When set, `buildSubagentMailboxBlock` registers the `subagent_send_message`
   * tool bound to this port so agents can exchange messages (parent↔child,
   * sibling↔sibling, broadcast) WITHOUT teardown. Absent ⇒ tool NOT registered
   * (default-OFF, byte-identical for every legacy caller — RFC §1.2).
   */
  subagentMailbox?: MailboxPort
  /**
   * Peer teammate messaging (RFC jun-6, DELTA #2) — host-owned team registry.
   * When set, the composition root wraps {@link subagentMailbox} with the
   * team-scope decorator (cross-team `send` denied + broadcast scoped to the
   * sender's own team), the subagent runner registers each spawned child into
   * it (so siblings share a team bus), and `buildTeamBlock` registers the
   * `team_create`/`team_delete` lifecycle tools over it. Absent ⇒ no team
   * boundary (the raw global mailbox), `team_*` tools NOT registered
   * (default-OFF, byte-identical). Wired only when `QUANTA_TEAM_PEER_MSG` is on.
   * Duck-typed (structural mirror of `TeamRegistryPort` in
   * `@/subagent/team/registry`) so `@/agent` core stays slice-isolated from the
   * `@/subagent` leaf.
   */
  teamRegistry?: import("../../subagent").TeamRegistryPort
  /**
   * RFC-04 / ADR-0437 — host-owned `TurnWakeRegistry`. The subagent runner
   * registers a per-child waker into THIS instance when a child loop starts;
   * `followup_task` calls `wake(agentId)` to trigger the child's turn. Absent ⇒
   * `followup_task` has no trigger substrate and is NOT registered (default-OFF).
   * Sharing one instance across the runner (writer) and the introspect tools
   * (reader) is what makes the trigger live.
   */
  subagentTurnWake?: import("../../subagent").TurnWakeRegistry
  /**
   * RFC-04 §11 / ADR-0437 follow-up — per-CHILD turn gate. The subagent runner
   * mints ONE gate per forked child loop, threads it onto the CHILD config
   * here, and registers a {@link import("../../subagent").Waker} (bridged to this
   * gate) into the shared {@link subagentTurnWake} so `followup_task`'s
   * `wake(childId)` finds a live receiver. The child loop PARKS on the gate at
   * its clean-completion point so a wake can trigger another turn (idle→`woke`)
   * or a pending wake runs the next turn (busy→`queued`). The ROOT session
   * NEVER carries one (root is not in the registry / never a followup_task
   * target); absent ⇒ the loop finishes immediately on completion
   * (byte-identical default-OFF, RFC §1.2).
   */
  subagentTurnGate?: import("../../subagent").SubagentTurnGate
  /**
   * RFC-04 / ADR-0437 — host-owned `AgentMetaRegistry` side-table. `spawn_agent`
   * (when wired) records `{depth,label}` here; `list_agents` joins it for
   * richer rows. Absent ⇒ `list_agents` falls back to `depth=0` + a
   * description-derived label (byte-identical spawn path; the side-table is
   * purely additive). OPTIONAL even when introspect is enabled.
   */
  subagentAgentMeta?: import("../../subagent").AgentMetaRegistry
  /**
   * ADR-0416 sibling-identity fix (audit H) — STABLE per-agent mailbox label
   * for THIS agent. The subagent runner mints a DETERMINISTIC child id
   * (`parentLabel/seq` — a replay-friendly ordinal counter, never a random
   * uuid / clock) and threads it here onto the forked child config; the
   * dispatch seam surfaces it onto `ToolContext.agentLabel` so the
   * subagent-mailbox tools address each sibling UNIQUELY instead of collapsing
   * every same-depth sibling onto a single `agent@depth-N` label. Absent ⇒ the
   * tools fall back to the depth-derived label (byte-identical for the root
   * session and every legacy caller). The root session leaves this UNSET; only
   * forked children carry it.
   */
  mailboxAgentId?: string
  /**
   * ADR-0416 sibling-identity fix (audit H) — the STABLE mailbox label of the
   * agent that spawned THIS one. Surfaced onto `ToolContext.parentAgentLabel`
   * so `subagent_send_message`'s `"parent"` target resolves to the EXACT parent
   * that forked this child (even when siblings share a depth) rather than depth
   * arithmetic. The runner sets this to the parent's `mailboxAgentId` (or
   * `"root"` for a depth-1 child of the root session). Absent ⇒ `"parent"`
   * falls back to depth math (byte-identical legacy).
   */
  mailboxParentId?: string
  /**
   * ADR-0437 follow-up (BUG#4 self-target guard) — THIS child's own registry
   * task id (`req.taskId`). Threaded so `followup_task` can reject a child
   * targeting its OWN loop (`input.agentId === subagentTaskId ⇒ self_target`):
   * the introspect block wires it as `ownAgentId`. Distinct from
   * `mailboxAgentId` (the disjoint mailbox-label namespace, `root/N`). The root
   * session and any non-spawned agent leave this UNSET ⇒ no self-target guard
   * (byte-identical; root is never a `followup_task` target anyway).
   */
  subagentTaskId?: string
  /**
   * ADR-0223 auto-background after 2 s — Claude Code UX absorption. When set,
   * dispatch wraps each tool `execute()` with two-line `tickToolStart` /
   * `tickToolEnd` calls into `autoBackground.detector` so a host poll can ask
   * "is this call past the threshold?" and (via `autoBackground.proposer`)
   * surface a one-shot "move to background?" prompt. Pair with
   * {@link subagentBackground} so the prompt's "yes" path actually has a
   * detached scheduler to fork into — this slot is the OBSERVER; that slot
   * is the EXECUTOR.
   *
   * Default-OFF byte-identical (RFC §1.2): when this slot OR its
   * `detector` field is absent, the two-line wiring in dispatch.ts becomes
   * an optional-chain no-op (zero allocation, zero behaviour delta). The
   * proposer is independently optional — a host may wire only the detector
   * (and render its own status-bar nudge from `isStuck`) without paying for
   * the once-per-id Map in the proposer.
   */
  autoBackground?: AutoBackgroundConfig
  /**
   * ADR-0201 fork-session slot. When set, `buildForkSessionBlock` registers
   * the `fork_session` tool wired to this forker. Absent ⇒ tool NOT registered
   * (default-OFF, byte-identical for every legacy caller — RFC §1.2). Distinct
   * from `conversationCheckpoint` so a caller may wire the store for record/
   * restore consumers WITHOUT also exposing the fork tool (the forker
   * constructs over the same store but layers lineage + UUID minting).
   */
  fork?: { readonly forker: SessionForker }
  /**
   * ADR-0125 turn-diff loop wiring — opt-in trigger for the
   * {@link wireGitObservability} composite (ADR-0110). When `enabled === true`
   * the loop constructs a per-session `TurnDiffSession` (via
   * `wireGitObservability({runner: defaultGitRunner, cwd, signal})`) and
   * calls `startTurn(turnIndex)` just before each turn's body, then
   * `endTurn(turnIndex)` after the turn span closes — emitting any returned
   * `turn_diff_updated` AgentEvent onto the loop's stream.
   *
   * Default-OFF: absent or `enabled !== true` ⇒ the loop allocates no
   * session, performs no `startTurn`/`endTurn` calls, and is byte-identical
   * to the pre-wire path (RFC §1.2). Explicit opt-in (not auto-enabled when
   * `shadowOdb` is wired) so a caller that wires the storage port for
   * `branch_search` / rewind consumers does NOT pay the per-turn `git
   * rev-parse` + `git diff` cost without asking.
   *
   * `session` (test-injection seam): when supplied, the loop uses this
   * caller-built `TurnDiffSession` verbatim instead of constructing one from
   * `defaultGitRunner`. Mirrors the `dedupGate`/`capEnforcer` patterns —
   * production code never sets it; tests inject a fake-runner-backed
   * session to assert wiring without spawning `git`.
   */
  gitObservability?: { enabled: boolean; session?: import("../git-observability").TurnDiffSession }
  /**
   * ADR-0117 progress surface — when set, `branch-search-runner` wraps the
   * tool's `onTrace` with a side-effecting adapter that calls this callback
   * with a `formatBranchTrace`'d `ProgressLine` per event. Absent ⇒ the
   * adapter is not installed, byte-identical to pre-ADR-0117 behaviour.
   * Best-effort: a throwing callback never crashes the search (the adapter
   * try/catches around it, matching the OTel sink contract).
   */
  onProgress?: (line: ProgressLine) => void
  /**
   * Track D (runtime → REPL context wire) — per-turn prompt-assembly observer.
   * When set, the loop calls this ONCE per turn, immediately after
   * `buildTurnContext` assembles the system prompt, with a
   * {@link import("../context/usage-breakdown").PromptAssembledSnapshot} carrying
   * the assembled `SystemBlock[]` + the turn's `promptPolicy` presence flags +
   * the active model id. The REPL surface retains the latest snapshot so the
   * `/context` slash can render a live segmented context-window breakdown
   * (computed with the loop's OWN `estimateTokens` — no second heuristic).
   *
   * Absent ⇒ the loop performs NO capture (no snapshot constructed, no call),
   * so the assembly path is byte-identical for every non-REPL caller (RFC §1.2).
   * Best-effort/observation-only: a throwing callback NEVER crashes the turn
   * (the call site try/catches, matching the OTel-sink + `onProgress` contract).
   */
  onPromptAssembled?: (
    snapshot: import("../context/usage-breakdown").PromptAssembledSnapshot,
  ) => void
  /**
   * OPTIONAL working-state snapshot publisher. Fired ONCE at session start
   * (right after {@link buildSessionFeatures}) with a getter over the live
   * session-scoped {@link import("../working-state").WorkingState} — or a getter
   * that returns `undefined` when `workingState.enabled !== true`. The surface
   * (`/state`) retains the getter to render the current posture/blockers panel.
   * Absent ⇒ no publish (byte-identical). Pure observation; never throws into
   * the loop (the call site try/catches).
   */
  onWorkingStateReady?: (
    getSnapshot: () => import("../working-state").WorkingState | undefined,
  ) => void
  /**
   * ADR-0512 P3 — OPTIONAL skill tool-scope publisher. Fired ONCE at session
   * start (alongside {@link onWorkingStateReady}) with a getter over the live
   * {@link import("../loop/skill-scope-view").SkillScopeView} — the active skill +
   * the L1 availability filter's visible/hidden partition. The getter re-reads
   * the live `skillGate` each call so `/state` reflects the CURRENT scope (a
   * mid-turn `Skill` call may have armed it). The surface (`/state`) retains it
   * to render "왜 이 도구가 없지?". Fired ONLY when `runtimeConfig().skillScopeV2`
   * is on; absent / OFF ⇒ no publish (byte-identical). Pure observation; never
   * throws into the loop (the call site try/catches).
   */
  onSkillScopeReady?: (
    getView: () => import("../loop/skill-scope-view").SkillScopeView | undefined,
  ) => void
  /**
   * OPTIONAL per-turn stream-input capture sink. Fired right before each
   * provider stream call with the EXACT {@link import("@/llm").StreamInput}
   * used for that turn (messages / system / tools / thinking / toolChoice).
   * The surface (`/retry-with`) retains the latest so it can re-stream the
   * last turn against an alternate model. Absent ⇒ no capture (byte-identical,
   * no allocation). Pure observation; the call site try/catches.
   */
  onTurnStreamInput?: (input: import("@/llm").StreamInput) => void
  /**
   * ADR-0440 wire-finish — OPTIONAL tool-diff capture sink. When set, the
   * dispatch seam surfaces it (plus the dispatched `ToolUseBlock.id`) onto the
   * {@link import("@/tool").ToolContext} so a file-mutating tool (`write`/`edit`)
   * hands its pre/post file text to the sink after a SUCCESSFUL mutation. The
   * web-daemon composition root adapts its canvas emitter's `feedToolDiff` into
   * this port ONLY when `QUANTA_WEB_CANVAS=1`; the sink converts the
   * before/after into a `tool.diff` canvas frame (the line-diff math runs ONCE
   * inside the daemon, NEVER recomputed agent-side).
   *
   * Absent ⇒ the dispatch seam omits the ctx fields, NO tool captures anything,
   * and the path is byte-identical for every non-canvas caller (RFC §1.2,
   * default-OFF). Duck-typed (structural mirror of `@/tool`'s `ToolDiffSink`) so
   * neither slice imports the other's `@/apps/*` surface — the composition root
   * is the only place that bridges the daemon emitter to this port. Best-effort:
   * the sink is no-throw by contract and the tool-side helper additionally
   * try/catches, so a misbehaving sink can never crash a turn.
   */
  onToolDiff?: import("@/tool").ToolDiffSink
  /**
   * QUANTA_WEB_AGENT_STATE — OPTIONAL agent-state capture sink. When set, the
   * out-of-band stream tap (`wireAgentStateTap`, optional-ports.ts) wraps
   * `config.stream.emit` so each of the 9 agent-state events
   * (`plan_*` / `mode_changed` / `tool_progress` / `context_compacted` /
   * `ratelimit_snapshot`) is ALSO handed to this sink AFTER the base stream
   * emits it verbatim. The web-daemon composition root adapts its per-connection
   * WS forwarder onto this port ONLY when `QUANTA_WEB_AGENT_STATE=1`; the sink
   * maps the event → an `AgentStateMessage` and `ws.send`s the encoded frame so
   * the web/Tauri surface renders plan / mode / progress state the in-band
   * session protocol currently DROPS.
   *
   * Absent ⇒ the tap is NEVER installed (the stream is returned verbatim), NO
   * event is captured, and the path is byte-identical for every non-web caller
   * (default-OFF). Duck-typed (structural mirror of `@/protocol/agent-state`'s
   * `AgentStateSink`) so neither slice imports the other's `@/apps/*` surface —
   * the composition root is the only place that bridges the daemon forwarder to
   * this port. Best-effort: the sink is no-throw by contract and the tap
   * additionally guards, so a misbehaving sink can never crash a turn.
   */
  onAgentState?: import("@/protocol/agent-state").AgentStateSink
  /**
   * Multi-agent orchestration SUBSTRATE — OPTIONAL subagent lifecycle capture
   * sink (PARALLEL to {@link onAgentState}). When set, the subagent runner
   * installs it as the shared `TaskRegistry`'s emit sink so every spawn/settle
   * TRANSITION (`register()` ⇒ `subagent_spawn`; `complete()`/`fail()`/`stop()`
   * ⇒ `subagent_status`) is projected to a {@link
   * import("@/protocol/subagent").SubagentObservation} and handed here. BOTH the
   * CLI `/agents --tree` and the web Sub-Agents panel (later waves) tap this via
   * the `@/protocol/subagent` seam. The `description` / `finalTextPreview` /
   * `error` fields are bounded + secret-scrubbed at the registry emit boundary
   * (this data crosses to a UI).
   *
   * Absent ⇒ the runner never installs the registry emitter, NO event is
   * captured, and the path is byte-identical for every non-panel caller
   * (default-OFF, RFC §1.2). The `TaskRecord` still gains its cheap lineage
   * fields (`parentTaskId` / `depth` / `mailboxLabel`) regardless — those are a
   * pure data addition, not a behaviour change. Duck-typed via the
   * `@/protocol/subagent` `SubagentObservation` so neither slice imports the
   * other's `@/apps/*` surface. Best-effort: the sink is no-throw by contract
   * and the registry additionally guards each emit, so a misbehaving forwarder
   * can never crash a spawn/settle transition.
   */
  onSubagentEvent?: (event: import("@/protocol/subagent").SubagentObservation) => void
  /**
   * Multi-agent-panel SUBSTRATE (lineage thread) — the registry TASK ID under
   * which THIS agent config was registered when it was itself spawned as a
   * child. The subagent runner threads it onto a forked CHILD config so that
   * when the child spawns a GRANDCHILD, the runner can stamp the grandchild's
   * `TaskRecord.parentTaskId = spawnedAsTaskId` — forming a real parent→child
   * TREE in `registry.list()` instead of a flat list. The ROOT session leaves
   * this UNSET ⇒ its direct children get `parentTaskId: undefined` (root-level).
   * Distinct from {@link subagentTaskId} (which is the SAME id but scoped to the
   * `followup_task` self-target guard — kept separate so the two consumers can
   * evolve independently). Absent ⇒ the spawned task is root-level
   * (byte-identical legacy path).
   */
  spawnedAsTaskId?: string
  /**
   * H6 (jun-3-misc §3) — OPTIONAL passive-VCS event sink. When set, the dispatch
   * seam surfaces it onto {@link import("@/tool").ToolContext}'s `vcsEventSink`
   * so the `bash` tool's post-exec hook (`maybeEmitPassiveVcs`) — gated by
   * `QUANTA_PASSIVE_VCS` — can forward a classified `VcsEvent` (raw git/gh stdout
   * → structured commit/push/branch/pr facets) to it. The composition root
   * (`agent-config-assembler#maybeWireVcsEventSink`) wires a sink that ADAPTS the
   * event onto the EXISTING `AgentEvent` stream (a `recovery` event tagged
   * `reason:"vcs_event"` carrying the serialized facets) — it does NOT invent a
   * second bus. ONLY wired when the knob is on; the loop/replay never depends on
   * it.
   *
   * Absent ⇒ the dispatch seam omits the ctx field, the hook resolves its noop,
   * and the bash post-exec path is byte-identical for every legacy caller (RFC
   * §1.2, default-OFF). Typed as the producer `PassiveVcsEventSink` (the `@/agent`
   * slice already imports `@/git/directive-emit`, so reaching the sibling
   * `@/git/passive-classify` is in-fence); the dispatch seam threads it through
   * the `@/tool` structural `VcsEventSink` mirror so `@/tool` stays a leaf.
   * Best-effort: the sink is no-throw by contract and the hook additionally
   * try/catches, so a misbehaving sink can never crash a turn.
   */
  vcsEventSink?: import("@/git/passive-classify").PassiveVcsEventSink
  /**
   * C2 (jun-4-communicate-update.md) — OPTIONAL structured-progress sink. When
   * set, the dispatch seam surfaces it onto {@link import("@/tool").ToolContext}'s
   * `progressSink` so the `communicate_update` tool can forward its typed
   * `{current_step, final_summary?, completed_subtitle?}` payload to it. The
   * composition root wires a sink that ADAPTS the mirror onto the EXISTING
   * `AgentEvent` stream as a render-only `progress_update` event — it does NOT
   * invent a second bus, and the loop never inspects the event (no control
   * authority).
   *
   * Absent ⇒ the dispatch seam omits the ctx field, the tool's `?.emit` is a
   * no-op, and the run is byte-identical for every legacy caller (RFC §1.2,
   * default-OFF). Typed via the `@/tool` structural {@link import("@/tool").ProgressSink}
   * mirror so `@/tool` stays a leaf (same discipline as `vcsEventSink` /
   * `onToolDiff`). Best-effort: the sink is no-throw by contract.
   */
  progressSink?: import("@/tool").ProgressSink
  /**
   * file_history_rewind — OPTIONAL per-file snapshot capture sink. When set, the
   * dispatch seam surfaces it onto {@link import("@/tool").ToolContext}'s
   * `fileHistory` so the `write`/`edit` tools record each new file version into
   * the session history store the `file_history_rewind` tool reads. The
   * composition root mints ONE bounded store per session (when
   * `QUANTA_FILE_HISTORY` is on) and wires BOTH this sink AND
   * `DefaultToolPorts.fileHistory` (the tool's read side) over the SAME store.
   *
   * Absent ⇒ the dispatch seam omits the ctx field, `captureFileHistory` is a
   * no-op, and the run is byte-identical for every legacy caller (RFC §1.2,
   * default-OFF). Typed via the `@/tool` structural
   * {@link import("@/tool").FileHistorySink} mirror so `@/tool` stays a leaf
   * (same discipline as `progressSink` / `vcsEventSink`). Best-effort: the sink
   * is no-throw by contract.
   */
  fileHistory?: import("@/tool").FileHistorySink
  /**
   * code-mode (RFC jun-6-code-mode, Phase 1) — OPTIONAL per-cell dispatch-port
   * FACTORY. When set (the composition root wires it ONLY when `QUANTA_CODE_MODE`
   * is on), the dispatch seam calls `codeCellDispatchFactory(callId)` for a
   * `code_cell` dispatch and surfaces the resulting port on
   * `ToolContext.codeCellDispatch`. The factory (`@/agent/codemode-wire.ts`)
   * closes over the loop's LIVE `config`/`permission`/`autoClassifier` and routes
   * every in-cell tool call through the REAL `dispatchTool` — so a cell is N
   * ordinary gated tool calls (structural no-bypass, §6.1). It is a FACTORY (not
   * a port) so each cell gets a fresh deterministic call-id sequence keyed off the
   * `code_cell` tool-call id. Absent (gate OFF / non-wiring host) ⇒ the dispatch
   * seam omits the ctx field and the `code_cell` tool is not registered
   * (byte-identical default-OFF). Typed via the `@/tool` structural
   * {@link import("@/tool").CodeCellDispatchSeam} mirror so `@/tool` stays a leaf. */
  codeCellDispatchFactory?: (callId: string) => import("@/tool").CodeCellDispatchSeam
  /**
   * code-mode (RFC jun-6-code-mode, Phase 2 — FULL tool surface). When set
   * (the composition root wires it ONLY when `QUANTA_CODE_MODE` is on, alongside
   * {@link codeCellDispatchFactory}), the dispatch seam surfaces the result on
   * `ToolContext.codeCellSurface` so the `code_cell` cell binds `tools.<name>`
   * for EVERY tool the agent has. It is a THUNK (`() => readonly string[]`) so it
   * reads the LIVE `registry.toolNames()` at cell-dispatch time — a tool
   * registered after assembly appears automatically, and a tool the agent lacks
   * is never in the list (unbound in the cell). Each bound `tools.<name>` STILL
   * re-enters the REAL `dispatchTool` via the port (the structural no-bypass
   * invariant is UNCHANGED; this only widens which NAMES are exposed). Absent
   * (gate OFF / non-wiring host) ⇒ the seam omits the ctx field and `@/codemode`
   * falls back to the Phase-1 3-tool surface (`read`/`grep`/`write`) —
   * byte-identical default-OFF. */
  codeCellSurfaceTools?: () => readonly string[]
  /**
   * jun-6 exfil-rail (a) — OPTIONAL per-turn write/edit budget. When set, the
   * dispatch seam binds the CURRENT turn ordinal (`run?.turn ?? 0`) and surfaces
   * a turn-bound {@link import("@/tool").WriteBudgetPort} onto `ToolContext` so
   * the `write`/`edit` tools tally each mutation against the per-turn counter and
   * deny once the configured cap is exceeded IN AN UNTRUSTED-INPUT TURN. The
   * composition root mints ONE session-long `SessionWriteBudget` (when
   * `QUANTA_WRITE_BUDGET=1` AND `QUANTA_WRITE_BUDGET_MAX` is set) with
   * `untrustedContext` resolved from the untrusted-envelope gate
   * (`QUANTA_UNTRUSTED_ENVELOPE`); the counter resets per turn because dispatch
   * re-binds the current turn. Absent (knob off / no cap / non-wiring host) ⇒ the
   * dispatch seam omits the ctx field and the mutating path is byte-identical
   * (default-OFF). Duck-typed via the `@/tool/_shared/write-budget`
   * `SessionWriteBudget` so `@/tool` stays a leaf. */
  writeBudget?: import("@/tool/_shared/write-budget").SessionWriteBudget
  /**
   * RFC04-2/3 (MCP tool hot-reload) — OPTIONAL atomically-swappable capability
   * snapshot pointer. When present, `session-bootstrap` reads
   * `registrySnapshotRef.current()` at the turn boundary INSTEAD of building a
   * fresh snapshot from `registry` — so a reload the host published between
   * turns (via the {@link import("./turn-registry-snapshot").TurnRegistrySnapshotRef}'s
   * hidden `publish` handle, held ONLY by the host reload controller) is picked
   * up at the NEXT turn. The pinned generation is read ONCE per turn boundary
   * (no mid-turn re-query); a turn that already pinned `current()` keeps its
   * generation across a publish.
   *
   * The ref is SEEDED from the SAME `registry` (via `buildTurnRegistrySnapshot`)
   * so the FIRST turn's snapshot is byte-identical to the no-ref path. Absent
   * (default / `QUANTA_MCP_HOT_RELOAD` off / no MCP servers) ⇒ session-bootstrap
   * falls back to `buildTurnRegistrySnapshot(registry)` exactly as today ⇒ no
   * controller, no observer sink, no ref, byte-identical. `registry` stays the
   * required dispatch authority; this slot never replaces it.
   */
  registrySnapshotRef?: TurnRegistrySnapshotRef
}
