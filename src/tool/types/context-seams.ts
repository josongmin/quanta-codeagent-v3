/**
 * Duck-typed context-seam mirrors for the `@/tool` slice (extracted from
 * `./types.ts` to keep that module under the god-module line threshold).
 *
 * Every type here is an OPTIONAL, DUCK-TYPED SEAM mirror surfaced on
 * {@link ToolContext} (in `../types`): the agent slice (or another slice)
 * injects a concrete service into the tool slice through one of these shapes
 * WITHOUT `@/tool` importing the providing slice — the slice-isolation
 * discipline `biome` enforces structurally (RFC §3.1). `@/tool` must NEVER
 * `import type` from `@/agent`, `@/permission`, `@/subagent`, etc.; these
 * structural mirrors are the in-slice stand-ins.
 *
 * The complete original public surface is RE-EXPORTED verbatim from `../types`
 * so every external importer of `@/tool/types` stays byte-compatible.
 */

/** ticket-11 — duck-typed mirror of the ACTIVE-worktree value the worktree tools
 *  set on the session slot. Read by the `bash`/`edit` tools as the relative-cwd
 *  override (see {@link ToolContext.activeWorktree}). The session producer
 *  (`@/agent`) sets a structurally-equal value; a renamed/removed field is caught
 *  by the consumer-side test in `tests/unit/tool/worktree/*` (which CAN see both
 *  slices). */
export interface ActiveWorktree {
  /** Absolute path of the worktree the relative-cwd override points at. */
  readonly worktreePath: string
  /** Branch the worktree is checked out on. */
  readonly branch: string
  /** True ⇒ a PERSISTENT worktree (NOT auto-removed on exit; the operator owns
   *  lifecycle). False ⇒ a THROWAWAY worktree (auto-removed on clean exit). */
  readonly isPersistent: boolean
  /** Repo root the worktree belongs to (the session repo). */
  readonly repoRoot: string
  /** Where the worktree branched from: `"head"` (current HEAD) or `"fresh"`
   *  (origin/<default>). Recorded so `worktree_status` can surface it. */
  readonly branchFrom: "fresh" | "head"
}

/** ticket-11 — duck-typed mutable worktree-slot handle injected via
 *  {@link ToolContext.worktreeSlot}. The worktree tools (`enter`/`exit`/`status`)
 *  are the ONLY mutators; the slot is session-scoped (one per session) so a worktree
 *  entered in one turn is visible to `bash`/`edit` in later turns of the same
 *  session. Kept HERE so the `@/tool` slice stays a leaf (the `@/agent` composition
 *  root builds the concrete session-scoped holder). NO-THROW on the pure
 *  accessors; `set`/`clear` are synchronous (the async git work happens in the
 *  tool BEFORE it calls `set`). */
export interface WorktreeSlotHandle {
  /** Current active worktree, or `undefined` when none is entered. */
  current(): ActiveWorktree | undefined
  /** Record the entered worktree as the session's active one. Replaces any
   *  prior value (the tool refuses a duplicate enter BEFORE calling this). */
  set(value: ActiveWorktree): void
  /** Clear the active worktree (called by `exit_worktree` after teardown). */
  clear(): void
  /** Immutable session repo root (the git repo the session runs in). */
  readonly repoRoot: string
  /** Immutable session cwd — the SESSION jail root. Absolute paths in `bash`/
   *  `edit` jail to THIS, never to the worktree (the trust-boundary invariant). */
  readonly sessionCwd: string
}

/** code-mode (RFC jun-6-code-mode, Phase 1) — duck-typed mirror of
 *  `CodeCellDispatchPort` from `@/codemode` (kept HERE so `@/tool/types` stays a
 *  slice leaf — same discipline as {@link FileHistorySink}). `(name, input) =>
 *  Promise<{ ok, content }>`: the host has already run the FULL `dispatchTool`
 *  pipeline (admissibility gate / HARD_DENY / plan-mode / redaction) and
 *  collapsed the result to the model-facing `content` (already redacted) + an
 *  `ok` flag. NO-THROW at the port boundary by contract. */
