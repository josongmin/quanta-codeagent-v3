import type { z } from "zod"
import type { SensitivityClass } from "@/security"
import type { HITLTier, ToolCapability } from "@/shared"
import type { WriteBudgetPort } from "./_shared/write-budget"
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
 *                           `edit` / both patch tools, called BEFORE touching
 *                           the FS.
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
  /** RFC02-0 — STABLE session/thread owner identity for background shells. The
   *  bash tool stamps this onto every background shell it detaches into the
   *  `BashBgRegistry` so a cross-session surface cannot kill another session's
   *  shell (only `killOwned(id, ownerId)` succeeds). Provided by the dispatch
   *  seam from `AgentConfig.sessionId`; NEVER derived from a shell id / PID /
   *  cwd. Absent (legacy caller / no session id) ⇒ the shell is unowned
   *  (listable but not owner-killable) — byte-identical for every caller that
   *  does not set a session id. Duck-typed so `@/tool` never imports `@/agent`. */
  ownerId?: string
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
  /** ADR-0296 PROMPT mode — OPTIONAL mid-execution consent requester. When the
   *  effective `timeout_behavior` is `prompt`, the bash tool calls this AT the
   *  deadline to surface a one-keystroke "move to background?" prompt; `true` ⇒
   *  detach into the bg registry, `false` ⇒ kill (legacy timeout). Duck-typed so
   *  `@/tool` never imports the host surface — the dispatch/CLI seam binds it
   *  (e.g. to the mid-turn approval channel). Absent ⇒ `prompt` falls back to
   *  plain `background` (auto-detach, no prompt). */
  requestBackgroundConsent?: (info: {
    readonly command: string
    readonly elapsedMs: number
  }) => Promise<boolean>
  /** ADR-0086 — OPTIONAL plan-exit requester. The `request_plan_exit` tool
   *  calls this to surface a finished plan to whoever decides (CLI prompt /
   *  IDE modal / RPC) and get back the 3-way {@link PlanExitToolOutcome}.
   *  Duck-typed so `@/tool` never imports `@/agent`: the dispatch seam builds
   *  the concrete requester from `AgentConfig.planExitPort` (wrapping
   *  `runPlanExitFlow`). Absent ⇒ the tool is not registered. */
  requestPlanExit?: PlanExitRequester
  /** OPTIONAL plan-ENTRY requester — the inverse of {@link requestPlanExit}.
   *  The `enter_plan_mode` tool calls this with the model's reason for switching
   *  into plan mode; the loop flips collaboration mode at the next turn boundary.
   *  Fire-and-forget (entry only restricts the agent, so no operator round-trip).
   *  Duck-typed so `@/tool` never imports `@/agent`: the dispatch seam wires it
   *  from `AgentConfig.onPlanEnterRequest`, gated on the same `planExitPort` slot
   *  as the exit tool. Absent ⇒ the tool is not registered. */
  enterPlanMode?: PlanEntryRequester
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
  /** ADR-0093 (draft) — OPTIONAL structured-plan mutator. The 5 structured
   *  plan tools (`current_plan` / `create_plan` / `update_todos` /
   *  `update_plan` / `remove_todos`) route through this duck-typed handle.
   *  `current_plan` reads via `current()`; the 4 siblings mutate. Duck-typed so `@/tool`
   *  never imports `@/agent/plan` (slice isolation, RFC 3.1): the dispatch
   *  seam adapts `AgentConfig.planStore` into a {@link PlanMutator}.
   *  Structural mirror of canonical `PlanStore` — every error-code and
   *  delta-kind is a string literal matching the producer's
   *  `PlanMutationError["kind"]` / `PlanDeltaKind`. Absent ⇒ the structured
   *  plan tools are NOT registered (default-OFF byte-identical for every
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
   *  agent's own SDK posture (effort tier, permission mode, identity mode,
   *  tool profile, model, provider). The dispatch seam wires this from
   *  `AgentConfig.sessionConfigPort`; when absent, `session_config` returns a
   *  typed `not_wired` failure (the tool itself is always registered in
   *  `buildDefaultTools` so the LLM can surface a coherent answer either way).
   *  Duck-typed (structural mirror of `SessionConfigSeam` in
   *  `./session_config`) so the `@/tool` slice never imports `@/agent`. */
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
  /** jun-7-misc 06 (ADR ≥0497) — OPTIONAL model-based fast-apply MERGE rung. The
   *  `edit` tool calls this ONCE when the deterministic ladder misses (exact +
   *  fuzzy both fail to anchor): it hands the apply model the CURRENT file +
   *  a terse edit sketch derived from `old_string`/`new_string` and gets back a
   *  full MERGED file PROPOSAL. The proposal is then re-verified IN the edit tool
   *  and MUST be explicitly approved through `fastApplyMergeReview` before its
   *  normal gated commit. A diff sink is observation-only and is never treated as
   *  approval. On missing/rejected/throwing review, `{ok:false}` / a port throw /
   *  or any verification miss the ladder falls through to the existing typed
   *  mismatch (byte-identical recovery). Duck-typed (structural mirror of
   *  `FastApplyPort` in `@/agent/fast-apply-fallback`) so `@/tool` never imports
   *  `@/agent`; the dispatch seam wires the concrete port from
   *  `AgentConfig.fastApplyMerge` when `QUANTA_FAST_APPLY_MERGE=1` AND
   *  `QUANTA_FAST_APPLY_MODEL` are both set. ABSENT (default) ⇒ the ladder is the
   *  byte-identical `exact → fuzzy → typed mismatch`, ZERO apply-model dispatch. */
  fastApplyMerge?: FastApplyMergeSeam
  /** Authority owner for a whole-file model merge. This is intentionally NOT
   * auto-wired from `QUANTA_FAST_APPLY_MERGE`: the environment gate selects a
   * capability, while the host must supply a real review decision over complete
   * pre/post bytes. Missing, false, or throwing ⇒ fail-closed mismatch. */
  fastApplyMergeReview?: FastApplyMergeReviewSeam
  /** jun-26 edit-escalate (frontier-parity) — OPTIONAL auto-escalation flag. When
   *  `true`, the `edit` tool runs the deterministic whitespace-tolerant fuzzy
   *  ladder on an exact MISS even when the caller did NOT set `input.fuzzy`
   *  (Claude Code / Codex both auto-retry whitespace-tolerant on exact-miss). The
   *  ladder is fail-closed (an ambiguous / no-confident result still returns
   *  `ok:false`, never a wrong write — wrong-edit > no-edit bias preserved), so
   *  the only behavior delta is recovering edits that differ from the file by
   *  whitespace alone. ABSENT / `false` (default) ⇒ fuzzy runs ONLY when
   *  `input.fuzzy === true` ⇒ BYTE-IDENTICAL legacy path. The dispatch seam wires
   *  this from `runtimeConfig().editAutoFuzzy` (`QUANTA_EDIT_AUTO_FUZZY === "1"`). */
  autoEscalateFuzzy?: boolean
  /** jul-13 edit-fresh-hash (self-inflicted-staleness fix, `QUANTA_EDIT_FRESH_HASH`).
   *  When true, a SUCCESSFUL `edit` appends the sha256 of the POST-edit bytes to
   *  its output so the model can chain a next edit to the same file WITHOUT a
   *  re-read (the post-edit bytes are already in memory as `planned.next`, so the
   *  hash costs no extra read). Root cause it fixes: sequential same-file edits
   *  invalidate the model's `expected_hash` — measured ~41% of edits on an
   *  edit-churn task hit `stale_precondition` purely from the model's OWN prior
   *  edit. ABSENT / `false` (default) ⇒ output BYTE-IDENTICAL to legacy. The
   *  dispatch seam wires this from `runtimeConfig().editFreshHash`. */
  editFreshHash?: boolean
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
  /** jun-6 exfil-rail (b) — OPTIONAL glob-in-write-path guard flag. When `true`
   *  (the dispatch seam threads it from `runtimeConfig().globWriteGuard`,
   *  `QUANTA_GLOB_WRITE_GUARD=1`), the `write`/`edit` tools reject a `path` that
   *  is a glob/wildcard pattern (`*`/`?`/`{a,b}`) with a typed `rejected` failure
   *  and the verbatim cc-cli message BEFORE any fs call. ABSENT / `false` ⇒ no
   *  glob check (byte-identical legacy path; a glob path is accepted as a literal
   *  filename exactly as before). A plain boolean (not a port) because the guard
   *  is a pure leaf predicate (`@/tool/_shared/glob-in-path`) the tool already
   *  owns — only the ENABLEMENT crosses the seam. */
  globWriteGuard?: boolean
  /** jun-6 exfil-rail (a) — OPTIONAL per-turn write/edit budget port. The
   *  `write`/`edit` tools call `recordWrite()` AFTER their existing guards; the
   *  returned verdict (`ok`/`confirm`/`deny`) gates the mutation. The budget
   *  fires ONLY in an untrusted-input turn (the host resolves `untrustedContext`
   *  from the untrusted-envelope gate) and ONLY past the configured per-turn cap
   *  (`QUANTA_WRITE_BUDGET_MAX`); the counter resets at each turn boundary (the
   *  dispatch seam binds the current `config.run?.turn`). ABSENT (knob off /
   *  non-wiring host) ⇒ omitted ⇒ the tool's `?.recordWrite()` is undefined and
   *  the write proceeds byte-identically (default-OFF). Duck-typed (the seam
   *  lives in `@/tool/_shared/write-budget`) so `@/tool` stays a leaf. */
  writeBudget?: WriteBudgetPort
  /** file_history_rewind — OPTIONAL per-file snapshot capture sink. The
   *  file-mutating tools (`write`/`edit`) call `record` with the file's NEW
   *  bytes after a successful mutation so the `file_history_rewind` tool can
   *  later restore that path to this exact version. Surfaced by the dispatch
   *  seam from `AgentConfig.fileHistory` ONLY when `QUANTA_FILE_HISTORY` is on
   *  (the host wires the SAME store the tool reads). ABSENT (gate OFF / non-
   *  wiring host) ⇒ omitted ⇒ the capture helper is a single `undefined` check
   *  and a no-op — zero capture, byte-identical legacy path (default-OFF). The
   *  sink resolves+jails the path internally (rejecting an escape) so the
   *  recorded key matches what the tool's `resolveJailed` produces. Duck-typed
   *  (structural mirror of the `@/tool/file-history` adapter) so `@/tool`'s
   *  hot-path types stay a leaf — same discipline as {@link ToolDiffSink}. */
  fileHistory?: FileHistorySink
  /** code-mode (RFC jun-6-code-mode, Phase 1) — OPTIONAL host dispatch port for
   *  the `code_cell` tool. The tool hands this verbatim to the `@/codemode`
   *  sandbox, which calls it for EVERY in-cell `tools.X(args)`. The ONLY
   *  implementation (`@/agent/codemode-wire.ts#buildCodeCellDispatchPort`)
   *  routes each call through the REAL `dispatchTool` with the loop's live
   *  permission/config — so a cell is N ordinary gated tool calls (the
   *  structural no-bypass invariant, §6.1). Surfaced by the dispatch seam from
   *  `AgentConfig.codeCellDispatchFactory` ONLY when `QUANTA_CODE_MODE` is on.
   *  ABSENT (gate OFF / non-wiring host) ⇒ the tool yields a typed `not_wired`
   *  failure (the tool is only REGISTERED when the port factory is present, so
   *  this is belt-and-braces). Duck-typed (structural mirror of `@/codemode`'s
   *  `CodeCellDispatchPort`) so `@/tool/types` stays a leaf — same discipline as
   *  {@link FileHistorySink} / {@link ToolDiffSink}. */
  codeCellDispatch?: CodeCellDispatchSeam
  /** code-mode (RFC jun-6-code-mode, Phase 2) — OPTIONAL FULL cell tool surface.
   *  The agent's ACTUAL registered tool names (`registry.toolNames()`), surfaced
   *  by the dispatch seam from `AgentConfig.codeCellSurfaceTools` ALONGSIDE
   *  {@link codeCellDispatch} ONLY when `QUANTA_CODE_MODE` is on. The `code_cell`
   *  tool hands this to the `@/codemode` sandbox so the cell binds `tools.<name>`
   *  for EVERY tool the agent has (each STILL re-gated through the dispatch port —
   *  the security invariant is unchanged; this only widens which tool NAMES are
   *  bound). A tool the agent lacks is absent from the list ⇒ unbound in the cell
   *  (the cell can never widen its own surface). ABSENT ⇒ the sandbox falls back
   *  to the Phase-1 3-tool surface (`read`/`grep`/`write`) — byte-identical for
   *  any caller that wired the port but not the surface. A `readonly string[]`
   *  (not a port) because it is a pure data snapshot the dispatch seam already
   *  holds (`config.registry`); no behavior crosses the seam. */
  codeCellSurface?: readonly string[]
  /** ticket-11 (P8 git-worktree agent tools) — OPTIONAL active-worktree VALUE.
   *  The session-scoped worktree slot's CURRENT value, projected by the dispatch
   *  seam from `AgentConfig.activeWorktreeSlot.current()`. When present, the
   *  shell-class (`bash`) and `edit` tools override their relative-resolution base
   *  with `worktreePath` so a RELATIVE write/command lands inside the worktree.
   *
   *  INVARIANT (NOT a trust-boundary redefinition): the worktree is a RELATIVE-cwd
   *  override ONLY. An ABSOLUTE path is STILL jailed to the SESSION jailRoot
   *  (`ctx.cwd`), never re-jailed to the worktree — `resolveEditBase` /
   *  `cwd = ctx.activeWorktree?.worktreePath ?? ctx.cwd` keep the session jail for
   *  absolute paths. ABSENT (gate OFF / no active worktree) ⇒ omitted ⇒ both tools
   *  use `ctx.cwd` exactly as today (byte-identical default-OFF). Duck-typed
   *  (structural mirror of `ActiveWorktree` in `@/tool/worktree`) so `@/tool/types`
   *  stays a leaf — same discipline as {@link FileHistorySink}. */
  activeWorktree?: ActiveWorktree
  /** ticket-11 (P8 git-worktree agent tools) — OPTIONAL mutable worktree-slot
   *  handle. The `enter_worktree` / `exit_worktree` / `worktree_status` tools read
   *  + mutate the SESSION-scoped slot through this seam: `enter` sets the slot
   *  (after creating/entering the worktree), `exit` clears it, `status` reads it.
   *  The dispatch seam wires the concrete session-scoped handle from
   *  `AgentConfig.activeWorktreeSlot` ONLY when `QUANTA_WORKTREE_TOOL` is on AND
   *  the host opted in (the worktree tools are REGISTERED only then). ABSENT ⇒ the
   *  tools yield a typed `not_wired` failure (belt-and-braces — they are not
   *  registered without the slot). The handle also carries the immutable session
   *  `repoRoot` / `sessionCwd` so the tools never re-derive a jail boundary.
   *  Duck-typed (structural mirror of `WorktreeSlotHandle` in `@/tool/worktree`)
   *  so `@/tool/types` stays a leaf — same discipline as {@link FileHistorySink}. */
  worktreeSlot?: WorktreeSlotHandle
}

