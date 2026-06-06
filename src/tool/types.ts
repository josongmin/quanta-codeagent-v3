import type { z } from "zod"
import type { DocumentBlock, ImageBlock } from "@/llm"
import type { SensitivityClass } from "@/security"
import type { HITLTier } from "@/shared"
import type { ShellExecObserver } from "./shell-exec-types"
import type { ReadFileState } from "./stale-read-guard"

/**
 * Execution context handed to every `Tool.execute(input, ctx)` call.
 *
 * The mandatory pair (`cwd`, `signal`) is the runtime contract every tool can
 * rely on. EVERY OTHER FIELD is an OPTIONAL, DUCK-TYPED SEAM through which the
 * agent slice (or another slice) injects a service into the tool slice WITHOUT
 * `@/tool` importing the providing slice — this is the slice-isolation
 * discipline `biome` enforces structurally (see RFC 3.1). A future reviewer
 * MUST preserve the duck-typing direction: types here may MIRROR a producer
 * structurally, but `@/tool` must NEVER `import type` from `@/agent`,
 * `@/permission`, `@/subagent`, `@/llm`, etc.
 *
 * SEAM REGISTRY (keep in sync when a seam is added/renamed/removed):
 *
 *   - `depth?`              ADR-0011 subagent slice. Provider: dispatch seam
 *                           from `AgentConfig.depth` (composition root in
 *                           `@/agent/agent-loop`). Consumer: `@/subagent`
 *                           depth gate. Absent ⇒ treated as 0.
 *
 *   - `agentLabel?` /       ADR-0416 sibling-identity fix. Provider: dispatch
 *     `parentAgentLabel?`   seam from `AgentConfig.mailboxAgentId` /
 *                           `mailboxParentId` (the subagent runner mints a
 *                           deterministic `parentLabel/seq` child id). Consumer:
 *                           the subagent-mailbox tools' `senderId` /
 *                           `resolveTarget`. Absent ⇒ depth-derived fallback
 *                           (byte-identical legacy).
 *
 *   - `workingState?`       Codex memory L3 absorption. Provider: agent loop
 *                           when `AgentConfig.workingState` is set (composition
 *                           root in `@/agent/working-state`). Consumer: the
 *                           `update_working_state` meta-tool. Mirror type:
 *                           `WorkingStateHandle` (declared below).
 *                           Absent ⇒ working-state feature is OFF.
 *
 *   - `onShellEvent?`       PR-5 / ADR-0081 shell event mirror. Provider:
 *                           dispatch seam wired from agent transport
 *                           (`@/agent/shell-event-bus`). Consumer: shell-class
 *                           tools (`bash` today). Typed via the CLOSED
 *                           `ShellExecObserver` union — adding a variant is a
 *                           compile error at every exhaustive switch.
 *                           Absent ⇒ no events, byte-identical buffered path.
 *
 *   - `requestPlanExit?`    ADR-0086 plan-exit. Provider: dispatch seam built
 *                           from `AgentConfig.planExitPort` (composition root
 *                           in `@/agent/plan-exit`), wrapping `runPlanExitFlow`.
 *                           Consumer: the `request_plan_exit` tool.
 *                           Absent ⇒ tool is not registered.
 *
 *   - `requestUserInput?`   ADR-0095 (draft) operator-input. Provider: dispatch
 *                           seam built from `AgentConfig.userInputPort` (P5/P6).
 *                           Consumer: the `request_user_input` tool. Returns a
 *                           CLOSED 2-arm {@link UserInputOutcome}
 *                           (`answer` | `cancelled`); extending to a 3rd arm
 *                           requires an ADR amendment + a compile-error update
 *                           at every exhaustive switch. Absent ⇒ tool yields a
 *                           graceful `ok:false` (mode `error`); the loop is
 *                           byte-identical.
 *
 *   - `gitWriteGuard?`      ADR-0091 git-write protection. Provider: dispatch
 *                           seam wired from `@/permission/git-write-guard`
 *                           (`gitWriteProtectReason`). Consumer: `write` /
 *                           `edit` tools, called BEFORE touching the FS.
 *                           Absent ⇒ no git-write guard (legacy path).
 *
 *   - `reviewerAgent?`      ADR-0111 git_review_diff isolated reviewer.
 *                           Provider: dispatch seam wired from the subagent
 *                           slice (`@/subagent`)'s `SubagentRunner` — the same
 *                           host port the `agent` tool uses, BUT pre-pinned to
 *                           a `taskKind:"review"` / read-only `toolFilter`
 *                           posture by the consumer (the `git_review_diff`
 *                           tool). Duck-typed `ReviewerRunner` mirror so
 *                           `@/tool` never imports `@/subagent` (RFC §3.1).
 *                           Absent ⇒ `git_review_diff` yields a deterministic
 *                           `ok:false` (reviewer port not attached); the loop
 *                           remains byte-identical for callers that did not
 *                           opt into the seam.
 *
 * Adding a new seam: append a paragraph here, define the mirror type below the
 * interface, and wire it from the agent-side composition root — never from a
 * `@/tool` file.
 *
 * STRUCTURAL EQUIVALENCE WITH THE PRODUCER. Closed-union mirrors here
 * (`GitWriteProtectReason`, `BlockerSurface`) cannot be checked by a
 * cross-slice `satisfies` clause inside this file — `@/tool` may NOT import
 * from `@/agent` or `@/permission` (RFC §3.1; biome enforces). Equivalence is
 * therefore CONVENTION + TWO BACKSTOPS:
 *   1. The literal-anchor tuples at the bottom of THIS file (`*_MIRROR`) pin
 *      the in-slice mirror to a constant set — drift between the mirror and
 *      the anchor is a `tsc` error here.
 *   2. A consumer-side round-trip test in `tests/unit/` (which CAN see both
 *      slices) asserts the anchor matches the producer's `ALL_*` array — drift
 *      between the producer and the mirror is a TEST failure there.
 * The earlier doc claim that this file held a real cross-slice compile-time
 * assertion was incorrect; it has been removed.
 */