export type CodeCellDispatchSeam = (
  name: string,
  input: unknown,
) => Promise<{ readonly ok: boolean; readonly content: string }>

/** file_history_rewind — duck-typed per-file snapshot sink injected via
 *  {@link ToolContext}. Structural mirror of the `@/tool/file-history` store
 *  adapter (kept HERE so the hot-path tool types stay a leaf — same discipline
 *  as {@link ToolDiffSink}). `record` is NO-THROW at the port boundary by
 *  contract; a mutating tool calls it INSIDE a guard so a misbehaving sink can
 *  never break a successful mutation. The sink resolves + jails `path` against
 *  `cwd` internally and silently drops an escape (the mutation already
 *  succeeded; a capture failure must never surface as a tool failure). */
export interface FileHistorySink {
  record(input: { readonly path: string; readonly cwd: string; readonly content: string }): void
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
    /** RFC-12 SURFACE B PRODUCER — the reviewed diff's ANCHORED findings, handed
     *  by `git_review_diff` so the daemon-side sink projects them onto the render
     *  overlay (`reviewFindingsToAnchors`). ADDITIVE + OPTIONAL: the `write`/`edit`
     *  capture path omits it ⇒ the daemon emits NO `anchors` key (byte-identical
     *  non-review diff). Typed via the {@link ReviewFindingMirror} structural
     *  mirror so `@/tool` stays a leaf (no `@/apps/web-daemon` import). */
    readonly findings?: readonly ReviewFindingMirror[]
  }): void
}

/** RFC-12 SURFACE B PRODUCER — structural mirror of the render-relevant subset of
 *  `@/tool/git/review-diff`'s `ReviewFinding` that the daemon-side
 *  `reviewFindingsToAnchors` projection reads. Kept HERE (in the seam mirror) so
 *  the duck-typed {@link ToolDiffSink} shape does not force `@/tool/types` to
 *  depend on `@/tool/git`; the concrete producer passes a real `ReviewFinding[]`
 *  (a structural supertype of this) through the seam. */
