import type { ToolAction } from "@/permission"
import { QuantaError } from "@/shared"
import type { AgentMode } from "./prompt"

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

/** True iff `mode` forbids mutating tools and `action` is mutating. Read-only
 *  actions pass through every mode unchanged. Fail-closed: a mode that is NOT
 *  in {@link MUTATING_MODES} (including any unknown runtime value) blocks
 *  mutating tools — a new mode forgotten by a future PR ships safe by default. */
export const isMutatingToolBlockedInMode = (mode: AgentMode, action: ToolAction): boolean => {
  if (action.isReadOnly) return false
  return !MUTATING_MODES.has(mode)
}

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
  glob: null,
  localize: null,
  diagnostics: null,
  test_runner: null,
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
  // N3 — MCP resource/prompt read surface (RFC jun-4-mcp-resource-tools). All
  // four are read-only enumerations/reads over a connected MCP server (the
  // output is mcp-origin untrusted DATA wrapped by the H2 envelope, but the
  // call performs no local state mutation). Safe in plan mode.
  mcp_list_resources: null,
  mcp_read_resource: null,
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
  // `session_config` — agent self-inspection / self-mutation over its own
  // SDK posture (effort tier, identity mode, tool profile, model, provider).
  // Although `op:set_effort` mutates the session EffortStore, the mutation
  // is purely an internal preference change (no FS / shell / git / network
  // side effect) and mirrors the existing operator `/effort` slash which is
  // also allowed in plan mode. Classifying as `null` keeps plan-mode
  // dispatch a one-table lookup while leaving the only operator-facing risk
  // — sudden effort bumps — under the operator's eye (every mutation is a
  // visible tool call in the trace). The unit + hellgate tests assert this
  // classification stays read-only-permissive.
  session_config: null,
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
  // ADR-0487 — subagent_force_background: promote/reorder a QUEUED background
  // subagent within its own admission pool (move-to-front / burst-run). It only
  // reorders work the agent already requested — no NEW workspace mutation — so
  // it is plan-safe, the same posture as `subagent_poll`. Caller-wire (minted by
  // subagentBgTools only when QUANTA_FORCE_BACKGROUND + the admission queue are
  // both on); PERMANENT entry so plan-mode dispatch never trips UnknownToolError.
  subagent_force_background: null,
  // G1 — appshot_verify: scaffold/render a UI, screenshot it (BrowserPort), and
  // judge the screenshot with a verify LLM. It WRITES the scaffold + screenshot
  // through the jailed FS scaffold, so `write_filesystem` is the right kind (plan
  // PROPOSES a UI build; it does not commit jailed artifacts mid-turn). Caller-wire
  // (DefaultToolPorts.appshot, QUANTA_APPSHOT); PERMANENT entry.
  appshot_verify: "write_filesystem",
})

/** Thrown by {@link isMutatingTool} / {@link assertNotMutatingInPlanMode}
 *  when a tool name is not in the explicit table. Surfaces the missing tool
 *  name so the failing test points directly at the omission. */
export class UnknownToolError extends QuantaError {
  readonly toolName: string
  constructor(toolName: string) {
    super(
      "unknown_tool",
      `Tool "${toolName}" is not classified in the plan-mode mutating table. ` +
        `Every registered tool must have an explicit entry in MUTATING_TOOL_TABLE ` +
        `(src/agent/mode.ts) so plan-mode cannot silently allow new mutating tools.`,
    )
    this.toolName = toolName
  }
}

/** Thrown by {@link assertNotMutatingInPlanMode} / dispatch-seam guard when
 *  a mutating tool is called in `plan` collaboration mode. Surfaces both the
 *  tool name and the mutating-kind so the LLM-facing deny message can be
 *  specific. */
export class PlanModeMutatingBlockedError extends QuantaError {
  readonly toolName: string
  readonly mutatingKind: MutatingToolKind
  constructor(toolName: string, mutatingKind: MutatingToolKind) {
    super(
      "plan_mode_mutating_blocked",
      `Tool "${toolName}" (${mutatingKind}) is blocked in plan collaboration mode. ` +
        `Exit plan mode first (for example via \`request_plan_exit\`), or switch via a developer ` +
        `message (\`mode=default\`) to mutate.`,
    )
    this.toolName = toolName
    this.mutatingKind = mutatingKind
  }
}

/** Thrown by {@link applyDeveloperModeTransition} when a developer message
 *  carries a `mode=…` directive that is neither `plan` nor `default`. */
export class InvalidModeTransitionError extends QuantaError {
  readonly attempted: string
  constructor(attempted: string) {
    super(
      "invalid_mode_transition",
      `Invalid collaboration mode transition: "${attempted}". ` +
        `Only mode=plan and mode=default are allowed via developer message.`,
    )
    this.attempted = attempted
  }
}

/** Look up a tool's mutating classification. Returns `true` iff the tool is
 *  classified as mutating (any {@link MutatingToolKind}); `false` for
 *  explicitly read-only tools. Throws {@link UnknownToolError} for any tool
 *  name not in the table — no silent fallback. */
export const isMutatingTool = (toolName: string): boolean => {
  if (!(toolName in MUTATING_TOOL_TABLE)) throw new UnknownToolError(toolName)
  return MUTATING_TOOL_TABLE[toolName] !== null
}

/** Returns the mutating kind for a tool, or `null` if the tool is read-only.
 *  Throws {@link UnknownToolError} for an unrecognized name. Exposed so the
 *  dispatch-seam guard can put the kind into its rejection payload. */
export const mutatingToolKind = (toolName: string): MutatingToolKind | null => {
  if (!(toolName in MUTATING_TOOL_TABLE)) throw new UnknownToolError(toolName)
  const kind = MUTATING_TOOL_TABLE[toolName]
  return kind ?? null
}

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
export const resolveCollaborationMode = (config: {
  collaborationMode?: CollaborationMode
  mode?: AgentMode
  planMode?: boolean
}): CollaborationMode => {
  if (config.collaborationMode === "plan") return "plan"
  if (config.collaborationMode === "default") return "default"
  return resolveAgentMode(config.mode, config.planMode) === "plan" ? "plan" : "default"
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