export interface ToolContext {
  cwd: string
  signal: AbortSignal
  /** Subagent recursion depth of the agent that owns this call (0 = root).
   *  Optional + duck-typed: the subagent slice reads it to enforce maxDepth;
   *  absent ⇒ treated as 0. Propagated by the dispatch seam from
   *  `AgentConfig.depth` (subagent absorption, ADR-0011). */
  depth?: number
  /** ADR-0416 sibling-identity fix — STABLE per-agent mailbox identity. The
   *  subagent-mailbox tools (`subagent_send_message` / `subagent_read_messages`)
   *  prefer this label over the depth-derived one when computing the caller's
   *  sender / inbox id. Depth ALONE collapses every sibling forked at the same
   *  depth onto a single label (`agent@depth-N`), so a parent's DIRECT message
   *  to one sibling could be consumed by another. The subagent runner mints a
   *  DETERMINISTIC id (`parentLabel/seq` — replay-friendly ordinal, not a uuid)
   *  and the dispatch seam surfaces it here from `AgentConfig.mailboxAgentId`.
   *  Absent ⇒ the tools fall back to the depth-derived label (byte-identical
   *  for every legacy caller that sets only `ctx.depth`). Duck-typed so `@/tool`
   *  never imports `@/agent`. */
  agentLabel?: string
  /** ADR-0416 sibling-identity fix — the STABLE mailbox identity of the agent
   *  that spawned this one. `subagent_send_message` resolves the literal target
   *  `"parent"` to THIS label when present (instead of depth arithmetic), so a
   *  child addresses the EXACT parent that forked it even when siblings share a
   *  depth. Surfaced by the dispatch seam from `AgentConfig.mailboxParentId`.
   *  Absent ⇒ `"parent"` falls back to the depth-derived parent label
   *  (byte-identical legacy). Duck-typed so `@/tool` never imports `@/agent`. */
  parentAgentLabel?: string
  /** Session-scoped WorkingState handle (Codex memory L3 absorption). Optional
   *  and duck-typed so the `@/tool` slice never imports `@/agent`: the agent
   *  loop builds the concrete instance when `AgentConfig.workingState` is set,
   *  and the `update_working_state` meta-tool mutates it through this seam.
   *  Absent ⇒ working-state feature is OFF (byte-identical for all callers). */
  workingState?: WorkingStateHandle
  /** PR-5 / ADR-0081 — OPTIONAL observer for the closed `ShellExecEvent` union
   *  emitted by shell-class tools (bash today; any future sibling shell tool
   *  via the same seam). The bash tool forwards this directly to `runShell`
   *  through `ShellOptions.onShellEvent`; absent ⇒ no events emitted, exact
   *  byte-identical buffered behavior preserved (legacy path). Typed via
   *  `ShellExecObserver` so a new variant on the union is a compile error at
   *  every consumer that exhaustively switches on `event.kind`. */
  onShellEvent?: ShellExecObserver
  /** ADR-0086 — OPTIONAL plan-exit requester. The `request_plan_exit` tool
   *  calls this to surface a finished plan to whoever decides (CLI prompt /
   *  IDE modal / RPC) and get back the 3-way {@link PlanExitToolOutcome}.
   *  Duck-typed so `@/tool` never imports `@/agent`: the dispatch seam builds
   *  the concrete requester from `AgentConfig.planExitPort` (wrapping
   *  `runPlanExitFlow`). Absent ⇒ the tool is not registered. */
  requestPlanExit?: PlanExitRequester
  /** ADR-0095 (draft) — OPTIONAL operator-input requester. The
   *  `request_user_input` tool calls this to ask the operator a question and
   *  block on a typed {@link UserInputOutcome}: either `answer` (carrying the
   *  operator's reply text) or `cancelled`. The 2-arm union is CLOSED — adding
   *  a 3rd arm requires an ADR amendment + a compile-error update at every
   *  exhaustive switch. Duck-typed so `@/tool` never imports `@/agent`: the
   *  dispatch seam (P5/P6) wires the concrete requester from
   *  `AgentConfig.userInputPort`. Absent ⇒ the tool yields a graceful
   *  `ok:false` (mode `error`); the loop is byte-identical. */
  requestUserInput?: UserInputRequester
  /** ADR-0091 — OPTIONAL git-write-protection detector. The `write`/`edit`
   *  tools call this with their resolved target path BEFORE touching the
   *  filesystem; a non-null return is a static escape-vector deny (`.git/hooks`,
   *  `.git/config`, `.git/config.worktree`, `.git/info/attributes`, `.vscode/`)
   *  and the tool yields an `ok:false` ToolResult with a typed
   *  `permission_denied` failure. Duck-typed so `@/tool` never imports
   *  `@/permission` (slice isolation, RFC 3.1): the dispatch seam wires the
   *  concrete `gitWriteProtectReason` from `@/permission/git-write-guard`. The
   *  returned string is the opaque reason tag surfaced to the model. Absent ⇒
   *  no git-write guard (byte-identical legacy path). */
  gitWriteGuard?: GitWriteGuard
  /** ADR-0111 — OPTIONAL isolated-reviewer port. The `git_review_diff` tool
   *  calls this with a pre-built review prompt (REVIEW notice + diff text +
   *  caller's focus hint) plus the child's `depth`, `taskKind:"review"`, and
   *  a read-only `toolFilter`. The seam is duck-typed (structural mirror of
   *  the subagent slice's `SubagentRunner`) so `@/tool` never imports
   *  `@/subagent` (slice fence, RFC §3.1). The dispatch seam (composition
   *  root in `@/agent`) is the only place that knows how to wire the
   *  concrete `SubagentRunner` here. Absent ⇒ the tool yields an `ok:false`
   *  with a typed `reviewer_not_attached` message; the loop is byte-
   *  identical for sessions that did not opt in. */
  reviewerAgent?: ReviewerRunner
  /** ADR-0093 (draft) — OPTIONAL plan-state mutator. The 4 plan tools
   *  (`create_plan` / `update_todos` / `update_plan` / `remove_todos`) route
   *  every mutation through this duck-typed handle. Duck-typed so `@/tool`
   *  never imports `@/agent/plan` (slice isolation, RFC 3.1): the dispatch
   *  seam adapts `AgentConfig.planStore` into a {@link PlanMutator}.
   *  Structural mirror of canonical `PlanStore` — every error-code and
   *  delta-kind is a string literal matching the producer's
   *  `PlanMutationError["kind"]` / `PlanDeltaKind`. Absent ⇒ the 4 plan
   *  tools are NOT registered (default-OFF byte-identical for every
   *  existing session). */
  planMutator?: PlanMutator
  /** ADR-0121 — OPTIONAL turn correlation id for the auto-checkpoint policy.
   *  The CheckpointPolicy (`@/agent/checkpoint-policy`) reads this to dedup
   *  per-(workspace, turn): at most ONE auto-anchor per turn in
   *  `"pre-destructive"` and `"per-turn"` modes, regardless of how many
   *  destructive tool calls fire. ABSENT ⇒ per-turn dedup cannot apply —
   *  per-turn mode safely skips (no spam) and pre-destructive mode anchors on
   *  every destructive call (no dedup window). Duck-typed so `@/tool` never
   *  imports `@/agent`; the wrap-helper (`withAutoCheckpoint`) reads it through
   *  this seam. Default-OFF when the orchestration plane does not set it
   *  (byte-identical for every legacy caller). */
  turnId?: string
  /** ADR-0235 wire (opt-in) — per-turn shell-snapshot restore seam threaded
   *  through to `runShell` by shell-class tools (`bash` today). When set, the
   *  consumer forwards this verbatim to `ShellOptions.shellSnapshot` so the
   *  spawned child sources the captured per-turn env (`source <path>; <cmd>`)
   *  BEFORE running the user command. Absent ⇒ no restore, byte-identical
   *  legacy spawn. Duck-typed (structural mirror of `ShellSnapshotRestoreSeam`
   *  in `@/runtime/types`) so the `@/tool` slice never imports
   *  `@/runtime/shell-snapshot` directly — the dispatch seam (composition root
   *  in `@/agent`) is the only place that knows how to wire the concrete port
   *  here. */
  shellSnapshot?: ShellSnapshotRestoreSeam
  /** Self-inspection seam for the `session_config` tool. Read+write over the
   *  agent's own SDK posture (effort tier, identity mode, tool profile, model,
   *  provider). The dispatch seam wires this from `AgentConfig.sessionConfigPort`;
   *  when absent, `session_config` returns a typed `not_wired` failure (the
   *  tool itself is always registered in `buildDefaultTools` so the LLM can
   *  surface a coherent answer either way). Duck-typed (structural mirror of
   *  `SessionConfigSeam` in `./session_config`) so the `@/tool` slice never
   *  imports `@/agent`. */
  sessionConfig?: SessionConfigSeam
  /** ADR-0474 — OPTIONAL stale-read-guard state. When present (host opted in via
   *  `staleReadGuardEnabled`), the `read` tool records the read-time mtime here
   *  and `write`/`edit` consult it (`guardWrite`) to block a mutation whose
   *  target was externally modified since the read. Absent ⇒ no tracking, no
   *  guard (byte-identical default-OFF). Wired from `AgentConfig.readFileState`
   *  in `buildToolContext`. */
  readFileState?: ReadFileState
  /** ADR-0421 — OPTIONAL fast-apply fallback port (ADR-0417 apply-wire). The
   *  `apply_patch` tool calls this ONCE when a V4A patch FAILS to apply
   *  (anchor drift / generic apply error / parse error): it hands the failing
   *  patch + the derived `errorKind` + the target file snapshot to the
   *  fallback, which asks a fast executor model to re-emit the patch. On
   *  `{ok:true,newPatch}` the tool re-runs the V4A applier ONCE with the new
   *  patch; on `{ok:false}` (or a retry that also fails, or a port throw) the
   *  ORIGINAL typed error surfaces unchanged. Duck-typed (structural mirror of
   *  `FastApplyFallbackPort` in `@/agent/fast-apply-fallback`) so the `@/tool`
   *  slice never imports `@/agent` — the dispatch seam wires the concrete port
   *  from `AgentConfig.fastApplyFallback`. ABSENT ⇒ exact pre-ADR behavior
   *  (the V4A error throws immediately, NO fallback attempt, byte-identical). */
  fastApplyFallback?: FastApplyFallbackSeam
  /** ADR-0428 jun-02 wire — OPTIONAL socket-level egress proxy env. When the
   *  `network-proxy` knob is active, a composition root / `runAgent` constructs
   *  + `listen()`s a `LoopbackEgressProxy` and the dispatch seam surfaces the
   *  bound proxy's `{ address, noProxy }` here. The bash tool forwards it
   *  VERBATIM to `runShell` via `ShellOptions.proxyEnv` so the spawned child's
   *  OWN sockets are funneled through the proxy (closing the subprocess egress
   *  bypass). Absent (or `address` undefined) ⇒ `withProxyEnv` returns the same
   *  base env reference and the child is byte-identical (legacy). Duck-typed
   *  (structural mirror of `ProxyEnvInput` in `@/runtime/network-proxy` — same
   *  shape `ShellOptions.proxyEnv` already accepts) so `@/tool` stays slice-
   *  isolated from `@/agent`; the dispatch seam wires it from
   *  `AgentConfig.proxyEnv`. */
  proxyEnv?: {
    readonly address?: { readonly host: string; readonly port: number }
    readonly noProxy?: readonly string[]
  }
  /** ADR-0455 — OPTIONAL declared local-environment selection. When the
   *  composition root loads a `.quanta/environment.toml` and the agent selects
   *  an env, the dispatch seam surfaces the selected `{ vars, pathPrepend }`
   *  here. The bash tool forwards it VERBATIM to `runShell` via
   *  `ShellOptions.localEnv`, which composes it ON TOP of the scrubbed base env
   *  (allowlist still governs). Absent ⇒ `applyLocalEnv` returns the same base
   *  env reference and the child is byte-identical (default-OFF). Duck-typed
   *  (structural mirror of `LocalEnvSelection` in `@/runtime/local-env` — same
   *  shape `ShellOptions.localEnv` accepts) so `@/tool` stays slice-isolated
   *  from `@/agent`; the dispatch seam wires it from `AgentConfig.localEnv`. */
  localEnv?: {
    readonly vars: Readonly<Record<string, string>>
    readonly pathPrepend: readonly string[]
  }
  /** ADR-0440 wire-finish — OPTIONAL tool-diff capture sink. A file-mutating
   *  tool (`write`/`edit`) calls `capture(...)` ONCE after a SUCCESSFUL mutation
   *  with the full pre/post file text it ALREADY has in hand (no recompute, no
   *  extra read on the gate-OFF path). The web-daemon composition root wires the
   *  concrete sink ONLY when `QUANTA_WEB_CANVAS=1`; the sink converts the
   *  before/after into a `tool.diff` canvas frame (the diff math runs ONCE inside
   *  the daemon's `feedToolDiff`, never here). Duck-typed (structural mirror of
   *  the daemon-side {@link ToolDiffSink} below) so `@/tool` never imports
   *  `@/apps/web-daemon` (slice fence, RFC §3.1; biome enforces). ABSENT ⇒ no
   *  capture, no allocation, byte-identical legacy path (default-OFF). The
   *  `toolCallId` correlates the frame with the dispatched call (surfaced by the
   *  dispatch seam from the `ToolUseBlock.id`); absent ⇒ no capture (the sink is
   *  per-call and needs the id). */
  toolDiff?: ToolDiffSink
  /** ADR-0440 wire-finish — the dispatched `ToolUseBlock.id` of the CURRENT
   *  call, surfaced so a mutating tool can correlate its {@link toolDiff} capture
   *  with the exact tool call. Surfaced by the dispatch seam only when a
   *  {@link toolDiff} sink is wired (gate ON); absent otherwise (byte-identical
   *  legacy path). */
  toolCallId?: string
  /** H6 (jun-3-misc §3) — OPTIONAL passive-VCS event sink. The `bash` tool's
   *  post-exec hook (`maybeEmitPassiveVcs`) reads this through its duck-typed
   *  `PassiveVcsHookCtx` view: when `QUANTA_PASSIVE_VCS` is on AND a sink is
   *  wired, it classifies a completed git/gh command's stdout into a structured
   *  VCS event and forwards it here. The host (composition root) wires a sink
   *  that adapts the event onto the EXISTING `AgentEvent` stream (NOT a second
   *  bus). Surfaced by the dispatch seam from `AgentConfig.vcsEventSink`. ABSENT
   *  (gate OFF / non-wiring host) ⇒ omitted ⇒ the hook resolves its noop and the
   *  bash post-exec path is byte-identical (default-OFF). Typed via the in-slice
   *  {@link VcsEventSink} structural mirror so `@/tool` stays a leaf and never
   *  imports `@/git` (same discipline as {@link ToolDiffSink} /
   *  {@link ShellExecObserver}). */
  vcsEventSink?: VcsEventSink
  /** C2 (jun-4-communicate-update.md) — OPTIONAL structured-progress sink. The
   *  `communicate_update` tool forwards its typed `{current_step, final_summary?,
   *  completed_subtitle?}` payload here; the host (composition root) adapts it
   *  onto the EXISTING `AgentEvent` stream as a render-only `progress_update`
   *  event. Surfaced by the dispatch seam from `AgentConfig.progressSink`. ABSENT
   *  (knob off / non-wiring host) ⇒ omitted ⇒ the tool's `?.emit` is a no-op and
   *  the run is byte-identical (default-OFF). Typed via the in-slice
   *  {@link ProgressSink} structural mirror so `@/tool` stays a leaf and never
   *  imports `@/stream` / `@/agent` (same discipline as {@link VcsEventSink} /
   *  {@link ToolDiffSink}). */
  progressSink?: ProgressSink
  /** jun-6 tool-interrupt-behavior — OPTIONAL critical-section seam. A tool that
   *  declares `interruptBehavior(): "block"` (see {@link ToolInterruptPolicy})
   *  wraps its ATOMIC FS-mutating window (the rename/flush) in
   *  `ctx.criticalSection?.begin()` … `.end()`. While the section is open the
   *  dispatch abort-router WITHHOLDS the turn abort from `ctx.signal` so an ESC
   *  cannot tear a half-applied file; on `end()` (or on a bounded watchdog
   *  expiry) the withheld abort is force-delivered immediately, so the tool's
   *  very next `signal.aborted` check post-rename sees it. The scope is the
   *  rename/flush window ONLY — `block` defers a cancel across a bounded section,
   *  it can NEVER veto or swallow it.
   *
   *  Default-OFF / byte-identical via THREE independent gates: (1) the host did
   *  not wire the seam (this field absent) ⇒ `begin?.()` is undefined ⇒ the tool
   *  behaves exactly as `"cancel"`; (2) the tool omits `interruptBehavior` ⇒ the
   *  dispatch router threads the raw `config.signal` and never opens a section;
   *  (3) the `QUANTA_TOOL_INTERRUPT_BLOCK` knob is unset ⇒ dispatch ignores the
   *  predicate entirely. Duck-typed (structural mirror of the dispatch-side
   *  impl) so `@/tool` never imports `@/agent`; the composition root in `@/agent`
   *  builds the concrete per-call section over a suppressible derived signal +
   *  the watchdog clock. */
  criticalSection?: CriticalSectionSeam
}

