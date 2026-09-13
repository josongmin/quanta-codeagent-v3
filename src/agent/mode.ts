import type { ToolAction } from "@/permission"
import {
  InvalidModeTransitionError,
  PlanModeMutatingBlockedError,
  UnknownToolError,
} from "./mode-errors"
import type { AgentMode } from "./prompt"

export {
  InvalidModeTransitionError,
  PlanModeMutatingBlockedError,
  UnknownToolError,
} from "./mode-errors"

/**
 * Mode policy (Codex `mode-and-plan-process-audit.md` absorption — Phase 3).
 *
 * Mode is more than a prompt nudge: it controls tool admissibility at the
 * dispatch seam. `plan`, `review`, and `audit` are all READ-ONLY task postures
 * (Codex's checkpoint-and-choose / findings-first / contract-vs-truth shapes
 * all forbid mutating side effects mid-loop). `default` is the legacy
 * assume-and-execute posture: mutating tools allowed.
 *
 * This file generalizes the prior `plan.ts` boolean gate into a typed enum
 * gate. `plan.ts` is kept as a thin deprecated alias so existing callers
 * compile unchanged; dispatch and new callers should route through this
 * module.
 */

/** Modes that PERMIT mutating tools. Phrased as a positive (mutating-allowed)
 *  set rather than the inverse (read-only) so the default for any UNKNOWN
 *  mode value at runtime is to BLOCK mutating tools — fail-closed. A future
 *  read-only mode addition (e.g. "debug") gets the safe posture automatically
 *  even if someone forgets to update this gate; an inverse `READ_ONLY_MODES`
 *  list would silently grant write access to the new mode.
 *
 *  ADR-0211 additions:
 *    - `editor` — minimal-diff MUTATING posture (Cline+Roo "Act" analog). Tools
 *      that mutate are PERMITTED; the prompt posture nudges minimal surgical
 *      edits. Added explicitly here so future SOTA "minimal-diff" variants
 *      stay write-capable without re-touching every read-only mode gate.
 *    - `architect` is INTENTIONALLY OMITTED — it inherits fail-closed posture
 *      (read-only by default), same as plan/review/audit. */
const MUTATING_MODES = new Set<AgentMode>(["default", "editor"])

/** Resolve the effective mode from the new `mode` field and the legacy
 *  `planMode` boolean. `mode` wins when present so callers can migrate
 *  incrementally without breakage; absent ⇒ `planMode:true` maps to `"plan"`;
 *  both absent ⇒ `"default"`. Mirrors the same precedence used by
 *  `buildTurnContext` so prompt + dispatch never disagree on the active mode. */
export const resolveAgentMode = (
  mode: AgentMode | undefined,
  planMode: boolean | undefined,
): AgentMode => {
  if (mode !== undefined) return mode
  if (planMode === true) return "plan"
  return "default"
}

/** Shape every live-mode consumer reads. Structural so `AgentConfig`, the
 *  turn-context input, and the admissibility-gate config all satisfy it without
 *  importing each other. */
export interface AgentModeSource {
  readonly mode?: AgentMode
  readonly planMode?: boolean
  readonly agentModeState?: { get(): AgentMode }
}

/** §17 packet M — the ONE resolution every consumer must use.
 *
 *  Precedence: the LIVE reader wins, then the fixed `mode`, then legacy
 *  `planMode`. The live reader is what makes a mid-session posture flip real —
 *  without it the CLI's `shift+tab` PLAN rung repainted the chrome while the
 *  agent kept full write capability, because `agentMode` reached a status pill
 *  and nothing else.
 *
 *  Read ONCE per turn by each consumer; never mid-turn. */
export const resolveLiveAgentMode = (source: AgentModeSource): AgentMode => {
  const live = source.agentModeState?.get()
  if (live !== undefined) return live
  return resolveAgentMode(source.mode, source.planMode)
}

/** True iff `mode` forbids mutating tools and `action` is mutating. Read-only
 *  actions pass through every mode unchanged. Fail-closed: a mode that is NOT
 *  in {@link MUTATING_MODES} (including any unknown runtime value) blocks
 *  mutating tools — a new mode forgotten by a future PR ships safe by default. */
/** THE mode predicate, stated over the one fact it actually needs: is the tool
 *  read-only?
 *
 *  Both the DISPATCH gate and the model's VISIBLE tool list must answer this the
 *  same way, or the model is advertised tools that will be refused — the
 *  "see-but-can't-call fumble" the skill-scope filter already avoids. Dispatch
 *  reads `action.isReadOnly`, which is exactly `registry.isReadOnly(name)`, so
 *  the visible-spec filter can consult the same predicate with the same value.
 *
 *  Fail-closed: a mode NOT in {@link MUTATING_MODES} — including any unknown
 *  runtime value — blocks mutating tools, so a mode a future PR forgets ships
 *  safe. */
export const isToolBlockedInMode = (mode: AgentMode, isReadOnly: boolean): boolean =>
  !isReadOnly && !MUTATING_MODES.has(mode)

export const isMutatingToolBlockedInMode = (mode: AgentMode, action: ToolAction): boolean =>
  isToolBlockedInMode(mode, action.isReadOnly)

/** True iff `mode` PERMITS mutating tools (a write-capable posture). SSOT
 *  membership check over {@link MUTATING_MODES}: `default`/`editor` are mutating;
 *  `plan`/`review`/`audit`/`architect` (and any unknown mode) are read-only
 *  (fail-closed, mirroring {@link isMutatingToolBlockedInMode}). Used by the
 *  subagent runner's most-restrictive mode clamp so a repo-controlled named-agent
 *  `mode:` can never RELAX a read-only parent into a write-capable child. */
export const isMutatingMode = (mode: AgentMode): boolean => MUTATING_MODES.has(mode)

/** Human-readable rationale for the deny message returned when a mutating
 *  tool is blocked. Used by dispatch so the LLM gets a specific reason ("in
 *  review mode") instead of a generic refusal. */
export const modeBlockReason = (mode: AgentMode, toolName: string): string =>
  `blocked in ${mode} mode: ${toolName}`

/* ───────────────────────── ADR-0036 (Plan vs Default collaboration mode) ──
 *
 * Plan vs Default collaboration mode (Codex `codex-collaboration-mode-pattern`
 * absorption). This narrower 2-mode collaboration enum is layered ON TOP of
 * the existing 4-mode `AgentMode` (default/plan/review/audit) without changing
 * any of the legacy exports. It exists to make ONE specific guarantee explicit:
 *
 *   In `plan` collaboration mode, mutating tools are blocked at the dispatch
 *   seam BEFORE any tool implementation runs. The block is driven by an
 *   explicit per-tool table — unknown tools throw rather than silently fall
 *   into the "non-mutating" bucket, so a future tool addition cannot bypass
 *   the gate by being forgotten.
 *
 * Sticky transition: collaboration mode flips ONLY on a developer-channel
 * message that carries an explicit `mode=plan` / `mode=default` directive.
 * No silent "the LLM thinks it should be plan now" drift; no fallback path.
 *
 * Wiring into `loop.ts` is intentionally out of scope for this cluster
 * (see ADR-0036 §한계). The exports here are standalone-callable so the
 * follow-up that adds the seam can do so as a pure import-and-call patch.
 */