export interface ReviewFindingMirror {
  readonly file: string
  readonly severity?: "info" | "warning" | "error"
  readonly what: string
  readonly verdict?: "confirmed" | "plausible"
  readonly category?: string
  readonly shortSummary?: string
  readonly anchor?: {
    readonly path: string
    readonly line: number
    readonly hunkId: string
    readonly beforeHash: string
    readonly afterHash: string
  }
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

/** jun-7-misc 06 (ADR ≥0497) — duck-typed mirror of `FastApplyPort` (the MERGE
 *  direction) from `@/agent/fast-apply-fallback`, kept HERE so `@/tool` stays
 *  slice-isolated from `@/agent` (RFC §3.1; biome enforces) exactly as
 *  {@link FastApplyFallbackSeam} mirrors the re-emit port above. Distinct from
 *  the re-emit seam: where re-emit returns a fresh V4A `newPatch`, this returns
 *  the full MERGED file. `apply` is NO-THROW at the port boundary (the producer
 *  collapses every dep/verification failure to `{ ok:false, merged:null }`); the
 *  consumer (`edit`) additionally guards a port that breaks its contract by
 *  throwing, and NEVER writes `merged` without its own edit-scoped verification
 *  + the normal gated commit path. A new field requires updating BOTH the
 *  producer (`FastApplyMergeResult`) AND this mirror. */
export interface FastApplyMergeResultMirror {
  readonly ok: boolean
  readonly merged: string | null
  readonly rationale: string
  readonly modelUsed?: string
}

/** Structural mirror of `FastApplyPort` (merge direction). */
export interface FastApplyMergeSeam {
  apply(
    input: { original: string; editSketch: string; path?: string },
    signal?: AbortSignal,
  ): Promise<FastApplyMergeResultMirror>
}

/** Mandatory authority boundary for a model-produced whole-file merge. The
 * deterministic edit ladder can prove an exact/fuzzy replacement, but cannot
 * prove that an arbitrary full-file proposal preserved unrelated semantics.
 * A host that intentionally enables the merge rung must therefore supply an
 * explicit reviewer which sees the complete before/after payload. Absent,
 * reject, or throw is deny — the edit falls back to its typed mismatch and no
 * model proposal reaches disk. */
export interface FastApplyMergeReviewSeam {
  approve(input: {
    readonly path: string
    readonly before: string
    readonly after: string
    readonly editSketch: string
  }): Promise<boolean>
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
  readonly readPermissionMode?: () => string
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

/** Slice-safe mirror of `ProjectedPlanTask` from `@/agent/plan/task-projection`.
 *  RFC07-3 Claude-compatible read alias over the canonical plan: `owner` is the
 *  `assignee` (omitted when absent), `blockedBy` is the canonical inbound
 *  dependency edge, and `blocks` is the reverse edge (ids this task blocks).
 *  These are READ-ONLY derived views — never stored, never mutation fields.
 *  MIRROR INVARIANT: adding a field here MUST also add it to the producer
 *  `ProjectedPlanTask`. */
export interface ProjectedPlanTaskView {
  readonly id: string
  /** RFC12-1 — the todo's display title (mirrors `ProjectedPlanTask.title`), so
   *  a graph render can label the node. Display-only; never write vocabulary. */
  readonly title: string
  /** RFC12-1 — the todo's lifecycle status (mirrors `ProjectedPlanTask.status`),
   *  so a graph render can class the node. Restated as the closed 5-literal union
   *  (slice fence: `@/tool` must not import `@/agent/plan`). */
  readonly status: "pending" | "in_progress" | "completed" | "cancelled" | "blocked"
  readonly owner?: string
  readonly blockedBy: readonly string[]
  readonly blocks: readonly string[]
}

/** Readonly summary view of the current plan (size signals + meta) — the
 *  surface tools can poll without dragging the whole plan through the seam.
 *  Full plan-state lives behind the producer; cross-slice flow stays by-value.
 *  `tasks` is the RFC07-3 owner/blockedBy/blocks read projection in canonical
 *  (`createdAt`, then `id`) order; it carries no new write vocabulary. */
export interface PlanReadonlyView {
  readonly version: number
  readonly name: string
  readonly overview: string
  readonly isProject: boolean
  readonly todoCount: number
  readonly phaseCount: number
  readonly tasks: readonly ProjectedPlanTaskView[]
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

/** Requester the `enter_plan_mode` tool invokes. Relays the model's reason for
 *  switching into plan mode; the loop applies the flip at the next turn
 *  boundary. Fire-and-forget (no operator round-trip): entry only RESTRICTS the
 *  agent to read-only, so unlike {@link PlanExitRequester} it returns nothing. */
export type PlanEntryRequester = (reason: string) => void

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

/** RFC-03 C3 — the proposal surfaced to the operator when a MODEL-originated
 *  objective mutation is gated (`QUANTA_PROPOSE_GOAL` ON). `operation` is the
 *  closed objective operation kind (`set` / `updateStatus` / `markCriterion` …)
 *  stringified so `@/tool` needs no `@/objective` value import; `goal` is the
 *  proposed goal text for a set/replace (absent for other operations); `summary`
 *  is a dialog-readable one-line description the surface renders verbatim. */
export interface ObjectiveApprovalRequest {
  readonly operation: string
  readonly goal?: string
  readonly summary: string
}

/** RFC-03 C3 — the CLOSED approval outcome. `admitted:true` is the ONLY thing
 *  that lets a gated model mutation commit; `admitted:false` is a plain decline
 *  (optionally carrying the operator's corrective `note`, e.g. a deny-and-steer
 *  message). The tool NEVER fabricates an `admitted:true`. */
export type ObjectiveApprovalDecision =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly note?: string }

/** RFC-03 C3 — the HITL adapter port. The dispatch seam builds it from the
 *  existing host `onConfirm` authority; the objective tool adapter invokes it
 *  between `prepare` and `commit` (no store lock held across the wait). */
export type ObjectiveApprovalRequester = (
  request: ObjectiveApprovalRequest,
) => Promise<ObjectiveApprovalDecision>

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