/**
 * ROLE-SEGMENTED CONTEXT VIEWS (ISP). {@link ToolContext} is the flat SSOT seam
 * registry above (43 optional seams, one hand-documented paragraph each). But a
 * tool consumes only a small, role-cohesive slice of it — `bash` never touches
 * `planMutator`, the plan tools never touch `shellSnapshot`. These `Pick`-derived
 * views let a tool DECLARE the narrow slice it actually depends on
 * (`execute(input, ctx: EditToolContext)`) instead of the whole 43-field bag, so
 * the dependency surface a reader must reason about shrinks to the role.
 *
 * Derived via `Pick<ToolContext, …>` (NOT re-declared) so they CANNOT drift: a
 * renamed/removed seam is a compile error at the view, and every view is a
 * structural subtype of `ToolContext` (a tool typed against a view still receives
 * the full runtime context — the builder is unchanged). Add a seam to a role by
 * adding its key to the relevant `Pick` list here.
 */
export type CoreToolContext = Pick<
  ToolContext,
  "cwd" | "signal" | "depth" | "turnId" | "toolCallId"
>

/** Shell-class tools (`bash` + any future sibling): the exec-time seams. */
export type ShellToolContext = CoreToolContext &
  Pick<
    ToolContext,
    | "onShellEvent"
    | "requestBackgroundConsent"
    | "shellSnapshot"
    | "proxyEnv"
    | "localEnv"
    | "criticalSection"
    | "activeWorktree"
    | "vcsEventSink"
    // `bash` also reads: `agentLabel` (bg-process mailbox identity) and
    // `readFileState` (a `>`/`sed -i` redirect is a write, so it participates in
    // the stale-read guard). Kept here so `bash` narrows to this view exactly.
    | "agentLabel"
    | "readFileState"
    // RFC02-0 — the stable session owner stamped onto detached background
    // shells so kill is owner-scoped (see `ToolContext.ownerId`).
    | "ownerId"
  >