/** Plan vs Default collaboration mode (ADR-0036). Distinct from {@link
 *  AgentMode} on purpose — `AgentMode` is the 4-mode posture enum tied to the
 *  prompt (default/plan/review/audit). `CollaborationMode` is the 2-mode
 *  permission-shape enum tied to the dispatch seam. They overlap on the words
 *  "default" and "plan" but are NOT the same field. */
export type CollaborationMode = "default" | "plan"

/** Kinds of mutating tools recognized at the dispatch seam (ADR-0036).
 *
 *   - `write_filesystem`: creates or overwrites files in the working tree
 *     (`write`, `edit`, `scripted_replace`).
 *   - `bash_mutating`: shell commands routed through `bash`. Any `bash` call
 *     is treated as mutating in plan mode — the dispatch seam cannot inspect
 *     the command text deeply enough to be sure read-only `ls`/`cat` is not
 *     hiding a mutating side effect (process spawn, env write, network).
 *   - `git_mutating`: mutating git tools. Shipped: `git_commit` (regular +
 *     wip-checkpoint modes) and `git_branch_switch` (ADR-0053, Claude
 *     Desktop 1.7196.3 `commitWipForBranchSwitch` absorption). Also covers
 *     the `gh_pr_*` write surfaces — they shell out via `gh` to push
 *     comments / open PRs / enable auto-merge, mutating the remote VCS.
 *     Read-only git tools are `git_status`/`git_log`/`git_diff`/`git_blame`.
 *   - `network_write`: outbound network writes (none ship today — MCP/HTTP
 *     write surfaces). Reserved for the same reason as `git_mutating`.
 *   - `working_state_write`: mutates the durable working-state surface (e.g.
 *     `update_working_state`). Permitted in default mode; blocked in plan
 *     mode because plan mode's contract is to PROPOSE state changes, not
 *     commit them mid-turn.
 *   - `memory_mutating`: writes to the durable memory layer
 *     (`memory_write` / `memory_update`). Distinct from `working_state_write`
 *     because memory survives turns and powers retrieval — plan mode must not
 *     poison future recalls with PROPOSED-but-not-committed facts.
 *   - `subagent_spawn`: spawns a child agent (`agent` tool). The child runs
 *     its OWN unrestricted tool set; plan mode must block at the parent seam
 *     because the spawn-time CollaborationMode does not propagate into the
 *     fork's loop (the child would happily mutate). Mirrors `bash_mutating`'s
 *     "cannot introspect the side effect" rationale.
 *   - `subagent_control`: bilateral subagent control surfaces (e.g.
 *     `task_stop` — cancels a running background subagent). Cancellation is
 *     itself a state mutation against the child + the in-memory `TaskRegistry`;
 *     plan mode forbids by the same "propose-not-commit" rule that blocks
 *     `update_working_state`.
 *   - `plan_control`: reserved for future host-only collaboration-mode
 *     controls. The model-facing `request_plan_exit` tool is INTENTIONALLY
 *     not classified under this kind once the loop owns the follow-through:
 *     it is the explicit plan-review exit seam (ADR-0086/0095), and after an
 *     approval the loop flips into default mode at the NEXT turn boundary.
 */
export type MutatingToolKind =
  | "write_filesystem"
  | "bash_mutating"
  | "git_mutating"
  | "network_write"
  | "working_state_write"
  | "memory_mutating"
  | "subagent_spawn"
  | "subagent_control"
  | "plan_control"

/** Explicit per-tool classification table (ADR-0036). EVERY tool name known
 *  to the v3 registry MUST appear here — `mode-mutating-table.test.ts`
 *  cross-checks this against `defaultTools` so adding a tool without updating
 *  the table fails CI. `null` = read-only; otherwise the {@link
 *  MutatingToolKind} that classifies the mutating effect.
 *
 *  The table is intentionally inverse of the registry's `isReadOnly()` so
 *  that adding a mutating tool without classifying its kind here is a
 *  COMPILE-OR-TEST failure, not a silent dispatch-seam bypass. */