/** jun-6 tool-interrupt-behavior — duck-typed critical-section seam injected via
 *  {@link ToolContext}. Structural mirror of the dispatch-side per-call impl
 *  (kept HERE so `@/tool` stays a slice leaf and never imports `@/agent` — same
 *  discipline as {@link ProgressSink} / {@link ToolDiffSink}). `begin()` opens
 *  the abort-withhold window and returns a disposable; the caller MUST `end()`
 *  it in a `finally` so a throwing FS op cannot leak an open section. Calling
 *  `end()` twice is a no-op (idempotent) by contract; the dispatch impl
 *  synchronously re-checks `config.signal` on the FIRST `end()` and force-aborts
 *  the derived signal if the turn aborted while withheld. NO-THROW at the port
 *  boundary. Absent seam ⇒ `block` degrades to `"cancel"` (byte-identical). */
export interface CriticalSectionSeam {
  /** Enter the atomic window: the abort router withholds the turn abort from
   *  `ctx.signal` until the returned handle's `end()` (or the watchdog cap).
   *  Returns a disposable whose `end()` is idempotent. */
  begin(): CriticalSectionHandle
}

/** jun-6 tool-interrupt-behavior — the disposable returned by
 *  {@link CriticalSectionSeam#begin}. `end()` closes the withhold window and is
 *  idempotent (second call is a no-op). */
export interface CriticalSectionHandle {
  /** Exit the atomic window — re-deliver any abort that arrived while withheld.
   *  Idempotent + NO-THROW. */
  end(): void
}

/** C2 (jun-4-communicate-update.md) — read-only structured-progress payload
 *  mirror. Carried to the host, which adapts it onto the EXISTING `AgentEvent`
 *  stream as a `progress_update` event. The snake_case field names match the
 *  model-facing `communicate_update` tool input (the host transforms them to the
 *  camelCase AgentEvent shape at the adapter boundary, exactly like the
 *  proto↔zod split in Cursor's `CommunicateUpdateArgs`). Optional fields stay
 *  ABSENT when the model omitted them (set-once-per-turn terminal fields). */
export interface ProgressUpdateMirror {
  readonly current_step: string
  readonly final_summary?: string
  readonly completed_subtitle?: string
}

/** C2 (jun-4-communicate-update.md) — duck-typed structured-progress event sink
 *  injected via {@link ToolContext}. Kept HERE so `@/tool` stays a slice leaf
 *  and never imports `@/stream` / `@/agent` (mirroring the `VcsEventSink` /
 *  `ToolDiffSink` discipline). `emit` is NO-THROW at the port boundary by
 *  contract; the host adapter swallows a dead consumer so a misbehaving sink can
 *  never break a turn. */
export interface ProgressSink {
  /** Forward a structured progress update. NO-THROW by contract. */
  emit(update: ProgressUpdateMirror): void
}

/** H6 (jun-3-misc §3) — structural mirror of `VcsEvent` from
 *  `@/git/passive-classify` (kept HERE so `@/tool` stays a slice leaf and never
 *  imports `@/git`). Every facet is OPTIONAL (a single command can surface
 *  several at once); the shapes match the producer's discriminated unions field-
 *  for-field. The closed `kind` / `action` literals mirror the producer's
 *  `VcsCommitKind` / `VcsBranchAction` — adding a value requires updating BOTH
 *  the producer AND this mirror (same convention as `GitWriteProtectReason`). */
export interface VcsEventMirror {
  readonly commit?: {
    readonly kind: "commit" | "amend" | "cherry-pick" | "merge"
    readonly sha?: string
  }
  readonly push?: { readonly localRef?: string; readonly remoteRef?: string }
  readonly branch?: { readonly action: "merged" | "rebased" | "amended" }
  readonly pr?: { readonly number: number; readonly url?: string }
}

/** H6 (jun-3-misc §3) — duck-typed passive-VCS event sink injected via
 *  {@link ToolContext}. Structural mirror of `PassiveVcsEventSink` from
 *  `@/git/passive-classify` (kept HERE so `@/tool` stays a slice leaf and never
 *  imports `@/git` — mirroring the `ToolDiffSink` discipline). `emit` is
 *  NO-THROW at the port boundary by contract; the bash hook additionally guards
 *  the call so a misbehaving custom sink can never break a bash turn. The
 *  payload is the {@link VcsEventMirror} structural shape; the producer's
 *  concrete `VcsEvent` is structurally assignable to it, and the host adapter
 *  (the only consumer that reads the facets) narrows back to the producer type
 *  at wire time. */
export interface VcsEventSink {
  /** Forward a classified VCS event. NO-THROW by contract. */
  emit(event: VcsEventMirror): void
}

/** ADR-0440 wire-finish — duck-typed tool-diff capture sink injected via
 *  {@link ToolContext}. Structural mirror of the daemon-side capture port (the
 *  web-daemon adapts its `canvas-emitter`'s `feedToolDiff` into this shape at
 *  the composition root) — kept HERE so `@/tool` stays slice-isolated from
 *  `@/apps/web-daemon` (RFC §3.1; biome enforces). `capture` is NO-THROW at the
 *  port boundary by contract (the daemon swallows a dead socket); a mutating
 *  tool calls it INSIDE a guard so a misbehaving sink can never break the turn.
 *  The diff math is NOT run here — the caller hands raw before/after strings and
 *  the daemon computes the line diff exactly ONCE (no recompute). */
