/**
 * Tool-surface SSOT (jun-03) — the single managed catalog of the LLM-accessible
 * tool set: which tools exist, what gates them, and whether they are ON by
 * default per surface. The companion to the FEATURE catalog (`tools/feature-
 * catalog`): fc governs *features*, this governs the *LLM tool-access axis*
 * (gate + per-surface default) that was previously scattered across
 * `buildDefaultTools` + the tier-1 blocks (`@/agent/features`) + the host
 * `maybeWireX` slots (`@/host/runtime/agent-config-assembler`) + the CLI env
 * seed (`@/apps/cli`). One file now answers "what can the agent call, and when".
 *
 * # Why a manifest (not just docs)
 *
 * Hand-written docs drift. This module is the SSOT a TWO-WAY drift guard
 * (`tests/unit/tool-surface-manifest-hellgate.test.ts`) pins against the REAL
 * registry assembly: every registered tool name MUST appear here (no orphan
 * tools — that test caught `apply_patch_structured` missing from fc), and every
 * manifest entry MUST be a real tool name (no stale rows). Adding a tool without
 * a manifest row, or deleting a tool without removing its row, fails CI.
 *
 * # The two axes
 *
 * 1. BASE — always registered by `buildDefaultTools()` with no ports. These are
 *    the unconditional read/edit/shell/search primitives; their availability is
 *    not gated, so they carry `gate: { kind: "always" }` and `default: "on"` on
 *    every surface. Derived + asserted against `buildDefaultTools()` by the
 *    drift guard, NOT hand-maintained beyond the name list.
 * 2. GATED — registered only when an env flag / config slot / external resource
 *    is present. THIS is the genuinely-scattered data the manifest owns: the
 *    gate (env var or `AgentConfig` slot) AND the per-surface default
 *    (`on` = wired by default on that surface, `opt-in` = needs an explicit
 *    flag, `resource` = self-gates on an external resource being present).
 *
 * # Plane-clean
 *
 * Lives in `@/tool` (imported by every gate site: `@/apps/cli`, `@/host`,
 * `@/runner`). Imports nothing but `@/shared` — the {@link ToolSurface} axis is
 * a local string union (NOT `@/runner/knobs`'s `Surface`, which `@/tool` may not
 * import per the slice fence). Pure data + pure `resolveToolGate`; no I/O.
 *
 * # NO arbitrary heuristics
 *
 * Every default state is a documented decision (see each row's `note`), not a
 * guess: CLI-default-ON only for cheap/in-memory capabilities; `resource` for
 * anything needing Chrome / an API key; `opt-in` for surfaces sensitive to a
 * changed tool menu (bench/eval reproducibility) or where a tool OVERLAPS
 * another (background-scheduler vs the 6-tool router).
 */

import { assertNever } from "@/shared"

/** Surfaces the agent runs on. Distinct from `@/runner/knobs`'s `Surface`
 *  (which `@/tool` cannot import) — this is the tool-availability axis only. */
export type ToolSurface = "cli" | "bench" | "web" | "ide" | "headless"

/** All surfaces, in stable order — the drift guard + renderers iterate this. */
export const TOOL_SURFACES: readonly ToolSurface[] = ["cli", "bench", "web", "ide", "headless"]

/** How a tool's availability is decided. */
export type ToolGate =
  /** Always registered (base default set). */
  | { readonly kind: "always" }
  /** Gated on a boolean env flag (the surface's env view). `default-on` ⇒ the
   *  flag defaults true when unset; `opt-in` ⇒ the flag must be explicitly set. */
  | { readonly kind: "env-flag"; readonly env: string }
  /** Gated on an `AgentConfig` slot the composition root populates (often itself
   *  behind an env flag — recorded in `env` when there is one). */
  | { readonly kind: "config-slot"; readonly slot: string; readonly env?: string }
  /** Self-gates on an external resource being present (a binary on PATH, an API
   *  key). Wired automatically when the resource resolves; never forced. */
  | { readonly kind: "resource"; readonly resource: string; readonly env?: string }
  /** ORPHAN — the tool factory exists but is wired into NO assembly path, so no
   *  agent on any surface can call it today. Catalogued (not hidden) so the
   *  orphan is VISIBLE + the drift guard tracks it; `reason` says why it's parked. */
  | { readonly kind: "unwired"; readonly reason: string }