const MUTATING_TOOL_TABLE: Readonly<Record<string, MutatingToolKind | null>> = Object.freeze({
  // Read-only built-ins
  read: null,
  grep: null,
  find_references: null, // ripgrep whole-word ref search — read-only, like grep
  glob: null,
  localize: null,
  diagnostics: null,
  // `test_runner` is NOT read-only and is classified MUTATING, like `run_tests` and
  // `collect_evidence`, which do the same thing.
  //
  // It used to be `null`, justified as "the canonical inner-loop action" whose command
  // "still faces the HARD_DENY denylist". Plan mode has TWO layers and they disagreed:
  // the admissibility gate blocks every non-read-only tool when the live AGENT mode is
  // `plan`, while the collaboration seam (`consultPlanModeSeam`) consults only this
  // table when `collaborationMode` is `plan` and the live mode is not. MEASURED in the
  // second posture: `test_runner { command: "echo pwned > src/x.ts" }` ran with zero
  // confirms under acceptEdits, because HARD_DENY is a destructive-command denylist
  // (it caught `rm -rf /`), not a write barrier. A `null` here was a write exemption
  // for the weaker layer only, so both layers now block.
  test_runner: "bash_mutating",
  lsp_definition: null,
  lsp_references: null,
  lsp_hover: null,
  lsp_type_definition: null,
  lsp_implementation: null,
  lsp_document_symbol: null,
  lsp_workspace_symbol: null,
  lsp_rename_preview: null,
  // jun-6 wave-2 — call-hierarchy navigation. Read-only LSP queries (no edit),
  // so plan-mode safe (null).
  lsp_incoming_calls: null,
  lsp_outgoing_calls: null,
  git_status: null,
  git_log: null,
  git_diff: null,
  git_blame: null,
  // Read-only fault-localization aids (Codex signal absorption): structure +
  // log-parse + churn/ownership. All read-only — safe in plan mode.
  file_tree_summary: null,
  parse_test_failure: null,
  git_churn: null,
  git_blame_heatmap: null,
  // Read-only upstream-divergence check (v0 chat=branch absorption, #5).
  git_upstream_check: null,
  // Read-only isolated-reviewer over a git diff (Claude Desktop `reviewDiff`
  // absorption, ADR-0111). The reviewer sub-agent itself is read-only by the
  // tool's REVIEWER_TOOL_FILTER; safe in plan mode.
  git_review_diff: null,
  // Read-only moved-code classifier (ADR-0109) + conflict inspector (ADR-0111).
  // Pure analysis over a diff / conflict-marked tree; both safe in plan mode.
  git_moved_code: null,
  git_conflict_inspect: null,
  // Read-only vision + web (ADR-0126 / ADR-0127). Both safe in plan mode.
  read_image: null,
  web_fetch: null,
  // Read-only document/structured-data tools (ADR-0133/0137). All five are
  // pure parse-and-render of disk-resident docs — no FS writes, no shell, no
  // network. Safe in plan mode by construction.
  csv_read: null,
  ndjson_read: null,
  yaml_read: null,
  pdf_read: null,
  xlsx_read: null,
  // jun-04 document READERS (pure unzip + OOXML parse; read-only, plan-safe).
  docx_read: null,
  pptx_read: null,
  // jun-04 read-only observability tools (pure in-memory / disk-read; plan-safe).
  // Caller-wire-time (coverage_check gated on DefaultToolPorts.coverageCheck;
  // prompt_cache_status gated on a wired observer) — entries are PERMANENT so
  // plan-mode dispatch never trips UnknownToolError when a host registers them.
  coverage_check: null,
  prompt_cache_status: null,
  // jun-04 Office AUTHORING writers (H14b/H14 — gated on DefaultToolPorts.
  // officeAuthoring) + image_gen (H14a — gated on DefaultToolPorts.imageGen).
  // All WRITE generated artifacts to the filesystem ⇒ block in plan mode.
  // PERMANENT entries (caller-wire tools): a host that injects them MUST NOT
  // crash plan-mode dispatch.
  xlsx_write: "write_filesystem",
  docx_write: "write_filesystem",
  pptx_write: "write_filesystem",
  image_gen: "write_filesystem",
  // Mutating built-ins
  write: "write_filesystem",
  edit: "write_filesystem",
  scripted_replace: "write_filesystem",
  // apply_patch (Wave C V4A): multi-file atomic patch — same write posture as
  // edit/write/scripted_replace; blocks in plan mode (plan PROPOSES, not commits).
  apply_patch: "write_filesystem",
  bash: "bash_mutating",
  // ADR-0296 async-shell siblings to `bash`. `bash_await` is pure polling over
  // an in-memory registry — read-only (safe in plan mode). `bash_kill` signals
  // a process (SIGTERM → SIGKILL), classified as `bash_mutating` because the
  // kill itself is irreversible like a destructive shell call.
  bash_await: null,
  bash_kill: "bash_mutating",
  update_working_state: "working_state_write",
  // ADR-0097 — `request_user_input` 는 port-gated 조건부 등록 (features.ts:
  // `userInputPort` 가 wired 될 때만 registry 에 inject). 그러나 표 엔트리는
  // PERMANENT: 어떤 호스트가 직접 도구를 등록해도 `isMutatingTool` 이
  // `UnknownToolError` 를 던지면 plan-mode dispatch 가 깨짐 (도구 자체는
  // 호스트 port 를 통한 운영자 입력만 — FS/shell touch 없으니 read-only).
  // Cross-check (mode-mutating-table.test.ts) 는 `requestUserInputTool()` 를
  // `allTools` 에 명시적으로 포함시켜 drift 를 검출함.
  request_user_input: null,
  // Mutating git built-ins (ADR-0053, Claude Desktop 1.7196.3
  // `commitWipForBranchSwitch` absorption). git_commit creates a commit;
  // git_branch_switch may write a wip checkpoint + change HEAD. Both block
  // in plan mode — plan mode PROPOSES; it does not commit.
  git_commit: "git_mutating",
  git_branch_switch: "git_mutating",
  // ─── ADR-0119 / ADR-0122 / ADR-0130 / ADR-0136 ─────────────────────────
  // Caller-wire-time tools — registered conditionally (only when the relevant
  // AgentConfig slot is wired: shadowOdb / subagentBackground / budgetLedger).
  // Their MUTATING_TOOL_TABLE entries MUST be PERMANENT regardless of whether
  // any host wires them: a host that does inject them MUST NOT trip
  // `UnknownToolError` from `isMutatingTool` on plan-mode dispatch, which
  // would crash the seam. The mode-mutating-table cross-check tolerates the
  // additional entries (caller-wire tools are not enumerated by
  // `allTools` in the cross-check; the orphan-direction check considers
  // them "known absent" via the explicit allowlist convention).
  // Shadow git ODB tools (ADR-0119 / ADR-0122). Snapshots is read-only
  // (lists refs); rewind/restore_partial overwrite worktree files (git
  // mutating, same posture as git_commit — plan mode forbids).
  shadow_snapshots: null,
  shadow_rewind: "git_mutating",
  shadow_restore_partial: "git_mutating",
  // Background subagent tools (ADR-0130). Fork SPAWNS shell work (same
  // posture as `bash` — plan mode forbids); poll + await are read-only
  // observations of the scheduler's state (safe in plan mode).
  subagent_fork: "bash_mutating",
  subagent_poll: null,
  subagent_await: null,
  // ADR-0287 — poll_deferred: read-only poll of a deferred async-tool result
  // (caller-wire, gated on QUANTA_ASYNC_TOOLS). Pure read, plan-safe like
  // subagent_poll. Classified so plan-mode dispatch never trips UnknownToolError.
  poll_deferred: null,
  // Read-only budget surface (ADR-0136). Pure render of the in-memory
  // ledger; no FS / shell / network touch. Safe in plan mode.
  budget_status: null,
  // ─── MUTATING_TOOL_TABLE drift closeout (S2) ──────────────────────────
  // Tools that previously slipped past the explicit cross-check because they
  // ship behind feature flags / caller-wire factories. Adding them here
  // permanently means plan-mode dispatch never trips `UnknownToolError`
  // regardless of which AgentConfig slots a given host wires.
  //
  // Read-only gh surfaces (already enumerated under their own categories;
  // listed here for parity with the new mutating gh entries).
  gh_pr_view: null,
  gh_pr_list: null,
  gh_pr_blame: null,
  gh_pr_review_diff: null,
  gh_issue_view: null,
  gh_check_status: null,
  // Mutating gh surfaces — shell out via `gh` to push remote state:
  // comments, PR creation, auto-merge enablement. Same `git_mutating`
  // category as `git_commit` (the seam cannot distinguish "remote VCS write"
  // from "local VCS write" — both deserve plan-mode block by intent).
  gh_pr_comment: "git_mutating",
  gh_pr_create: "git_mutating",
  gh_pr_auto_merge: "git_mutating",
  // jun-6 wave-2 gh write surfaces — `gh_pr_edit_labels` mutates PR labels via
  // `gh`; `gh_pr_resolve_thread` resolves a review thread via the GraphQL API
  // (gitRunner-gated). Both are remote VCS writes ⇒ same `git_mutating`
  // category, plan-mode blocked by intent.
  gh_pr_edit_labels: "git_mutating",
  gh_pr_resolve_thread: "git_mutating",
  // Memory layer (ADR-0135). `memory_search` is a read-only retrieval over the
  // durable store; `memory_write` / `memory_update` mutate it. Plan-mode
  // forbids writes — plan PROPOSES recall facts; it does not commit them.
  memory_search: null,
  memory_write: "memory_mutating",
  memory_update: "memory_mutating",
  // Speculative branch search (ADR-0084). Each candidate forks an entire
  // agent run in its own workspace; the side-effect surface is exactly the
  // shell-process surface that `bash` covers, so it inherits `bash_mutating`.
  branch_search: "bash_mutating",
  // Background subagent control surfaces. `task_output` polls the registry —
  // pure read of in-memory scheduler state, safe in plan mode. `task_stop`
  // cancels the child run, which is itself a state mutation against the
  // child + the registry, so it blocks under the new `subagent_control` kind.
  task_output: null,
  task_stop: "subagent_control",
  // Plan-review exit seam. Read-only by tool contract: it blocks on operator
  // review, then the loop consumes the typed outcome at the next turn
  // boundary. This MUST remain callable in plan mode; otherwise the plan
  // posture has no live way to leave the read-only fence.
  request_plan_exit: null,
  // Plan-ENTRY seam (inverse of request_plan_exit). Read-only by tool contract:
  // it only relays a reason; the loop flips collaboration mode at the next turn
  // boundary. Callable in BOTH modes — you call it FROM default to enter, and a
  // second call while already in plan mode is an explicit no-op.
  enter_plan_mode: null,
  // Sub-agent spawn — the child runs unrestricted tools; the spawn itself
  // is mutating because the child's mutations are reachable via this call.
  // Same rationale as `bash_mutating` ("cannot introspect the side effect").
  agent: "subagent_spawn",
  // Skill loader + tool-search are pure prompt/registry reads — they merely
  // surface text from disk/in-memory tool definitions. No FS write, shell,
  // network. Safe in plan mode.
  Skill: null,
  ToolSearch: null,
  // Read-only web surfaces (ADR-0127 family). `web_fetch` is already above;
  // `web_search` is the search-engine equivalent, returning result links +
  // snippets. No mutation; safe in plan mode.
  web_search: null,
  // Caller-wired workspace retrieval facade (ADR-0278). The concrete search
  // pipeline depends on cwd + optional indexer lifecycle, but the tool itself
  // is pure ranked retrieval over that pipeline. No mutation; safe in plan mode.
  search_codebase: null,
  // Read-only image ingestion from URL (ADR-0126 sibling of `read_image`).
  // Pure HTTP GET + multimodal-block emit; no FS write, no shell. Safe in
  // plan mode.
  read_image_url: null,
  // ─── jun-05 §7/§9 host-binding session tools (N1/N2/N3/N6/C2) ─────────────
  // All caller-wire (registered only when the relevant DefaultToolPort /
  // AgentConfig slot is wired, gated default-OFF). Their MUTATING_TOOL_TABLE
  // entries are PERMANENT so plan-mode dispatch never mis-handles them when a
  // host injects them (a missing entry routes the mutating ops through the
  // UnknownToolError deny path with a confusing "not classified" reason instead
  // of the correct PlanModeMutatingBlockedError, and `isMutatingTool`/
  // `mutatingToolKind` called from any other code path would throw). The
  // mode-mutating-table cross-check tolerates these via the caller-wire
  // allowlist convention (their factories require host ports to enumerate).
  //
  // N6 — PTY/tmux attach (RFC §5.2). `pty_list`/`pty_read` are read-only
  // (enumerate / read a cursor). `pty_attach`/`pty_write`/`pty_resize`/
  // `pty_kill` touch a LIVE shell session — `bash_mutating` is the right kind:
  // the seam cannot introspect what a stdin write executes, and kill is
  // irreversible (same rationale as `bash`/`bash_kill`). Plan mode forbids.
  pty_list: null,
  pty_read: null,
  pty_attach: "bash_mutating",
  pty_write: "bash_mutating",
  pty_resize: "bash_mutating",
  pty_kill: "bash_mutating",
  // N3 — MCP resource/prompt read surface (RFC jun-4-mcp-resource-tools; B4).
  // The enumerations/reads are read-only over a connected MCP server (output is
  // mcp-origin untrusted DATA wrapped by the H2 envelope). EXCEPTION: B4 makes
  // `mcp_read_resource` WRITE binary blob blocks to a jailed workspace file
  // (`blobSavedTo:`) — a `write_filesystem` mutation, so plan mode must forbid it
  // (a plan proposes, does not commit, file writes). `mcp_read_resource_dir` is a
  // pure resources/list + filter (no write) ⇒ null. Safe in plan mode.
  mcp_list_resources: null,
  mcp_list_resource_templates: null,
  mcp_read_resource: "write_filesystem",
  mcp_read_resource_dir: null,
  mcp_list_prompts: null,
  mcp_get_prompt: null,
  // N2 — MCP connector discovery. `mcp_connector_list` is a read-only catalog
  // enumeration; `mcp_connector_install` WRITES the server entry into
  // `.mcp.json` (`write_filesystem` — plan PROPOSES config changes, does not
  // commit them).
  mcp_connector_list: null,
  mcp_connector_install: "write_filesystem",
  // C2 — structured mid-turn progress report. Read-only by construction: the
  // ONLY effect is emitting a render-only `progress_update` observability event
  // onto a host sink (no FS / shell / git / session-state mutation). Safe in
  // plan mode (matches its own `isReadOnly: () => true` + `pre-approval-ok`).
  communicate_update: null,
  // N1 — background side-agent daemons. `side_agent_list`/`side_agent_findings`
  // are read-only (snapshot / drain). `side_agent_spawn` starts a persistent
  // background daemon that runs its OWN unrestricted passes (`subagent_spawn` —
  // same "cannot introspect the child's side effects" rationale as `agent`);
  // `side_agent_stop` cancels a running daemon (`subagent_control`, same as
  // `task_stop`). Plan mode forbids both mutating ops.
  side_agent_spawn: "subagent_spawn",
  side_agent_list: null,
  side_agent_stop: "subagent_control",
  side_agent_findings: null,
  // `session_config` — agent self-inspection over its own SDK posture, plus
  // `op:set_effort`, which mutates the session EffortStore. `isReadOnly()` is false
  // because the Tool contract has no per-call read-only classification.
  //
  // It used to be `null` "so an in-plan effort bump mirrors the operator /effort
  // slash", with a unit test claiming plan dispatch "allows null-classified tools
  // regardless of isReadOnly". That held in ONE plan layer: with the live agent mode
  // `plan`, the admissibility gate already blocks it — `op:get` included — because
  // it keys off `isReadOnly()`. The `null` only opened the collaboration-mode layer.
  // Classified as the in-session state write it is, so the two layers agree. The
  // operator `/effort` slash is unaffected; it does not dispatch through this tool.
  session_config: "working_state_write",
  // ─── R3 e2e-integration audit closeout — caller-wire tools that slipped past
  // the `mode-mutating-table.test.ts` cross-check (it enumerates `defaultTools`,
  // which excludes these conditionally-registered tools, and TOLERATES — does
  // not REQUIRE — caller-wire entries). Each ships behind a DefaultToolPort and
  // is reachable through `buildDefaultTools` when its slot is wired, so a
  // plan-mode dispatch (or any direct `isMutatingTool`/`mutatingToolKind` call)
  // would trip `UnknownToolError` — the MUTATING ones then deny with a confusing
  // "not classified" reason instead of the correct PlanModeMutatingBlockedError.
  // Entries are PERMANENT (the caller-wire allowlist convention).
  //
  // ADR-0464 — apply_patch_structured: per-file-isolated V4A apply, same write
  // posture as apply_patch (plan PROPOSES, does not commit).
  apply_patch_structured: "write_filesystem",
  // file_history_rewind — caller-wire (registered only when DefaultToolPorts.
  // fileHistory is wired, gated default-OFF on QUANTA_FILE_HISTORY). `op:restore`
  // WRITES a prior file version back to the worktree through the same jailed FS
  // port write/edit use ⇒ `write_filesystem` (plan PROPOSES, does not commit a
  // restore mid-turn). `op:list` is read-only, but the tool's worst-case op
  // mutates the filesystem, so it is classified mutating (a single table entry
  // per tool name; the read path is gated at the tool, not the table).
  file_history_rewind: "write_filesystem",
  // skill_create — caller-wire (registered only when QUANTA_SKILL_CREATOR is on
  // AND a writable user skills `dir` is configured; tier1/skill.ts). It WRITES
  // `<name>/SKILL.md` to the jailed skills directory through an injected writer
  // port ⇒ `write_filesystem` (plan PROPOSES authoring a skill; it does not
  // commit a new file mid-turn). PERMANENT entry so plan-mode dispatch blocks it
  // with the correct PlanModeMutatingBlockedError instead of tripping
  // UnknownToolError (the same omission class the S2 + round-2 closeouts fixed).
  skill_create: "write_filesystem",
  // C1 — artifact (Canvas) read/manage tools. list/get are read-only enumerations
  // over the in-memory session registry (plan-safe). register/destroy MUTATE that
  // session-canvas registry — no FS/shell/git side effect, purely in-session
  // durable state, so `working_state_write` is the right kind (plan PROPOSES
  // canvas changes; it does not commit them mid-turn). The dispatch seam's
  // read-only fast-path already let list/get through, but their absence here
  // still threw on any direct table lookup — classify them explicitly.
  artifact_list: null,
  artifact_get: null,
  artifact_register: "working_state_write",
  artifact_destroy: "working_state_write",
  // CLUSTER D #5 — permission_propose_pattern: the model-facing RECORDING half of
  // ADR-0061 remember-patterns. It MUTATES the in-memory session pattern store
  // (records a baseline-covered proposal into `allowed` so a future action
  // auto-passes) — no FS/shell/git/network side effect, purely in-session durable
  // permission state, so `working_state_write` is the right kind (plan PROPOSES a
  // pattern grant; it does not commit one mid-turn). Caller-wire
  // (DefaultToolPorts.permissionPatternPropose, QUANTA_REMEMBER_PATTERNS);
  // PERMANENT entry so plan-mode dispatch never trips UnknownToolError when a host
  // wires the port.
  permission_propose_pattern: "working_state_write",
  // ADR-0487 — subagent_force_background: promote a QUEUED background subagent to run
  // NOW (or to the FIFO head). Classified `subagent_control`, like `task_stop`.
  //
  // It was `null`, justified as "it only reorders work the agent already requested",
  // the same posture as `subagent_poll`. But `promoted_now` STARTS a queued subagent,
  // and the tool declares `isReadOnly: () => false`. So the admissibility gate already
  // blocked it with the live agent mode `plan`, while the collaboration-mode layer let
  // it start work that `subagent_fork` (`bash_mutating`) could not have started in
  // plan mode. Found by the census-wide invariant that no write-capable tool literal
  // may carry a `null` row; `subagent_poll` is a genuine read and stays `null`.
  // Caller-wire (minted by subagentBgTools only when QUANTA_FORCE_BACKGROUND and the
  // admission queue are both on).
  subagent_force_background: "subagent_control",
  // G1 — appshot_verify: scaffold/render a UI, screenshot it (BrowserPort), and
  // judge the screenshot with a verify LLM. It WRITES the scaffold + screenshot
  // through the jailed FS scaffold, so `write_filesystem` is the right kind (plan
  // PROPOSES a UI build; it does not commit jailed artifacts mid-turn). Caller-wire
  // (DefaultToolPorts.appshot, QUANTA_APPSHOT); PERMANENT entry.
  appshot_verify: "write_filesystem",
  // code-mode (RFC jun-6-code-mode, Phase 1) — code_cell runs a model-authored JS
  // program whose every in-cell tools.X(args) re-enters the REAL dispatchTool. It
  // can invoke MUTATING tools (write) and is at least as powerful as the union of
  // the tools it can call ⇒ classified `write_filesystem` (plan PROPOSES; a cell
  // that could write is blocked at the dispatch seam in plan mode). The per-call
  // re-gating means an IN-CELL write is ALSO independently plan-blocked, so this
  // is defense-in-depth, not the only guard. Caller-wire (DefaultToolPorts.codeMode
  // + AgentConfig.codeCellDispatchFactory, QUANTA_CODE_MODE); PERMANENT entry so
  // plan-mode dispatch never trips UnknownToolError when a host registers it.
  code_cell: "write_filesystem",
  // ADR-0249 — node_repl evaluates arbitrary Node code in a PERSISTENT `node -i`
  // subprocess (full host access: fs/net/require). At least as powerful as `bash`
  // ⇒ classified `bash_mutating` so plan mode BLOCKS it (plan PROPOSES; it does not
  // run arbitrary host code mid-turn). Caller-wire (DefaultToolPorts.nodeRepl,
  // QUANTA_NODE_REPL); PERMANENT entry so plan-mode dispatch never trips
  // UnknownToolError when a host registers it.
  node_repl: "bash_mutating",
  // ticket-11 (P8 git-worktree agent tools) — caller-wire, registered only when
  // `QUANTA_WORKTREE_TOOL` mints `AgentConfig.activeWorktreeSlot`. PERMANENT
  // entries so plan-mode dispatch classifies (not crashes with UnknownToolError)
  // when a host wires them. `enter_worktree` SPAWNS a `git worktree add` (shell-
  // backed, same posture as `bash` — plan mode forbids); `exit_worktree` tears
  // down the worktree + branch (`git worktree remove`/`branch -D`, git mutating,
  // same posture as git_commit); `worktree_status` is a read-only render of the
  // slot + a `git status --porcelain` count (plan-safe, null).
  enter_worktree: "bash_mutating",
  exit_worktree: "git_mutating",
  worktree_status: null,
  // ─── jun-08 long-tail NEW model-facing tools (§5.4 / §7.2 / §7.3) ─────────
  // Caller-wire (registered only when ghTools/gitTools are built with the
  // relevant opt, gated default-OFF behind its own QUANTA_* knob). All three are
  // read-only (`null`): `gh_pr_code_tour` parses a PR diff into a guided tour
  // (no mutation); `git_co_change` ranks co-occurring files from git log (pure
  // read); `ci_finding` records the agent's OWN analysis into an in-SESSION
  // store (no FS/shell/git side effect, plan-safe like communicate_update).
  // PERMANENT entries so plan-mode dispatch never trips UnknownToolError when a
  // host wires them.
  gh_pr_code_tour: null,
  git_co_change: null,
  ci_finding: null,
  // ─── sep-13 — the TEN tools the R3 closeout's own guard could not see ──────
  // The R3 closeout added entries "so plan-mode dispatch never trips
  // UnknownToolError" and proved it with a fixture that wired NINE of the thirty
  // `DefaultToolPorts`. With all thirty wired, ten more tools appear in no row at
  // all. MEASURED: `buildDefaultTools` with the full port plan yields 66 tools and
  // these ten threw from `isMutatingTool`.
  //
  // Read-only ⇒ `null`, by this table's own rule. For these five the row changes NO
  // dispatch behaviour, and an earlier version of this comment claimed the opposite
  // ("plan mode went from denying … to allowing them"). A read-only tool never reaches
  // this table at dispatch: `consultPlanModeSeam` returns early on
  // `registry.isReadOnly(name)`, and the admissibility gate keys off `isReadOnly` too.
  // MEASURED at the parent commit and after, in both plan postures: all five ran.
  // What the rows DO change is every consumer that looks a name up directly —
  // `isMutatingTool` / `mutatingToolKind` callers, which threw `UnknownToolError`, and
  // the side-conversation allowlist invariant.
  //
  // `threads_handoff` builds a `quanta://threads/{id}` deeplink and does no I/O; the
  // handoff itself happens on the receiving surface. `ask_user` asks the operator.
  // `reflect` is a one-shot, tool-less LLM critique of the agent's own plan.
  // `fetch_rules` reads rule files through its port. `projects_kb` reads a knowledge
  // base; its `project_write` op loads a jailed file into an in-memory store, and
  // production wires no persistent backend.
  threads_handoff: null,
  ask_user: null,
  reflect: null,
  fetch_rules: null,
  projects_kb: null,
  // Write-capable ⇒ a mutating kind. For these five the DENIAL is unchanged in both
  // plan layers — `UnknownToolError` already denied them — and the reason is now the
  // kind instead of "not classified". `notebook_edit` rewrites `.ipynb` cells through
  // the FS jail `edit` uses; its `write_filesystem` kind is also what makes the bench
  // stream tap count notebook edits. `debug_inspect` launches a program under a debug
  // adapter, `run_tests` detects and runs the project suite (with an optional
  // model-supplied `command`), and `collect_evidence` runs that suite and fuses the
  // result — all three execute code. `automation_update` stores a recurring automation
  // in the engine port, which later injects a prompt into an agent run, so it is agent
  // state that outlives the turn rather than an FS write; the label is informational,
  // since plan mode blocks every non-null kind the same way.
  automation_update: "working_state_write",
  notebook_edit: "write_filesystem",
  debug_inspect: "bash_mutating",
  run_tests: "bash_mutating",
  collect_evidence: "bash_mutating",
  // ─── sep-13 — the SIXTY-SEVEN catalogued tools with no row ─────────────────
  // The table's contract is that every tool the registry knows appears here. Measured
  // against the tool-surface manifest: 67 catalogued names had no row, so
  // `isMutatingTool` threw for each and the plan-mode seam denied them as "not
  // classified". Both drift detectors enumerated only fixture-reachable tools and
  // could not see the gap.
  //
  // NO DISPATCH BEHAVIOUR CHANGES, by construction. Each row follows the tool's own
  // `isReadOnly()` (runtime where the assembled universe builds it, the source
  // declaration otherwise):
  //   - read-only ⇒ `null`. A read-only tool never reaches this table at dispatch
  //     (`consultPlanModeSeam` returns on `isReadOnly`), so nothing that ran stops.
  //   - write-capable ⇒ a mutating kind. `UnknownToolError` already denied these in
  //     plan collaboration mode; now the denial names a kind.
  // The census-wide HITL arm enforces the second half: no write-capable tool literal may
  // carry `null`.
  //
  // Read-only.
  advisor: null,
  ast_grep: null,
  browser_console: null,
  browser_element_bounds: null,
  browser_highlight: null,
  browser_network: null,
  browser_read: null,
  browser_screenshot: null,
  browser_snapshot: null,
  browser_tab_list: null,
  browser_wait: null,
  check_secrets: null,
  current_plan: null,
  fork_session: null,
  get_mcp_task: null,
  git_compose_commit: null,
  git_compose_pr: null,
  list_agents: null,
  list_mcp_tasks: null,
  lsp_code_action: null,
  lsp_signature_help: null,
  objective_get: null,
  report_agent_job_result: null,
  shadow_verify: null,
  subagent_read_messages: null,
  wait_agent: null,
  // Write-capable: code execution and raw protocol access.
  container_exec: "bash_mutating",
  exec_command: "bash_mutating",
  write_stdin: "bash_mutating",
  browser_cdp: "bash_mutating",
  // Write-capable: files.
  container_write_file: "write_filesystem",
  lsp_format: "write_filesystem",
  lsp_rename_apply: "write_filesystem",
  // Write-capable: page interaction that can submit, navigate or close state on a live
  // site — the first rows of the `network_write` kind, which had no users.
  browser_click: "network_write",
  browser_drag: "network_write",
  browser_fill: "network_write",
  browser_mouse_click_xy: "network_write",
  browser_navigate: "network_write",
  browser_press_key: "network_write",
  browser_scroll: "network_write",
  browser_select_option: "network_write",
  browser_tab_close: "network_write",
  browser_tab_new: "network_write",
  browser_tab_switch: "network_write",
  browser_type: "network_write",
  // Write-capable: git and GitHub.
  git_push: "git_mutating",
  git_stage: "git_mutating",
  gh_pr_open: "git_mutating",
  // Write-capable: spawning work.
  spawn_agent: "subagent_spawn",
  spawn_batch: "subagent_spawn",
  spawn_agents_on_csv: "subagent_spawn",
  run_workflow: "subagent_spawn",
  delegate: "subagent_spawn",
  followup_task: "subagent_spawn",
  // Write-capable: controlling work already spawned.
  close_agent: "subagent_control",
  send_input: "subagent_control",
  subagent_send_message: "subagent_control",
  team_create: "subagent_control",
  team_delete: "subagent_control",
  cancel_mcp_task: "subagent_control",
  // Write-capable: plan state. OPEN, recorded rather than decided: these are blocked in
  // plan mode by BOTH layers today (agent-mode plan blocks every non-read-only tool),
  // which is odd for tools whose job is planning. Allowing them needs a plan-mode rule
  // that is not "null means read-only", and that is a behaviour decision.
  create_plan: "plan_control",
  update_plan: "plan_control",
  update_todos: "plan_control",
  remove_todos: "plan_control",
  // Write-capable: objective state that outlives the turn.
  objective_set: "working_state_write",
  objective_update: "working_state_write",
  objective_verify: "working_state_write",
})