export interface ToolDiffSink {
  capture(input: {
    readonly toolCallId: string
    readonly before: string
    readonly after: string
    readonly path?: string
  }): void
}

/** ADR-0421 — duck-typed mirror of `FastApplyFallbackPort` from
 *  `@/agent/fast-apply-fallback` (kept here so `@/tool` stays slice-isolated
 *  from `@/agent` — RFC §3.1; biome enforces). `attempt` is NO-THROW at the
 *  port boundary (the producer collapses every dep failure to `{ok:false}`);
 *  the consumer (`apply_patch`) additionally guards against a port that breaks
 *  its contract by throwing. The closed `errorKind` literal union mirrors the
 *  producer's `FastApplyFailure["errorKind"]`; a new kind requires updating
 *  BOTH the producer AND this mirror. */
export type FastApplyFailureKind = "anchor_not_found" | "apply_error" | "parse_error"

/** Structural mirror of `FastApplyFailure`. */
export interface FastApplyFailureMirror {
  readonly patch: string
  readonly errorKind: FastApplyFailureKind
  readonly errorMessage: string
}

/** Structural mirror of `FastApplyAttemptResult`. */
export interface FastApplyAttemptResultMirror {
  readonly ok: boolean
  readonly newPatch: string | null
  readonly rationale: string
  readonly modelUsed?: string
}

/** Structural mirror of `FastApplyFallbackPort`. */
export interface FastApplyFallbackSeam {
  attempt(
    input: {
      failure: FastApplyFailureMirror
      sourceFile?: string
      sourceContent?: string
    },
    signal?: AbortSignal,
  ): Promise<FastApplyAttemptResultMirror>
}

/** Canonical seam declaration for the `session_config` tool. Lives in
 *  `./types` (not in `./session_config`) so `ToolContext` can reference it
 *  without a circular import; the tool file re-exports it for downstream
 *  callers. The dispatch seam (`@/agent/dispatch.ts`) builds the concrete
 *  port from `AgentConfig.sessionConfigPort`; absent ⇒ the tool returns a
 *  typed `not_wired` failure. Effort tier mirrors `@/agent/effort#EffortLevel`
 *  as a closed literal union — the unit test in
 *  `tests/unit/tool/session-config.test.ts` pins parity. */
export interface SessionConfigSeam {
  readonly readEffort: () => "default" | "max" | "high" | "medium" | "low"
  readonly writeEffort: (next: "default" | "max" | "high" | "medium" | "low") => void
  readonly readIdentityMode?: () => string
  readonly readToolProfile?: () => string
  readonly readModel?: () => string
  readonly readProvider?: () => string
}

/** ADR-0235 wire — structural mirror of `ShellSnapshotRestoreSeam` from
 *  `@/runtime/types`. Declared HERE so the `@/tool` slice does not import
 *  `@/runtime/shell-snapshot` (slice isolation, RFC §3.1). The shape is
 *  IDENTICAL to the runtime mirror; the dispatch seam (composition root in
 *  `@/agent`) hands an instance through both fields verbatim. */
export interface ShellSnapshotRestoreSeam {
  readonly handle: { readonly id: string; readonly path: string }
  readonly restore: (
    handle: { readonly id: string; readonly path: string },
    prefix: ReadonlyArray<string>,
  ) => { readonly argv: string[] }
}

// ── Plan-mode duck-typed mirror (ADR-0093 draft) ─────────────────────────

/** Mirror of `PlanDeltaKind` from `@/agent/plan/types`. Adding a value MUST
 *  extend the producer's union (compile error there) AND this literal here. */
export type PlanDeltaKind =
  | "created"
  | "todos_added"
  | "todos_updated"
  | "todos_removed"
  | "phases_reordered"
  | "noop"

/** Mirror of `PlanMutationError["kind"]` from `@/agent/plan/types`. Adding a
 *  value MUST extend the producer's union AND this literal here. */
export type PlanMutationErrorCode =
  | "version_conflict"
  | "todo_not_found"
  | "phase_not_found"
  | "dependency_cycle"
  | "dependency_unknown"
  | "self_dependency"
  | "content_too_long"
  | "invalid_status_transition"
  | "duplicate_id"
  | "empty_plan_create"

/** Mutator-side result. ok-true carries the post-mutation version + delta
 *  kind + touched ids (the surface needed to re-fetch / animate). ok-false
 *  carries the typed reason code + human message. NEVER throws. */
export type PlanMutationResult =
  | {
      readonly ok: true
      readonly version: number
      readonly deltaKind: PlanDeltaKind
      readonly touchedIds: readonly string[]
    }
  | {
      readonly ok: false
      readonly reason: string
      readonly code: PlanMutationErrorCode
    }

/** Readonly summary view of the current plan (size signals + meta) — the
 *  surface tools can poll without dragging the whole plan through the seam.
 *  Full plan-state lives behind the producer; cross-slice flow stays by-value. */
export interface PlanReadonlyView {
  readonly version: number
  readonly name: string
  readonly overview: string
  readonly isProject: boolean
  readonly todoCount: number
  readonly phaseCount: number
}

/** Duck-typed mirror of the producer-side `PlanStore` (`@/agent/plan/state.ts`).
 *  Tools call `ctx.planMutator?.{create,addTodos,updateTodos,removeTodos,
 *  updateMeta,reorderPhases}` and consume the typed result. The dispatch seam
 *  (composition root) builds a concrete `PlanMutator` from `AgentConfig.planStore`
 *  by adapting the producer's `PlanResult<PlanDelta>` to {@link PlanMutationResult}. */
/** Mirror NewTodo input shape — zod-compatible (`| undefined` on optionals). */
export interface PlanMutatorNewTodo {
  content: string
  status?: string | undefined
  dependencies?: readonly string[] | undefined
  phaseId?: string | undefined
  assignee?: string | undefined
  verifyHint?: string | undefined
}

export interface PlanMutatorTodoPatch {
  id: string
  content?: string | undefined
  status?: string | undefined
  dependencies?: readonly string[] | undefined
  phaseId?: string | null | undefined
  assignee?: string | null | undefined
  verifyHint?: string | null | undefined
}

export interface PlanMutator {
  create(args: {
    name: string
    overview: string
    isProject?: boolean | undefined
    todos: readonly PlanMutatorNewTodo[]
    phases?: readonly { name: string; todoIndexes?: readonly number[] | undefined }[] | undefined
  }): PlanMutationResult
  addTodos(items: readonly PlanMutatorNewTodo[], expectedVersion: number): PlanMutationResult
  updateTodos(
    patches: readonly PlanMutatorTodoPatch[],
    merge: boolean,
    expectedVersion: number,
  ): PlanMutationResult
  removeTodos(ids: readonly string[], expectedVersion: number): PlanMutationResult
  updateMeta(
    args: {
      name?: string | undefined
      overview?: string | undefined
      isProject?: boolean | undefined
      phaseOrder?: readonly string[] | undefined
    },
    expectedVersion: number,
  ): PlanMutationResult
  current(): PlanReadonlyView | null
}

/**
 * Closed-union mirror of `GitWriteProtectReason` from
 * `@/permission/git-write-guard` (kept here so `@/tool` stays slice-isolated
 * from `@/permission` — RFC §3.1; biome enforces the fence). The producer
 * `gitWriteProtectReason` returns exactly these 5 literals or `null`.
 *
 * MIRROR INVARIANT — adding a 6th protect reason requires updating BOTH
 * `src/permission/git-write-guard.ts` (the producer) AND this declaration. The
 * `@/tool` slice CANNOT import from `@/permission` to verify structurally, so
 * the slice fence makes this a manual sync — reviewers MUST check on PR. A
 * round-trip integration test in `tests/unit/` (consumer side, which CAN see
 * both slices) catches drift at test time. The `STRUCTURAL_HASH` constant at
 * the bottom of this file is a literal anchor a future reader can grep for.
 */
export type GitWriteProtectReason =
  | "git_hooks"
  | "git_hooks_dir"
  | "git_config"
  | "git_attributes"
  | "editor_config"

/** Duck-typed git-write-protection detector injected via {@link ToolContext}.
 *  Structural mirror of `gitWriteProtectReason` from `@/permission/git-write-
 *  guard` (kept here so `@/tool` stays slice-isolated from `@/permission`):
 *  PURE path-pattern matcher, no I/O. Returns a closed-union reason tag when
 *  writing `path` would be a code-execution / policy-escape vector, else null.
 *  The return type is the closed `GitWriteProtectReason | null` (NOT `string`)
 *  so a new producer literal becomes a compile error at every exhaustive
 *  consumer site, instead of widening through this mirror. */
export type GitWriteGuard = (path: string) => GitWriteProtectReason | null

/** ADR-0086 plan-exit decision — structural mirror of `PlanExitDecision`
 *  (`@/agent/plan-exit`); dispatch bridges the two by value. */
export type PlanExitToolDecision = "approved" | "rejected" | "changes_requested"

/** Structural mirror of `PlanExitOutcome`. `feedback` is non-empty IFF
 *  `decision === "changes_requested"` (the producer `buildPlanExit` enforces
 *  it; the tool only relays). */
export interface PlanExitToolOutcome {
  readonly decision: PlanExitToolDecision
  readonly feedback?: string
}

/** Requester the `request_plan_exit` tool invokes. */
export type PlanExitRequester = (plan: string) => Promise<PlanExitToolOutcome>

