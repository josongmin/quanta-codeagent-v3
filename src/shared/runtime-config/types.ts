/**
 * The `RuntimeConfig` interface — every runtime-tunable value, frozen at startup.
 * Extracted from `runtime-config.ts` (god-module split): the parent keeps the
 * `loadFromEnv` resolver body + the live cache, this file carries the typed
 * surface so neither file exceeds the god-module threshold. The launcher/path/
 * bench half lives in `./types-extra` (`RuntimeConfigPaths`); `RuntimeConfig`
 * `extends` it, so the public shape is one structural interface (UNCHANGED).
 *
 * Leaf type imports come from `./parsers` (the shared value-vocabulary). The
 * `#24` doc↔resolver drift hellgate cross-checks BOTH this file's and
 * `./types-extra`'s per-field JSDoc against the parent's `loadFromEnv` lines.
 */

import type { BashAutoBackgroundMode, LogLevel, PtyBackend } from "./parsers"
import type { RuntimeConfigPaths } from "./types-extra"

/** All runtime-tunable values, frozen at startup. Add fields here when a new
 *  env var is introduced — never read `process.env` from a feature site. */
export interface RuntimeConfig extends RuntimeConfigPaths {
  readonly logLevel: LogLevel
  /** Compaction threshold override (tokens). Absent ⇒ use the per-config
   *  default in `agent/compaction.ts`. NEVER silently flipped by env. */
  readonly compactTokens: number | undefined
  /** ADR-0473 background (speculative) compaction gate (`QUANTA_BG_COMPACTION`).
   *  Strict opt-in: `true` ONLY when the value is exactly `"1"` (mirrors the
   *  `bgCompactionEnabled` slice gate). Default false ⇒ the loop's existing
   *  synchronous proactive/reactive compaction paths are byte-identical. */
  readonly bgCompaction: boolean
  /** RFC-01 A7 context-headroom advisory (`QUANTA_CONTEXT_HEADROOM_ADVISORY`).
   *  Strict `=== "1"` opt-in. Default false ⇒ the compaction wire emits no
   *  `context_headroom_crossed` event and never touches the latch — byte-identical.
   *  Owned here so the @/agent slice reads a resolved boolean, not process.env. */
  readonly contextHeadroomAdvisory: boolean
  /** RFC jun-6-microcompaction — tier-1 tool-result eviction gate
   *  (`QUANTA_MICROCOMPACT`). Opt-in: `true` ONLY when the value is
   *  exactly `"1"`. Default false ⇒ `maybeCompact` never constructs the
   *  eviction pre-pass, never reads its clock, never touches the spill dir — the
   *  existing tier-2-only flow is byte-identical. */
  readonly microcompact: boolean
  /** Keep the LAST N tool_results intact during a microcompaction
   *  (`QUANTA_MICROCOMPACT_KEEP_RECENT`, positive int). Absent ⇒ the wire
   *  default (the recent results are the live working set). */
  readonly microcompactKeepRecent: number | undefined
  /** Commit a microcompaction ONLY if estimated tokensSaved > this floor
   *  (`QUANTA_MICROCOMPACT_FLOOR_TOKENS`, positive int). Below the floor,
   *  churning the transcript is not worth it. Absent ⇒ the wire default. */
  readonly microcompactFloorTokens: number | undefined
  /** Time-based cadence (ms) between microcompaction fires
   *  (`QUANTA_MICROCOMPACT_INTERVAL_MS`, positive int). A min-interval gate held
   *  in the wire. Absent ⇒ the wire default. */
  readonly microcompactIntervalMs: number | undefined
  /** ADR-0471 untrusted-source envelope gate (`QUANTA_UNTRUSTED_ENVELOPE`).
   *  Strict opt-in: `true` ONLY when the value is exactly `"1"` (mirrors the
   *  `untrustedEnvelopeEnabled` slice gate). Default false ⇒ tool-result text
   *  is NOT wrapped at the dispatch seam (byte-identical). */
  readonly untrustedEnvelope: boolean
  /** ADR-0472 edit-repair-loop gate (`QUANTA_EDIT_REPAIR_LOOP`). Strict opt-in
   *  (`=== "1"`). Default false ⇒ the dispatch seam attaches no lint-delta to
   *  edit results (byte-identical). */
  readonly editRepairLoop: boolean
  /** ADR-0476 skill→MCP auto-attach gate (`QUANTA_SKILL_MCP_DEPS`). Strict
   *  opt-in (`=== "1"`). Default false ⇒ skill `dependencies.tools[]` blocks are
   *  NOT lifted onto the active-skill channel and no MCP server is auto-attached
   *  (byte-identical). Also read by the slice's own `skillMcpDepsEnabled`. */
  readonly skillMcpDeps: boolean
  /** ADR-0470 B1 follow-up inbound MCP sampling gate (`QUANTA_MCP_SAMPLING`).
   *  Opt-in (`gateOn` vocab `1`/`on`/`true`/`yes`; #24). LIVE consumer:
   *  `host/mcp-composition.ts` (`resolveMcpInboundWiring`, ~L623) reads this
   *  field and passes it to `buildSamplingWiring(runtimeConfig().mcpSampling,
   *  samplingDeps)`, whose `advertise` flag + answering handler flow to the MCP
   *  inbound negotiator / sampling handler (advertise-iff-able).
   *  Advertise-iff-able: sampling is ON only when this field is set AND an LLM
   *  AND an interactive consent prompter are assembled at the composition root (a
   *  remote server must never silently spend inference unattended); the
   *  advertisement and the `@/llm`-backed HITL handler always move together.
   *  Default false ⇒ `buildSamplingWiring` returns OFF, sampling is NOT
   *  advertised, and the headless rejecter declines (`no-handler`) —
   *  byte-identical. A live consumer exists when ON (given LLM + consent). */
  readonly mcpSampling: boolean
  /** delta-token-accounting (RFC jun-6) incremental context-estimate gate
   *  (`QUANTA_DELTA_TOKEN_COUNT`). Strict opt-in (`=== "1"`). When ON, the loop
   *  may construct a `TokenDeltaCounter` and read its O(1) running `total()` at
   *  the `estimateTokens` re-scan sites instead of re-walking the whole
   *  transcript. The counter tracks the PRE-CEIL char sum (`charsOf`) and applies
   *  the single end-`Math.ceil` only in `total()`, so the produced numbers are
   *  byte-identical to a full re-scan (the knob guards CONSTRUCTION/perf, NOT
   *  arithmetic). Default false ⇒ the counter is never constructed and every site
   *  calls `estimateTokens(...)` directly — byte-identical, zero new allocation. */
  readonly deltaTokenCount: boolean
  /** H19 (jun-3-misc §3) inbound MCP `roots/list` gate (`QUANTA_MCP_ROOTS`).
   *  Opt-in (`gateOn` vocab `1`/`on`/`true`/`yes`; #24). When ON *and* the composition root wires a
   *  `RootsProviderPort` (from the active workspace), the MCP client advertises
   *  `roots` AND answers inbound `roots/list` from that source
   *  (advertise-iff-able — the advertisement and the source always move
   *  together). Default false ⇒ `roots` is NOT advertised and an unsolicited
   *  `roots/list` is answered with an empty list (byte-identical negotiation).
   *  The typed OUTBOUND `resources/*` + `prompts/*` methods are NOT gated by
   *  this knob — they only act when the connected server advertises the
   *  matching capability, so they are always safe to expose. */
  readonly mcpRoots: boolean
  /** H18 (jun-04) MCP HTTP-server OAuth gate (`QUANTA_MCP_OAUTH`). Opt-in
   *  (the `gateOn` truthy vocab (#24)). When ON *and* the composition root wires a connectors-backed
   *  `McpOAuthProviderPort` (RFC 8414 discovery → DCR → PKCE browser flow →
   *  token, RFC 6749 §6 refresh) AND a server config sets `oauth: true`, the
   *  `McpClient` resolves a bearer and attaches `Authorization: Bearer <token>`
   *  to that server's HTTP requests. Default false ⇒ no provider is wired, the
   *  client falls back to the headless rejecter (obtains no token), and every
   *  MCP load is byte-identical to the pre-H18 path (no discovery, no flow, no
   *  header). The provider and the per-server `oauth` opt-in must BOTH be present
   *  for any OAuth side effect (advertise-iff-able). */
  readonly mcpOAuth: boolean
  /** H9 read `file_unchanged` dedup gate (`QUANTA_READ_DEDUP`). Opt-in
   *  (the `gateOn` truthy vocab (#24)). When ON, the `read` tool short-circuits a re-read of the SAME
   *  (canonical path, offset, limit) whose CONTENT HASH equals the hash recorded
   *  when that range was last read, returning a compact `file_unchanged`
   *  sentinel instead of re-sending the full content (large token savings in
   *  iterative loops). CONTENT-TRUTH (UUX-6-07): the file is read + hashed EVERY
   *  time (the dedup saves tokens, not disk IO) and the verdict compares the
   *  just-read bytes' hash — an mtime-preserving content rewrite can never serve
   *  a stale verdict (pre-fix the signal was the mtime, which such a rewrite
   *  defeats). Default false ⇒ the read tool ALWAYS renders full content,
   *  computes NO hash, and allocates NO per-range dedup state (byte-identical to
   *  the pre-H9 path). ORTHOGONAL to the stale-read-guard (ADR-0474,
   *  write-blocking freshness — still mtime-based): H9 is the READ-SIDE dedup,
   *  keyed by RANGE, and never affects guardWrite. */
  readonly readDedup: boolean
  /** H6 (jun-3-misc §3) passive git/gh VCS classification gate
   *  (`QUANTA_PASSIVE_VCS`). Opt-in (`gateOn` vocab `1`/`on`/`true`/`yes`; #24). Default false ⇒ the
   *  bash post-exec hook returns immediately (no stdout classification, no
   *  sink touch, byte-identical). When true AND a host wired a `vcsEventSink`,
   *  a completed git/gh command's stdout is classified into a structured VCS
   *  event (`{commit:{sha,kind}, push, branch:{action}, pr:{number}}`) and
   *  forwarded onto the EXISTING turn-diff bus. Closes the raw-stdout blind
   *  spot of `src/git/directive-emit/` (which only reads quanta's own
   *  `::git-*` lines). */
  readonly passiveVcs: boolean
  /** N1 assistant language auto-detect gate (`QUANTA_LANG_DETECT`). Strict
   *  opt-in (`gateOn` vocab; #24). Default false ⇒ buildDynamicContext pushes NO language
   *  notice (byte-identical prompt). When true, a high-confidence non-English
   *  Unicode-script detection on the latest user message injects a per-turn
   *  "respond in <lang>" notice (English/ambiguous ⇒ still byte-identical). */
  readonly langDetect: boolean
  /** H14a image_gen tool gate (`QUANTA_IMAGE_GEN`). Opt-in (`gateOn` vocab `1`/`on`/`true`/`yes`; #24).
   *  Default false ⇒ the composition root wires NO `DefaultToolPorts.imageGen`
   *  port, so the `image_gen` tool is NOT registered (byte-identical default
   *  menu). When true AND a provider key resolves, the host passes a key-bound
   *  `openAiImagePort({ apiKey })` and the model gains text→image generation +
   *  edit (writes a versioned-sibling artifact through the FS jail). A missing
   *  key surfaces as a typed `no_key` failure, never a crash. */
  readonly imageGen: boolean
  /** H14b Office document AUTHORING gate (`QUANTA_OFFICE_AUTHORING`). Strict
   *  opt-in (`gateOn` vocab; #24). Default false ⇒ the composition root wires NO
   *  `DefaultToolPorts.officeAuthoring`, so `xlsx_write` / `docx_write` are NOT
   *  registered (byte-identical default menu). When true the agent can generate
   *  real `.xlsx` / `.docx` files (pure-TS STORED-ZIP + OOXML, no office
   *  dependency) to jailed, versioned-sibling paths (never silent overwrite). */
  readonly officeAuthoring: boolean
  /** W6 (NotebookEdit P17) `notebook_edit` tool gate (`QUANTA_NOTEBOOK_EDIT`).
   *  Opt-in (`gateOn` vocab `1`/`on`/`true`/`yes`; #24). Default false ⇒ host sets NO
   *  `DefaultToolPorts.notebookEdit`, tool not registered (byte-identical menu).
   *  When true, the cell editor (str_replace/insert/delete on `.ipynb`) is
   *  appended, writing through the same FS jail `edit`/`write` use. */
  readonly notebookEdit: boolean
  /** W5 (DAP) `debug_inspect` debugger tool gate (`QUANTA_DEBUG_TOOLS`). Strict
   *  opt-in (`gateOn` vocab; #24). Default false ⇒ host sets NO `DefaultToolPorts.debugTools`,
   *  tool not registered (byte-identical menu). When true, `debug_inspect` (run
   *  under a DAP adapter, stop at first breakpoint, report stack + variables) is
   *  appended — high-risk (executes the program), always-confirm tier. */
  readonly debugTools: boolean
  /** ADR-0249 `node_repl` persistent-kernel tool gate (`QUANTA_NODE_REPL`).
   *  Strict opt-in (`gateOn` vocab; #24). Default false ⇒ host wires NO
   *  `DefaultToolPorts.nodeRepl`, tool not registered (byte-identical menu).
   *  When true, `node_repl` (evaluate code in a persistent `node -i` subprocess
   *  whose bindings survive across calls) is appended — high-risk (arbitrary
   *  Node code, full host access), always-confirm tier. */
  readonly nodeRepl: boolean
  /** Epic-2 `run_tests` structured test-runner gate (`QUANTA_TEST_RUNNER`).
   *  Opt-in (`gateOn` vocab `1`/`on`/`true`/`yes`; #24). Default false ⇒ host sets NO
   *  `DefaultToolPorts.testRunner`, tool not registered (byte-identical). When
   *  true, `run_tests` (detect toolchain + run suite + normalized evidence) is
   *  appended — high-risk (runs project test code), always-confirm tier. */
  readonly testRunner: boolean
  /** Keystone `collect_evidence` Evidence Packet Builder gate (`QUANTA_EVIDENCE`).
   *  Opt-in (`gateOn` vocab `1`/`on`/`true`/`yes`; #24). Default false ⇒ host sets NO
   *  `DefaultToolPorts.evidence`, tool not registered (byte-identical). When true,
   *  `collect_evidence` (detect → run suite → fuse failure+static+runtime+repo
   *  into one packet) is appended — high-risk (runs the suite), always-confirm. */
  readonly evidence: boolean
  /** H15 (jun-3-misc §3) reasoning carry-over gate (`QUANTA_REASONING_CARRYOVER`).
   *  OpenAI-Responses / o-series ONLY (the ChatGPT-OAuth subscription path).
   *  Opt-in (`gateOn` vocab `1`/`on`/`true`/`yes`; #24). Default false ⇒ the responses-wire path is
   *  BYTE-IDENTICAL to today: each reasoning item's `encrypted_content` is
   *  DROPPED (non-resumable), no `include` field is added, and no prior reasoning
   *  is re-emitted on the next turn's input. When true the wire captures each
   *  reasoning output item's opaque `encrypted_content` (ZDR — never decoded
   *  locally), the host persists it per-turn, and the NEXT turn's Responses input
   *  re-emits those reasoning items at its head with `store:false` +
   *  `include:["reasoning.encrypted_content"]` so multi-step chain-of-thought
   *  survives across turns/tool-calls. NEVER affects the Anthropic adapter or the
   *  chat-completions path (provider-scoped to the Responses surface). */
  readonly reasoningCarryover: boolean
  /** H13 external-agent-config migration gate (`QUANTA_MIGRATE_CONFIG`). Strict
   *  opt-in (`gateOn` vocab; #24). Default false ⇒ startup runs NO detect of competitor
   *  (Claude Code / Cursor) config, surfaces no migration prompt, and writes no
   *  throttle ledger — byte-identical startup. When true the CLI startup seam
   *  runs `runConfigMigration({ enabled: true, homeDir, projectDir })`, which
   *  detects `~/.claude` + project `.claude`/`CLAUDE.md`/`.mcp.json`/subagents
   *  + Cursor `.cursor/rules`, converts each into the quanta shape, throttles a
   *  re-offer via `~/.quanta/external_config_migration.json`, and surfaces a
   *  one-line stderr notice. Import is opt-in (notice only). */
  readonly migrateConfig: boolean
  /** H17 thread-goal budget ENFORCEMENT gate (`QUANTA_OBJECTIVE_BUDGET_ENFORCE`).
   *  Opt-in (`gateOn` vocab `1`/`on`/`true`/`yes`; #24). Default false ⇒ the `ObjectiveBudget`
   *  (maxTokens/maxTurns) stays purely INFORMATIONAL — the objective store's
   *  derived `status` never takes `"budget_limited"` and the loop's
   *  idle-continuation re-issues `setNextActions` exactly as today
   *  (byte-identical to ADR-0394). When true the host constructs the objective
   *  store with `enforceBudget: true`, so once accumulated `tokensUsed >=
   *  maxTokens` (or `turnsUsed >= maxTurns`) the status flips to
   *  `"budget_limited"` and the loop STOPS re-issuing continuation for that
   *  exhausted objective (a hard gate — a budget-exhausted goal does not
   *  auto-resume). Raising/resetting the budget un-limits (the status is a pure
   *  function of the current cell, no sticky flag). */
  readonly objectiveBudgetEnforce: boolean
  /** H17 idle goal-CONTINUATION gate (`QUANTA_GOAL_ENFORCE`). Opt-in
   *  (the `gateOn` truthy vocab (#24)). Default false ⇒ NO idle goal-continuation is ever launched —
   *  byte-identical to today's informational objective (the orchestrator's
   *  `enabled` is false, so `runIdleContinuation` returns `disabled` before
   *  touching any port or resume sink). When true the host wires the
   *  idle-monitor / reactor seam to `runIdleContinuation`: an IDLE thread with
   *  an `active` goal auto-resumes, GUARDED by the Codex guards (plan-mode /
   *  turn-active / queued-input / mailbox-input / no-goal / ephemeral /
   *  goal-changed) and serialized by a single-permit semaphore. Independent of
   *  `QUANTA_OBJECTIVE_BUDGET_ENFORCE` (that gate controls budget→status; this
   *  one controls whether the idle resume fires at all). */
  readonly goalContinuationEnforce: boolean
  /** Capability A — multi-agent task dependency DAG gate (`QUANTA_TEAM_DAG`).
   *  Opt-in (`gateOn` vocab `1`/`on`/`true`/`yes`; #24). Default false ⇒ `spawn_batch` fan-out is the
   *  EXISTING flat parallel pool (no dependency ordering) — byte-identical. When
   *  ON *and* a batch carries dependency edges, the tier1 builder wraps the
   *  child runner with a DAG gate (`@/subagent/coordination`) so each child
   *  dispatches only once its `dependsOn` are completed, releasing dependents as
   *  children finish (bounded by the existing worker ceiling). A cyclic/dangling
   *  graph is rejected before dispatch; a failed/cancelled dep surfaces its
   *  dependents as a typed dead branch (never an indefinite hang). */
  readonly teamDag: boolean
  /** Capability B — leader-mediated permission escalation broker
   *  (`QUANTA_TEAM_BROKER`). Opt-in (`gateOn` vocab `1`/`on`/`true`/`yes`; #24). Default false ⇒ a worker
   *  that hits a denied tool fails hard (today's behavior — no escalation path).
   *  When ON, the worker's SOFT-deny is brokered IN-PROCESS by the leader's
   *  wire (`@/agent/coordination-broker-wire#buildLeaderHitlBroker`): it runs the
   *  escalation through the host's permission decide/HITL and the worker applies
   *  ONLY a leader-authored response matching its outstanding correlationId — it
   *  can NEVER self-grant (load-bearing security invariant, plan §5). */
  readonly teamBroker: boolean
  /** Capability C — team-idle barrier (`QUANTA_TEAM_IDLE`). Opt-in
   *  (the `gateOn` truthy vocab (#24)). Default false ⇒ the leader polls / no fan-in barrier (today).
   *  When ON, each subagent emits an idle beacon at turn-end and the leader
   *  awaits `teamIdle` (`@/subagent/coordination`) — every member idle — before
   *  fanning in (next phase / handoff / shutdown). Pure predicate + injected
   *  clock; absent ⇒ no beacons, byte-identical. */
  readonly teamIdle: boolean
  /** Peer teammate messaging (`QUANTA_TEAM_PEER_MSG`, RFC jun-6). Opt-in
   *  (the `gateOn` truthy vocab (#24)). Builds ON the EXISTING `QUANTA_TEAM_*` peer mailbox + wake-idle
   *  substrate; adds three deltas. Default false ⇒ (a) the loop wires no
   *  `peerInbox` drain (`pollPeerInbox` returns null ⇒ the turn loop is
   *  byte-identical — peer mail surfaces ONLY via a manual `subagent_read_messages`
   *  poll, today's behavior); (b) no `TeamScopedMailbox` decorator (the raw global
   *  mailbox is used — no cross-team partition); (c) no team registry, `team_create`/
   *  `team_delete` NOT registered. When ON: (1) auto-delivery — undelivered peer
   *  mail drains into the recipient's turn at the turn-top seam (no manual poll;
   *  a wake'd idle teammate now auto-receives); (2) team boundary — a
   *  `TeamRegistryPort` + a `TeamScopedMailbox` decorator over the EXISTING store
   *  denies cross-team `send` (before enqueue) and scopes `"*"` to the sender's
   *  own team; `team_create`/`team_delete` mint/reap a membership scope (NOT a new
   *  store — the audit-H caps stay global); (3) redaction — the auto-delivered
   *  body is routed through `@/security/redaction` (peer content is untrusted-as-
   *  DATA) before it enters context. SECURITY: the peer bus is a COMMS channel,
   *  never a grant channel — auto-delivered mail enters context as INFORMATION
   *  only; it does NOT invoke the permission decider, and the broker's
   *  leader-authored-response-only widen (no-self-grant) is preserved. */
  readonly teamPeerMsg: boolean
  /** RFC11-1 — corpus-parity subagent observability projection
   *  (`QUANTA_SUBAGENT_OBS`). Opt-in (`gateOn` vocab; #24). Default false ⇒ the
   *  subagent runner does NOT tap the child stream and projects NOTHING onto the
   *  `SubagentResult` / `TaskRecord.result` (byte-identical to the pre-RFC11-1
   *  result JSON). When ON, the runner wraps the child stream with a pass-through
   *  tap (event stream still byte-identical) and PROJECTS — never stores —
   *  `{frameCount, modelsUsed?, worktreeBranch?, totalToolUseCount?, totalTokens?,
   *  totalDurationMs, usage?}` from signals that already exist (RFC-02-3
   *  `model_route_changed` events, the always-on `usage`/`tool_call` events, the
   *  RFC-06 worktree branch, `turns`). NO new store / meter / bus. */
  readonly subagentObs: boolean
  /** C1 — Canvas / artifact persistence store (`QUANTA_ARTIFACT_STORE`). Strict
   *  opt-in (`gateOn` vocab; #24). Default false ⇒ no registry, the artifact tools are NOT
   *  registered (byte-identical). When ON, the composition root mints ONE
   *  per-session `@/artifact` registry and passes it to
   *  `DefaultToolPorts.artifactRegistry` (the generation tools register their
   *  outputs; the model lists/inspects/destroys via `artifact_*`). */
  readonly artifactStore: boolean
  /** ADR-0503 P3 — master gate for the cross-surface capability-exposure layer
   *  (`@/capability`, `QUANTA_CAPABILITY_LAYER`). Strict opt-in (`=== "1"`).
   *  Default false ⇒ `resolveExposure` is NOT wired into any live surface gate;
   *  each surface keeps its legacy per-surface env read (byte-identical degrade).
   *  When ON the read-only consistency probe cross-checks the unified resolver
   *  against the legacy gate to catch split-brain drift (it never mutates flow). */
  readonly capabilityLayer: boolean
  /** code-mode (RFC jun-6-code-mode, Phase 1) gate (`QUANTA_CODE_MODE`). Strict
   *  opt-in (`=== "1"`). Default false ⇒ the composition root wires NO
   *  `DefaultToolPorts.codeCellDispatch` factory, the `code_cell` tool is NOT
   *  registered (byte-identical default menu), and the QuickJS-WASM module is
   *  NEVER instantiated (lazily imported only when the tool runs). When ON the
   *  agent gains `code_cell`: a model-authored JS program runs in a QuickJS-WASM
   *  isolate whose every `await tools.X(args)` re-enters the REAL `dispatchTool`
   *  (full admissibility gate / HARD_DENY / plan-mode / redaction — a cell is N
   *  ordinary gated tool calls). The cell has NO require/fetch/process/FS/network
   *  surface (QuickJS gives none; we add none). */
  readonly codeMode: boolean
  /** code-mode Phase 3 — `code_mode_only` steering gate (`QUANTA_CODE_MODE_ONLY`).
   *  Strict opt-in (`=== "1"`). Default false ⇒ the per-turn dynamic
   *  `<system-reminder>` carries NO code-mode steering directive (byte-identical
   *  dynamic tail) — the model uses the normal one-tool-per-turn path. When ON,
   *  `buildDynamicContext` splices the `CODE_MODE_ONLY_DIRECTIVE` (steers the
   *  model to drive multi-step work through `code_cell` programs). Independent of
   *  `codeMode` (the SECURITY gate that registers the tool + wires the port): the
   *  directive is harmless prose when `code_cell` is not also wired, but a host
   *  that wants the model to actually USE cells sets BOTH `QUANTA_CODE_MODE=1`
   *  (registers + gates the tool) AND `QUANTA_CODE_MODE_ONLY=1` (steers toward it).
   *  This knob NEVER hides individual tools or relaxes any gate — the in-cell
   *  re-gating (permission / HARD_DENY / plan-mode) is unchanged; it only shapes
   *  the model's calling STYLE via prompt prose. */
  readonly codeModeOnly: boolean
  /** code-mode WASM heap cap in bytes (`QUANTA_CODE_MODE_MEM_BYTES`). Unset ⇒
   *  the tool falls back to the 64 MiB default (`CODE_MODE_DEFAULTS`). */
  readonly codeModeMemBytes: number | undefined
  /** code-mode wall-clock deadline ms (`QUANTA_CODE_MODE_TIMEOUT_MS`). Unset ⇒
   *  30 s default. A `while(true){}` cell is interrupted at the deadline. */
  readonly codeModeTimeoutMs: number | undefined
  /** code-mode per-cell tool-call cap (`QUANTA_CODE_MODE_MAX_CALLS`). Unset ⇒
   *  64 default. A runaway fan-out past the cap throws a typed cap error. */
  readonly codeModeMaxCalls: number | undefined
  /** code-mode model-facing output cap in bytes (`QUANTA_CODE_MODE_OUTPUT_CAP`).
   *  Unset ⇒ 16 KiB default; over-cap return is truncated with a marker. */
  readonly codeModeOutputCap: number | undefined
  /** file_history_rewind — per-file session-snapshot capture + restore
   *  (`QUANTA_FILE_HISTORY`). Opt-in (`gateOn` vocab `1`/`on`/`true`/`yes`; #24). Default false ⇒ no
   *  per-file history store is constructed, the write/edit capture sink is NOT
   *  wired (no recording), and `file_history_rewind` is NOT registered
   *  (byte-identical). When ON, the composition root mints ONE per-session
   *  bounded {@link FileHistoryStore} (`@/tool/file-history`), wires its sink
   *  onto `AgentConfig.fileHistory` (write/edit record each new file version),
   *  and registers the list/restore tool bound to the SAME store. Bounded per
   *  path (versions + bytes — no unbounded growth) and jailed (a path can't
   *  escape cwd; same `resolveJailed` chokepoint as read/write). */
  readonly fileHistory: boolean
  /** CLUSTER D #5 — remember-patterns RECORDING seam (`QUANTA_REMEMBER_PATTERNS`).
   *  Opt-in (`gateOn` vocab `1`/`on`/`true`/`yes`; #24). Default false ⇒ no `PatternGrantStore` is
   *  constructed, `DefaultToolPorts.permissionPatternPropose` stays absent, and
   *  `permission_propose_pattern` is NOT registered (byte-identical). When ON, the
   *  composition root mints ONE per-session `PatternGrantStore` seeded with the
   *  trusted user/policy baseline and wires the no-widen propose port (the model
   *  may then propose baseline-covered pattern refinements; an uncovered proposal
   *  is rejected — it can never self-grant a new capability). */
  readonly rememberPatterns: boolean
  /** CLUSTER D #5 residual — operator opt-in to RECORD `maybeDangerous`
   *  self-proposed patterns (`QUANTA_REMEMBER_PATTERNS_DANGEROUS`). Strict opt-in
   *  (`=== "1"`). Default false ⇒ a model proposal flagged dangerous is ALWAYS
   *  rejected (`dangerous`), routed to the reviewer — the current safe behavior,
   *  byte-identical. When ON, the composition root passes `allowDangerous: true`
   *  into the propose port so a dangerous-BUT-baseline-covered proposal records.
   *  SECURITY (load-bearing): this lifts ONLY the extra dangerous-gate; the
   *  no-widen gate is UNTOUCHED — a dangerous-AND-uncovered proposal is still
   *  `would_widen` rejected, so the knob can never let a model self-grant a new
   *  capability. Inert unless `rememberPatterns` is also ON (no slice ⇒ no port). */
  readonly rememberPatternsDangerous: boolean
  /** jun-6 (Codex paste-burst) — large-paste coalescing threshold
   *  (`QUANTA_PASTE_BURST`, a positive integer = the inclusive min-char count).
   *  Absent / invalid ⇒ `undefined` ⇒ the CLI reader echoes a paste inline
   *  exactly as today (byte-identical). When set, a SINGLE keypress carrying ≥
   *  this many chars is echoed as `[Pasted Content N chars]` while the FULL text
   *  still submits. Detection is chunk-SIZE only (no clock). The reader slice
   *  takes this by injection (`ReadLineOptions.pasteBurst`); it never reads env. */
  readonly pasteBurstMinChars: number | undefined
  /** jun-6 (Codex skill-creator) — agent-callable skill-authoring tool gate
   *  (`QUANTA_SKILL_CREATOR`). Opt-in (`gateOn` vocab `1`/`on`/`true`/`yes`; #24). Default false ⇒ no
   *  `SkillWriterPort` is constructed and the `skill_create` tool is NOT
   *  registered (byte-identical default tool surface). When ON, the composition
   *  root wires a jailed writer (under the user/repo skills dir) and registers
   *  the tool so the model can scaffold + validate + install a new skill. */
  readonly skillCreator: boolean
  /** ADR-0252 — Windsurf-style `{{ name }}` template-literal substitution in the
   *  skill body (`QUANTA_SKILL_TEMPLATE_VARS`). Opt-in (`gateOn` vocab
   *  `1`/`on`/`true`/`yes`; #24). Default false ⇒ the `Skill` tool body is NOT
   *  scanned for `{{ name }}` (byte-identical — a literal `{{ x }}` in a body is
   *  emitted verbatim exactly as today). When ON, a body's `{{ name }}` refs are
   *  resolved against a context parsed from the caller's `key=value` `args`
   *  tokens via `createDefaultTemplateExpander`; an unknown variable surfaces the
   *  expander's typed short-circuit (no guess / silent-drop). Runs ALONGSIDE the
   *  `$ARGUMENTS`/`$N` positional interpolation (ADR-0252 sibling contract). */
  readonly skillTemplateVars: boolean
  /** C6 — structured deny-reason surfacing (`QUANTA_DENY_REASON`). Opt-in
   *  (the `gateOn` truthy vocab (#24)). Default false ⇒ the `ToolFailure.permission_denied` envelope
   *  omits `denyReason`, the model-facing deny `content` carries no
   *  `[layer/pillar]` prefix, and the `DecisionEvent` carries only its current
   *  fields — byte-identical to today. When ON, each deny site attaches a
   *  {@link import("@/permission").StructuredDenyReason} (whose `safeReason`
   *  REUSES the already-sanitized recorder one-liner — no new exposure) so the
   *  model can self-correct on the deciding `layer` / `pillar` instead of
   *  retry-thrashing, and a human debugging a deny sees provenance. The
   *  structured reason is computed lazily ONLY when this is on (zero allocation
   *  otherwise). */
  readonly surfaceDenyReason: boolean
  /** T05 (per-hunk diff accept/reject) — `QUANTA_HUNK_APPROVAL`. Opt-in (the
   *  `gateOn` truthy vocab; #24). Default false ⇒ the approval prompt offers
   *  ONLY whole-call approve/deny (byte-identical to today); a `selectedHunks`
   *  on the decision/command is inert. When ON, the CLI confirm offers an
   *  `[h]unk-select` verb for a previewable mutation with ≥2 hunks, and the
   *  accepted subset is applied via `@/runner/hunk-apply` (atomic + mode-
   *  preserving + staleness-guarded). Partial application is an integrity risk
   *  on overlapping/offset hunks, so this starts opt-in (unlike the default-ON
   *  `QUANTA_DIFF_PREVIEW`). */
  readonly hunkApproval: boolean
  /** RFC06-4 (B5) — durable mutation receipt + CAS undo journal for per-hunk
   *  apply (`QUANTA_HUNK_MUTATION_RECEIPT`). Opt-in (`gateOn` vocab (#24)).
   *  Default false ⇒ the per-hunk apply is byte-identical (no receipt persisted,
   *  no undo journal). When ON, every per-hunk apply goes through
   *  `@/runner/hunk-mutation-journal#applyHunkSelectionWithReceipt`, recording an
   *  intent→effect→terminal receipt with before/after/expected-current hashes so
   *  the mutation is undoable via a content-verified CAS revert (fail-closed on
   *  disk drift). Independent of `hunkApproval`. */
  readonly hunkMutationReceipt: boolean
  /** sandbox-escalation (RFC jun-6) — OS-sandbox block → user-gated
   *  escalation-retry loop (`QUANTA_SANDBOX_ESCALATION`). Opt-in
   *  (the `gateOn` truthy vocab (#24)). Default false ⇒ the platform result-mapping points NEVER
   *  consult `classifySandboxDenial` (no `denialReason` is ever set),
   *  `sandboxBlockToLlmError` is never wired, and a nonzero exit from a
   *  sandboxed command is BYTE-IDENTICAL to today (a plain failure — no
   *  discriminant, no escalation prompt, no post-denial record). When ON, a
   *  recognised sandbox BLOCK (the sandbox ran AND denied a syscall) is surfaced
   *  to the model as recoverable; the model may re-request the byte-same argv
   *  `escalate:true` + a `justification`, routed through the EXISTING post-denial
   *  3-step machine (`recordDenial` → `recordRiskSeen` → `recordUserOverride`) +
   *  the normal permission gate (escalation NEVER auto-grants — always routes to
   *  user/HITL). On approve the byte-same argv re-runs WITHOUT the sandbox
   *  wrapper for that ONE call. NOTE: this unlocks a future SAFE default-ON
   *  sandbox (a blocked-but-legitimate command now recovers via escalation
   *  instead of failing opaquely) — but FLIPPING `QUANTA_SANDBOX` to default-ON
   *  is a SEPARATE decision, explicitly OUT OF SCOPE here. */
  readonly sandboxEscalation: boolean
  /** sandbox-escalation per-turn retry cap (`QUANTA_SANDBOX_ESCALATION_MAX`,
   *  the `ExecPolicyAmendmentExhausted` analog). Absent / invalid ⇒ the
   *  escalation cap module's default (3). Bounds escalation REQUESTS per
   *  `(threadId, turnId)` — once exhausted the tool returns a typed
   *  `escalation-exhausted` result and fires no further prompt (anti-spam: a
   *  model cannot loop escalate→deny→escalate forever). A KNOB, not a baked
   *  constant. Separate from the loop-breaker — it bounds escalation requests,
   *  not tool calls. */
  readonly sandboxEscalationMax: number | undefined
  /** account-ratelimit (RFC jun-6) proactive pre-request delay gate
   *  (`QUANTA_RATELIMIT_PROACTIVE`). Opt-in (`gateOn` vocab `1`/`on`/`true`/`yes`; #24). Default false ⇒
   *  the LLM adapters never capture `.withResponse()` ratelimit headers into the
   *  snapshot store and the loop never inserts a `proactiveDelayMs` sleep before a
   *  request (byte-identical to today). When ON, the adapter response-header hook
   *  feeds an `account-ratelimit` snapshot store and the loop pauses by the
   *  derived pre-request delay to avoid tripping the account limit. */
  readonly proactiveRateLimit: boolean
  /** `QUANTA_RATELIMIT_NOTICE` (P27) — operator wants the transient CLI quota
   *  notice. SSOT for the core loop's snapshot-capture gate: when ON (even with
   *  `proactiveRateLimit` OFF) the loop builds the snapshot store + header hook
   *  and EMITS `ratelimit_snapshot` on a reached window, so the CLI notice port
   *  has events to render. Absent ⇒ false; the store is built only if proactive
   *  is on (byte-identical). */
  readonly ratelimitNotice: boolean
  /** N6 PTY backend selector (`QUANTA_PTY_BACKEND`). `tmux` (default,
   *  byte-identical) | `bun` (Bun-native terminal) | `both` (bun w/ tmux
   *  fallback). Only consulted when `ptyAttach` is on (else no PTY tools are
   *  registered at all). */
  readonly ptyBackend: PtyBackend
  /** ADR-0296 auto-background — default `timeout_behavior` for the bash tool
   *  (`QUANTA_BASH_AUTO_BACKGROUND`). `background` (DEFAULT — ships ON) detaches
   *  a command that exceeds its deadline into the bash background registry
   *  (Claude-Code-style); the model resumes it with `bash_await`/`bash_kill`. A
   *  command that completes before its deadline is byte-identical to the legacy
   *  result. `kill` is the legacy SIGTERM-on-deadline opt-out. `prompt` asks for
   *  one-keystroke consent before detaching (falls back to `background` where no
   *  interactive surface is wired). A per-call `timeout_behavior` argument on the
   *  bash tool ALWAYS overrides this. */
  readonly bashAutoBackground: BashAutoBackgroundMode
  /** ADR-0296 — deadline (ms) after which an un-completed bash command is
   *  auto-backgrounded (`QUANTA_BASH_AUTO_BACKGROUND_THRESHOLD_MS`). Absent ⇒
   *  the runtime default (120 000 ms, same as the legacy kill deadline). A
   *  per-call `timeout_ms` argument overrides this. Only consulted when the
   *  effective behavior is `background`/`prompt`. */
  readonly bashAutoBackgroundThresholdMs: number | undefined
  /** H18/keyring — OS-keyring-backed MCP OAuth token store
   *  (`QUANTA_MCP_OAUTH_KEYRING`). Opt-in (`gateOn` vocab `1`/`on`/`true`/`yes`; #24). Default false ⇒ the
   *  MCP OAuth provider uses the plain 0600 file `TokenStorePort` (byte-identical).
   *  When ON *and* the OS keyring binary is reachable, the composition root wraps
   *  the file store with `composeTokenStore(selectKeyring(...), fileStore)`
   *  (Keychain / libsecret, file-fallback + migration, NO-THROW). */
  readonly mcpOAuthKeyring: boolean
  /** ADR-0159 Phase 2 work-resume (`QUANTA_SUBAGENT_RESUME`).
   *  Opt-in (`gateOn` vocab `1`/`on`/`true`/`yes`; #24). Default false ⇒
   *  `buildSharedExecutionPlaneRuntimeAugments` leaves interrupted handles
   *  untouched in the store (normalizeBgStatus maps them to `"failed"` only
   *  on poll/list — store is the ground truth, byte-identical). When ON, the
   *  execution-plane calls `resumeInterruptedHandles` with the freshly-built
   *  persistent scheduler + `defaultResumePolicy`, sweeping every
   *  `"interrupted"` handle for the workspace: each one is re-forked and
   *  the original handle is flipped to `"resumed"` in the store.
   *
   *  NOTE: `buildSharedExecutionPlaneRuntimeAugments` reads this flag via
   *  `gateOn(args.envSource, "QUANTA_SUBAGENT_RESUME")` directly (not via this
   *  field) because it accepts an injectable `envSource` for testability — tests
   *  inject a fake env object, not `process.env`. This field exists for other
   *  callers (CLI start-up, surfaces) that read from the frozen process.env
   *  snapshot via `runtimeConfig()`. */
  readonly subagentResume: boolean
  /** ADR-0487 subagent background admission queue (`QUANTA_SUBAGENT_QUEUE`).
   *  Opt-in (`gateOn` vocab `1`/`on`/`true`/`yes`; #24). Default false ⇒ `defaultBackgroundSubagentScheduler`
   *  is constructed WITHOUT `admissionQueue`, so an over-cap spawn throws-at-cap
   *  (today's behavior) and the 4th `subagent_force_background` tool is NOT
   *  registered (byte-identical). When ON, the scheduler admits over-cap spawns
   *  onto a FIFO queue and `forceBackground` can promote/reorder. */
  readonly subagentQueue: boolean
  /** ADR-0487 force-background tool exposure (`QUANTA_FORCE_BACKGROUND`). Strict
   *  opt-in (`gateOn` vocab; #24). Default false ⇒ `subagentBgTools` does NOT mint the
   *  `subagent_force_background` tool (byte-identical). When ON *and* the queue is
   *  enabled, the tool is exposed so the model can promote a queued spawn to the
   *  front / burst-run it. */
  readonly forceBackground: boolean
  /** G1 appshot visual-verify loop (`QUANTA_APPSHOT`). Opt-in (`gateOn` vocab `1`/`on`/`true`/`yes`; #24).
   *  Default false ⇒ the composition root mints NO `DefaultToolPorts.appshot`
   *  slot, so `appshot_verify` is NOT registered (byte-identical default menu).
   *  When ON *and* a BrowserPort + judge LLM are reachable, the root assembles the
   *  `AppshotPort` (render/screenshot→BrowserPort, verify→LLM-judge,
   *  scaffold→jailed scaffold, artifactSink→artifact registry). */
  readonly appshot: boolean
  /** N1 — background side-agent daemons (`QUANTA_SIDE_AGENT`). Opt-in
   *  (the `gateOn` truthy vocab (#24)). Default false ⇒ no daemon registry, the `side_agent_*` tools
   *  are NOT registered (byte-identical). When ON, the assembler mints a
   *  `@/side-agent` registry (Phase-2: with the real subagent runner / mailbox /
   *  timers) and the tier1 block exposes the management tools over it. */
  readonly sideAgent: boolean
  /** §4.4 — TYPED agent kind boundary validation (`QUANTA_SUBAGENT_TYPED_KIND`).
   *  Opt-in. Default false ⇒ the `agent` tool's `agent_type` is the legacy free
   *  string (carried verbatim, never rejected — byte-identical). When ON, the
   *  tier1 subagent block wires `enforceTypedAgentKind` so the spawn boundary
   *  normalises a well-known {@link SubagentType} kind, accepts a registered
   *  named-agent name, and REJECTS an unknown type (Claude-Code
   *  `subagent_type_miss` parity). */
  readonly subagentTypedKind: boolean
  /** C5059-05 — single-agent-first delegation suppression
   *  (`QUANTA_SUBAGENT_DELEGATE_SUPPRESS`). Default-OFF ⇒ byte-identical prompt;
   *  ON prepends the delegation policy to every spawn/delegation surface (the
   *  `agent`/`spawn_agent`/`spawn_batch`/`spawn_agents_on_csv` tool descriptions
   *  and the system-prompt tool-routing atom). */
  readonly subagentDelegateSuppress: boolean
  /** RFC jul-13 §4.2/§6.5 A (rev.4) — MAX DESCENDANT DEPTH a spawn may create
   *  (`QUANTA_MAX_DESCENDANT_DEPTH`, non-negative integer). NUMERIC POLICY, not a
   *  bool gate: default 1 = root-only (rev.4 canonical, the user's leaf intent).
   *  This is THE authoritative operator ceiling; per-config `subagent.maxDepth` is
   *  a tightening-only override (`effectiveCap = min(policy, requested)`). The two
   *  derived predicates (`canExposeSpawnTools`/`canAdmitChildDepth`,
   *  `@/agent/spawn-depth`) read THIS as the policy: an agent at `config.depth`
   *  gets spawn tools iff `(depth ?? 0) < effectiveCap`; `1` = root-only, `0` =
   *  total kill switch (non-negative parse; no agent, incl. root, spawns). Invalid
   *  / unset ⇒ the parser floors to the default 1. (Renamed from `maxSpawnDepth`,
   *  off-by-one fixed: names the max descendant depth, not the max depth that
   *  receives tools.) */
  readonly maxDescendantDepth: number
  /** §4.3 — LIVE side-agent OS-PROCESS backer selector (`QUANTA_SIDE_AGENT_PROCESS`).
   *  Opt-in, and REQUIRES the master gate `QUANTA_SIDE_AGENT` (it only chooses the
   *  backer once side-agents are enabled). Default false ⇒ the side-agent registry
   *  runs IN-PROCESS (the daemon's per-wake pass on the MAIN thread), byte-identical.
   *  When ON (and `QUANTA_SIDE_AGENT` on), the live root `maybeWireSideAgent`
   *  (`@/host/runtime/agent-config-assembler`) reads THIS field and mints the
   *  PROCESS-backed registry (`createProcessSideAgentDaemonRegistry`, `@/side-agent`)
   *  instead of the in-process one: each daemon is a SUPERVISED FORKED CHILD over
   *  `nodeProcessForkPort` running the production worker
   *  (`@/side-agent/worker-entry.mjs`) — fork → ready → charter → finding(s) →
   *  shutdown, with exponential-backoff crash-respawn (`createSupervisedProcessDaemon`,
   *  `@/side-agent/process`). The process registry satisfies the SAME
   *  `SideAgentDaemonRegistry`/`SideAgentDaemonPort` shape the `side_agent_*` tools
   *  consume, so the tool surface is unchanged. Driven over a REAL forked child in
   *  `tests/integration/side-agent-process-os-fork-e2e.test.ts` and selected at the
   *  live root in `tests/unit/side-agent-assembler-process-wire-hellgate.test.ts`.
   *  Worker note: the child runs a REAL but DETERMINISTIC bounded pass today (no LLM
   *  call) — see the `worker-entry.mjs` header for exactly what it does and the
   *  single swap point for a full LLM-backed child loop. V1 core only — NOT a
   *  launchctl/systemd manager. */
  readonly sideAgentProcess: boolean
  /** N2 — MCP connector discovery (`QUANTA_MCP_CONNECTORS`). Opt-in via the
   *  canonical `gateOn` vocab (`1`/`on`/`true`/`yes`; #24 doc-fix — the resolver
   *  is `gateOn`, NOT strict the `gateOn` truthy vocab (#24)). Default false ⇒ no discovery port, the `mcp_connector_*` tools
   *  are NOT registered (byte-identical). When ON, the composition root wires a
   *  discovery port (catalog source + `.mcp.json` writer). */
  readonly mcpConnectors: boolean
  /** N3 — MCP resource/prompt tools (`QUANTA_MCP_RESOURCES`). Opt-in via the
   *  canonical `gateOn` vocab (`1`/`on`/`true`/`yes`; #24 doc-fix — resolver is
   *  `gateOn`, NOT strict the `gateOn` truthy vocab (#24)). Default false ⇒ the six `mcp_list_resources` /
   *  `mcp_list_resource_templates` / `mcp_read_resource` / `mcp_read_resource_dir` / `mcp_list_prompts` /
   *  `mcp_get_prompt` tools are NOT registered
   *  (byte-identical). When ON AND at least one connected MCP server advertises
   *  `resources`/`prompts`, the surface (`loadFeatures`) builds an aggregate
   *  `ResourcesHandle` over the live clients and threads it into
   *  `DefaultToolPorts.mcpResources` so the four tools register through the
   *  mcp-origin array (H2 untrusted-source envelope applies). With no such server
   *  the handle is undefined ⇒ tools still absent. */
  readonly mcpResources: boolean
  /** §19.1 — honor MCP server-declared tool annotations (`QUANTA_MCP_TOOL_ANNOTATIONS`).
   *  Opt-in via the standard boolean vocab (`1`/`true`/`on`; #24 doc-fix — resolver
   *  is `parseBool`, NOT strict the `gateOn` truthy vocab (#24)). The global default-OFF master switch: when OFF the
   *  bridge ignores `readOnlyHint`/`idempotentHint` entirely (`annotationsHonored`
   *  stays false ⇒ every MCP tool keeps its conservative read/concurrency
   *  classification, byte-identical). When ON the composition root passes
   *  `loadMcpTools` opts `annotationsHonored:true`, so a TRUSTED server's
   *  annotations may ELEVATE a tool's `isReadOnly`/`isConcurrencySafe` predicates
   *  (never demote — annotations can only relax, and only for trusted origins). */
  readonly mcpToolAnnotations: boolean
  /** C2 — structured mid-turn progress report (`QUANTA_PROGRESS_UPDATE`). Opt-in
   *  via the canonical `gateOn` vocab (`1`/`on`/`true`/`yes`; #24 doc-fix — resolver
   *  is `gateOn`, NOT strict the `gateOn` truthy vocab (#24)). Default false ⇒ the `communicate_update` tool is NOT
   *  registered (byte-identical). When ON, the composition root passes
   *  `DefaultToolPorts.progressUpdate=true` AND wires `AgentConfig.progressSink`
   *  (the host adapter that turns the tool's mirror into a render-only
   *  `progress_update` AgentEvent). */
  readonly progressUpdate: boolean
  /** #8 — mid-turn keystroke capture (`QUANTA_MIDTURN_CAPTURE`). Opt-in via the
   *  canonical `gateOn` vocab (`1`/`on`/`true`/`yes`; #24 doc-fix — resolver is
   *  `gateOn`, NOT strict the `gateOn` truthy vocab (#24)). Default false ⇒ the CLI session loop wires NO mid-turn capture
   *  facade; the input reader is byte-identical to today (one `readLine` per turn
   *  boundary, no keystroke source while a turn runs). When ON, the session loop
   *  builds a `defaultMidTurnCapture` over the live plan-queue + drains captured
   *  lines onto the existing `externalPromptQueue` race, so a completed input
   *  line that arrives WHILE a turn is in flight is enqueued (Codex "type while
   *  running") and surfaced at the next turn boundary. NOTE: this knob wires the
   *  capture→drain SEAM only; the concurrent raw-mode keystroke SOURCE during a
   *  turn is a separate, hot-path change (see jun-6 report residual). With the
   *  knob ON but no source feeding `captureMidTurnLine`, behavior is still
   *  byte-identical. */
  readonly midTurnCapture: boolean
  /** §11.5 ticket-08b — render the bottom input LANE for mid-turn keystrokes
   *  (`QUANTA_MIDTURN_VISIBLE`). Opt-in via the canonical `gateOn` vocab
   *  (`1`/`on`/`true`/`yes`; #24 doc-fix — resolver is `gateOn`, NOT strict
   *  the `gateOn` truthy vocab (#24)), TTY-only. With capture on the
   *  reader sees keystrokes but the user types BLIND; this knob makes the session
   *  loop echo the live partial into a bottom-anchored lane (cursor save/restore
   *  so streamed output above is undisturbed). Separate from capture because the
   *  render is a stdout hot-path write — capture-without-render stays the safe
   *  default. Non-TTY / OFF ⇒ no render (byte-identical). */
  readonly midTurnVisible: boolean
  /** §P7 ticket-05-③ — override for the OS managed-settings file path
   *  (`QUANTA_MANAGED_SETTINGS_PATH`). Non-blank ⇒ used on every platform (CI /
   *  org-lockdown escape hatch); absent ⇒ the per-OS default. */
  readonly managedSettingsPath: string | undefined
  /** N6 — PTY/tmux session attach (`QUANTA_PTY_ATTACH`). Opt-in
   *  (the `gateOn` truthy vocab (#24)). Default false ⇒ the 6 `pty_*` tools are NOT registered
   *  (byte-identical, exec-risk). When ON, the composition root wires a
   *  `DefaultToolPorts.ptySession` backend (tmux/Bun). */
  readonly ptyAttach: boolean
  /** D3 (jun-7-naive-impl-hardening) — PTY env-inherit ESCAPE HATCH
   *  (`QUANTA_PTY_INHERIT_ENV`). Default false ⇒ the PTY child's env is SCRUBBED
   *  through the same `scrubEnv`/`applyLocalEnv` chokepoint as `runShell`
   *  (`*_API_KEY`/`*_TOKEN`/`*_SECRET` dropped — closes the credential leak from
   *  the legacy full `{ ...process.env }` inherit). Truthy (`1`/`true`/`on`) ⇒
   *  the interactive shell inherits the FULL parent env (mirrors runShell's
   *  `inheritEnv`). */
  readonly ptyInheritEnv: boolean
  /** C3 — brief-mode session-posture knob SEED (`QUANTA_BRIEF`). Accepts the
   *  standard boolean knob vocabulary (`1`/`true`/`on`, case-insensitive) ⇒
   *  true; absent / any other value ⇒ false (default-OFF, byte-identical). This
   *  is ONLY the initial seed for the per-session brief store (`createBriefStore`);
   *  the live posture is then flipped by `/brief` or a `set_brief` control-op.
   *  When false at seed AND never toggled, `buildDynamicContext` emits no
   *  `BRIEF_NOTICE` and the per-turn dynamic tail is byte-identical. */
  readonly brief: boolean
  /** §5 prompt-directive bundle (jun-06) — seven independent DEFAULT-OFF
   *  behavioral directives, each spliced into the per-turn DYNAMIC
   *  `<system-reminder>` by `buildDynamicContext` (`src/agent/prompt.ts`) ONLY
   *  when its knob is ON (`=== "1"`). Each defaults false ⇒ contributes zero
   *  bytes ⇒ the dynamic tail is byte-identical (proven by the all-OFF golden).
   *  See `src/agent/prompt-directives.ts` for the texts + the pure selector. */
  /** Autonomous-loop preamble (`QUANTA_DIRECTIVE_AUTONOMOUS`). */
  readonly directiveAutonomous: boolean
  /** Read-completeness directive (`QUANTA_DIRECTIVE_READ_COMPLETE`). */
  readonly directiveReadComplete: boolean
  /** Progress-narration discipline (`QUANTA_DIRECTIVE_PROGRESS`). */
  readonly directiveProgress: boolean
  /** Memory-drift verify-before-trust (`QUANTA_DIRECTIVE_MEMORY_VERIFY`). */
  readonly directiveMemoryVerify: boolean
  /** Thinking-frequency self-regulation (`QUANTA_DIRECTIVE_THINK_FREQ`). */
  readonly directiveThinkFreq: boolean
  /** Anti-platitude voice (`QUANTA_DIRECTIVE_ANTI_PLATITUDE`). */
  readonly directiveAntiPlatitude: boolean
  /** Parallel tool-call nudge (`QUANTA_DIRECTIVE_PARALLEL_TOOLS`). */
  readonly directiveParallelTools: boolean
  /** Advisor timing-rail directive (RFC jun-6 §5.2 — `QUANTA_ADVISOR_RAIL`).
   *  When ON, the per-turn dynamic slot carries a short "consult the advisor
   *  before committing to an approach / before declaring done" rail. Default
   *  false ⇒ zero bytes ⇒ byte-identical. The TEXT itself only matters when the
   *  `advisor` tool is also wired, but the selector emits it whenever the knob is
   *  on (the rail is harmless prose when no advisor exists). */
  readonly directiveAdvisorRail: boolean
  /** adaptive-thinking (RFC jun-6) — Anthropic `thinking:{type:"adaptive"}` gate
   *  (`QUANTA_ADAPTIVE_THINKING`). Opt-in (`gateOn` vocab `1`/`on`/`true`/`yes`; #24). Default false ⇒
   *  the effort/classifier producer (`applyEffortClassifierFloor`) emits the
   *  manual `{type:"enabled", budget_tokens:N}` arm for EVERY model — BYTE-IDENTICAL
   *  to today. When ON *and* the resolved model's family is adaptive-capable
   *  (`supportsAdaptiveThinking` — Opus 4.6/4.7/4.8, Sonnet 4.6), the producer
   *  emits `{type:"adaptive"}` (no `budget_tokens`) so the model self-paces; older
   *  models (Sonnet 4.5 / Haiku 4.5 / 3.x) still fall back to the manual budget
   *  (no 400). The "should we think at all" signal is unchanged (`budgetTokens >
   *  0`, effort-derived) — this knob only changes the SHAPE, never whether
   *  thinking is requested. Anthropic-only: OpenAI / Responses never read the
   *  field. Repairs the latent live break where the default model `claude-opus-4-8`
   *  400s on any non-zero manual budget. */
  readonly adaptiveThinking: boolean
  /** ADR-0512 — skill tool-scoping v2: gates the availability FILTER (L1) and
   *  the escalation ASK (L3). Default false ⇒ ADR-0011 behavior (all tools
   *  visible; an out-of-scope call is a recoverable `skill-scoped` deny). ON ⇒
   *  out-of-scope tools are removed from the spec set sent to the model, and a
   *  model that still calls one is routed to `onConfirm` instead of hard-denied.
   *  The L2 nav-base carve-out (read-only exploration ladder always in scope) is
   *  UNCONDITIONAL — it is a bug fix, not gated by this flag. */
  readonly skillScopeV2: boolean
  /** Advisor full-history forward (RFC jun-6 §5.1 — `QUANTA_ADVISOR_FORWARD_HISTORY`).
   *  Strict the `gateOn` truthy vocab (#24) opt-in. Default false ⇒ the advisor knob wires NO
   *  `transcriptSource`, so a `forwardHistory:true` request is a no-op (the
   *  explicit question/context path is byte-identical). ON ⇒ the knob injects a
   *  redacted live-transcript source into `advisorConsultFromLLM`. */
  readonly advisorForwardHistory: boolean
  /** syntax-aware-chunking (RFC jun-6) — AST-aligned indexer chunker gate
   *  (`QUANTA_SYNTAX_CHUNK`). Opt-in (`gateOn` vocab `1`/`on`/`true`/`yes`; #24). Default false ⇒ the
   *  indexer calls the pure line-window `chunkFile` exactly as today
   *  (byte-identical retrieval); the `CodeParserPort` is never constructed and
   *  NO WASM is loaded. When ON *and* a composition root injects a parser, the
   *  scanner parses each supported file once and emits AST-aligned chunks
   *  (`chunkFileSyntactic`) that never split a function mid-body, falling back
   *  to the line-window for any non-supported / unparseable file. */
  readonly syntaxChunk: boolean
  /** read-outline (RFC jun-6) — collapsed signatures+structure `read` mode
   *  gate (`QUANTA_READ_OUTLINE`). Opt-in (`gateOn` vocab `1`/`on`/`true`/`yes`; #24). Default false ⇒
   *  a `read outline:true` request returns the normal line-range read (the
   *  parser is never constructed, no WASM); `read` without the flag is
   *  byte-identical regardless. When ON *and* a parser is wired, `outline:true`
   *  returns the collapsed signatures view (bodies elided to `// …`), budget-
   *  sized, gracefully degrading to a line-range read on unsupported languages. */
  readonly readOutline: boolean
  /** Grammar-`.wasm` directory override for the `CodeParserPort`
   *  (`QUANTA_TREE_SITTER_DIR`). Absent ⇒ the parser resolves the installed
   *  `tree-sitter-wasms/out` dir. A packaging step that relocates the grammars
   *  sets this. Only read when a parser is constructed (default-OFF ⇒ unread). */
  readonly treeSitterDir: string | undefined
  /** Web-daemon thread-history DB directory override (`QUANTA_WEB_DB_DIR`).
   *  Absent ⇒ `undefined` ⇒ the persistence root resolves `~/.quanta/web-daemon`
   *  at the consumer (byte-identical to the prior raw-read fallback). Routed
   *  through runtimeConfig() so a `/config set` reaches it and the read is
   *  testable without mutating the real environment (ADR-0503 P4 read-routing). */
  readonly webDbDir: string | undefined
  /** Session-resource-registry SQLite backend path (`QUANTA_SESSION_REGISTRY_SQLITE_PATH`,
   *  ADR-0367). Absent/empty ⇒ `undefined` ⇒ the registry falls through to the
   *  disk / in-memory backend (byte-identical to the prior raw-read chain). The
   *  consumer keeps the non-empty-length guard + NO-THROW fallback. Routed through
   *  runtimeConfig() (ADR-0503 P4) — same precedence chain as every other knob. */
  readonly sessionRegistrySqlitePath: string | undefined
  /** Session-resource-registry disk-JSONL backend directory
   *  (`QUANTA_SESSION_REGISTRY_DISK_DIR`, ADR-0351). Absent/empty ⇒ `undefined` ⇒
   *  the registry falls through to in-memory (byte-identical). Routed through
   *  runtimeConfig() (ADR-0503 P4). */
  readonly sessionRegistryDiskDir: string | undefined
  /** FS jail disable flag (`QUANTA_FS_JAIL=off`). Default false (jail ON). */
  readonly fsJailDisabled: boolean
  /** ADR-0062 cap-as-instruction dispatch enforcement (`QUANTA_CAP_ENFORCE=1`).
   *  Default false — opt-in seam that injects a system-reminder when a tool's
   *  prior `nextAction` is ignored on the next call against the same target. */
  readonly capEnforce: boolean
}