/** SINGLE SOURCE OF TRUTH for the "caller-wire" tool-name allowlist.
 *
 *  A *caller-wire* tool is one whose {@link MUTATING_TOOL_TABLE} entry is
 *  PERMANENT but whose registration is CONDITIONAL — it is minted only when a
 *  host wires the relevant `AgentConfig` slot or tier-1 block (gated default-OFF
 *  behind an env knob) AND no drift-test fixture can reach it. A tool behind a
 *  `DefaultToolPort` does NOT belong here: `tests/unit/_shared/wired-tool-ports.ts`
 *  wires every port through an exhaustive `Record<keyof DefaultToolPorts, …>`, so
 *  the detectors enumerate it and a vanished registration is reported as an orphan
 *  row instead of being vouched for by name.
 *
 *  The two drift detectors that cross-check the table against the registered
 *  universe — `tests/integration/plan-mode-dispatch-hell-e2e.test.ts` and
 *  `tests/unit/mode-mutating-table.test.ts` — must therefore augment the
 *  enumerable tools with this NAME list so the orphan-direction check
 *  ("every table key maps to a real tool") stays exact without forcing every
 *  caller-wire factory to be reachable.
 *
 *  This constant exists to ELIMINATE a 3-way hand-sync footgun: previously
 *  EACH of those two tests carried its own hand-maintained literal copy of
 *  this list, and `MUTATING_TOOL_TABLE` was a third. Adding a caller-wire tool
 *  to the table but forgetting one of the two copies produced a confusing
 *  orphan/missing-direction failure (it bit poll_deferred,
 *  subagent_force_background, appshot_verify, and silently drifted
 *  read_image_url between the two copies). Now BOTH tests import THIS constant,
 *  so adding a caller-wire tool is ONE edit (table entry + this list, both in
 *  this file) and the two tests cannot diverge.
 *
 *  Invariant preserved: this list does NOT weaken the drift detectors. They
 *  still fail if a table key matches neither an enumerable tool NOR a name
 *  here (true orphan), and still fail if an enumerable tool is missing from
 *  the table (true missing). The SSOT only removes the DUPLICATE copies. The
 *  `caller-wire-ssot` test additionally pins that no name here is already
 *  enumerable from the BROADLY-WIRED fixture (it used to compare against the bare
 *  `defaultTools`, which let 30 port-gated names sit here and mask stale rows) and
 *  that every name here has a table entry. */