/** ADR-0095 (draft) — CLOSED 2-arm outcome the `request_user_input` tool relays
 *  from `ToolContext.requestUserInput` to the model. `answer` carries the
 *  operator's reply text (the tool surfaces it as `ToolResult.output`);
 *  `cancelled` carries no payload (the tool surfaces it as a typed
 *  `rejected` failure with `reason: "user_cancelled"`).
 *
 *  CLOSED-UNION INVARIANT: this union must stay at exactly 2 arms. Adding a 3rd
 *  arm requires an ADR amendment AND a compile-error update at every
 *  exhaustive switch (the tool's `switch (outcome.decision)` has a `never`
 *  default; a new arm becomes a `tsc` error there). No heuristics. */
export type UserInputOutcome = { decision: "answer"; text: string } | { decision: "cancelled" }

/** ADR-0095 (draft) — requester the `request_user_input` tool invokes.
 *  `promptId` is generated by the tool (UUID) so a surface (CLI/IDE) can
 *  correlate the request with an out-of-band UI element; `prompt` is the
 *  model-authored question; `choices` (≤12, each non-empty) is an OPTIONAL
 *  fixed-choice list a surface may render as buttons; `multiline` is an
 *  OPTIONAL hint that the answer may span multiple lines. The requester
 *  resolves with a CLOSED {@link UserInputOutcome}. */
export type UserInputRequester = (req: {
  promptId: string
  prompt: string
  choices?: readonly string[]
  multiline?: boolean
}) => Promise<UserInputOutcome>

/** ADR-0111 — duck-typed mirror of `SubagentRunner` from `@/subagent/types`.
 *  Kept here so `@/tool` stays slice-isolated from `@/subagent` (RFC §3.1;
 *  biome enforces). The producer-side `SubagentRunner` carries a larger
 *  request union; this mirror only types the FIELDS the `git_review_diff`
 *  tool actually populates. The dispatch seam adapts a concrete
 *  `SubagentRunner` into this narrower port at wire time.
 *
 *  Structural-equivalence convention (same posture as `GitWriteGuard` and
 *  `WorkingStateHandle`): a future widening of `SubagentRequest` need not
 *  ripple into this mirror unless the tool starts populating the new field.
 *  Conversely a renamed/removed field is caught by the consumer-side test
 *  in `tests/integration/git-review-diff-e2e.test.ts` (which CAN see both
 *  slices). */
export interface ReviewerRequest {
  /** The reviewer-seed prompt: REVIEW notice + diff text + optional focus. */
  prompt: string
  /** Recursion depth of this child (parent depth + 1). Root is 0. */
  depth: number
  /** Always `"review"` for this seam — read-only critique posture. */
  taskKind?: "read" | "edit" | "review"
  /** Tool-name allowlist the child registry is filtered to (read/grep/glob). */
  toolFilter?: readonly string[]
  /** Per-request abort signal; chained from the tool's `ctx.signal`. */
  signal?: AbortSignal
}

export interface ReviewerResult {
  ok: boolean
  /** Final assistant text the child produced — the reviewer's answer. */
  finalText: string
  /** Number of model turns the child took. */
  turns: number
}

/** Duck-typed reviewer port. The host (`@/agent`) provides the concrete
 *  implementation by adapting `SubagentRunner` from `@/subagent`. The
 *  `git_review_diff` tool consumes it through this narrow interface. */
export type ReviewerRunner = (req: ReviewerRequest) => Promise<ReviewerResult>

/** Duck-typed handle a tool uses to mutate or read the session WorkingState
 *  without importing `@/agent`. The agent loop is the only producer; tools are
 *  the consumers. `snapshot()` returns the current state by reference; callers
 *  must treat it as read-only and route mutations through `mutate()`. */
export interface WorkingStateHandle {
  /** Apply a partial replacement to the current state. Each provided field is
   *  a REPLACEMENT for the corresponding state field — absent fields preserve
   *  existing state. `hypothesis: null` clears the field. */
  mutate(patch: WorkingStatePatch): WorkingStateSnapshot
  /** Read-only snapshot of the current state. */
  snapshot(): WorkingStateSnapshot
}

/** Mirror of `BlockerSurface` from `@/agent/working-state` (kept here so
 *  `@/tool` is slice-isolated from `@/agent`).
 *
 *  MIRROR INVARIANT — structural equivalence is CONVENTION-ONLY: the slice
 *  fence (`@/tool` may NOT import `@/agent`) prevents a cross-slice
 *  `Equals<>`/`satisfies` compile check inside this file. Adding a new
 *  surface requires updating BOTH `src/agent/working-state.ts` AND this
 *  declaration; reviewers MUST verify on PR, and a consumer-side round-trip
 *  test in `tests/unit/` (which CAN see both slices) catches drift. The
 *  `STRUCTURAL_HASH` constant at the bottom of this file is a literal
 *  anchor a future reader can grep for. */
export type BlockerSurface = "type" | "owner" | "wire" | "test" | "runtime" | "build" | "other"

/** Structural duck-typed mirror of `WorkingState` (kept here so `@/tool` is
 *  slice-isolated from `@/agent`). */
export interface WorkingStateSnapshot {
  ownerShortlist: { file: string; reason: string }[]
  hypothesis?: string
  blockers: { what: string; surface: BlockerSurface }[]
  nextStepQueue: { what: string; deferred?: boolean }[]
  deferredValidation: { rail: string; reason: string }[]
}

/** Patch shape for `WorkingStateHandle.mutate`. Each present field REPLACES
 *  the corresponding state field; `hypothesis: null` clears it. `| undefined`
 *  is spelled explicitly on every optional so a zod `.optional()` parse output
 *  (which is structurally `T | undefined`) is assignable under
 *  `exactOptionalPropertyTypes: true`. */
export interface WorkingStatePatch {
  ownerShortlist?: { file: string; reason: string }[] | undefined
  hypothesis?: string | null | undefined
  blockers?: { what: string; surface: BlockerSurface }[] | undefined
  nextStepQueue?: { what: string; deferred?: boolean | undefined }[] | undefined
  deferredValidation?: { rail: string; reason: string }[] | undefined
}

/**
 * ADR-0062 rule #3 — structured cap-as-instruction third channel.
 *
 * A tool may return a `nextAction` hint on its successful result when it
 * detects that its output was capped and the next call MUST apply a
 * specific change before switching tools. The dispatch seam reads this
 * and (when `QUANTA_CAP_ENFORCE=1`) enforces the hint by injecting a
 * `<system-reminder>` when a subsequent call ignores it.
 *
 * INVARIANT: `nextAction` is OPTIONAL — tools that omit it are byte-
 * identical. Only `file_tree_summary` populates it today; adding a
 * second tool that emits it never changes unrelated callers.
 *
 * The union is CLOSED via the `kind` discriminant. Adding a new variant
 * requires updating every exhaustive switch at consumer sites (the
 * dispatch seam's enforcement block). The two numeric variants carry a
 * `suggested` value derived purely from the current parameter × 2,
 * capped by the tool's own schema max — no heuristics.
 */
export type NextAction =
  | { kind: "increase_max_depth"; suggested: number; reason: string }
  | { kind: "raise_max_files"; suggested: number; reason: string }
  | { kind: "narrow_path"; reason: string }

export interface ToolResult {
  ok: boolean
  /** Text returned to the model as the tool_result content. */
  output: string
  /** Optional execution evidence surfaced to RFC-0002 §5.2 trajectory.
   *  Tools that exec shell commands attach stderr/exitCode/log-spill paths
   *  here; tools that don't simply omit the field. Replaces the previous
   *  duck-typed extra-prop smuggling on `ToolResult` (CR3): the dispatch
   *  seam now reads `result.evidence?.*` through this typed surface so the
   *  `stdErr` vs `stderr` casing drift can no longer slip past `tsc`. */
  evidence?: ToolResultEvidence
  /** OPTIONAL (absorb #1): structured value paired with `output`. When a tool
   *  declares an `outputSchema`, the dispatch seam validates THIS field (not
   *  `output`) against the schema. Absent ⇒ no structured payload; existing
   *  callers are byte-identical. Typed `unknown` here so `ToolResult` stays
   *  non-generic; `defineTool` narrows it at the factory boundary. */
  structured?: unknown
  /** OPTIONAL (absorb #1): a deferred-result marker. When a tool sets
   *  `supportsDeferredResults` and returns a placeholder it is still running
   *  in, this carries the handle the poller resolves later. The presence of
   *  `deferred` means `output` is a provisional placeholder, not the final
   *  answer. Absent ⇒ ordinary synchronous result (byte-identical). */
  deferred?: DeferredHandle
  /** OPTIONAL (absorb #2 — Cursor `EditResult`/`ShellResult` failure model): a
   *  TYPED, discriminated reason a tool failed, letting the model branch on the
   *  failure KIND instead of regex-matching `output`.
   *
   *  INVARIANT: `failure` is only meaningful when `ok === false`. When present
   *  it carries the typed reason IN ADDITION TO (never instead of) `output` —
   *  `output` remains the model-facing tool_result text exactly as before, so a
   *  tool that omits `failure` is byte-identical for every existing caller.
   *  Tools opt in by populating it on their `ok:false` results; the dispatch
   *  seam surfaces it onto `DispatchResult.failure` unchanged. */
  failure?: ToolFailure
  /** ADR-0062 rule #3 — OPTIONAL structured cap-as-instruction hint. When a
   *  tool detects its output was capped (depth rollup or file-count truncation),
   *  it populates this field so the dispatch seam can enforce the suggestion
   *  structurally rather than relying solely on the prose in `output`.
   *
   *  Tools that do NOT emit it are byte-identical (no allocation, no change to
   *  the existing `output` channel). The dispatch seam reads this ONLY when
   *  `QUANTA_CAP_ENFORCE=1` is set — DEFAULT-OFF. */
  nextAction?: NextAction
  /** OPTIONAL (ADR-0126): structured image attachments to surface to the model
   *  via the next user message's tool_result content. The dispatch seam reads
   *  this field and composes an Anthropic-API tool_result block whose `content`
   *  is `[{type:"text",text:output}, ...images.map(toImageContentBlock)]`.
   *  Absent ⇒ tool_result content is the legacy string-only shape
   *  (byte-identical). Each image is a base64-encoded ImageBlock; caller is
   *  responsible for size/policy checks UPSTREAM.
   *
   *  Slice-fence note: this is the FIRST `ToolResult` field whose type is
   *  imported from `@/llm`. biome's `@/tool` override does NOT restrict `@/llm`
   *  (only `@/memory`, `@/stream`, `@/permission`, `@/lsp`, `@/observability`,
   *  `@/mcp`, `@/patch`, `@/rules`), so this import is structurally allowed —
   *  but the historical doc on `ToolContext` listed `@/llm` among its `MUST
   *  NEVER import` set. That copy was a doc drift from a pre-vision posture; the
   *  authoritative slice fence is the biome override. */
  images?: ImageBlock[]
  /** OPTIONAL (ADR-0137): structured document attachments to surface to the
   *  model via the next user message's tool_result content. Sibling of
   *  {@link images}: dispatch's `composeToolResultContent` appends these AFTER
   *  any image blocks so the composed `[text, ...images, ...documents]` array
   *  preserves both modalities in the order the tool produced. Today the only
   *  supported media type is `application/pdf` (Anthropic native document
   *  block — see ADR-0137). Absent ⇒ no document attachments (byte-identical).
   *  Each document is base64-encoded; caller is responsible for size / policy
   *  checks UPSTREAM (the `pdf_read` tool enforces the 32 MB Anthropic API cap
   *  + magic-byte sniff at its boundary). */
  documents?: DocumentBlock[]
}