/** File-mutating tools (`write`/`edit`/`apply_patch`/`scripted_replace`/notebook). */
export type EditToolContext = CoreToolContext &
  Pick<
    ToolContext,
    | "gitWriteGuard"
    | "readFileState"
    | "fastApplyFallback"
    | "fastApplyMerge"
    | "fastApplyMergeReview"
    | "autoEscalateFuzzy"
    | "editFreshHash"
    | "globWriteGuard"
    | "writeBudget"
    | "fileHistory"
    | "toolDiff"
    | "activeWorktree"
    | "criticalSection"
  >

/** Plan-collaboration tools (create/update/remove todos, plan-enter/exit). */
export type PlanToolContext = CoreToolContext &
  Pick<ToolContext, "planMutator" | "requestPlanExit" | "enterPlanMode">

/** Subagent / mailbox / reviewer tools (identity + child-loop seams). */
export type SubagentToolContext = CoreToolContext &
  Pick<ToolContext, "agentLabel" | "parentAgentLabel" | "workingState" | "reviewerAgent">

import type {
  ActiveWorktree,
  BlockerSurface,
  CodeCellDispatchSeam,
  CriticalSectionSeam,
  FastApplyFallbackSeam,
  FastApplyMergeReviewSeam,
  FastApplyMergeSeam,
  FileHistorySink,
  GitWriteGuard,
  GitWriteProtectReason,
  PlanEntryRequester,
  PlanExitRequester,
  PlanMutator,
  ProgressSink,
  ReviewerRunner,
  SessionConfigSeam,
  ShellSnapshotRestoreSeam,
  ToolDiffSink,
  UserInputRequester,
  VcsEventSink,
  WorkingStateHandle,
  WorktreeSlotHandle,
} from "./types/context-seams"