/** Per-surface default availability. `on` = wired by default; `opt-in` = needs an
 *  explicit gate; `resource` = wired iff the external resource is present. */
export type ToolDefault = "on" | "opt-in" | "resource"

/** Coarse risk class — drives the "should this be default-ON" judgement and is
 *  cross-checkable against the live `Tool.isReadOnly()` / `Tool.hitlTier`. */
export type ToolRisk = "read-only" | "mutating" | "exec" | "network" | "spawns-subagent" | "meta"

/** One managed tool (or tool-group sharing a single gate). */
export interface ToolSurfaceEntry {
  /** The registered tool `name` (or representative name for a same-gate group). */
  readonly name: string
  /** Sibling tool names that share this exact gate (e.g. the 6-tool router). */
  readonly group?: readonly string[]
  /** Where the tool is built. */
  readonly origin: string
  readonly gate: ToolGate
  /** Per-surface default. Surfaces omitted inherit `opt-in` (conservative). */
  readonly default: Partial<Record<ToolSurface, ToolDefault>>
  readonly risk: ToolRisk
  /** ADR reference, when one exists. */
  readonly adr?: string
  /** Why this default state (the non-heuristic justification). */
  readonly note?: string
}

/** The unconditional base set — `buildDefaultTools()` with NO ports. The drift
 *  guard asserts this list === the real base registry (minus the gated adds).
 *  Listed by name only; gate is implicitly `always` / default `on` everywhere. */
export const BASE_TOOL_NAMES: readonly string[] = [
  "read",
  "write",
  "edit",
  "scripted_replace",
  "apply_patch",
  "bash",
  "bash_await",
  "bash_kill",
  "grep",
  "glob",
  "localize",
  "file_tree_summary",
  "parse_test_failure",
  "test_runner",
  "diagnostics",
  "read_image",
  "read_image_url",
  "web_fetch",
  "csv_read",
  "ndjson_read",
  "yaml_read",
  "pdf_read",
  "xlsx_read",
  "docx_read",
  "pptx_read",
  "session_config",
]