/** OPTIONAL (absorb #2 — Cursor `EditResult`/`ShellResult`): the discriminated
 *  set of failure reasons a tool may classify on an `ok:false` `ToolResult`.
 *  The literal `mode` is the discriminant; switching over it with a `never`
 *  default is exhaustive (a new variant becomes a compile error at every site).
 *
 *  Variants chosen to match how v3 tools actually fail today:
 *   - `not_found`: a target path/symbol/match did not exist (read on a missing
 *     file, `edit` `old_string not found`, `scripted_replace` `pattern not
 *     found`). `path` carried when the missing target is a file.
 *   - `permission_denied`: the action was refused by the FS jail or a real
 *     permission boundary. `isReadonly` distinguishes a refusal that exists
 *     ONLY because the session/tool is in read-only mode (would succeed if
 *     mutation were allowed) from a genuine permission denial — Cursor's
 *     `is_readonly` flag.
 *   - `rejected`: a human/gate declined the call (HITL deny, plan-mode block).
 *     `reason` is the stable tag.
 *   - `timeout`: execution exceeded a deadline. `timeoutMs` carried when known.
 *   - `spawn_error`: an external process could not be launched at all (Cursor
 *     `ShellSpawnError` — e.g. `command not found`, ENOENT). Distinct from
 *     `error` because the retry strategy differs: the model should pick a
 *     DIFFERENT command rather than re-read an error string. `error` carries the
 *     spawn diagnostic.
 *   - `error`: any other failure. `modelVisibleError` is the safe text shown to
 *     the model; `clientVisibleError` is richer detail for the UI/operator that
 *     is NOT necessarily forwarded to the model (Cursor's
 *     model-visible vs client-visible split). */
/** C6 (RFC jun-6-deny-reason-surfacing) — duck-typed mirror of `DenyLayer`
 *  from `@/permission/deny-reason` (kept here so `@/tool` stays slice-isolated
 *  from `@/permission` — RFC §3.1; biome enforces). The deny SITE (always
 *  unambiguous). Adding a value requires updating BOTH the producer AND this
 *  mirror. */
export type DenyLayerMirror =
  | "hard-deny"
  | "stack"
  | "reviewer"
  | "hook"
  | "tool-profile"
  | "mode"
  | "broker"

/** C6 — duck-typed mirror of `DenyPillar` from `@/permission/deny-reason`. */
export type DenyPillarMirror = "fileSystem" | "network" | "sandbox" | "control" | "approval"

/** C6 — duck-typed mirror of `PermissionStackSource` from
 *  `@/permission/recorder` (the stack-axis enum reused verbatim on the
 *  `layer:"stack"` deny path when derivable). */
export type DenyStackSourceMirror =
  | "hard-deny"
  | "read-only-bypass"
  | "post-denial-override"
  | "per-thread"
  | "per-host"
  | "global-default"

/**
 * C6 (RFC jun-6-deny-reason-surfacing) — duck-typed mirror of
 * `StructuredDenyReason` from `@/permission/deny-reason` (kept here so `@/tool`
 * stays slice-isolated from `@/permission` — RFC §3.1; biome enforces the
 * fence). The producer's `StructuredDenyReason` is structurally assignable to
 * this shape; the agent-side `deny(..., denyReason)` builder attaches the real
 * value, and this mirror is the only declaration `@/tool` consumers branch on.
 *
 * NO-LEAK (the core C6 constraint): `safeReason` is the recorder's already-
 * sanitized one-liner surfaced VERBATIM — NEVER raw input / command text /
 * regex source / matched HARD_DENY pattern. The HARD_DENY case carries the
 * CATEGORICAL `hardDenySafeReason()` form, never the command-echoing prose.
 *
 * MIRROR INVARIANT — adding a `layer` / `pillar` / `stackSource` literal
 * requires updating BOTH the producer AND this mirror; a consumer-side
 * round-trip test in `tests/unit/` (which CAN see both slices) catches drift.
 */
export interface DenyReasonValue {
  readonly verdict: "deny"
  readonly layer: DenyLayerMirror
  readonly pillar?: DenyPillarMirror
  readonly stackSource?: DenyStackSourceMirror
  readonly safeReason: string
}

export type ToolFailure =
  | { mode: "not_found"; path?: string }
  | {
      mode: "permission_denied"
      path?: string
      isReadonly?: boolean
      /** C6 (RFC jun-6-deny-reason-surfacing) — OPTIONAL structured "why was
       *  this denied" record, attached ONLY when `surfaceDenyReason`
       *  (`QUANTA_DENY_REASON`) is on AND the deny flows through the
       *  admissibility-gate's `deny(..., denyReason)` path. Lets the model
       *  branch on the deciding `layer` / `pillar` instead of regex-matching
       *  the prose `content`. ABSENT (default-OFF / a tool-level FS-jail deny
       *  that does not thread it) ⇒ the envelope is `{mode, isReadonly}` only,
       *  byte-identical to today.
       *
       *  SLICE FENCE (RFC §3.1; biome enforces): `@/tool` MUST NOT import
       *  `@/permission`, so the value-shape is MIRRORED locally as
       *  {@link DenyReasonValue} — structurally equivalent to
       *  `StructuredDenyReason` from `@/permission/deny-reason`. The agent-side
       *  deny() builder (`@/agent/dispatch-helpers`) produces the real
       *  `StructuredDenyReason` (assignable to this mirror by structure) and the
       *  gate is the only populating site. Adding a `DenyLayer` / `DenyPillar`
       *  literal requires updating BOTH the producer AND this mirror; a
       *  consumer-side test in `tests/unit/` (which CAN see both slices) catches
       *  drift. */
      denyReason?: DenyReasonValue
    }
  | { mode: "rejected"; reason: string }
  | { mode: "timeout"; timeoutMs?: number }
  | { mode: "spawn_error"; error: string }
  | { mode: "error"; modelVisibleError?: string; clientVisibleError?: string }
  /** ADR-0295 — OS sandbox refused the call. Emitted by the bash tool (and any
   *  future shell-class sibling) when its `mode="read"` per-call wrap forwarded
   *  a write/exec/network attempt that the kernel/Seatbelt rejected with
   *  EACCES / "Operation not permitted". `reason` is a CLOSED enum so a future
   *  arm (e.g. `kqueue_denied`) becomes a compile error at every exhaustive
   *  switch. The OS is the enforcer — no pattern-matching on the command. */
  | { mode: "sandbox_violation"; reason: SandboxViolationReason }
  /** ADR-0295 — OS sandbox cannot be enforced on this host (sandbox-exec
   *  missing, linux backend not implemented per-call, unsupported platform).
   *  The bash tool surfaces this BEFORE spawning when `mode="read"` is
   *  requested — explicitly NOT falling back to an unsandboxed legacy spawn
   *  (fail-closed posture). `reason` is the opaque stable tag from the port. */
  | { mode: "sandbox_unavailable"; reason: string }
  /** ADR-0398 — `edit`/`write` tool was called with an `expected_hash`
   *  precondition that did NOT match the current file's sha256. The on-disk
   *  bytes are UNTOUCHED (no partial write, no rollback to perform). The
   *  caller (model or human gate) can re-read the file and decide whether the
   *  divergence is intentional (give up the edit) or stale-context (re-issue
   *  with the fresh `expected_hash`). The two hashes are surfaced as hex
   *  strings so downstream tooling can diff them without re-reading the
   *  file. `path` is the file the precondition guarded. */
  | {
      mode: "stale_precondition"
      path?: string
      expectedHash: string
      actualHash: string
    }

/** Closed enum of OS-sandbox violation kinds. Each arm maps a class of OS
 *  denial to a stable tag the model can branch on. Adding a new arm requires
 *  updating every exhaustive switch (consumer-side compile error). */