/**
 * Re-export the FULL context-seam mirror surface (extracted to
 * `./types/context-seams.ts`) so every external importer of `@/tool/types`
 * keeps its byte-identical public API.
 */
export type {
  ActiveWorktree,
  BlockerSurface,
  CodeCellDispatchSeam,
  CriticalSectionHandle,
  CriticalSectionSeam,
  FastApplyAttemptResultMirror,
  FastApplyFailureKind,
  FastApplyFailureMirror,
  FastApplyFallbackSeam,
  FastApplyMergeResultMirror,
  FastApplyMergeReviewSeam,
  FastApplyMergeSeam,
  FileHistorySink,
  GitWriteGuard,
  GitWriteProtectReason,
  PlanDeltaKind,
  PlanEntryRequester,
  PlanExitRequester,
  PlanExitToolDecision,
  PlanExitToolOutcome,
  PlanMutationErrorCode,
  PlanMutationResult,
  PlanMutator,
  PlanMutatorNewTodo,
  PlanMutatorTodoPatch,
  PlanReadonlyView,
  ProgressSink,
  ProgressUpdateMirror,
  ReviewerRequest,
  ReviewerResult,
  ReviewerRunner,
  SessionConfigSeam,
  ShellSnapshotRestoreSeam,
  ToolDiffSink,
  UserInputOutcome,
  UserInputRequester,
  VcsEventMirror,
  VcsEventSink,
  WorkingStateHandle,
  WorkingStatePatch,
  WorkingStateSnapshot,
  WorktreeSlotHandle,
} from "./types/context-seams"