export const CALLER_WIRE_TOOL_NAMES = Object.freeze([
  // EXACTLY the table rows no drift-test fixture can build — measured, not curated.
  //
  // sep-13: every catalogued tool gained a row (table and manifest are now the same 203
  // names), and both drift detectors enumerate the ASSEMBLED universe
  // (`tests/unit/_shared/assembled-tool-universe.ts`, 156 names from ten real builders)
  // instead of a hand-picked set. This list is what is left: 47 names whose builders
  // need a live resource at construction. It is also the runtime-parity gate's
  // not-yet-assembled ledger — one list, not two — and it may only shrink: a name the
  // universe starts building must leave (both detectors and the parity gate assert it).
  //
  // Browser tools — `@/agent/tier1/browser` needs a CDP endpoint.
  "browser_cdp",
  "browser_click",
  "browser_console",
  "browser_drag",
  "browser_element_bounds",
  "browser_fill",
  "browser_highlight",
  "browser_mouse_click_xy",
  "browser_navigate",
  "browser_network",
  "browser_press_key",
  "browser_read",
  "browser_screenshot",
  "browser_scroll",
  "browser_select_option",
  "browser_snapshot",
  "browser_tab_close",
  "browser_tab_list",
  "browser_tab_new",
  "browser_tab_switch",
  "browser_type",
  "browser_wait",
  // MCP task control — needs a server that advertises Tasks.
  "cancel_mcp_task",
  "get_mcp_task",
  "list_mcp_tasks",
  // Memory — needs a live store.
  "memory_search",
  "memory_update",
  "memory_write",
  // Background subagents — need the background runner and admission queue.
  "subagent_await",
  "subagent_force_background",
  "subagent_fork",
  "subagent_poll",
  "poll_deferred",
  // Per-child or composition-root bindings the fixture does not model.
  "report_agent_job_result",
  "delegate",
  "followup_task",
  "fork_session",
  "shadow_verify",
  "skill_create",
  "update_working_state",
  // Retrieval, search and bench-driver wiring.
  "search_codebase",
  "web_search",
  "find_references",
  "ast_grep",
  "check_secrets",
  // Built and tested, registered by NO production path (catalogued `unwired`).
  "git_push",
  "git_stage",
] as const)