export type SandboxViolationReason = "write_denied" | "exec_denied" | "network_denied" | "unknown"

/** Optional RFC-0002 §5.2 execution evidence a tool may attach to its
 *  `ToolResult`. All fields are optional individually: a tool may carry just
 *  a stderr tail, or just a spill path, or any combination. Implementations
 *  cap their own field lengths; the dispatch seam re-trims `stderr` to its
 *  own `STDERR_TAIL_CAP` as a defense-in-depth backstop. */
export interface ToolResultEvidence {
  /** Tail of stderr captured during execution. Implementations cap their
   *  own length — dispatch trims again to its `STDERR_TAIL_CAP` backstop. */
  stderr?: string
  /** Process exit code when the tool spawned an external process. */
  exitCode?: number
  /** Absolute path to a full log when output spilled. Caller-resolved
   *  (FS jail still applies to the path). */
  fullLogPath?: string
}

/**
 * Events a tool streams while running. A tool yields zero or more `progress`
 * events, then exactly one terminal `result` — which MUST be the last event.
 *
 * Deferred results (absorb #1) are carried on the terminal `result` via the
 * OPTIONAL `ToolResult.deferred` handle — NOT as a separate event variant.
 * Keeping the union at `progress | result` preserves byte-identical type
 * narrowing for every existing call site that switches on `event.type`.
 */
export type ToolEvent =
  | { type: "progress"; message: string }
  | { type: "result"; result: ToolResult }

/** OPTIONAL (absorb #1): an opaque, serializable handle identifying a deferred
 *  tool result. The dispatch seam hands this to a `DeferredResultRegistry` which
 *  resolves the final `ToolResult` once the out-of-band work completes. Kept
 *  minimal & string-keyed so it can cross a JSON boundary unchanged. */
export interface DeferredHandle {
  /** Stable id the registry/poller keys on. Unique within a session. */
  id: string
  /** Optional human-facing hint shown while the result is pending. */
  hint?: string | undefined
}

/** OPTIONAL (absorb #1): the resolution outcome of a deferred handle, as
 *  surfaced by `DeferredResultRegistry.poll`. */
export type DeferredToolResult =
  | { state: "pending"; handle: DeferredHandle }
  | { state: "resolved"; handle: DeferredHandle; result: ToolResult }

/**
 * Codex HITL 4-tier taxonomy (hitl-audit.md). Re-exported from the canonical
 * `@/shared` declaration — NOT redeclared — so the `@/tool` and `@/permission`
 * copies can never drift. `@/tool` reaching `@/shared` is allowed (the leaf
 * layer); biome only forbids the `@/tool ↔ @/permission` direction. Dispatch
 * still composes the two slices via duck-typing.
 */
export type { HITLTier }

/**
 * Phase 2 tool contract (RFC §6.2). `execute` is an async generator yielding
 * `ToolEvent`s; `isConcurrencySafe(input)` lets the dispatcher batch pure
 * reads to run in parallel while keeping side-effecting calls serialized.
 *
 * `Tool<I, O>` is the intersection of FOUR concerns (Interface-Segregation
 * grouping — structural guardrail for ISP):
 *
 *   1. {@link ToolCore}            — required surface, always set.
 *   2. {@link ToolSecurityHooks}   — optional permission / sensitivity hooks
 *                                    populated by built-in tools today.
 *   3. {@link ToolResultShape}     — optional result-shape contract
 *                                    (structured payload + model rendering +
 *                                    deferred-results opt-in).
 *   4. {@link ToolStreamingInput}  — optional streaming-input callbacks
 *                                    mirroring LLM `tool_use_*` events.
 *   5. {@link ToolInterruptPolicy} — optional per-tool interrupt policy
 *                                    (jun-6) read by the dispatch abort-router.
 *
 * Every member of groups 2–5 is OPTIONAL on `Tool` (the `Partial<…>`s below
 * preserve the previous flat shape), so all existing readers — `registry.run`,
 * `registry.extractShellCommand`, `factory.enforceOutputSchema` /
 * `renderToolOutput` / `driveStreamingInput`, the permission gate's
 * `inferToolTier`, and the dispatch redaction layer — keep working unchanged.
 *
 * Grouping is the structural guardrail: a future "dead optional" sticks out
 * because it has no consumer in its group. Do NOT add a scanner rule.
 */
export type Tool<I = unknown, O = unknown> = ToolCore<I> &
  Partial<ToolSecurityHooks<I>> &
  Partial<ToolResultShape<O>> &
  Partial<ToolStreamingInput<I>> &
  Partial<ToolInterruptPolicy>

/**
 * Required surface every tool implements. The dispatch/registry seams call
 * `execute`, `isReadOnly`, and `isConcurrencySafe` on EVERY tool — no
 * `?.` access, no `!== undefined` guards. New tools start here.
 */
export interface ToolCore<I = unknown> {
  name: string
  description: string
  inputSchema: z.ZodType<I>
  isReadOnly(): boolean
  /** True ⇒ this call has no observable interaction with any other call and
   *  may run concurrently with other concurrency-safe calls. */
  isConcurrencySafe(input: I): boolean
  execute(input: I, ctx: ToolContext): AsyncIterable<ToolEvent>
}

/**
 * Optional security / sensitivity hooks. Built-in tools populate these today
 * (`hitlTier` — 10 tools; `extractShellCommand` — `bash`; `classifySource` —
 * `bash`, `read`). Each is consumed by a real seam in `@/permission` (`policy`
 * — `inferToolTier`), `@/tool/registry` (`extractShellCommand`), or the
 * dispatch redaction layer (`classifySource`).
 */
export interface ToolSecurityHooks<I = unknown> {
  /** Input-dependent HITL tier (Codex hitl-audit.md absorption).
   *  When omitted, the dispatch gate infers tier from `isReadOnly()`:
   *  `true ⇒ "none"` (reversible, harmless), `false ⇒ "always-confirm"`
   *  (fail-closed secure-by-default, see `inferToolTier` in
   *  `@/permission/policy`). Tools that DO mutate but want pre-approval
   *  semantics (e.g. `write`/`edit`/`test_runner`/`scripted_replace`)
   *  explicitly opt in via `hitlTier: () => "pre-approval-ok"`. Tools whose
   *  tier varies per-input (`bash` — `git push` is always-confirm, `ls` is
   *  pre-approval-ok) provide their own classifier here. Only consulted
   *  when the HITL gate is explicitly enabled in `AgentConfig.hitl`. */
  hitlTier(input: I): HITLTier
  /** S16: when a tool accepts a raw shell command string, it implements this
   *  to expose the command for HARD_DENY evaluation. The permission policy
   *  gates ANY tool whose `extractShellCommand` returns a non-null value
   *  through the same dangerous-pattern denylist as `bash` — so a sibling
   *  shell tool (a future `shell`/`exec`/MCP `run` tool, a typo'd `Bash`,
   *  etc.) cannot silently slip past the gate that previously only matched
   *  `action.tool === "bash"`. Tools whose input is not a shell string omit
   *  the method entirely. */
  extractShellCommand(input: I): string | null
  /** PR-2 self-audit fix (ADR-0078): structural declaration of the tool
   *  result's source sensitivity class for the secret-redaction gate.
   *  Mirrors the `extractShellCommand` pattern — tools that touch a
   *  filesystem path or run a shell command DECLARE their classifier here,
   *  rather than the dispatch seam guessing from `tool.name` / argument-field
   *  names. Returning `"secret"` causes the dispatch redaction layer to
   *  replace the entire tool result with `[REDACTED:source_class_secret]`
   *  before the model sees it; returning `"public"`/`"internal"` falls
   *  through to the Layer-2 deterministic-regex pattern matcher; returning
   *  `null` (or omitting the method) is identical to today's behavior
   *  (Layer-2 only, no source-class short-circuit). Pre-fix this lived in a
   *  hard-coded `PATH_TOOL_NAMES` / `COMMAND_TOOL_NAMES` set in dispatch.ts
   *  — a name-and-field-string heuristic that silently skipped any tool
   *  whose name wasn't `"Read"/"read"/"view_file"/"open_file"/"Bash"/...`.
   *  Declaration-based posture: a custom tool that adds a new file/command
   *  surface explicitly opts in by implementing this method. */
  classifySource(input: I): SensitivityClass | null
  /** ADR-0298 / T02 reconciliation — opt a NON-read-only tool into
   *  streaming-dispatch EARLY-START (Phase 1 in-flight overlap).
   *
   *  T02 (`streaming-dispatch.ts`) restricts early-start to tools that are
   *  read-only AND concurrency-safe, so a turn that ends in a `refusal` cannot
   *  have already committed a MUTATING side effect at the PARENT dispatch seam
   *  (e.g. `session_config` set_effort, `automation_update`). Those tools must
   *  stay deferred and must NOT implement this method.
   *
   *  `agent` is the deliberate exception: it is `isConcurrencySafe:true` but
   *  `isReadOnly:false` (it spawns a child loop that owns an unrestricted tool
   *  set). Its effects do NOT land at the parent seam — they happen INSIDE the
   *  child loop, behind the child's OWN dispatch gates and its OWN
   *  `AbortController`, with the parent's depth/budget guards already applied.
   *  Without this opt-in, T02's read-only gate silently serializes sibling
   *  `agent` fan-out (ADR-0296/0298), defeating the whole parallel-worker
   *  design. Implementing `isEarlyDispatchSafe: () => true` restores in-flight
   *  concurrency for agent fan-out WITHOUT loosening the parent-seam mutation
   *  guard for any other tool.
   *
   *  When omitted, the streaming-dispatch gate falls back to `isReadOnly()` —
   *  byte-identical to the T02 behavior. Returning `true` here means "early
   *  start is acceptable even though I am not read-only". */
  isEarlyDispatchSafe(): boolean
}

