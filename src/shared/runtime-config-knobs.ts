/**
 * `@/shared/runtime-config-knobs.ts` — DECLARATION registry for the typed
 * `runtime-config` knobs (ADR-0503 P3, catalog completeness).
 *
 * The ~145 knobs read by `runtime-config.ts`'s `loadFromEnv` are consumed as
 * `runtimeConfig().<field>` (typed struct), so they never appear as a quoted
 * `QUANTA_X` literal in slices — which means the unified catalog (cli + inventory
 * + runner) was MISSING them. This registry declares them (envKey/kind/default/
 * describe/group) so the catalog (`/knobs all`, `--help`, web `/api/knobs`)
 * becomes the TRUE single SSOT over every quanta knob.
 *
 * DECLARATION-ONLY + PURE DATA (no imports, no env reads). Lives in @/shared
 * (the layer runtime-config lives in) so both surface wires (apps/cli, apps/web)
 * can import it downward. `home: "runtime-config"` for all (these ARE the typed
 * runtime-config fields). Secrets are credential VALUES, absent by design — the
 * credential-HELPER command knobs (api-key-helper, *-auth-refresh) are config,
 * not secrets, so they stay.
 */

export type RcKind = "bool" | "int" | "float" | "string" | "enum"

export interface RuntimeConfigKnob {
  readonly envKey: `QUANTA_${string}`
  readonly kind: RcKind
  readonly default: boolean | number | string | undefined
  readonly group: string
  readonly describe: string
}