/** Look up a tool's mutating classification. Returns `true` iff the tool is
 *  classified as mutating (any {@link MutatingToolKind}); `false` for
 *  explicitly read-only tools. Throws {@link UnknownToolError} for any tool
 *  name not in the table — no silent fallback. */
export const isMutatingTool = (toolName: string): boolean => {
  // `Object.hasOwn`, not `in`: `in` walks the prototype chain, so `constructor`,
  // `toString` and `__proto__` read as CLASSIFIED — with a function or
  // `Object.prototype` as their "kind". It happened to fail toward blocking; it was
  // still a classification nobody wrote.
  if (!Object.hasOwn(MUTATING_TOOL_TABLE, toolName)) throw new UnknownToolError(toolName)
  return MUTATING_TOOL_TABLE[toolName] !== null
}

/** Returns the mutating kind for a tool, or `null` if the tool is read-only.
 *  Throws {@link UnknownToolError} for an unrecognized name. Exposed so the
 *  dispatch-seam guard can put the kind into its rejection payload. */
export const mutatingToolKind = (toolName: string): MutatingToolKind | null => {
  if (!Object.hasOwn(MUTATING_TOOL_TABLE, toolName)) throw new UnknownToolError(toolName)
  const kind = MUTATING_TOOL_TABLE[toolName]
  return kind ?? null
}