/**
 * jun-6 tool-interrupt-behavior — OPTIONAL per-tool interrupt policy. A THIRD
 * member of the per-tool-predicate family alongside `isReadOnly()` /
 * `isConcurrencySafe()` on {@link ToolCore}: a tool self-describes a property
 * the SCHEDULER (here, the abort-router in `@/agent`) consumes. Kept as its own
 * optional `Partial` arm (not a required `ToolCore` member) so the default is
 * absence-by-construction — exactly the {@link ToolSecurityHooks} shape.
 *
 * The dispatch abort-router reads it as `tool.interruptBehavior?.() ?? "cancel"`:
 *   - ABSENT / `"cancel"` ⇒ the raw `config.signal` is threaded into
 *     `ctx.signal` (legacy uniform turn-level cancel, BYTE-IDENTICAL). Every
 *     existing tool (`read`/`grep`/`glob`/`ls`/`bash`/…) is on this path.
 *   - `"block"` ⇒ the router threads a SUPPRESSIBLE derived signal and wires the
 *     {@link CriticalSectionSeam} so the tool can withhold the abort across its
 *     bounded atomic FS-mutating window only (see `ctx.criticalSection`).
 *     `write`/`edit` (and future atomic appliers) opt in here.
 *
 * `block` defers a cancel across ONE bounded window (a watchdog cap, RFC §4.3);
 * it can never veto an interrupt forever. The whole feature is additionally
 * gated OFF by the `QUANTA_TOOL_INTERRUPT_BLOCK` knob, so a tool returning
 * `"block"` while the knob is unset is byte-identical to `"cancel"`.
 */
export interface ToolInterruptPolicy {
  /** How an in-flight interrupt is handled while THIS tool's `execute` runs.
   *  Absent ⇒ `"cancel"` (legacy uniform behavior, byte-identical). */
  interruptBehavior(): "cancel" | "block"
}

/**
 * Optional result-shape contract (absorb #1). Wired into the registry/factory
 * seams but no built-in tool sets these today — they exist so a custom or
 * subagent-side tool can opt in WITHOUT changing dispatch. Removing one would
 * break its seam, NOT just its callers.
 *
 *   - `outputSchema`           → `factory.enforceOutputSchema` +
 *                                `registry.run` (also `@/subagent/tools-6`).
 *   - `toModelOutput`          → `factory.renderToolOutput` + `registry.run`.
 *   - `supportsDeferredResults` → `@/tool/deferred` registry + dispatch.
 *
 * @deprecated AS A GROUP — every field on this interface is currently set by
 * ZERO production tools (the subagent's external `outputSchema` use is the
 * only live consumer surface). The dispatch/factory wiring is retained because
 * deleting it risks breaking that external use; new built-in tools SHOULD NOT
 * opt in. Prefer: (a) put structured payloads in the `output` text directly,
 * (b) keep result rendering inside the tool (`result.output` IS the model-
 * facing text), (c) use the orchestrator's polling for long-running work
 * rather than an in-band deferred handle. If you genuinely need one of these,
 * file an ADR — the audit decision is to NOT delete (would break the seam,
 * not just callers) but also NOT to grow new use.
 */
export interface ToolResultShape<O = unknown> {
  /** @deprecated Schema for the tool's STRUCTURED result
   *  (`ToolResult.structured`). When present, the dispatch seam validates the
   *  structured payload via {@link validateToolOutput}; a mismatch is surfaced
   *  as an `ok:false` ToolResult instructing the model to retry — never thrown
   *  past the loop. Absent ⇒ no structured-output contract (byte-identical).
   *  No built-in tool sets this today; the subagent's external use is the
   *  only live consumer. Prefer placing structured data in `output` directly. */
  outputSchema: z.ZodType<O>
  /** @deprecated Produce a COMPACT, model-facing rendering of a result,
   *  distinct from the richer UI/`output` text, to save tokens. When absent
   *  the dispatch seam uses `result.output` as today (byte-identical). No
   *  built-in tool sets this today; keep rendering inside the tool so
   *  `result.output` is the single source of model-facing text. */
  toModelOutput(result: ToolResult): string
  /** @deprecated When `true`, this tool may return a deferred result (a
   *  `{type:"deferred"}` event or `ToolResult.deferred`) that a
   *  `DeferredResultRegistry` resolves later. Absent/false ⇒ synchronous only.
   *  No built-in tool sets this today; prefer the orchestrator's polling over
   *  in-band deferred handles. */
  supportsDeferredResults: boolean
}

/**
 * Optional streaming-input callbacks (absorb #1). Mirror of the LLM
 * `tool_use_start` / `tool_use_delta` / `tool_use_end` events. Wired into
 * `factory.driveStreamingInput` + `@/agent/tool-input-streaming`, but no
 * built-in tool sets these today. All three are individually optional and
 * side-effecting only — the parsed input is still passed to `execute`.
 *
 * @deprecated AS A GROUP — zero production tools set any of these. The
 * dispatch wiring is retained for a possible future opt-in (deleting would
 * break the seam, not just callers), but new built-in tools SHOULD NOT
 * implement them; let `execute(input, ctx)` receive the parsed input as
 * today. File an ADR if you have a real streaming-input use case.
 */
export interface ToolStreamingInput<I = unknown> {
  /** @deprecated No built-in tool implements this; the parsed input is
   *  delivered to `execute(input, ctx)` directly. */
  onInputStart(): void
  /** @deprecated No built-in tool implements this; the parsed input is
   *  delivered to `execute(input, ctx)` directly. */
  onInputDelta(delta: string): void
  /** @deprecated No built-in tool implements this; the parsed input is
   *  delivered to `execute(input, ctx)` directly. */
  onInputAvailable(input: I): void
}

/** Provider-agnostic schema the agent forwards to the LLM.
 *  `aliases` is a discovery-only hint used by the `ToolSearch` skill for
 *  lexical scoring (token + substring match at name-weight). It is NEVER
 *  forwarded to LLM provider adapters — both `@/llm/adapters/anthropic` and
 *  `@/llm/adapters/openai` explicitly project to `{ name, description,
 *  input_schema }` so the alias hint stays inside the tool catalog and the
 *  on-wire `tools` payload remains byte-identical for callers that omit
 *  `aliases`. */
export interface ToolSpec {
  name: string
  description: string
  input_schema: Record<string, unknown>
  aliases?: string[]
}

/**
 * SEAM-MIRROR STRUCTURAL HASH (literal anchor; no cross-slice import).
 *
 * The `@/tool` slice CANNOT import from `@/agent` or `@/permission` (RFC §3.1
 * slice fence; biome enforces structurally), so a direct cross-slice
 * `Equals<>`/`satisfies` compile check is impossible HERE. The closed-union
 * mirrors above (`GitWriteProtectReason`, `BlockerSurface`) are documented as
 * convention-only — reviewers verify on PR and a consumer-side round-trip test
 * in `tests/unit/` (which CAN see both slices) catches drift at test time.
 *
 * This `as const` tuple is a literal grep anchor: a future drift in the union
 * literal MUST be reflected here too, and a consumer-side test asserts the
 * tuple matches the producer's `ALL_*` array. The `satisfies` clauses below
 * are pure in-slice checks — they verify the tuple's literal set matches THIS
 * file's mirror exactly (catches drift between the mirror and the anchor).
 *
 * If you add a 6th `GitWriteProtectReason`:
 *   1. add the literal to the producer (`src/permission/git-write-guard.ts`).
 *   2. add it to the mirror union above.
 *   3. add it to this anchor tuple.
 *   4. extend `ALL_GIT_WRITE_PROTECT_REASONS` in the producer.
 * Steps 2-3 are local — the satisfies below will fail to compile if you skip
 * either. Steps 1+4 are caught by the consumer-side round-trip test.
 */
export const GIT_WRITE_PROTECT_REASONS_MIRROR = [
  "git_hooks",
  "git_hooks_dir",
  "git_config",
  "git_attributes",
  "editor_config",
] as const satisfies ReadonlyArray<GitWriteProtectReason>

export const BLOCKER_SURFACES_MIRROR = [
  "type",
  "owner",
  "wire",
  "test",
  "runtime",
  "build",
  "other",
] as const satisfies ReadonlyArray<BlockerSurface>

// In-slice structural check: every literal in the closed mirror union must
// appear in the anchor tuple. A `satisfies` on the other direction — every
// anchor entry is a valid union member — is enforced by the `as const
// satisfies ReadonlyArray<…>` above. Together they pin the set exactly.
type _GitWriteProtectReasonAnchorCoversUnion =
  GitWriteProtectReason extends (typeof GIT_WRITE_PROTECT_REASONS_MIRROR)[number]
    ? true
    : { error: "GIT_WRITE_PROTECT_REASONS_MIRROR is missing a union member" }
type _BlockerSurfaceAnchorCoversUnion =
  BlockerSurface extends (typeof BLOCKER_SURFACES_MIRROR)[number]
    ? true
    : { error: "BLOCKER_SURFACES_MIRROR is missing a union member" }
// Force evaluation — if either lookup degrades to the error object the
// assignment fails at `tsc`, producing the message above.
const _gitWriteProtectReasonAnchorCheck: _GitWriteProtectReasonAnchorCoversUnion = true
const _blockerSurfaceAnchorCheck: _BlockerSurfaceAnchorCoversUnion = true
void _gitWriteProtectReasonAnchorCheck
void _blockerSurfaceAnchorCheck