/** The GATED tools — the scattered-gate axis this SSOT exists to centralize. */
export const GATED_TOOLS: readonly ToolSurfaceEntry[] = [
  {
    name: "apply_patch_structured",
    origin: "@/tool/apply-patch-structured-tool",
    gate: {
      kind: "config-slot",
      slot: "DefaultToolPorts.structuredPatch",
      env: "QUANTA_ENABLE_STRUCTURED_PATCH",
    },
    default: { cli: "on" },
    risk: "mutating",
    adr: "0464",
    note: "Per-file-isolated apply with self-correction hints. CLI default-ON; bench/web opt-in (tool-menu reproducibility).",
  },
  {
    name: "agent",
    group: ["task_output", "task_stop"],
    origin: "@/agent/tier1/subagent (trio)",
    gate: { kind: "config-slot", slot: "subagent.enabled", env: "QUANTA_SUBAGENT" },
    default: { cli: "on" },
    risk: "spawns-subagent",
    adr: "0011",
    note: "Sequential foreground subagent dispatch. CLI default-ON (QUANTA_SUBAGENT defaults true in the CLI surface); non-CLI surfaces own their own subagent posture, so the SSOT only claims CLI here (seed stays CLI-scoped — bench/web auto-seed nothing for reproducibility).",
  },
  {
    name: "spawn_agent",
    group: ["wait_agent", "close_agent", "exec_command", "write_stdin", "send_input"],
    origin: "@/agent/tier1/subagent (6-tool router)",
    gate: { kind: "config-slot", slot: "subagent.enable6Tools", env: "QUANTA_SUBAGENT_6TOOLS" },
    default: { cli: "on" },
    risk: "exec",
    adr: "0041",
    note: "Parallel background workers + raw PTY exec_command (cwd-jailed; dangerous cmds hit HITL). CLI default-ON.",
  },
  {
    name: "spawn_batch",
    origin: "@/agent/tier1/subagent-batch",
    gate: { kind: "config-slot", slot: "subagent.enableBatchSpawn", env: "QUANTA_SUBAGENT_BATCH" },
    default: { cli: "on" },
    risk: "spawns-subagent",
    adr: "0145",
    note: "Fan a prompt list over parallel children in one call. CLI default-ON (companion to spawn_agent).",
  },
  {
    name: "list_agents",
    origin: "@/agent/tier1/subagent-introspect",
    gate: {
      kind: "config-slot",
      slot: "subagent.enableIntrospect",
      env: "QUANTA_SUBAGENT_INTROSPECT",
    },
    default: { cli: "on" },
    risk: "meta",
    adr: "0041",
    note: "See the background workers spawned. CLI default-ON (near-mandatory companion to spawn_agent).",
  },
  {
    name: "subagent_send_message",
    group: ["subagent_read_messages"],
    origin: "@/agent/tier1/subagent-mailbox",
    gate: { kind: "config-slot", slot: "subagentMailbox", env: "QUANTA_SUBAGENT_MAILBOX" },
    default: { cli: "on" },
    risk: "meta",
    adr: "0416",
    note: "In-memory inter-agent mailbox. CLI default-ON (seeded in apps/cli); bench/web opt-in (shared assembler — reproducibility).",
  },
  {
    name: "objective_set",
    group: ["objective_get", "objective_update"],
    origin: "@/agent/tier1/objective",
    gate: { kind: "config-slot", slot: "objective", env: "QUANTA_OBJECTIVE_TOOLS" },
    default: { cli: "on" },
    risk: "meta",
    adr: "0394",
    note: "In-memory agent objective tracking. CLI default-ON (seeded); bench/web opt-in (shared assembler — reproducibility).",
  },
  {
    name: "subagent_fork",
    group: ["subagent_poll", "subagent_await"],
    origin: "@/agent/tier1/subagent-bg",
    gate: { kind: "config-slot", slot: "subagentBackground", env: "QUANTA_SUBAGENT_BG" },
    default: {},
    risk: "spawns-subagent",
    adr: "0151",
    note: "Background-scheduler parallel workers. OPT-IN everywhere — OVERLAPS the 6-tool spawn_agent router; don't give the model two parallel-spawn surfaces by default.",
  },
  {
    name: "browser_snapshot",
    group: [
      "browser_navigate",
      "browser_click",
      "browser_type",
      "browser_screenshot",
      "browser_scroll",
      "browser_press_key",
      "browser_drag",
      "browser_select_option",
      "browser_fill",
      "browser_console",
      "browser_read",
      "browser_wait",
      "browser_cdp",
      "browser_mouse_click_xy",
    ],
    origin: "@/agent/tier1/browser (CDP)",
    gate: { kind: "resource", resource: "chrome/chromium on PATH", env: "QUANTA_BROWSER_TOOL" },
    default: { cli: "resource", web: "resource" },
    risk: "exec",
    adr: "0427",
    note: "Headless CDP browser automation. Wired only when QUANTA_BROWSER_TOOL=on AND a chrome binary exists (double-gate).",
  },
  {
    name: "web_search",
    origin: "@/agent/tier1/web-search",
    gate: { kind: "resource", resource: "BRAVE_SEARCH_API_KEY | QUANTA_WEB_SEARCH_DUCKDUCKGO=1" },
    default: {
      cli: "resource",
      bench: "resource",
      web: "resource",
      ide: "resource",
      headless: "resource",
    },
    risk: "network",
    adr: "0142",
    note: "Self-gates on an env-provided provider; no key ⇒ tool not registered (never a dead 'no provider' tool).",
  },
  {
    name: "git_status",
    group: [
      "git_diff",
      "git_log",
      "git_commit",
      "git_stage",
      "git_push",
      "git_branch_switch",
      "git_blame",
      "git_blame_heatmap",
      "git_churn",
      "git_compose_commit",
      "git_compose_pr",
      "git_conflict_inspect",
      "git_moved_code",
      "git_review_diff",
      "git_upstream_check",
    ],
    origin: "@/tool gitTools()",
    gate: { kind: "env-flag", env: "QUANTA_GIT_TOOLS" },
    default: { cli: "opt-in", bench: "opt-in", web: "opt-in", ide: "opt-in", headless: "opt-in" },
    risk: "mutating",
    adr: "0098",
    note: "Opt-in (QUANTA_GIT_TOOLS=1). Mutating git surface kept off the default menu — the agent uses bash for git unless explicitly opted in.",
  },
  {
    name: "gh_pr_view",
    group: [
      "gh_pr_list",
      "gh_pr_create",
      "gh_pr_open",
      "gh_pr_comment",
      "gh_pr_blame",
      "gh_pr_review_diff",
      "gh_pr_auto_merge",
      "gh_check_status",
      "gh_issue_view",
    ],
    origin: "@/tool gh* (gitTools)",
    gate: { kind: "env-flag", env: "QUANTA_GIT_TOOLS" },
    default: { cli: "opt-in" },
    risk: "network",
    adr: "0103",
    note: "GitHub PR/issue tools — opt-in alongside git tools.",
  },
  {
    name: "lsp_diagnostics",
    origin: "@/tool lspDiagnosticsTool",
    gate: { kind: "env-flag", env: "QUANTA_LSP" },
    default: { cli: "opt-in" },
    risk: "read-only",
    adr: "0141",
    note: "Opt-in — needs a language server running.",
  },
  {
    name: "lsp_references",
    group: [
      "lsp_document_symbol",
      "lsp_workspace_symbol",
      "lsp_rename_apply",
      "lsp_format",
      "lsp_code_action",
      "lsp_signature_help",
    ],
    origin: "@/tool lspNavToolList",
    gate: { kind: "env-flag", env: "QUANTA_LSP_TOOLS" },
    default: { cli: "opt-in" },
    risk: "mutating",
    adr: "0141",
    note: "Opt-in LSP navigation/edit tools — needs a language server.",
  },
  {
    name: "check_secrets",
    origin: "@/agent/tier1/check-secrets",
    gate: { kind: "env-flag", env: "QUANTA_SECRET_CHECK_TOOL" },
    default: { cli: "opt-in" },
    risk: "read-only",
    adr: "0164",
    note: "Opt-in (QUANTA_SECRET_CHECK_TOOL=on).",
  },
  {
    name: "automation_update",
    origin: "@/tool automation_update",
    gate: {
      kind: "config-slot",
      slot: "DefaultToolPorts.automationEngine",
      env: "QUANTA_AUTOMATION",
    },
    default: { cli: "opt-in" },
    risk: "mutating",
    adr: "0280",
    note: "Opt-in — registered only when an automation engine is wired.",
  },
  {
    name: "poll_deferred",
    origin: "@/tool poll_deferred",
    gate: { kind: "env-flag", env: "QUANTA_ASYNC_TOOLS" },
    default: { cli: "opt-in" },
    risk: "meta",
    adr: "0287",
    note: "Opt-in async-tools deferred-result poll.",
  },
  {
    name: "search_codebase",
    origin: "@/tool searchWire (retrieval pipeline)",
    gate: { kind: "env-flag", env: "QUANTA_INDEX" },
    default: { cli: "opt-in" },
    risk: "read-only",
    adr: "0159",
    note: "Opt-in — registered when the retrieval index pipeline is built.",
  },
  {
    name: "request_user_input",
    origin: "@/agent/tier1/user-input",
    gate: { kind: "config-slot", slot: "userInputPort" },
    default: { cli: "on" },
    risk: "meta",
    note: "Wired by the CLI runtime-context (interactive surface owns the ask channel).",
  },
  {
    name: "communicate_update",
    origin: "@/tool/communicate-update",
    gate: {
      kind: "config-slot",
      slot: "DefaultToolPorts.progressUpdate",
      env: "QUANTA_PROGRESS_UPDATE",
    },
    default: { cli: "opt-in" },
    risk: "read-only",
    note: "C2 — structured mid-turn progress report (current_step / final_summary / completed_subtitle → render-only progress_update event). Opt-in (QUANTA_PROGRESS_UPDATE=1); absent ⇒ tool not registered, byte-identical.",
  },
  {
    name: "shadow_rewind",
    group: ["shadow_snapshots", "shadow_verify", "shadow_restore_partial"],
    origin: "@/agent/tier1/shadow",
    gate: { kind: "config-slot", slot: "shadowOdb", env: "QUANTA_SHADOW" },
    default: { cli: "opt-in" },
    risk: "mutating",
    adr: "0121",
    note: "Opt-in (QUANTA_SHADOW) — checkpoint/rewind over the shadow ODB.",
  },
  {
    name: "create_plan",
    group: ["update_plan", "current_plan", "update_todos", "remove_todos"],
    origin: "@/agent/tier1/plan-mutation (buildPlanMutationBlock)",
    gate: { kind: "config-slot", slot: "planStore" },
    default: { cli: "opt-in" },
    risk: "meta",
    adr: "0207",
    note: "Plan/todo authoring. Wired when config.planStore is set (surface owns the store).",
  },
  {
    name: "request_plan_exit",
    origin: "@/agent/tier1/plan-exit (buildPlanExitBlock)",
    gate: { kind: "config-slot", slot: "planExitPort" },
    default: { cli: "opt-in" },
    risk: "meta",
    adr: "0088",
    note: "Agent-requested plan-mode exit. Wired when config.planExitPort is set.",
  },
  {
    name: "update_working_state",
    origin: "@/agent/tier1/working-state (buildWorkingStateBlock)",
    gate: { kind: "config-slot", slot: "workingState" },
    default: { cli: "opt-in" },
    risk: "meta",
    adr: "0135",
    note: "Agent scratch working-state. Wired when config.workingState is set.",
  },
  {
    name: "fork_session",
    origin: "@/agent/tier1/fork-session (buildForkSessionBlock)",
    gate: { kind: "config-slot", slot: "fork" },
    default: { cli: "opt-in" },
    risk: "meta",
    adr: "0201",
    note: "Fork the session into a child branch. Wired when config.fork.forker is set.",
  },
  {
    name: "delegate",
    origin: "@/agent/tier1/delegate (buildDelegateBlock)",
    gate: { kind: "config-slot", slot: "delegation" },
    default: { cli: "opt-in" },
    risk: "spawns-subagent",
    adr: "0218",
    note: "Mode-typed delegation. Wired when config.delegation is set (--delegate / QUANTA_DELEGATE).",
  },
  {
    name: "advisor",
    origin: "@/agent/tier1/advisor (buildAdvisorBlock)",
    gate: { kind: "config-slot", slot: "advisor", env: "QUANTA_ADVISOR_MODEL" },
    default: { cli: "opt-in" },
    risk: "network",
    note: "Second-opinion advisor LLM. Wired when config.advisor.consult is set.",
  },
  {
    name: "followup_task",
    origin: "@/agent/tier1/subagent-introspect (enableFollowup)",
    gate: { kind: "config-slot", slot: "subagent.enableFollowup" },
    default: { cli: "opt-in" },
    risk: "spawns-subagent",
    adr: "0041",
    note: "Queue a follow-up task. Opt-in — pairs with the mailbox/wake registry (not auto-on; left off until those are default-wired).",
  },
  {
    name: "list_mcp_tasks",
    group: ["get_mcp_task", "cancel_mcp_task"],
    origin: "@/tool/mcp_tasks (mcpTasksTools)",
    gate: { kind: "config-slot", slot: "TasksHandle (apps MCP wire)" },
    default: { cli: "opt-in" },
    risk: "meta",
    adr: "0196",
    note: "MCP long-running task control. Wired only when an MCP server advertises Tasks + the apps layer wires a TasksHandle.",
  },
  {
    name: "coverage_check",
    origin: "@/tool (coverageCheckTool, via DefaultToolPorts.coverageCheck)",
    gate: {
      kind: "config-slot",
      slot: "DefaultToolPorts.coverageCheck",
      env: "QUANTA_COVERAGE_TOOL",
    },
    default: { cli: "on" },
    risk: "read-only",
    adr: "0165",
    note: "Read-only V8-coverage reporter + optional threshold gate (self-verifying agents). CLI default-ON; bench/web opt-in (tool-menu reproducibility). Self-contained — builds its own coverage source; jailed path resolve like read/csv_read.",
  },
  {
    name: "image_gen",
    origin: "@/tool (imageGenTool, via DefaultToolPorts.imageGen)",
    gate: {
      kind: "config-slot",
      slot: "DefaultToolPorts.imageGen",
      env: "QUANTA_IMAGE_GEN",
    },
    default: { cli: "opt-in", bench: "opt-in", web: "opt-in", ide: "opt-in", headless: "opt-in" },
    risk: "mutating",
    adr: "H14a",
    note: "NEW CATEGORY — the first binary-artifact-GENERATION tool (text→image + edit; existing read_image* is read-only). Opt-in EVERYWHERE (QUANTA_IMAGE_GEN): spends provider quota AND writes files, so it never auto-seeds. The composition root wires a key-bound provider port; a key-less port yields a typed no_key failure (never a dead 'no provider' tool, never a crash). Output goes to a versioned-sibling jailed path (never silent overwrite, Codex imagegen save-path policy). Classed `mutating` (writes the artifact); also network-backed.",
  },
  {
    name: "xlsx_write",
    group: ["docx_write", "pptx_write"],
    origin: "@/tool/document/authoring (via DefaultToolPorts.officeAuthoring)",
    gate: {
      kind: "config-slot",
      slot: "DefaultToolPorts.officeAuthoring",
      env: "QUANTA_OFFICE_AUTHORING",
    },
    default: { cli: "opt-in", bench: "opt-in", web: "opt-in", ide: "opt-in", headless: "opt-in" },
    risk: "mutating",
    adr: "H14b",
    note: "NEW CATEGORY — Office document AUTHORING (generate real .xlsx / .docx) alongside image_gen. Pure-TS STORED-ZIP (CRC-32) + minimal-valid OOXML; NO office dependency (installs blocked). Opt-in EVERYWHERE (QUANTA_OFFICE_AUTHORING): writes files, so it never auto-seeds (CLI tool-menu reproducibility). Mutating — serialize in-memory then write through the same FS-jail chokepoint the readers use; an existing target lands at a versioned -vN sibling (never silent overwrite). No port to inject (self-contained). H14 PPTX follow-up added `pptx_write` (PresentationML) reusing this same STORED-ZIP + OOXML core; the matching `pptx_read` reader is BASE (always-on) alongside xlsx_read/docx_read.",
  },
  {
    name: "prompt_cache_status",
    origin: "@/tool (promptCacheStatusTool, via tier1 buildPromptCacheBlock)",
    gate: {
      kind: "config-slot",
      slot: "AgentConfig.promptCacheObserver",
      env: "QUANTA_PROMPT_CACHE_STATUS",
    },
    default: { cli: "on" },
    risk: "read-only",
    adr: "0182",
    note: "Read-only cache hit-rate / savings introspection. The host mints ONE PromptCacheObserver per session (maybeWirePromptCacheObserver); the SAME instance is fed by the loop's emitUsage (cache_read + cache_creation buckets, threaded adapter→StreamEvent→loop) and read by this tool. CLI default-ON; bench/web opt-in (tool-menu reproducibility).",
  },
  {
    name: "artifact_list",
    group: ["artifact_register", "artifact_get", "artifact_destroy"],
    origin: "@/tool/artifact (via DefaultToolPorts.artifactRegistry)",
    gate: {
      kind: "config-slot",
      slot: "DefaultToolPorts.artifactRegistry",
      env: "QUANTA_ARTIFACT_STORE",
    },
    default: { cli: "opt-in", bench: "opt-in", web: "opt-in", ide: "opt-in", headless: "opt-in" },
    risk: "meta",
    adr: "C1",
    note: "Canvas / artifact persistence store (§7). Session registry for NON-code generation outputs (image_gen PNGs, xlsx/docx/pptx files) — list/get/destroy by id + a stable `quanta-artifact://<id>` preview URL, so artifacts live OUTSIDE the transcript. `register` is host-side (the generation tools register their outputs); the model only reads/manages. Opt-in EVERYWHERE (QUANTA_ARTIFACT_STORE): a new capability whose registry must be wired, so it never auto-seeds. Pure in-memory registry (@/artifact, injected clock + id-factory); duck-typed port keeps @/tool fence-clean.",
  },
  {
    name: "side_agent_spawn",
    group: ["side_agent_list", "side_agent_stop", "side_agent_findings"],
    origin: "@/tool/side-agent (via tier1 buildSideAgentBlock on AgentConfig.sideAgentDaemons)",
    gate: {
      kind: "config-slot",
      slot: "AgentConfig.sideAgentDaemons",
      env: "QUANTA_SIDE_AGENT",
    },
    default: { cli: "opt-in", bench: "opt-in", web: "opt-in", ide: "opt-in", headless: "opt-in" },
    risk: "spawns-subagent",
    adr: "N1",
    note: "Background side-agent daemons (§7, RFC jun-4-background-side-agent) — a PERSISTENT daemon that wakes on interval/event, runs one bounded pass per wake, and PUSHES findings via mailbox WITHOUT blocking the main loop (distinct from one-shot subagent_*_bg and the scheduler). The model spawns/lists/stops/drains; the registry core (@/side-agent, pure leaf with injected runner/mailbox/timers) is host-supervised. Opt-in EVERYWHERE (QUANTA_SIDE_AGENT): spawns work, so it never auto-seeds. Duck-typed port keeps @/tool fence-clean. Phase-2 host runner adaptation wires the real subagent pass.",
  },
  {
    name: "mcp_connector_list",
    group: ["mcp_connector_install"],
    origin: "@/tool/mcp-connector (via DefaultToolPorts.mcpConnectors)",
    gate: {
      kind: "config-slot",
      slot: "DefaultToolPorts.mcpConnectors",
      env: "QUANTA_MCP_CONNECTORS",
    },
    default: { cli: "opt-in", bench: "opt-in", web: "opt-in", ide: "opt-in", headless: "opt-in" },
    risk: "mutating",
    adr: "N2",
    note: "MCP connector discovery/catalog (§7, Codex imported-connector-apps) — discover installable MCP servers + install one into .mcp.json (vs hand-editing). Pairs with H18 (OAuth=auth, this=discovery). The model lists/installs; the HOST owns the catalog source + toMcpServerConfig transform (@/connectors mcp-connector-catalog) + the real .mcp.json write. Group risk = the max-risk member: mcp_connector_list is read-only but mcp_connector_install is config-WRITE — it writes a .mcp.json server entry the host SPAWNS as code next launch, so the row is `mutating` (NOT `meta`/no-side-effect). Fail-closed: install REFUSES a divergent same-name server (name-conflict) and an unreadable/wrong-shaped existing .mcp.json (config-unreadable) rather than clobber a user-pinned/audited entry. Opt-in EVERYWHERE (QUANTA_MCP_CONNECTORS): install mutates config, never auto-seeds. Duck-typed port keeps @/tool fence-clean.",
  },
  {
    name: "mcp_list_resources",
    group: ["mcp_read_resource", "mcp_list_prompts", "mcp_get_prompt"],
    origin: "@/tool/mcp_resources (mcpResourcesTools, via DefaultToolPorts.mcpResources)",
    gate: {
      kind: "config-slot",
      slot: "DefaultToolPorts.mcpResources",
      env: "QUANTA_MCP_RESOURCES",
    },
    default: { cli: "opt-in", bench: "opt-in", web: "opt-in", ide: "opt-in", headless: "opt-in" },
    risk: "network",
    adr: "N3",
    note: "MCP resource/prompt read surface (§7, RFC jun-4-mcp-resource-tools) over the H19-landed McpClient resources/* + prompts/* methods. The model enumerates + reads a connected MCP server's resources and prompt templates. Wired only when an MCP server advertises resources/prompts + the apps layer wires a ResourcesHandle (the duck-typed mirror of @/mcp/resources McpResourcesPort, adapted over a live McpClient). risk:network because each call is an outbound RPC and resource READ exfiltrates server data into the transcript. Output is mcp-origin ⇒ deriveProvenance→mcp ⇒ the H2/ADR-0471 <untrusted-source> envelope wraps it at dispatch (third-party content is adversary-controllable DATA). BLOB blocks are never inlined (placeholder); text is capped. Opt-in EVERYWHERE (QUANTA_MCP_RESOURCES). Duck-typed port keeps @/tool fence-clean.",
  },
  {
    name: "pty_attach",
    group: ["pty_list", "pty_write", "pty_read", "pty_resize", "pty_kill"],
    origin: "@/tool/pty (ptyTools, via DefaultToolPorts.ptySession)",
    gate: {
      kind: "config-slot",
      slot: "DefaultToolPorts.ptySession",
      env: "QUANTA_PTY_ATTACH",
    },
    default: { cli: "opt-in", bench: "opt-in", web: "opt-in", ide: "opt-in", headless: "opt-in" },
    risk: "exec",
    adr: "N6",
    note: "Attach to a long-lived PTY / named tmux session — resize + live stdin/stdout (resumable `pty_read` cursor) across turns (§7, RFC jun-4-pty-attach). Distinct from the one-shot bash + 6-tool pipe paths: this attaches to sessions quanta did NOT necessarily spawn. Two zero-dep backends behind one PtySessionPort: tmux shell-out (createTmuxAdapter — attach to existing named sessions) and Bun native PTY (Bun.Terminal — real tty/resize). pty_list/pty_read are read-only; attach/write/resize/kill are exec-risk. SECURITY: only tmux sessions matching the allow-prefix (default `quanta-`) are attachable; a foreign session is fail-closed `foreign-denied` unless pty.allowForeignTmux + HITL; dangerous pty_write content flows through the host's existing command HITL; 64 KiB write cap, 1..1000 resize bounds, MAX_ATTACHED cap. Opt-in EVERYWHERE (QUANTA_PTY_ATTACH) — exec risk, touches sessions outside the spawn jail; never auto-seeds. Closed-port DI keeps @/tool/pty fence-clean (injected exec/backend).",
  },
]