/**
 * The same classification, WITHOUT failing closed: the kind, `null` for a tool the
 * table marks plan-safe, and `undefined` for a name it does not know.
 *
 * For accounting and telemetry only. {@link mutatingToolKind} throws
 * `UnknownToolError` on an unknown name, which is correct at the plan-mode seam and
 * wrong anywhere a throw lands inside a running turn: the bench stream tap used it,
 * and a hallucinated tool name crashed the instance. `Object.hasOwn`, so a name
 * like `constructor` or `toString` is unknown rather than a prototype method.
 */
export const classifiedMutatingKind = (toolName: string): MutatingToolKind | null | undefined =>
  Object.hasOwn(MUTATING_TOOL_TABLE, toolName) ? (MUTATING_TOOL_TABLE[toolName] ?? null) : undefined

/** Read-only snapshot of the mutating-tool table — exposed for the
 *  cross-check test in `tests/unit/mode-mutating-table.test.ts`. */
export const planModeMutatingTable = (): Readonly<Record<string, MutatingToolKind | null>> =>
  MUTATING_TOOL_TABLE

/** Assert that calling `toolName` is permitted under the given collaboration
 *  `mode`. No-op in `default` mode; in `plan` mode, throws
 *  {@link PlanModeMutatingBlockedError} for any mutating tool. Throws
 *  {@link UnknownToolError} for an unrecognized tool name. */