import type { ToolEvent, ToolResult } from "./types/tool-result"

/**
 * Re-export the FULL tool-result / tool-failure surface (extracted to
 * `./types/tool-result.ts`) so every external importer of `@/tool/types` keeps
 * its byte-identical public API.
 */
export type {
  DeferredHandle,
  DeferredToolResult,
  DenyLayerMirror,
  DenyPillarMirror,
  DenyReasonValue,
  DenyStackSourceMirror,
  NextAction,
  SandboxViolationReason,
  ToolEvent,
  ToolFailure,
  ToolResult,
  ToolResultEvidence,
} from "./types/tool-result"

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
  /** PDP capability declaration (jun-10, P2-T3). Optional, additive: the SSOT for
   *  WHY a tool needs a confirm, read by the security-floor decider
   *  (`@/permission` `decideFloor`). A tool that declares `confirm: "sensitive"`
   *  joins the UNIVERSAL always-confirm floor — confirmed on every surface,
   *  even under bypass, even without the HITL opt-in. `needs-sandbox` (e.g. bash
   *  without a profile) DEFERS to the sandbox / mode layer. Absent ⇒ defer
   *  (byte-identical legacy). Per-input so a tool can vary it. */
  capability?(input: I): ToolCapability
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
 * seams so a tool can opt in WITHOUT changing dispatch. Removing a field would
 * break its seam, NOT just its callers. See STATUS below for per-field live use.
 *
 *   - `outputSchema`           → `factory.enforceOutputSchema` +
 *                                `registry.run` (also `@/subagent/tools-6`).
 *   - `toModelOutput`          → `factory.renderToolOutput` + `registry.run`.
 *   - `supportsDeferredResults` → `@/tool/deferred` registry + dispatch.
 *
 * STATUS — do NOT treat this interface as dead:
 *   - `toModelOutput` IS LIVE: set by the `apply_patch_structured` production
 *     tool (`makeApplyPatchStructuredTool`, `apply-patch-structured-tool.ts`),
 *     which is conditionally registered at `index.ts` when
 *     `ports.structuredPatch === true` (ADR-0464). Deleting the seam breaks a
 *     live tool, not just a latent one.
 *   - `outputSchema` has an external live consumer surface: the subagent's
 *     `output_schema` use (`@/subagent/tools-6`).
 *   - `supportsDeferredResults` is set only by the `defineToolAsync` helper
 *     (`async-helper.ts`), not by any registered tool — no live in-tree
 *     consumer today.
 * The dispatch/factory wiring is retained; new built-in tools SHOULD still be
 * conservative here. Prefer: (a) put structured payloads in the `output` text
 * directly, (b) keep result rendering inside the tool (`result.output` IS the
 * model-facing text) unless a compact model rendering genuinely helps (as
 * `apply_patch_structured` does), (c) use the orchestrator's polling for
 * long-running work rather than an in-band deferred handle.
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
  /** Produce a COMPACT, model-facing rendering of a result, distinct from the
   *  richer UI/`output` text, to save tokens. When absent the dispatch seam
   *  uses `result.output` as today (byte-identical). LIVE: set by the
   *  `apply_patch_structured` tool to render its per-file `AppliedChange[]` so
   *  the model can self-correct only the failed file(s). Other tools should
   *  keep rendering inside the tool so `result.output` is the single source of
   *  model-facing text unless a compact model rendering genuinely helps. */
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