export const RUNTIME_CONFIG_KNOBS: readonly RuntimeConfigKnob[] = [
  // ── loop / compaction
  { envKey: "QUANTA_LOG_LEVEL", kind: "enum", default: "info", group: "observability", describe: "Log level threshold for stderr." },
  { envKey: "QUANTA_COMPACT_TOKENS", kind: "int", default: undefined, group: "compaction", describe: "Compaction threshold override (tokens)." },
  { envKey: "QUANTA_BG_COMPACTION", kind: "bool", default: false, group: "compaction", describe: "Background speculative compaction (ADR-0473)." },
  { envKey: "QUANTA_MICROCOMPACT", kind: "bool", default: false, group: "compaction", describe: "Tier-1 tool-result eviction gate." },
  { envKey: "QUANTA_MICROCOMPACT_KEEP_RECENT", kind: "int", default: undefined, group: "compaction", describe: "Keep last N tool_results intact." },
  { envKey: "QUANTA_MICROCOMPACT_FLOOR_TOKENS", kind: "int", default: undefined, group: "compaction", describe: "Minimum token savings to fire." },
  { envKey: "QUANTA_MICROCOMPACT_INTERVAL_MS", kind: "int", default: undefined, group: "compaction", describe: "Time-based cadence between fires (ms)." },
  // ── tool / agent-loop gates
  { envKey: "QUANTA_UNTRUSTED_ENVELOPE", kind: "bool", default: false, group: "tool", describe: "Untrusted-source envelope gate." },
  { envKey: "QUANTA_EDIT_REPAIR_LOOP", kind: "bool", default: false, group: "tool", describe: "Edit-repair-loop (lint-delta) gate." },
  { envKey: "QUANTA_READ_DEDUP", kind: "bool", default: false, group: "tool", describe: "Read file_unchanged dedup gate." },
  { envKey: "QUANTA_IMAGE_GEN", kind: "bool", default: false, group: "tool", describe: "image_gen tool gate." },
  { envKey: "QUANTA_OFFICE_AUTHORING", kind: "bool", default: false, group: "tool", describe: "Office document authoring gate." },
  { envKey: "QUANTA_ARTIFACT_STORE", kind: "bool", default: false, group: "tool", describe: "Canvas artifact persistence store." },
  { envKey: "QUANTA_FILE_HISTORY", kind: "bool", default: false, group: "tool", describe: "file_history_rewind capture gate." },
  { envKey: "QUANTA_APPSHOT", kind: "bool", default: false, group: "tool", describe: "Appshot visual-verify loop gate." },
  { envKey: "QUANTA_SKILL_CREATOR", kind: "bool", default: false, group: "tool", describe: "Skill-creator agent-callable tool gate." },
  { envKey: "QUANTA_ASYNC_TOOLS", kind: "bool", default: false, group: "tool", describe: "Async-tool kind activation." },
  { envKey: "QUANTA_DEFERRED_CAP", kind: "int", default: undefined, group: "tool", describe: "Deferred-result registry max live handles." },
  { envKey: "QUANTA_TOOL_OUTPUT_MAX", kind: "int", default: undefined, group: "tool", describe: "Tool output cap." },
  { envKey: "QUANTA_TOOL_OUTPUT_SPILL_KEEP", kind: "int", default: undefined, group: "tool", describe: "Tool spill retention." },
  { envKey: "QUANTA_TOOL_INTERRUPT_BLOCK", kind: "bool", default: false, group: "tool", describe: "Block-interrupt critical-section gate." },
  { envKey: "QUANTA_CRITICAL_SECTION_MAX_MS", kind: "int", default: 5000, group: "tool", describe: "Watchdog cap (ms) bounding critical section." },
  { envKey: "QUANTA_IPYNB_OUTPUTS", kind: "bool", default: true, group: "tool", describe: "Render .ipynb textual outputs (default ON)." },
  { envKey: "QUANTA_PTY_BACKEND", kind: "enum", default: "tmux", group: "tool", describe: "PTY backend (tmux/bun/both)." },
  { envKey: "QUANTA_PTY_ATTACH", kind: "bool", default: false, group: "tool", describe: "PTY/tmux session attach gate." },
  { envKey: "QUANTA_PTY_INHERIT_ENV", kind: "bool", default: false, group: "tool", describe: "PTY env-inherit escape hatch." },
  { envKey: "QUANTA_FAST_APPLY_MERGE", kind: "bool", default: false, group: "tool", describe: "Model-apply MERGE rung gate." },
  { envKey: "QUANTA_FAST_APPLY_MODEL", kind: "string", default: undefined, group: "tool", describe: "Operator-chosen apply-model id." },
  { envKey: "QUANTA_DEDUP_ENV_PREFIXES_EXTRA", kind: "string", default: "", group: "tool", describe: "Extra literal command prefixes appended." },
  // ── code-mode (strict security)
  { envKey: "QUANTA_CODE_MODE", kind: "bool", default: false, group: "tool", describe: "code-mode Phase-1 security gate (strict)." },
  { envKey: "QUANTA_CODE_MODE_ONLY", kind: "bool", default: false, group: "tool", describe: "code-mode Phase-3 steering gate (strict)." },
  { envKey: "QUANTA_CODE_MODE_MEM_BYTES", kind: "int", default: undefined, group: "tool", describe: "code-mode WASM heap cap (bytes)." },
  { envKey: "QUANTA_CODE_MODE_TIMEOUT_MS", kind: "int", default: undefined, group: "tool", describe: "code-mode wall-clock deadline (ms)." },
  { envKey: "QUANTA_CODE_MODE_MAX_CALLS", kind: "int", default: undefined, group: "tool", describe: "code-mode per-cell tool-call cap." },
  { envKey: "QUANTA_CODE_MODE_OUTPUT_CAP", kind: "int", default: undefined, group: "tool", describe: "code-mode model-facing output cap." },
  // ── mcp
  { envKey: "QUANTA_SKILL_MCP_DEPS", kind: "bool", default: false, group: "mcp", describe: "Skill→MCP auto-attach gate." },
  { envKey: "QUANTA_MCP_SAMPLING", kind: "bool", default: false, group: "mcp", describe: "Inbound MCP sampling gate." },
  { envKey: "QUANTA_MCP_ROOTS", kind: "bool", default: false, group: "mcp", describe: "Inbound MCP roots/list gate." },
  { envKey: "QUANTA_MCP_OAUTH", kind: "bool", default: false, group: "mcp", describe: "MCP HTTP-server OAuth gate." },
  { envKey: "QUANTA_MCP_OAUTH_KEYRING", kind: "bool", default: false, group: "mcp", describe: "OS-keyring-backed MCP OAuth token store." },
  { envKey: "QUANTA_MCP_CONNECTORS", kind: "bool", default: false, group: "mcp", describe: "MCP connector discovery gate." },
  { envKey: "QUANTA_MCP_RESOURCES", kind: "bool", default: false, group: "mcp", describe: "MCP resource/prompt tools gate." },
  { envKey: "QUANTA_MCP_TOOL_ANNOTATIONS", kind: "bool", default: false, group: "mcp", describe: "Honor MCP server-declared tool annotations." },
  { envKey: "QUANTA_MCP_PROTOCOL_MAX", kind: "string", default: undefined, group: "mcp", describe: "Max-offered MCP protocol version." },
  // ── memory
  { envKey: "QUANTA_DELTA_TOKEN_COUNT", kind: "bool", default: false, group: "memory", describe: "Incremental context-estimate gate." },
  { envKey: "QUANTA_AUTO_DREAM", kind: "bool", default: false, group: "memory", describe: "Cross-session memory consolidation gate." },
  { envKey: "QUANTA_AUTO_DREAM_SESSIONS", kind: "int", default: undefined, group: "memory", describe: "Sessions-since-last-dream threshold." },
  { envKey: "QUANTA_AUTO_DREAM_HOURS", kind: "float", default: undefined, group: "memory", describe: "Hours-since-last-dream threshold." },
  // ── subagent / team
  { envKey: "QUANTA_TEAM_DAG", kind: "bool", default: false, group: "subagent", describe: "Multi-agent task-dependency DAG gate." },
  { envKey: "QUANTA_TEAM_BROKER", kind: "bool", default: false, group: "subagent", describe: "Leader-mediated escalation broker." },
  { envKey: "QUANTA_TEAM_IDLE", kind: "bool", default: false, group: "subagent", describe: "Team-idle barrier gate." },
  { envKey: "QUANTA_TEAM_PEER_MSG", kind: "bool", default: false, group: "subagent", describe: "Peer teammate messaging gate." },
  { envKey: "QUANTA_SUBAGENT_QUEUE", kind: "bool", default: false, group: "subagent", describe: "Subagent background admission queue." },
  { envKey: "QUANTA_FORCE_BACKGROUND", kind: "bool", default: false, group: "subagent", describe: "Force-background tool exposure gate." },
  { envKey: "QUANTA_SIDE_AGENT", kind: "bool", default: false, group: "subagent", describe: "Background side-agent daemons gate." },
  // ── session / git / permission
  { envKey: "QUANTA_GOAL_ENFORCE", kind: "bool", default: false, group: "session", describe: "Idle goal-continuation gate." },
  { envKey: "QUANTA_MIGRATE_CONFIG", kind: "bool", default: false, group: "session", describe: "External-agent-config migration gate." },
  { envKey: "QUANTA_OBJECTIVE_BUDGET_ENFORCE", kind: "bool", default: false, group: "session", describe: "Thread-goal budget enforcement gate." },
  { envKey: "QUANTA_CAP_ENFORCE", kind: "bool", default: false, group: "session", describe: "Cap-as-instruction dispatch enforcement." },
  { envKey: "QUANTA_SESSIONS_DIR", kind: "string", default: undefined, group: "session", describe: "Sessions root override." },
  { envKey: "QUANTA_SESSION_TRANSCRIPT_MAX_BYTES", kind: "int", default: undefined, group: "session", describe: "Per-session transcript retention cap (bytes)." },
  { envKey: "QUANTA_SESSION_LIST_FORMAT", kind: "enum", default: undefined, group: "session", describe: "Session-list default format pin." },
  { envKey: "QUANTA_SESSION_LIST_MAX", kind: "int", default: undefined, group: "session", describe: "Session-list default cap." },
  { envKey: "QUANTA_SESSION_AUTO_TITLE", kind: "bool", default: false, group: "session", describe: "AI session auto-title gate." },
  { envKey: "QUANTA_SESSION_TITLE_MODEL", kind: "string", default: undefined, group: "session", describe: "Cheap model id for auto-title." },
  { envKey: "QUANTA_GIT_SHA", kind: "string", default: undefined, group: "git", describe: "Git SHA stamp for trajectory producer." },
  { envKey: "QUANTA_PASSIVE_VCS", kind: "bool", default: false, group: "git", describe: "Passive git/gh VCS classification gate." },
  { envKey: "QUANTA_FS_JAIL", kind: "bool", default: true, group: "permission", describe: "FS jail (=off disables — security protection)." },
  { envKey: "QUANTA_REMEMBER_PATTERNS", kind: "bool", default: false, group: "permission", describe: "Remember-patterns recording seam." },
  { envKey: "QUANTA_REMEMBER_PATTERNS_DANGEROUS", kind: "bool", default: false, group: "permission", describe: "Opt-in for dangerous remembered patterns." },
  { envKey: "QUANTA_DENY_REASON", kind: "bool", default: false, group: "permission", describe: "Structured deny-reason surfacing gate." },
  { envKey: "QUANTA_SANDBOX_ESCALATION", kind: "bool", default: false, group: "permission", describe: "OS-sandbox escalation-retry loop." },
  { envKey: "QUANTA_SANDBOX_ESCALATION_MAX", kind: "int", default: undefined, group: "permission", describe: "Sandbox-escalation per-turn retry cap." },
  { envKey: "QUANTA_PERMISSION_STATE", kind: "string", default: undefined, group: "permission", describe: "Permission state-file override." },
  { envKey: "QUANTA_PROFILES_DIR", kind: "string", default: undefined, group: "permission", describe: "User permission-profile directory." },
  { envKey: "QUANTA_PERMISSION_HOOK", kind: "bool", default: false, group: "permission", describe: "permission_request hook kill-switch." },
  { envKey: "QUANTA_GLOB_WRITE_GUARD", kind: "bool", default: false, group: "permission", describe: "Glob-in-write-path guard gate." },
  { envKey: "QUANTA_WRITE_BUDGET", kind: "bool", default: false, group: "permission", describe: "Per-turn write/edit budget gate." },
  { envKey: "QUANTA_WRITE_BUDGET_MAX", kind: "int", default: undefined, group: "permission", describe: "Per-turn write/edit cap N." },
  { envKey: "QUANTA_EXFIL_SCOUTING", kind: "bool", default: false, group: "permission", describe: "Exfil-scouting gate." },
  { envKey: "QUANTA_EXFIL_SCOUTING_K", kind: "int", default: undefined, group: "permission", describe: "Exfil-scouting threshold K." },
  { envKey: "QUANTA_GUARDIAN_ASSESSOR", kind: "bool", default: false, group: "permission", describe: "Per-action LLM risk assessor gate." },
  { envKey: "QUANTA_HITL_OVERRIDES", kind: "string", default: undefined, group: "permission", describe: "HITL overrides JSON path." },
  // ── llm / network
  { envKey: "QUANTA_REASONING_CARRYOVER", kind: "bool", default: false, group: "llm", describe: "Reasoning carry-over gate." },
  { envKey: "QUANTA_ADAPTIVE_THINKING", kind: "bool", default: false, group: "llm", describe: "Adaptive thinking-budget control gate." },
  { envKey: "QUANTA_PRICING_VERSION", kind: "string", default: undefined, group: "llm", describe: "Trajectory pricing version override." },
  { envKey: "QUANTA_LLM_STREAM_FIRST_CHUNK_MS", kind: "int", default: undefined, group: "llm", describe: "LLM stream first-chunk timeout (ms)." },
  { envKey: "QUANTA_LLM_STREAM_IDLE_MS", kind: "int", default: undefined, group: "llm", describe: "LLM stream inter-chunk idle timeout (ms)." },
  { envKey: "QUANTA_LLM_TRANSPORT", kind: "string", default: undefined, group: "llm", describe: "Explicit cloud-transport selection." },
  { envKey: "QUANTA_LLM_CREDENTIAL_TRUSTED", kind: "bool", default: false, group: "llm", describe: "Workspace-trust attestation for credential-helper." },
  { envKey: "QUANTA_PROMPT_CACHE_TTL", kind: "enum", default: "5m", group: "llm", describe: "Prompt-cache TTL selector." },
  { envKey: "QUANTA_API_KEY_HELPER_LEGACY_VENDOR", kind: "bool", default: false, group: "llm", describe: "Legacy per-vendor apiKeyHelper resolution." },
  { envKey: "QUANTA_AUTO_MODE_RULES", kind: "bool", default: false, group: "llm", describe: "User rule-overlay auto-mode classifier." },
  { envKey: "QUANTA_CIRCUMVENT_DETECT", kind: "bool", default: false, group: "llm", describe: "Denied-effect re-attempt tracker gate." },
  { envKey: "QUANTA_API_KEY_HELPER", kind: "string", default: undefined, group: "network", describe: "Rotating-credential shell command." },
  { envKey: "QUANTA_API_KEY_HELPER_TTL_MS", kind: "int", default: undefined, group: "network", describe: "apiKeyHelper refresh TTL (ms)." },
  { envKey: "QUANTA_AWS_AUTH_REFRESH", kind: "string", default: undefined, group: "network", describe: "AWS pre-call refresh command." },
  { envKey: "QUANTA_GCP_AUTH_REFRESH", kind: "string", default: undefined, group: "network", describe: "GCP pre-call refresh command." },
  { envKey: "QUANTA_OAUTH_REVOKE_ON_LOGOUT", kind: "bool", default: false, group: "network", describe: "OAuth token revoke-on-logout gate." },
  { envKey: "QUANTA_RATELIMIT_PROACTIVE", kind: "bool", default: false, group: "network", describe: "Account-ratelimit proactive pre-request delay." },
  { envKey: "QUANTA_SECRET_EGRESS", kind: "enum", default: undefined, group: "network", describe: "Secret-aware egress mode." },
  { envKey: "QUANTA_SECRET_EGRESS_MAX_BODY", kind: "int", default: undefined, group: "network", describe: "Max buffered-body byte cap for secret-egress." },
  { envKey: "QUANTA_TLS_MITM_ON_FAILURE", kind: "enum", default: "deny", group: "network", describe: "TLS-MITM fail-closed policy." },
  // ── search
  { envKey: "QUANTA_SYNTAX_CHUNK", kind: "bool", default: false, group: "search", describe: "Syntax-aware-chunking opt-in." },
  { envKey: "QUANTA_READ_OUTLINE", kind: "bool", default: false, group: "search", describe: "Read-outline opt-in." },
  { envKey: "QUANTA_TREE_SITTER_DIR", kind: "string", default: undefined, group: "search", describe: "Grammar-wasm dir override." },
  // ── ui / directives
  { envKey: "QUANTA_PASTE_BURST", kind: "int", default: undefined, group: "ui", describe: "Large-paste coalescing threshold." },
  { envKey: "QUANTA_RATELIMIT_NOTICE", kind: "bool", default: false, group: "ui", describe: "Transient CLI quota notice." },
  { envKey: "QUANTA_PROGRESS_UPDATE", kind: "bool", default: false, group: "ui", describe: "Structured mid-turn progress report." },
  { envKey: "QUANTA_MIDTURN_CAPTURE", kind: "bool", default: false, group: "ui", describe: "Mid-turn keystroke capture gate." },
  { envKey: "QUANTA_BRIEF", kind: "bool", default: false, group: "ui", describe: "Brief-mode session-posture seed." },
  { envKey: "QUANTA_DIRECTIVE_AUTONOMOUS", kind: "bool", default: false, group: "ui", describe: "Autonomous-loop preamble directive." },
  { envKey: "QUANTA_DIRECTIVE_READ_COMPLETE", kind: "bool", default: false, group: "ui", describe: "Read-completeness directive." },
  { envKey: "QUANTA_DIRECTIVE_PROGRESS", kind: "bool", default: false, group: "ui", describe: "Progress-narration discipline directive." },
  { envKey: "QUANTA_DIRECTIVE_MEMORY_VERIFY", kind: "bool", default: false, group: "ui", describe: "Memory-drift verify-before-trust directive." },
  { envKey: "QUANTA_DIRECTIVE_THINK_FREQ", kind: "bool", default: false, group: "ui", describe: "Thinking-frequency self-regulation directive." },
  { envKey: "QUANTA_DIRECTIVE_ANTI_PLATITUDE", kind: "bool", default: false, group: "ui", describe: "Anti-platitude voice directive." },
  { envKey: "QUANTA_DIRECTIVE_PARALLEL_TOOLS", kind: "bool", default: false, group: "ui", describe: "Parallel tool-call nudge directive." },
  { envKey: "QUANTA_ADVISOR_RAIL", kind: "bool", default: false, group: "ui", describe: "Advisor timing-rail directive." },
  { envKey: "QUANTA_ADVISOR_FORWARD_HISTORY", kind: "bool", default: false, group: "ui", describe: "Advisor full-history forward gate." },
  // ── bench / misc / config
  { envKey: "QUANTA_HOME", kind: "string", default: undefined, group: "misc", describe: "Quanta home dir override." },
  { envKey: "QUANTA_PREFS_HOME", kind: "string", default: undefined, group: "misc", describe: "Preferences home override." },
  { envKey: "QUANTA_LAST_TOKENS", kind: "string", default: undefined, group: "observability", describe: "Last-reported token count." },
  { envKey: "QUANTA_LOG_RATE_LIMIT", kind: "bool", default: false, group: "observability", describe: "Disable logger label-keyed rate limiter." },
  { envKey: "QUANTA_HOOK_TIMEOUT_MS", kind: "int", default: undefined, group: "misc", describe: "Hook per-handler timeout (ms)." },
  { envKey: "QUANTA_HOOK_MAX_HANDLERS", kind: "int", default: undefined, group: "misc", describe: "Max handlers per hook event." },
  { envKey: "QUANTA_HOOK_MAX_PAYLOAD_BYTES", kind: "int", default: undefined, group: "misc", describe: "Max hook emit payload (bytes)." },
  { envKey: "QUANTA_MANIFEST_COMPAT", kind: "bool", default: false, group: "misc", describe: "Codex-shape manifest ingest normalizer." },
  { envKey: "QUANTA_CENTRAL_CONFIG", kind: "bool", default: false, group: "misc", describe: "Repo-local central config loader gate (strict)." },
  { envKey: "QUANTA_CONFIG_DIR", kind: "string", default: undefined, group: "misc", describe: "User-config-dir override (@/config USER layer)." },
  { envKey: "QUANTA_SETTING_SOURCES", kind: "string", default: undefined, group: "misc", describe: "Setting-sources subset for config layers." },
  { envKey: "QUANTA_TRUSTED_PATHS", kind: "string", default: undefined, group: "misc", describe: "Static trusted-path allow-list (headless/CI)." },
  { envKey: "QUANTA_BENCH_HOME", kind: "string", default: undefined, group: "bench", describe: "Bench artifacts root override." },
  { envKey: "QUANTA_BENCH_CACHE_PATHSPECS_EXTRA", kind: "string", default: "", group: "bench", describe: "Extra cache directory names appended." },
  { envKey: "QUANTA_BENCH_TIMEOUT_MS", kind: "int", default: undefined, group: "bench", describe: "Per-instance wall-clock budget." },
  { envKey: "QUANTA_MAX_TURNS", kind: "int", default: undefined, group: "bench", describe: "Max turns per instance (bench)." },
  { envKey: "QUANTA_RUN_ID", kind: "string", default: undefined, group: "bench", describe: "Pinned run id." },
  { envKey: "QUANTA_SWEBENCH_CACHE_LEVEL", kind: "enum", default: "env", group: "bench", describe: "SWE-bench Docker image cache level." },
  { envKey: "QUANTA_SWEBENCH_CLEAN", kind: "bool", default: false, group: "bench", describe: "SWE-bench clean flag." },
  { envKey: "QUANTA_SWEBENCH_MAX_WORKERS", kind: "int", default: undefined, group: "bench", describe: "SWE-bench grading parallelism." },
  { envKey: "QUANTA_SWEBENCH_NAMESPACE", kind: "string", default: undefined, group: "bench", describe: "SWE-bench image namespace." },
  { envKey: "QUANTA_SWEBENCH_FORCE_REBUILD", kind: "bool", default: false, group: "bench", describe: "SWE-bench force_rebuild flag." },
  { envKey: "QUANTA_SWEBENCH_PYTHON_BIN", kind: "string", default: undefined, group: "bench", describe: "Explicit Python interpreter for SWE-bench." },
  { envKey: "QUANTA_SWEBENCH_PREPARE_FORCE", kind: "bool", default: false, group: "bench", describe: "Force local build attempt on arm64." },
]

export const allRuntimeConfigKnobs = (): readonly RuntimeConfigKnob[] => RUNTIME_CONFIG_KNOBS