export const assertNotMutatingInPlanMode = (mode: CollaborationMode, toolName: string): void => {
  if (mode === "default") return
  const kind = mutatingToolKind(toolName)
  if (kind === null) return
  throw new PlanModeMutatingBlockedError(toolName, kind)
}

/** Resolve the effective {@link CollaborationMode} from an `AgentConfig`-like
 *  surface (just the two fields we read). Precedence:
 *    1. explicit `collaborationMode` field (set by host / developer-channel
 *       transition) wins;
 *    2. otherwise fall back to the 4-mode `AgentMode` → 2-mode projection
 *       (only `"plan"` from {@link resolveAgentMode} maps to `"plan"`; every
 *       other posture, including `review`/`audit`, projects to `"default"`).
 *
 *  Default-OFF for legacy callers: a config with NEITHER field set yields
 *  `"default"` so the dispatch seam never blocks. This is the same shape
 *  `dispatch.ts` used pre-L4 when constructing `runPlanExitFlow`'s collab
 *  argument, factored here so the dispatch seam, plan-exit flow, and any
 *  future caller share ONE projection.
 *
 *  Pure: no IO, no clock, no read of process env. Takes the narrow slice it
 *  needs (the three optional `AgentConfig` fields). */
export const resolveCollaborationMode = (
  config: AgentModeSource & { collaborationMode?: CollaborationMode },
): CollaborationMode => {
  if (config.collaborationMode === "plan") return "plan"
  if (config.collaborationMode === "default") return "default"
  // §17 packet M — via the LIVE resolution, so a mid-session flip reaches the
  // dispatch seam and not only the prompt.
  return resolveLiveAgentMode(config) === "plan" ? "plan" : "default"
}

/** Mutable config slice owned by the collaboration-mode transition seam. The
 *  helper rewrites the authoritative runtime state (`mode` / `planMode` /
 *  `collaborationMode`) in ONE place so prompt assembly, dispatch gating, and
 *  stream observability never split authority again. */
export interface CollaborationModeState {
  collaborationMode?: CollaborationMode
  mode?: AgentMode
  planMode?: boolean
}

export interface CollaborationModeTransition {
  readonly from: CollaborationMode
  readonly to: CollaborationMode
  readonly fromAgentMode: AgentMode
  readonly toAgentMode: AgentMode
  readonly changed: boolean
}

/** Apply a collaboration-mode transition to the authoritative runtime state.
 *  Equal-mode requests are a pure observation (`changed:false`) and leave the
 *  finer agent posture untouched (`editor` stays `editor` on `default` → `default`).
 *  Actual transitions collapse onto the collaboration owner semantics:
 *    - `plan`    ⇒ `mode="plan"`,   `planMode=true`,  `collaborationMode="plan"`
 *    - `default` ⇒ `mode="default"`,`planMode=false`, `collaborationMode="default"` */
export const applyCollaborationModeTransition = (
  config: CollaborationModeState,
  nextMode: CollaborationMode,
): CollaborationModeTransition => {
  const from = resolveCollaborationMode(config)
  const fromAgentMode = resolveAgentMode(config.mode, config.planMode)
  if (from === nextMode) {
    return {
      from,
      to: nextMode,
      fromAgentMode,
      toAgentMode: fromAgentMode,
      changed: false,
    }
  }
  config.collaborationMode = nextMode
  config.planMode = nextMode === "plan"
  config.mode = nextMode === "plan" ? "plan" : "default"
  return {
    from,
    to: nextMode,
    fromAgentMode,
    toAgentMode: resolveAgentMode(config.mode, config.planMode),
    changed: true,
  }
}

/** Strict regex for the `mode=…` directive that a developer message must
 *  carry to cause a collaboration-mode transition. Anchored — anything other
 *  than the bare directive (with optional surrounding whitespace) is treated
 *  as "no directive present". */
const MODE_DIRECTIVE_RE = /^\s*mode\s*=\s*([a-z_]+)\s*$/

/** Apply a developer-channel message to the current collaboration mode.
 *
 *  - Returns the unchanged `currentMode` if `devMessage` does NOT contain a
 *    `mode=…` directive (developer messages without a directive are routed
 *    elsewhere — this function's contract is "transition or stay").
 *  - Returns the requested mode if the directive parses as `mode=plan` or
 *    `mode=default`. Identical-mode transition is a no-op (returns
 *    `currentMode`, no error — sticky-set semantics).
 *  - Throws {@link InvalidModeTransitionError} for any other `mode=…` value.
 *    No silent fallback. */
export const applyDeveloperModeTransition = (
  currentMode: CollaborationMode,
  devMessage: string,
): CollaborationMode => {
  const match = MODE_DIRECTIVE_RE.exec(devMessage)
  if (match === null) return currentMode
  const attempted = match[1]
  if (attempted === "plan" || attempted === "default") return attempted
  throw new InvalidModeTransitionError(attempted ?? devMessage.trim())
}
