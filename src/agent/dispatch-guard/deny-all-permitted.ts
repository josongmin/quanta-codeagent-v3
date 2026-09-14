/**
 * The tools a DENY-ALL network posture lets run, each with why it neither reaches a
 * network nor runs code that could.
 *
 * WHY AN ALLOWLIST. The posture used to refuse a list of names (plus any shell line and
 * any `url`/`host` field). Round-10 audit, reproduced: `web_search {query}` sent the
 * query to the search provider under `createAnalysisAgent`'s deny-all batch mode, and
 * `git_push`, `gh_pr_create`, `gh_pr_comment`, `image_gen`, `mcp_connector_install`,
 * every `mcp__*` tool and a subagent's renamed tools were allowed — the refusal list only
 * covered the plan-mode rows someone had classified as code or network. A tool that is
 * not below — a new one, an MCP tool, a tool a host renamed — is refused.
 *
 * WHAT DOES NOT QUALIFY: a network API (web, GitHub, image generation, MCP servers, the
 * browser), running code (shells, test runners, debuggers, the Node REPL, language
 * servers — they execute workspace code), git operations that run hooks (commit, branch
 * switch, worktree creation), scheduling later runs, and the OS-process side agent (its
 * worker is not built from this config and carries no guard).
 *
 * `tests/unit/dispatch-guard-deny-all-coverage-hellgate.test.ts` classifies every tool in
 * the assembled universe and the caller-wire ledger against this table, both ways.
 */
export const DENY_ALL_PERMITTED_TOOLS: Readonly<Record<string, string>> = {
  // Local reads. The helpers that shell out run fixed local binaries (ripgrep, git,
  // ast-grep) over the tree; none runs the tree's code.
  read: "reads a file",
  read_image: "reads a local image",
  glob: "lists paths",
  grep: "searches files",
  file_tree_summary: "runs git and ripgrep for a tree summary",
  find_references: "runs ripgrep",
  localize: "runs ripgrep",
  ast_grep: "runs ast-grep",
  csv_read: "parses a local file",
  docx_read: "parses a local file",
  pdf_read: "parses a local file",
  pptx_read: "parses a local file",
  xlsx_read: "parses a local file",
  yaml_read: "parses a local file",
  ndjson_read: "parses a local file",
  parse_test_failure: "parses test output it is given",
  coverage_check: "reads a coverage JSON",
  check_secrets: "scans text for secrets",
  search_codebase: "lexical search; hybrid mode embeds through the configured provider",
  projects_kb: "session knowledge base on local files",
  fetch_rules: "ranks the local requestable-rules index",
  git_blame: "reads git history",
  git_blame_heatmap: "reads git history",
  git_churn: "reads git history",
  git_co_change: "reads git history",
  git_diff: "reads the working tree and index",
  git_log: "reads git history",
  git_moved_code: "reads git history",
  git_status: "reads the working tree and index",
  git_conflict_inspect: "reads conflict markers",
  git_review_diff: "reads a diff",
  git_compose_commit: "composes a message from the staged diff",
  git_compose_pr: "composes a PR body from a diff; it does not call GitHub",
  git_upstream_check: "compares against the already-fetched upstream; it does not fetch",
  worktree_status: "reads worktree state",
  shadow_snapshots: "lists local snapshots",
  task_output: "reads a background task's output",
  bash_await: "reads an existing background shell's output; starts nothing",
  pty_list: "lists existing PTYs",
  pty_read: "reads an existing PTY's buffer",
  poll_deferred: "polls work that is already running",
  // Local writes.
  write: "writes a file",
  edit: "edits a file",
  apply_patch: "applies a patch to files",
  apply_patch_structured: "applies a patch to files",
  scripted_replace: "rewrites files by pattern",
  notebook_edit: "edits a notebook file",
  docx_write: "writes a local file",
  pptx_write: "writes a local file",
  xlsx_write: "writes a local file",
  file_history_rewind: "restores recorded file versions",
  shadow_rewind: "restores a local snapshot",
  shadow_restore_partial: "restores paths from a local snapshot",
  skill_create: "writes a skill file",
  git_stage: "updates the index",
  exit_worktree: "removes a worktree (no checkout hooks run)",
  // Session and agent state.
  Skill: "loads skill instructions",
  ToolSearch: "lists deferred tools",
  ask_user: "asks the operator",
  request_user_input: "asks the operator",
  request_plan_exit: "asks the operator",
  enter_plan_mode: "changes the session mode",
  create_plan: "session plan state",
  current_plan: "session plan state",
  update_plan: "session plan state",
  update_todos: "session plan state",
  remove_todos: "session plan state",
  update_working_state: "session state",
  session_config: "session state",
  objective_get: "objective state",
  objective_set: "objective state",
  objective_update: "objective state",
  artifact_get: "artifact registry",
  artifact_list: "artifact registry",
  artifact_register: "artifact registry",
  artifact_destroy: "artifact registry",
  ci_finding: "records a finding in the session store",
  communicate_update: "reports progress to the operator",
  reflect: "records a reflection",
  budget_status: "reads the budget meter",
  prompt_cache_status: "reads cache counters",
  permission_propose_pattern: "proposes a permission pattern to the operator",
  report_agent_job_result: "records a job result",
  threads_handoff: "emits a handoff link; no I/O",
  fork_session: "forks the local session",
  memory_write: "writes the local memory store",
  memory_update: "writes the local memory store",
  // The model provider the agent already talks to.
  advisor: "consults the configured model provider",
  memory_search: "local search; embeds through the configured provider",
  // Control of processes that already exist; nothing new runs.
  bash_kill: "signals a background process",
  pty_attach: "attaches to an existing PTY",
  pty_kill: "signals a PTY",
  pty_resize: "resizes a PTY",
  // Child agent loops: each child is built from this config and runs under this guard
  // (`buildChildConfig`), so its own calls are checked here too.
  agent: "child loop under this guard",
  delegate: "child loop under this guard",
  spawn_agent: "child loop under this guard",
  spawn_batch: "child loops under this guard",
  spawn_agents_on_csv: "child loops under this guard",
  run_workflow: "child loops under this guard",
  branch_search: "candidate loops spread this config, guard included",
  subagent_fork: "child loop under this guard",
  followup_task: "continues a child loop under this guard",
  send_input: "messages a child loop",
  close_agent: "stops a child loop",
  wait_agent: "waits for a child loop",
  list_agents: "lists child loops",
  subagent_await: "waits for a child loop",
  subagent_poll: "polls a child loop",
  subagent_read_messages: "reads a child's messages",
  subagent_send_message: "messages a child loop",
  subagent_force_background: "backgrounds a child loop",
  task_stop: "stops a child task",
  team_create: "groups child loops",
  team_delete: "ungroups child loops",
  side_agent_list: "lists side-agent records",
  side_agent_findings: "reads side-agent findings",
  side_agent_stop: "stops a side agent",
  code_cell: "QuickJS sandbox with no network; its tool calls re-enter this guard",
}

export const isPermittedUnderDenyAll = (tool: string): boolean =>
  Object.hasOwn(DENY_ALL_PERMITTED_TOOLS, tool)