/** Resolve a single tool/group's availability on a surface given a default-state
 *  resolver. Pure. `gateActive` answers "is this tool's gate satisfied right
 *  now" (the caller wires it to the real env/resource/slot check); this fn maps
 *  the manifest's per-surface DEFAULT policy. The two compose at the call site:
 *  a tool is available iff its surface default is `on`, OR (`opt-in`/`resource`)
 *  AND the gate is active. */
export const surfaceDefaultFor = (entry: ToolSurfaceEntry, surface: ToolSurface): ToolDefault =>
  entry.default[surface] ?? "opt-in"

/** Should this surface seed the tool's env flag to ON by default? True only for
 *  `on`-default entries that gate on an env flag / config-slot-with-env — i.e.
 *  the set the CLI host seeds. `resource`/`opt-in` are never auto-seeded. */
export const shouldSeedOn = (entry: ToolSurfaceEntry, surface: ToolSurface): boolean => {
  if (surfaceDefaultFor(entry, surface) !== "on") return false
  const g = entry.gate
  switch (g.kind) {
    case "env-flag":
      return true
    case "config-slot":
      return g.env !== undefined
    case "resource":
    case "always":
    case "unwired":
      return false
    default:
      return assertNever(g)
  }
}

/** Every env var the manifest names — the canonical gate-env set the CLI seed
 *  block + drift guard read from (no hand-kept parallel list). */
export const seedEnvVarsForSurface = (surface: ToolSurface): readonly string[] => {
  const out: string[] = []
  for (const entry of GATED_TOOLS) {
    if (!shouldSeedOn(entry, surface)) continue
    const g = entry.gate
    const env = g.kind === "env-flag" ? g.env : g.kind === "config-slot" ? g.env : undefined
    if (env !== undefined && !out.includes(env)) out.push(env)
  }
  return out
}

/** Flatten an entry to all the concrete tool names it governs. */
export const entryToolNames = (entry: ToolSurfaceEntry): readonly string[] => [
  entry.name,
  ...(entry.group ?? []),
]

/** All tool names the manifest accounts for (base + every gated group member).
 *  The drift guard asserts this set covers the live registry. */
export const ALL_MANIFEST_TOOL_NAMES: readonly string[] = [
  ...BASE_TOOL_NAMES,
  ...GATED_TOOLS.flatMap(entryToolNames),
]
