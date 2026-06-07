/**
 * Frozen runtime config — the SINGLE place that touches `process.env`.
 *
 * Why this exists: scattered `process.env.X` reads have two recurring failure
 * modes that previous audits surfaced.
 *
 *  1. **Silent garbage acceptance.** `process.env.QUANTA_LOG_LEVEL as LogLevel`
 *     accepts any string; an unknown value made every comparison `<undefined`
 *     and silently dropped EVERY log line. CRITICAL during incidents.
 *  2. **Mid-run env mutation.** `process.env` read at call-site means a test
 *     or harness that temporarily overrides a var changes behavior
 *     unpredictably across the run. We pin the values at first access so the
 *     run is reproducible.
 *
 * Contract:
 *   - First call evaluates + freezes. Subsequent reads are cached.
 *   - Invalid values are REJECTED + a single stderr line warns once (no
 *     logger import — logger depends on us; we use raw `process.stderr.write`).
 *   - Defaults are documented inline. Adding a new env var goes here.
 *   - `__resetRuntimeConfig()` is the test seam — production code MUST NOT
 *     call it.
 *
 * Adding an env var: write a `parseFoo` helper + add a field to `RuntimeConfig`
 * + parse in `loadFromEnv`. Use the var FROM `runtimeConfig()`, never from
 * `process.env` directly. The anti-regression scanner bans the latter.
 *
 * Disk config precedence (jun-7-misc 05, the `@/config` slice): when
 * `QUANTA_CENTRAL_CONFIG` is on, an OPTIONAL on-disk config is consulted UNDER
 * env. The resolution order, high→low, is:
 *   env > managed > user > project(trusted) > local(trusted)
 * i.e. an explicit `QUANTA_*` env var ALWAYS wins; the disk value is only a
 * fallback an operator can set in `settings.json`. The ONE exception (§9 Q2,
 * decided): a MANAGED layer key flagged non-overridable
 * (`allowManagedPermissionRulesOnly`/`allowManagedHooksOnly`) is org-locked and
 * is NOT overridable by env (lockdown semantics) — but that gating lives in the
 * `@/config` merge, not here; this chokepoint only consumes the already-resolved
 * value. Absent the knob, NO disk read occurs and this file is byte-identical.
 */

import { tlsMitmAuthorized } from "@/runtime/network-proxy/mitm-gate"
import { gateDisabledStrict, gateOn, gateOnStrict } from "./env-flag"
import { knobOverrideCount, knobOverrides, knobOverridesVersion } from "./knob-overrides"
import { writeStderr } from "./terminal-io"

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

const LOG_LEVEL_SET = new Set<string>(LOG_LEVELS)

/** SWE-bench Docker image cache levels (upstream `run_evaluation` vocabulary).
 *  `none` rebuilds + discards everything; `env` (the upstream default and ours)
 *  keeps base + per-repo env images warm; `instance` also keeps per-instance
 *  images for fastest re-runs of the SAME instance. */
export const SWEBENCH_CACHE_LEVELS = ["none", "base", "env", "instance"] as const
export type SwebenchCacheLevel = (typeof SWEBENCH_CACHE_LEVELS)[number]

const SWEBENCH_CACHE_LEVEL_SET = new Set<string>(SWEBENCH_CACHE_LEVELS)

const stderrWarn = (msg: string): void => {
  // Direct write because the logger imports US; using logger here would loop.
  writeStderr(`[quanta] config: ${msg}\n`)
}

const parseLogLevel = (raw: string | undefined): LogLevel => {
  if (raw === undefined) return "info"
  if (LOG_LEVEL_SET.has(raw)) return raw as LogLevel
  stderrWarn(
    `ignoring unknown QUANTA_LOG_LEVEL="${raw}" — valid: ${LOG_LEVELS.join("|")} — defaulting to "info"`,
  )
  return "info"
}

const parsePositiveInt = (raw: string | undefined, varName: string): number | undefined => {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  // Reject non-integer / non-positive / extra whitespace / hex / sign:
  if (!/^\d+$/.test(trimmed)) {
    stderrWarn(`ignoring invalid ${varName}="${raw}" — must be a positive integer`)
    return undefined
  }
  const n = Number.parseInt(trimmed, 10)
  if (!Number.isInteger(n) || n <= 0) {
    stderrWarn(`ignoring invalid ${varName}="${raw}" — must be a positive integer`)
    return undefined
  }
  return n
}

/** SSOT truthy predicate for boolean env knobs. Case-INSENSITIVE: `"1"` /
 *  `"true"` / `"on"` (any case) ⇒ true; `undefined` / empty / any other value ⇒
 *  false. Exported so a knob's own `parse` can reuse the EXACT same function as
 *  the live `runtimeConfig()` read (e.g. `QUANTA_MCP_TOOL_ANNOTATIONS`), making
 *  the two channels byte-equal — no `"TRUE"`/`"ON"` divergence between the knob
 *  registry/telemetry and the consumer. */
export const parseBool = (raw: string | undefined): boolean => {
  if (raw === undefined) return false
  return raw === "1" || raw.toLowerCase() === "true" || raw.toLowerCase() === "on"
}

/** "Is the rate-limit NOTICE surface wanted?" — lenient truthy: absent / `""` /
 *  `0` / `false` / `off` / `no` (case-insensitive) ⇒ false; ANY other value ⇒
 *  true. Exported as the SINGLE SSOT predicate shared by the core loop
 *  (snapshot-capture gate in `session-bootstrap`) and the CLI render gate
 *  (`isRatelimitNoticeEnabled`). The notice and proactive-backoff both feed the
 *  SAME snapshot store; this decides whether the store/capture is built when
 *  proactive is OFF, so `QUANTA_RATELIMIT_NOTICE` alone produces snapshots. */
export const ratelimitNoticeWanted = (raw: string | undefined): boolean => {
  if (raw === undefined) return false
  const norm = raw.trim().toLowerCase()
  return !(norm === "" || norm === "0" || norm === "false" || norm === "off" || norm === "no")
}

/** Boolean knob that DEFAULTS to true: absent ⇒ true; an explicit off-vocabulary
 *  value (`0`/`false`/`off`, case-insensitive) ⇒ false; anything else ⇒ true.
 *  Used by the single default-ON knob (`QUANTA_IPYNB_OUTPUTS`) — see the field
 *  doc for why default-true is the safe posture there. */
const parseBoolDefaultTrue = (raw: string | undefined): boolean => {
  if (raw === undefined) return true
  const lc = raw.toLowerCase()
  return !(raw === "0" || lc === "false" || lc === "off")
}

/** Parse a strictly-positive finite number (fractional allowed). Used for the
 *  auto-dream HOURS threshold where a sub-hour cadence (`0.5`) is legal.
 *  Rejects `NaN`, `Infinity`, zero, negatives, and non-numeric strings —
 *  invalid ⇒ `undefined` (the caller falls back to a documented default). */
const parsePositiveNumber = (raw: string | undefined, varName: string): number | undefined => {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  const n = Number(trimmed)
  if (trimmed.length === 0 || !Number.isFinite(n) || n <= 0) {
    stderrWarn(`ignoring invalid ${varName}="${raw}" — must be a positive number`)
    return undefined
  }
  return n
}

/** Parse a delimiter-separated list (`,` `:` `;` `\n`). Trims, drops empties.
 *  Returns a frozen array (length 0 ⇒ caller treats as "no extras"). Used for
 *  list-shaped env vars that EXTEND a code-side default (operator merge, not
 *  replace) — keeps audited defaults intact while admitting ecosystem additions
 *  (Rust `target/`, new package managers like `uv`/`poetry`, etc). */
const parseStringList = (raw: string | undefined): readonly string[] => {
  if (raw === undefined || raw.length === 0) return Object.freeze([])
  const parts: string[] = []
  for (const piece of raw.split(/[,:;\n]/)) {
    const t = piece.trim()
    if (t.length > 0) parts.push(t)
  }
  return Object.freeze(parts)
}

const parseSessionListFormat = (raw: string | undefined): "rich" | "plain" | undefined => {
  if (raw === undefined || raw.length === 0) return undefined
  if (raw === "rich" || raw === "plain") return raw
  stderrWarn(
    `ignoring unknown QUANTA_SESSION_LIST_FORMAT="${raw}" — valid: rich|plain — falling back to TTY auto-detect`,
  )
  return undefined
}

/** PTY backend selector (`QUANTA_PTY_BACKEND`). `tmux` (default, byte-identical
 *  to the pre-slice path) | `bun` (Bun-native terminal) | `both` (try bun, fall
 *  back to tmux). Unknown ⇒ warn once + default `tmux`. */
const PTY_BACKENDS = ["tmux", "bun", "both"] as const
export type PtyBackend = (typeof PTY_BACKENDS)[number]
const PTY_BACKEND_SET = new Set<string>(PTY_BACKENDS)
const parsePtyBackend = (raw: string | undefined): PtyBackend => {
  if (raw === undefined) return "tmux"
  if (PTY_BACKEND_SET.has(raw)) return raw as PtyBackend
  stderrWarn(
    `ignoring unknown QUANTA_PTY_BACKEND="${raw}" — valid: ${PTY_BACKENDS.join("|")} — defaulting to "tmux"`,
  )
  return "tmux"
}

const parseSwebenchCacheLevel = (raw: string | undefined): SwebenchCacheLevel => {
  if (raw === undefined) return "env"
  if (SWEBENCH_CACHE_LEVEL_SET.has(raw)) return raw as SwebenchCacheLevel
  stderrWarn(
    `ignoring unknown QUANTA_SWEBENCH_CACHE_LEVEL="${raw}" — valid: ${SWEBENCH_CACHE_LEVELS.join("|")} — defaulting to "env"`,
  )
  return "env"
}

/** All runtime-tunable values, frozen at startup. Add fields here when a new
 *  env var is introduced — never read `process.env` from a feature site. */
export interface RuntimeConfig {
  readonly logLevel: LogLevel
  /** Compaction threshold override (tokens). Absent ⇒ use the per-config
   *  default in `agent/compaction.ts`. NEVER silently flipped by env. */
  readonly compactTokens: number | undefined
  /** ADR-0473 background (speculative) compaction gate (`QUANTA_BG_COMPACTION`).
   *  Strict opt-in: `true` ONLY when the value is exactly `"1"` (mirrors the
   *  `bgCompactionEnabled` slice gate). Default false ⇒ the loop's existing
   *  synchronous proactive/reactive compaction paths are byte-identical. */
  readonly bgCompaction: boolean
  /** RFC jun-6-microcompaction — tier-1 tool-result eviction gate
   *  (`QUANTA_MICROCOMPACT`). Strict opt-in: `true` ONLY when the value is
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
   *  Strict opt-in (`=== "1"`). SEAM (validated, not yet composed at the root):
   *  the handler builder (`host/runtime/mcp-sampling-handler.ts`
   *  `buildSamplingWiring`) and the `McpClient` `samplingHandler` acceptance slot
   *  both exist and are unit-tested, but NO production code reads this field to
   *  pass `opts.sampling` + a `samplingHandler` to the client yet. Until that
   *  composition lands, this field has zero production consumers and is a no-op.
   *  Intended end state (advertise-iff-able): when ON *and* an LLM + a consent
   *  prompter are assembled at the composition root, the MCP client advertises
   *  `sampling` AND is wired with an `@/llm`-backed handler (HITL consent on
   *  every request); the advertisement and the handler always move together.
   *  Default false ⇒ sampling is NOT advertised and the headless rejecter
   *  declines (`no-handler`) — byte-identical (and currently byte-identical even
   *  when ON, because the field is unread). */
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
   *  Strict opt-in (`=== "1"`). When ON *and* the composition root wires a
   *  `RootsProviderPort` (from the active workspace), the MCP client advertises
   *  `roots` AND answers inbound `roots/list` from that source
   *  (advertise-iff-able — the advertisement and the source always move
   *  together). Default false ⇒ `roots` is NOT advertised and an unsolicited
   *  `roots/list` is answered with an empty list (byte-identical negotiation).
   *  The typed OUTBOUND `resources/*` + `prompts/*` methods are NOT gated by
   *  this knob — they only act when the connected server advertises the
   *  matching capability, so they are always safe to expose. */
  readonly mcpRoots: boolean
  /** H18 (jun-04) MCP HTTP-server OAuth gate (`QUANTA_MCP_OAUTH`). Strict opt-in
   *  (`=== "1"`). When ON *and* the composition root wires a connectors-backed
   *  `McpOAuthProviderPort` (RFC 8414 discovery → DCR → PKCE browser flow →
   *  token, RFC 6749 §6 refresh) AND a server config sets `oauth: true`, the
   *  `McpClient` resolves a bearer and attaches `Authorization: Bearer <token>`
   *  to that server's HTTP requests. Default false ⇒ no provider is wired, the
   *  client falls back to the headless rejecter (obtains no token), and every
   *  MCP load is byte-identical to the pre-H18 path (no discovery, no flow, no
   *  header). The provider and the per-server `oauth` opt-in must BOTH be present
   *  for any OAuth side effect (advertise-iff-able). */
  readonly mcpOAuth: boolean
  /** H9 read `file_unchanged` dedup gate (`QUANTA_READ_DEDUP`). Strict opt-in
   *  (`=== "1"`). When ON, the `read` tool short-circuits a re-read of the SAME
   *  (canonical path, offset, limit) whose on-disk mtime equals the recorded
   *  read-time mtime for that range, returning a compact `file_unchanged`
   *  sentinel instead of re-sending the full content (large token savings in
   *  iterative loops). Default false ⇒ the read tool ALWAYS renders full content
   *  and allocates NO per-range dedup state (byte-identical to the pre-H9 path).
   *  ORTHOGONAL to the stale-read-guard (ADR-0474, write-blocking freshness): H9
   *  is the READ-SIDE dedup, keyed by RANGE, and never affects guardWrite. */
  readonly readDedup: boolean
  /** H6 (jun-3-misc §3) passive git/gh VCS classification gate
   *  (`QUANTA_PASSIVE_VCS`). Strict opt-in (`=== "1"`). Default false ⇒ the
   *  bash post-exec hook returns immediately (no stdout classification, no
   *  sink touch, byte-identical). When true AND a host wired a `vcsEventSink`,
   *  a completed git/gh command's stdout is classified into a structured VCS
   *  event (`{commit:{sha,kind}, push, branch:{action}, pr:{number}}`) and
   *  forwarded onto the EXISTING turn-diff bus. Closes the raw-stdout blind
   *  spot of `src/git/directive-emit/` (which only reads quanta's own
   *  `::git-*` lines). */
  readonly passiveVcs: boolean
  /** H14a image_gen tool gate (`QUANTA_IMAGE_GEN`). Strict opt-in (`=== "1"`).
   *  Default false ⇒ the composition root wires NO `DefaultToolPorts.imageGen`
   *  port, so the `image_gen` tool is NOT registered (byte-identical default
   *  menu). When true AND a provider key resolves, the host passes a key-bound
   *  `openAiImagePort({ apiKey })` and the model gains text→image generation +
   *  edit (writes a versioned-sibling artifact through the FS jail). A missing
   *  key surfaces as a typed `no_key` failure, never a crash. */
  readonly imageGen: boolean
  /** H14b Office document AUTHORING gate (`QUANTA_OFFICE_AUTHORING`). Strict
   *  opt-in (`=== "1"`). Default false ⇒ the composition root wires NO
   *  `DefaultToolPorts.officeAuthoring`, so `xlsx_write` / `docx_write` are NOT
   *  registered (byte-identical default menu). When true the agent can generate
   *  real `.xlsx` / `.docx` files (pure-TS STORED-ZIP + OOXML, no office
   *  dependency) to jailed, versioned-sibling paths (never silent overwrite). */
  readonly officeAuthoring: boolean
  /** H15 (jun-3-misc §3) reasoning carry-over gate (`QUANTA_REASONING_CARRYOVER`).
   *  OpenAI-Responses / o-series ONLY (the ChatGPT-OAuth subscription path).
   *  Strict opt-in (`=== "1"`). Default false ⇒ the responses-wire path is
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
   *  opt-in (`=== "1"`). Default false ⇒ startup runs NO detect of competitor
   *  (Claude Code / Cursor) config, surfaces no migration prompt, and writes no
   *  throttle ledger — byte-identical startup. When true the CLI startup seam
   *  runs `runConfigMigration({ enabled: true, homeDir, projectDir })`, which
   *  detects `~/.claude` + project `.claude`/`CLAUDE.md`/`.mcp.json`/subagents
   *  + Cursor `.cursor/rules`, converts each into the quanta shape, throttles a
   *  re-offer via `~/.quanta/external_config_migration.json`, and surfaces a
   *  one-line stderr notice. Import is opt-in (notice only). */
  readonly migrateConfig: boolean
  /** H17 thread-goal budget ENFORCEMENT gate (`QUANTA_OBJECTIVE_BUDGET_ENFORCE`).
   *  Strict opt-in (`=== "1"`). Default false ⇒ the `ObjectiveBudget`
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
  /** H17 idle goal-CONTINUATION gate (`QUANTA_GOAL_ENFORCE`). Strict opt-in
   *  (`=== "1"`). Default false ⇒ NO idle goal-continuation is ever launched —
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
   *  Strict opt-in (`=== "1"`). Default false ⇒ `spawn_batch` fan-out is the
   *  EXISTING flat parallel pool (no dependency ordering) — byte-identical. When
   *  ON *and* a batch carries dependency edges, the tier1 builder wraps the
   *  child runner with a DAG gate (`@/subagent/coordination`) so each child
   *  dispatches only once its `dependsOn` are completed, releasing dependents as
   *  children finish (bounded by the existing worker ceiling). A cyclic/dangling
   *  graph is rejected before dispatch; a failed/cancelled dep surfaces its
   *  dependents as a typed dead branch (never an indefinite hang). */
  readonly teamDag: boolean
  /** Capability B — leader-mediated permission escalation broker
   *  (`QUANTA_TEAM_BROKER`). Strict opt-in (`=== "1"`). Default false ⇒ a worker
   *  that hits a denied tool fails hard (today's behavior — no escalation path).
   *  When ON, the worker's SOFT-deny is brokered IN-PROCESS by the leader's
   *  wire (`@/agent/coordination-broker-wire#buildLeaderHitlBroker`): it runs the
   *  escalation through the host's permission decide/HITL and the worker applies
   *  ONLY a leader-authored response matching its outstanding correlationId — it
   *  can NEVER self-grant (load-bearing security invariant, plan §5). */
  readonly teamBroker: boolean
  /** Capability C — team-idle barrier (`QUANTA_TEAM_IDLE`). Strict opt-in
   *  (`=== "1"`). Default false ⇒ the leader polls / no fan-in barrier (today).
   *  When ON, each subagent emits an idle beacon at turn-end and the leader
   *  awaits `teamIdle` (`@/subagent/coordination`) — every member idle — before
   *  fanning in (next phase / handoff / shutdown). Pure predicate + injected
   *  clock; absent ⇒ no beacons, byte-identical. */
  readonly teamIdle: boolean
  /** Peer teammate messaging (`QUANTA_TEAM_PEER_MSG`, RFC jun-6). Strict opt-in
   *  (`=== "1"`). Builds ON the EXISTING `QUANTA_TEAM_*` peer mailbox + wake-idle
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
  /** C1 — Canvas / artifact persistence store (`QUANTA_ARTIFACT_STORE`). Strict
   *  opt-in (`=== "1"`). Default false ⇒ no registry, the artifact tools are NOT
   *  registered (byte-identical). When ON, the composition root mints ONE
   *  per-session `@/artifact` registry and passes it to
   *  `DefaultToolPorts.artifactRegistry` (the generation tools register their
   *  outputs; the model lists/inspects/destroys via `artifact_*`). */
  readonly artifactStore: boolean
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
   *  (`QUANTA_FILE_HISTORY`). Strict opt-in (`=== "1"`). Default false ⇒ no
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
   *  Strict opt-in (`=== "1"`). Default false ⇒ no `PatternGrantStore` is
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
   *  (`QUANTA_SKILL_CREATOR`). Strict opt-in (`=== "1"`). Default false ⇒ no
   *  `SkillWriterPort` is constructed and the `skill_create` tool is NOT
   *  registered (byte-identical default tool surface). When ON, the composition
   *  root wires a jailed writer (under the user/repo skills dir) and registers
   *  the tool so the model can scaffold + validate + install a new skill. */
  readonly skillCreator: boolean
  /** C6 — structured deny-reason surfacing (`QUANTA_DENY_REASON`). Strict opt-in
   *  (`=== "1"`). Default false ⇒ the `ToolFailure.permission_denied` envelope
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
  /** sandbox-escalation (RFC jun-6) — OS-sandbox block → user-gated
   *  escalation-retry loop (`QUANTA_SANDBOX_ESCALATION`). Strict opt-in
   *  (`=== "1"`). Default false ⇒ the platform result-mapping points NEVER
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
   *  (`QUANTA_RATELIMIT_PROACTIVE`). Strict opt-in (`=== "1"`). Default false ⇒
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
  /** H18/keyring — OS-keyring-backed MCP OAuth token store
   *  (`QUANTA_MCP_OAUTH_KEYRING`). Strict opt-in (`=== "1"`). Default false ⇒ the
   *  MCP OAuth provider uses the plain 0600 file `TokenStorePort` (byte-identical).
   *  When ON *and* the OS keyring binary is reachable, the composition root wraps
   *  the file store with `composeTokenStore(selectKeyring(...), fileStore)`
   *  (Keychain / libsecret, file-fallback + migration, NO-THROW). */
  readonly mcpOAuthKeyring: boolean
  /** ADR-0487 subagent background admission queue (`QUANTA_SUBAGENT_QUEUE`).
   *  Strict opt-in (`=== "1"`). Default false ⇒ `defaultBackgroundSubagentScheduler`
   *  is constructed WITHOUT `admissionQueue`, so an over-cap spawn throws-at-cap
   *  (today's behavior) and the 4th `subagent_force_background` tool is NOT
   *  registered (byte-identical). When ON, the scheduler admits over-cap spawns
   *  onto a FIFO queue and `forceBackground` can promote/reorder. */
  readonly subagentQueue: boolean
  /** ADR-0487 force-background tool exposure (`QUANTA_FORCE_BACKGROUND`). Strict
   *  opt-in (`=== "1"`). Default false ⇒ `subagentBgTools` does NOT mint the
   *  `subagent_force_background` tool (byte-identical). When ON *and* the queue is
   *  enabled, the tool is exposed so the model can promote a queued spawn to the
   *  front / burst-run it. */
  readonly forceBackground: boolean
  /** G1 appshot visual-verify loop (`QUANTA_APPSHOT`). Strict opt-in (`=== "1"`).
   *  Default false ⇒ the composition root mints NO `DefaultToolPorts.appshot`
   *  slot, so `appshot_verify` is NOT registered (byte-identical default menu).
   *  When ON *and* a BrowserPort + judge LLM are reachable, the root assembles the
   *  `AppshotPort` (render/screenshot→BrowserPort, verify→LLM-judge,
   *  scaffold→jailed scaffold, artifactSink→artifact registry). */
  readonly appshot: boolean
  /** N1 — background side-agent daemons (`QUANTA_SIDE_AGENT`). Strict opt-in
   *  (`=== "1"`). Default false ⇒ no daemon registry, the `side_agent_*` tools
   *  are NOT registered (byte-identical). When ON, the assembler mints a
   *  `@/side-agent` registry (Phase-2: with the real subagent runner / mailbox /
   *  timers) and the tier1 block exposes the management tools over it. */
  readonly sideAgent: boolean
  /** N2 — MCP connector discovery (`QUANTA_MCP_CONNECTORS`). Strict opt-in
   *  (`=== "1"`). Default false ⇒ no discovery port, the `mcp_connector_*` tools
   *  are NOT registered (byte-identical). When ON, the composition root wires a
   *  discovery port (catalog source + `.mcp.json` writer). */
  readonly mcpConnectors: boolean
  /** N3 — MCP resource/prompt tools (`QUANTA_MCP_RESOURCES`). Strict opt-in
   *  (`=== "1"`). Default false ⇒ the four `mcp_list_resources` / `mcp_read_resource`
   *  / `mcp_list_prompts` / `mcp_get_prompt` tools are NOT registered
   *  (byte-identical). When ON AND at least one connected MCP server advertises
   *  `resources`/`prompts`, the surface (`loadFeatures`) builds an aggregate
   *  `ResourcesHandle` over the live clients and threads it into
   *  `DefaultToolPorts.mcpResources` so the four tools register through the
   *  mcp-origin array (H2 untrusted-source envelope applies). With no such server
   *  the handle is undefined ⇒ tools still absent. */
  readonly mcpResources: boolean
  /** §19.1 — honor MCP server-declared tool annotations (`QUANTA_MCP_TOOL_ANNOTATIONS`).
   *  Strict opt-in (`=== "1"`). The global default-OFF master switch: when OFF the
   *  bridge ignores `readOnlyHint`/`idempotentHint` entirely (`annotationsHonored`
   *  stays false ⇒ every MCP tool keeps its conservative read/concurrency
   *  classification, byte-identical). When ON the composition root passes
   *  `loadMcpTools` opts `annotationsHonored:true`, so a TRUSTED server's
   *  annotations may ELEVATE a tool's `isReadOnly`/`isConcurrencySafe` predicates
   *  (never demote — annotations can only relax, and only for trusted origins). */
  readonly mcpToolAnnotations: boolean
  /** C2 — structured mid-turn progress report (`QUANTA_PROGRESS_UPDATE`). Strict
   *  opt-in (`=== "1"`). Default false ⇒ the `communicate_update` tool is NOT
   *  registered (byte-identical). When ON, the composition root passes
   *  `DefaultToolPorts.progressUpdate=true` AND wires `AgentConfig.progressSink`
   *  (the host adapter that turns the tool's mirror into a render-only
   *  `progress_update` AgentEvent). */
  readonly progressUpdate: boolean
  /** #8 — mid-turn keystroke capture (`QUANTA_MIDTURN_CAPTURE`). Strict opt-in
   *  (`=== "1"`). Default false ⇒ the CLI session loop wires NO mid-turn capture
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
   *  (`QUANTA_MIDTURN_VISIBLE`). Strict opt-in, TTY-only. With capture on the
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
  /** N6 — PTY/tmux session attach (`QUANTA_PTY_ATTACH`). Strict opt-in
   *  (`=== "1"`). Default false ⇒ the 6 `pty_*` tools are NOT registered
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
   *  (`QUANTA_ADAPTIVE_THINKING`). Strict opt-in (`=== "1"`). Default false ⇒
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
  /** Advisor full-history forward (RFC jun-6 §5.1 — `QUANTA_ADVISOR_FORWARD_HISTORY`).
   *  Strict `=== "1"` opt-in. Default false ⇒ the advisor knob wires NO
   *  `transcriptSource`, so a `forwardHistory:true` request is a no-op (the
   *  explicit question/context path is byte-identical). ON ⇒ the knob injects a
   *  redacted live-transcript source into `advisorConsultFromLLM`. */
  readonly advisorForwardHistory: boolean
  /** syntax-aware-chunking (RFC jun-6) — AST-aligned indexer chunker gate
   *  (`QUANTA_SYNTAX_CHUNK`). Strict opt-in (`=== "1"`). Default false ⇒ the
   *  indexer calls the pure line-window `chunkFile` exactly as today
   *  (byte-identical retrieval); the `CodeParserPort` is never constructed and
   *  NO WASM is loaded. When ON *and* a composition root injects a parser, the
   *  scanner parses each supported file once and emits AST-aligned chunks
   *  (`chunkFileSyntactic`) that never split a function mid-body, falling back
   *  to the line-window for any non-supported / unparseable file. */
  readonly syntaxChunk: boolean
  /** read-outline (RFC jun-6) — collapsed signatures+structure `read` mode
   *  gate (`QUANTA_READ_OUTLINE`). Strict opt-in (`=== "1"`). Default false ⇒
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
  /** FS jail disable flag (`QUANTA_FS_JAIL=off`). Default false (jail ON). */
  readonly fsJailDisabled: boolean
  /** ADR-0062 cap-as-instruction dispatch enforcement (`QUANTA_CAP_ENFORCE=1`).
   *  Default false — opt-in seam that injects a system-reminder when a tool's
   *  prior `nextAction` is ignored on the next call against the same target. */
  readonly capEnforce: boolean
  /** Git SHA stamp for trajectory `producer.gitSha`. Set by the launcher
   *  (CI, dev script). Absent ⇒ field omitted from trajectory events. */
  readonly gitSha: string | undefined
  /** Trajectory pricing version override — pinned by op for reproducibility. */
  readonly pricingVersion: string | undefined
  /** Sessions root override (`QUANTA_SESSIONS_DIR`). Absent ⇒ session/paths
   *  computes `~/.quanta/sessions`. */
  readonly sessionsDir: string | undefined
  /** Per-session transcript retention cap in cumulative utf-8 BYTES
   *  (`QUANTA_SESSION_TRANSCRIPT_MAX_BYTES`). Feeds the host-layer transcript
   *  sweep (`@/apps/cli/session-transcript-retention`) which applies the
   *  `@/stream` `applyRetention` sliding window to each `<id>.jsonl` envelope
   *  under `sessionsRoot()`.
   *
   *  Default ABSENT ⇒ retention is OFF (unbounded — today's behavior). This is
   *  the SAFE default: the sweep is a no-op until an operator opts in, and even
   *  when ON it NEVER deletes a whole session — it only trims the OLDEST rows of
   *  a single transcript once that transcript alone crosses the cap, keeping the
   *  newest events. So recent/active sessions are inherently preserved. */
  readonly sessionTranscriptMaxBytes: number | undefined
  /** HITL overrides JSON path (`QUANTA_HITL_OVERRIDES`). Absent ⇒
   *  `agent/hitl-tier-registry` defaults to `~/.quanta/hitl-overrides.json`. */
  readonly hitlOverridesPath: string | undefined
  /** Tool output cap (`QUANTA_TOOL_OUTPUT_MAX`). Absent ⇒ default in
   *  `tool/output-spill.ts`. */
  readonly toolOutputMaxChars: number | undefined
  /** Tool spill retention (`QUANTA_TOOL_OUTPUT_SPILL_KEEP`). Absent ⇒ default. */
  readonly toolOutputSpillKeep: number | undefined
  /** LLM stream first-chunk timeout in ms (`QUANTA_LLM_STREAM_FIRST_CHUNK_MS`).
   *  Absent ⇒ adapter default (60_000 ms). Read ONCE at adapter construction;
   *  T1 hang-stream guard. Reasoning models (o1/o3/gpt-5) can take 30s+ to
   *  first token, so default is generous. */
  readonly llmStreamFirstChunkMs: number | undefined
  /** LLM stream inter-chunk idle timeout in ms (`QUANTA_LLM_STREAM_IDLE_MS`).
   *  Absent ⇒ adapter default (120_000 ms). Read ONCE at adapter
   *  construction; T1 hang-stream guard. Long completions are OK. */
  readonly llmStreamIdleMs: number | undefined
  /** Quanta home dir override (`QUANTA_HOME`). Absent ⇒ feature sites compute
   *  `~/.quanta`. Used by ADR-0046 permission-store path resolution. */
  readonly quantaHome: string | undefined
  /** Bench artifacts root override (`QUANTA_BENCH_HOME`). Absent ⇒ bench
   *  computes a PERSISTENT default (never tmp): `<quantaHome>/bench`, else
   *  macOS `~/Library/quanta-codeagent-v3/bench`, else `~/.quanta/bench`. */
  readonly benchHome: string | undefined
  /** Extra cache directory names appended to the audited
   *  `DEFAULT_CACHE_DIR_NAMES` SSOT in `apps/bench/cache-pathspecs.ts`.
   *  `QUANTA_BENCH_CACHE_PATHSPECS_EXTRA` is a `,`/`:`/`;`/newline-separated
   *  list — merge semantics (NOT replace), so adding `target` (Rust) does
   *  not silently drop `__pycache__` (Python). Empty ⇒ defaults only. */
  readonly cachePathspecsExtra: readonly string[]
  /** Extra literal command prefixes appended to the audited env-regime
   *  detection set in `agent/dispatch-dedup.ts#DEFAULT_ENV_PREFIXES`.
   *  `QUANTA_DEDUP_ENV_PREFIXES_EXTRA` is a delimiter-separated list of
   *  LITERAL first-token names (e.g. `uv,poetry,cargo`). Operator merge
   *  semantics — defaults intact. Used to keep the dedup gate's env brake
   *  current with new package managers without code edits. */
  readonly dedupEnvPrefixesExtra: readonly string[]
  /** Permission state-file override (`QUANTA_PERMISSION_STATE`). Absent ⇒
   *  feature site computes `<quantaHome>/permission-state.json`. */
  readonly permissionStateFile: string | undefined
  /** User-defined permission-profile directory (`QUANTA_PROFILES_DIR`,
   *  ADR-0434). Absent ⇒ `listPermissionProfiles`/`selectPermissionProfile`
   *  return only the 3 built-ins (default-OFF, no disk IO). */
  readonly profilesDir: string | undefined
  /** SSH connection marker (`SSH_CONNECTION`). Used by ADR-0046's
   *  `resolveHostId()` to decide between `<user>@<host>` and `localhost`. */
  readonly sshConnection: string | undefined
  /** SWE-bench Docker image cache level (`QUANTA_SWEBENCH_CACHE_LEVEL`).
   *  Default `env` (upstream default) — keeps base+env images warm so a batch
   *  doesn't rebuild the expensive per-repo conda env per instance. */
  readonly swebenchCacheLevel: SwebenchCacheLevel
  /** SWE-bench `--clean` flag (`QUANTA_SWEBENCH_CLEAN`). Default false — keep
   *  images at/under cacheLevel between runs (warm pool). */
  readonly swebenchClean: boolean
  /** SWE-bench grading parallelism (`QUANTA_SWEBENCH_MAX_WORKERS`). Absent ⇒
   *  the harness config computes `min(4, ceil(cpus * 0.75))`. */
  readonly swebenchMaxWorkers: number | undefined
  /** SWE-bench image namespace (`QUANTA_SWEBENCH_NAMESPACE`). Absent ⇒ the
   *  harness config picks by arch ("none" ⇒ build locally; avoids x86 pulls
   *  that would emulate on arm64). */
  readonly swebenchNamespace: string | undefined
  /** SWE-bench `--force_rebuild` (`QUANTA_SWEBENCH_FORCE_REBUILD`). Default
   *  false — reuse cached images unless explicitly invalidated. */
  readonly swebenchForceRebuild: boolean
  /** Explicit Python interpreter for the SWE-bench harness
   *  (`QUANTA_SWEBENCH_PYTHON_BIN`). Absent ⇒ python-swebench.ts probes
   *  `python` then `python3`. Useful on hosts whose `python3` is too old
   *  for the harness (the package uses PEP 604 `list | None`, needs 3.10+);
   *  set to e.g. `python3.11` or an absolute path to override the probe. */
  readonly swebenchPythonBin: string | undefined
  /** Per-instance wall-clock budget for the bench runner (`QUANTA_BENCH_TIMEOUT_MS`).
   *  Absent ⇒ batch mode default (120_000ms). Surface for `apps/agent/
   *  mode-presets/batch.ts` (RFC may-22 Phase 4). */
  readonly benchTimeoutMs: number | undefined
  /** Max turns per instance for the bench runner (`QUANTA_MAX_TURNS`).
   *  Absent ⇒ batch mode default from BUDGET_PRESETS.batch. */
  readonly maxTurnsBatch: number | undefined
  /** Force `--prepare-images` to attempt the local build even on arm64
   *  (`QUANTA_SWEBENCH_PREPARE_FORCE`). Default false — arm64 skips prepare
   *  (conda crashes under x86 emulation; the eval path pulls prebuilt). */
  readonly swebenchPrepareForce: boolean
  /** Pinned run id (`QUANTA_RUN_ID`). Set ONCE by the bench launcher so
   *  observe + predictions + report all group under the same persistent
   *  `runs/<runId>/` dir (no per-call `Date.now()` drift). Absent ⇒
   *  `apps/bench/paths.ts#benchRunId` mints a `run-<Date.now()>` id. */
  readonly runId: string | undefined
  /** Preferences home override (`QUANTA_PREFS_HOME`). Absent ⇒ slash-command
   *  prefs/usage paths fall back to `os.homedir()`. */
  readonly prefsHome: string | undefined
  /** Last-reported token count (`QUANTA_LAST_TOKENS`). Surfaced by the
   *  `/context` slash command. Absent ⇒ the command omits the line. */
  readonly lastTokens: string | undefined
  /** `quanta session list` default format pin (`QUANTA_SESSION_LIST_FORMAT`).
   *  `plain` keeps the byte-identical legacy table (back-compat + pipelines);
   *  `rich` opts into the Codex-inspired TUI on a real TTY. Absent ⇒ the CLI
   *  surface picks `rich` when `process.stdout.isTTY`, else `plain`. */
  readonly sessionListFormat: "rich" | "plain" | undefined
  /** `quanta session list` default cap (`QUANTA_SESSION_LIST_MAX`). Applies
   *  only to the rich format (plain stays uncapped). Absent ⇒ the dispatcher
   *  defaults to 10. */
  readonly sessionListMax: number | undefined
  /** S5 hook hardening — per-handler timeout in ms (`QUANTA_HOOK_TIMEOUT_MS`).
   *  Absent ⇒ `hooks.ts` `DEFAULT_HOOK_TIMEOUT_MS` (5000). A timed-out handler
   *  logs a warning and the bus continues to the next handler. A
   *  per-registration override (`HookOnOptions.timeoutMs`) WINS over this
   *  default — the env knob is the operator-side floor for hosts that did not
   *  specify a per-hook timeout. */
  readonly hookTimeoutMs: number | undefined
  /** S5 hook hardening — max handlers per event (`QUANTA_HOOK_MAX_HANDLERS`).
   *  Absent ⇒ `hooks.ts` `MAX_HANDLERS_PER_EVENT` (64). Registering above the
   *  cap throws `HookRegistrationError` (load-bearing — surfaces a host
   *  misconfiguration loudly rather than silently dropping handlers). */
  readonly hookMaxHandlers: number | undefined
  /** S5 hook hardening — max emit payload size in BYTES
   *  (`QUANTA_HOOK_MAX_PAYLOAD_BYTES`). Absent ⇒ `hooks.ts`
   *  `MAX_PAYLOAD_BYTES` (1_048_576 = 1MB). Oversize payloads are TRUNCATED
   *  with a stable marker (graceful degradation — the dispatch still fires
   *  so a host that watches a hook never observes a missed event from a
   *  pathological argument). */
  readonly hookMaxPayloadBytes: number | undefined
  /** ADR-0287 async-tool kind activation (`QUANTA_ASYNC_TOOLS=1|on|true`).
   *  Default false — opt-in. When true the composition root constructs the
   *  `DefaultDeferredResultRegistry` and wires `poll_deferred` + every
   *  `defineToolAsync` instance to it; when false those tools degrade to
   *  synchronous execution (byte-identical to the pre-ADR path). */
  readonly asyncTools: boolean
  /** ADR-0286 deferred-result registry max live handles
   *  (`QUANTA_DEFERRED_CAP`). Absent ⇒ `DEFAULT_DEFERRED_CAP` (1000). LRU
   *  eviction; pending/running entries are never evicted (see
   *  `default-registry.ts` invariant #3). */
  readonly deferredCap: number | undefined
  /** H16 cross-session memory consolidation ("auto-dream") gate
   *  (`QUANTA_AUTO_DREAM`). Default false ⇒ the cross-session dream trigger
   *  is NOT constructed: its persisted counter never advances, no state is
   *  read/written, and the consolidate pass never fires from elapsed
   *  sessions/hours (byte-identical to the pre-H16 path). The composition
   *  root builds + wires `CrossSessionDreamTrigger` with a `DreamPolicy` ONLY
   *  when this is on. */
  readonly autoDream: boolean
  /** H16 sessions-since-last-dream threshold (`QUANTA_AUTO_DREAM_SESSIONS`).
   *  Absent ⇒ `DEFAULT_DREAM_POLICY.sessionsThreshold` (5). Drives the OR
   *  semantics — a dream fires after this many session-ends OR after the
   *  hours threshold, whichever crosses first. Positive integer; invalid ⇒
   *  fall back to default. Only consulted when `autoDream` is on. */
  readonly autoDreamSessions: number | undefined
  /** H16 hours-since-last-dream threshold (`QUANTA_AUTO_DREAM_HOURS`).
   *  Absent ⇒ `DEFAULT_DREAM_POLICY.hoursThreshold` (24). Positive number
   *  (fractional allowed, e.g. `0.5` for a 30-minute cadence in tests);
   *  invalid ⇒ fall back to default. Only consulted when `autoDream` is on. */
  readonly autoDreamHours: number | undefined
  /** R4 audit-H — disable the logger label-keyed leaky-bucket rate limiter
   *  (`QUANTA_LOG_RATE_LIMIT=off`). Default false (rate limit ON). Set to
   *  `off` to restore unbounded `logger.{info,warn,error,debug}` semantics —
   *  useful during incident triage where suppressing same-label spam would
   *  hide a forensic signal. The default-ON posture closes the audit-H DoS
   *  surface where a hostile catch in a hot loop could emit millions of
   *  `logger.warn` lines and stall stderr backpressure. */
  readonly logRateLimitDisabled: boolean
  /** H7 rotating cloud credentials — apiKeyHelper shell command
   *  (`QUANTA_API_KEY_HELPER`). Absent ⇒ no helper is wired; the credential
   *  source's `mintApiKey()` is a no-op (byte-identical to BYOK/env-key today).
   *  When set, the composition root builds a trust-gated `CredentialSource` that
   *  runs this command to mint an API key, TTL-cached. Mirrors Claude Code's
   *  `apiKeyHelper`. SENSITIVE — arbitrary command execution; the source gates
   *  it behind the workspace trust check before ever shelling out. */
  readonly apiKeyHelper: string | undefined
  /** H7 — apiKeyHelper / refresh TTL in ms (`QUANTA_API_KEY_HELPER_TTL_MS`).
   *  Absent ⇒ `credential-helper.ts` `DEFAULT_HELPER_TTL_MS` (5 min, mirroring
   *  Claude's `CLAUDE_CODE_API_KEY_HELPER_TTL_MS`). Bounds both the minted-key
   *  cache window AND the pre-call cloud-refresh throttle. */
  readonly apiKeyHelperTtlMs: number | undefined
  /** H7 — AWS pre-call refresh command (`QUANTA_AWS_AUTH_REFRESH`). Absent ⇒ the
   *  Bedrock adapter does NOT run a pre-call refresh (byte-identical SDK default
   *  chain). When set, `refreshCloudCreds("aws")` runs this command (e.g.
   *  `aws sso login`) before each Bedrock call, TTL-throttled. SENSITIVE —
   *  trust-gated. */
  readonly awsAuthRefresh: string | undefined
  /** H7 — GCP pre-call refresh command (`QUANTA_GCP_AUTH_REFRESH`). Absent ⇒ the
   *  Vertex adapter does NOT run a pre-call refresh (byte-identical ADC path).
   *  When set, `refreshCloudCreds("gcp")` runs this command (e.g.
   *  `gcloud auth application-default login`) before each Vertex call,
   *  TTL-throttled. SENSITIVE — trust-gated. */
  readonly gcpAuthRefresh: string | undefined
  /** H7 / ADR-0139 — EXPLICIT cloud-transport selection for the MAIN agent LLM
   *  (`QUANTA_LLM_TRANSPORT`). Empty/absent ⇒ the surface falls through to the
   *  registry env precedence ladder (`ANTHROPIC_{BEDROCK,VERTEX,FOUNDRY}_BASE_URL`
   *  / `ANTHROPIC_FOUNDRY_RESOURCE` / `QUANTA_USE_FOUNDRY`). Set to
   *  `default` | `bedrock` | `vertex` | `foundry` | `mantle` to route the main
   *  agent LLM through `createMulticloudLLM` (the H7 rotating-credential path).
   *  Default-OFF: unset AND no cloud env signal ⇒ the legacy `createLLM` path
   *  builds the four vendor providers BYTE-IDENTICALLY. This is the END-USER
   *  selection knob that was previously missing — it makes the proven multicloud
   *  + rotation seam reachable by config rather than only by an explicit
   *  `buildMulticloudLLMCore` call. */
  readonly llmTransport: string | undefined
  /** H7 — explicit workspace-trust attestation for the credential-helper shell
   *  (`QUANTA_LLM_CREDENTIAL_TRUSTED`). A credential helper / `*AuthRefresh` is
   *  ARBITRARY COMMAND EXECUTION, so the composition root's `isTrusted` predicate
   *  FAILS CLOSED: only the literal `1` here authorizes the shell to run. Unset /
   *  any other value ⇒ the source surfaces a typed `untrusted` decline and NEVER
   *  shells out (mirrors Claude Code's explicit-trust posture for `apiKeyHelper`).
   *  Default-OFF and orthogonal to the four H7 command knobs — setting a refresh
   *  command WITHOUT this attestation is a fail-closed no-run, not a silent run. */
  readonly llmCredentialTrusted: boolean
  /** Prompt-cache TTL selector (`QUANTA_PROMPT_CACHE_TTL`). `"5m"` (default) or
   *  `"1h"`. Only the literal `"1h"` opts into the extended cache-control TTL;
   *  any other value (including absent) ⇒ `"5m"`, byte-identical to the prior
   *  fixed-5m cache_control. The factory further gates `"1h"` behind an
   *  allowlist of models that actually support it (`resolveCacheTtl`), so even
   *  ON it is a no-op for non-allowlisted models. */
  readonly cacheTtl: "5m" | "1h"
  /** OAuth token revoke-on-logout gate (`QUANTA_OAUTH_REVOKE_ON_LOGOUT`). Strict
   *  opt-in (`=== "1"`). Default false ⇒ logout only clears local credential
   *  state (byte-identical). When true, the logout command additionally calls
   *  the provider's RFC 7009 token revocation endpoint before clearing. */
  readonly oauthRevokeOnLogout: boolean
  /** jun-6 (ADR-0481) cell-aware `.ipynb` render — append textual outputs
   *  (`QUANTA_IPYNB_OUTPUTS`). DEFAULT **ON** (the ONLY knob in this codebase
   *  that is default-true, justified: a `.ipynb` read is BROKEN today — it dumps
   *  raw nbformat JSON with base64 image blobs — so the safe default is the
   *  fixed render, not the broken one; matches Claude/Cursor/Codex). This knob
   *  ONLY toggles whether each code cell's TEXTUAL outputs (stream / text-plain /
   *  error traceback) are appended after its source. Set to `off`/`0`/`false`
   *  to render cell SOURCE only. Two things are UNCONDITIONAL (never a knob):
   *  (1) cell-source rendering for any `.ipynb`, and (2) base64 image-blob
   *  stripping (emitting a base64 PNG is never wanted). Has ZERO effect on any
   *  non-`.ipynb` read — the extension gate short-circuits, so every other file
   *  is byte-identical to the pre-ADR raw render. */
  readonly ipynbIncludeOutputs: boolean
  /** jun-6 (RFC jun-6-byok-api-key-helper) — legacy per-vendor apiKeyHelper
   *  resolution gate (`QUANTA_API_KEY_HELPER_LEGACY_VENDOR`). Strict opt-in
   *  (`=== "1"`). Default false ⇒ the legacy LLM-build seam passes
   *  `source: undefined` to `resolveVendorApiKey`, so key resolution is
   *  byte-identical to the pre-slice BYOK/env path. When ON, the composition
   *  root resolves the per-vendor key through the apiKeyHelper credential
   *  source before building the provider. */
  readonly apiKeyHelperLegacyVendor: boolean
  /** jun-6 (RFC jun-6-ai-session-title) — AI session auto-title gate
   *  (`QUANTA_SESSION_AUTO_TITLE`). Standard boolean knob vocabulary
   *  (`1`/`true`/`on`). Default false ⇒ the composition root builds NO
   *  `autoTitlePort` and the loop's first-turn title branch is dead
   *  (byte-identical). When ON *and* `sessionTitleModel` resolves a cheap
   *  `LLMPort`, the loop fire-and-forgets a ≤6-word title for the first user
   *  prompt (never awaited, never clobbers a human rename). */
  readonly sessionAutoTitle: boolean
  /** jun-6 — cheap model id for the auto-title call (`QUANTA_SESSION_TITLE_MODEL`,
   *  mirrors `QUANTA_COMPACT_MODEL`). Absent ⇒ no port is built even when
   *  `sessionAutoTitle` is on (both must be present — advertise-iff-able). */
  readonly sessionTitleModel: string | undefined
  /** jun-6 (RFC jun-6-tool-interrupt-behavior) — `block`-interrupt critical-
   *  section gate (`QUANTA_TOOL_INTERRUPT_BLOCK`). Strict opt-in (`=== "1"`).
   *  Default false ⇒ the dispatch seam threads the raw `config.signal` and NO
   *  `criticalSection` onto `ToolContext` (byte-identical: a `block` tool
   *  behaves exactly like `cancel`). When ON, a tool whose
   *  `interruptBehavior() === "block"` runs over a derived suppressible signal so
   *  its atomic FS-write window (rename/flush) finishes whole before a withheld
   *  ESC is delivered — bounded by {@link criticalSectionMaxMs}. */
  readonly toolInterruptBlock: boolean
  /** jun-6 — watchdog cap (ms) bounding how long a critical section may withhold
   *  an in-flight abort before it is force-delivered
   *  (`QUANTA_CRITICAL_SECTION_MAX_MS`). Absent ⇒ {@link DEFAULT_CRITICAL_SECTION_MAX_MS}
   *  (5000). The critical-section slice (`@/tool/critical-section`) takes this by
   *  injection; there is NO magic constant inside it, so the default lives here.
   *  5s is generous for a single rename/flush yet guarantees `block` can DEFER a
   *  cancel across one bounded window, never SWALLOW it. */
  readonly criticalSectionMaxMs: number
  /** jun-6 (RFC jun-6-permission-request-hook) — `permission_request` hook
   *  kill-switch (`QUANTA_PERMISSION_HOOK`). Strict opt-in (`=== "1"`). Default
   *  false ⇒ the admissibility gate does NOT emit the pre-decision
   *  `permission_request` event (byte-identical, the gate falls through to the
   *  policy stack). When ON *and* a `HookBus` is wired, the gate emits the event
   *  before the policy stack and routes the verdict via
   *  `routePermissionHookVerdict` (HARD_DENY floor enforced — a hook `allow`
   *  never overrides the denylist). Extra guard atop hook presence. */
  readonly permissionHook: boolean
  /** jun-6 (RFC jun-6-exfil-egress-rails (b)) — glob-in-write-path guard gate
   *  (`QUANTA_GLOB_WRITE_GUARD`). Strict opt-in (`=== "1"`). Default false ⇒ the
   *  dispatch seam does NOT set `ToolContext.globWriteGuard`, so `write`/`edit`
   *  accept a glob/wildcard `path` as a literal filename exactly as before
   *  (byte-identical). When ON, a `path` that is a glob pattern (`*`/`?`/`{a,b}`)
   *  is rejected with the verbatim cc-cli message BEFORE any fs call. The RFC
   *  argues this is a strong default-ON candidate after a soak; it ships
   *  default-OFF for byte-identity (mirrors `globWriteGuardEnabled`). */
  readonly globWriteGuard: boolean
  /** jun-6 (RFC jun-6-exfil-egress-rails (a)) — per-turn write/edit budget gate
   *  (`QUANTA_WRITE_BUDGET`). Strict opt-in (`=== "1"`). Default false ⇒ no
   *  budget port is constructed and `ToolContext.writeBudget` is absent, so
   *  `write`/`edit` proceed byte-identically (no counter). The budget ALSO
   *  requires a configured cap ({@link writeBudgetMax}) — both must be present
   *  for any side effect (advertise-iff-able) — and only fires in an
   *  untrusted-input turn (the §3.5 untrusted-envelope signal). */
  readonly writeBudget: boolean
  /** jun-6 (RFC jun-6-exfil-egress-rails (a)) — per-turn write/edit cap N
   *  (`QUANTA_WRITE_BUDGET_MAX`, a positive integer). This is the CONFIGURABLE
   *  KNOB value — there is NO hardcoded default (no-heuristics rule: the cap MUST
   *  be calibrated from a real-turn write-count corpus, not guessed). Absent /
   *  invalid ⇒ `undefined` ⇒ the budget stays INERT even when {@link writeBudget}
   *  is on, so the path is byte-identical until an operator sets a cap. */
  readonly writeBudgetMax: number | undefined
  /** jun-6 (RFC jun-6-exfil-egress-rails (c)) — exfil-scouting gate
   *  (`QUANTA_EXFIL_SCOUTING`). Strict opt-in (`=== "1"`). Default false ⇒ the
   *  deterministic `detectScouting` aggregate over the proxy deny-log is never
   *  called and the "Exfil Scouting" taxonomy prose line is OMITTED from the
   *  assembled classifier prompt (byte-identical prompt + behavior). When ON the
   *  detector emits an ADVISORY signal (a classification hint, never a hard
   *  auto-deny — RFC §7 (c)) for ≥ K distinct denied non-allowlisted hosts. */
  readonly exfilScouting: boolean
  /** jun-6 (RFC jun-6-exfil-egress-rails (c)) — exfil-scouting threshold K
   *  (`QUANTA_EXFIL_SCOUTING_K`, a positive integer). The CONFIGURABLE KNOB —
   *  NO hardcoded default (no-heuristics rule: K must be calibrated from a real
   *  probe-burst corpus, not guessed). Absent / invalid ⇒ `undefined` ⇒ the
   *  detector stays INERT even when {@link exfilScouting} is on, so the path is
   *  byte-identical until an operator sets a threshold. */
  readonly exfilScoutingK: number | undefined
  /** jun-6 (RFC jun-6-exfil-egress-rails (B)) — secret-aware egress MODE
   *  (`QUANTA_SECRET_EGRESS` = `deny` | `redact`). Any other value (unset, "1",
   *  "true") ⇒ `undefined` (OFF) ⇒ the egress decision is HOST-ONLY (no
   *  body/header scan), byte-identical. When set, the proxy injects the existing
   *  `compositeSecretScanner` into the PLAINTEXT-HTTP request path and
   *  denies/redacts a leaving declared/detected secret. ⚠️ HTTPS CONNECT tunnels
   *  are OPAQUE (raw TLS) and are NEVER content-scanned — they log a visible
   *  `connect-tunnel-unscanned` marker; full coverage needs TLS MITM, a deferred
   *  Phase-2 RFC. `redact` is the recommended mode (RFC §7 (B)). */
  readonly secretEgress: "deny" | "redact" | undefined
  /** jun-6 (RFC jun-6-exfil-egress-rails (B)) — max buffered-body byte cap for
   *  the secret-egress scan (`QUANTA_SECRET_EGRESS_MAX_BODY`, a positive
   *  integer). DoS guard: a body past the cap is forwarded UNSCANNED with a
   *  visible `body-cap-unscanned` log marker (never blocked-by-truncation). NO
   *  hardcoded default (no-heuristics rule); absent / invalid ⇒ `undefined` ⇒
   *  the wire treats secret-egress as INERT (a scan with no byte budget is not
   *  advertised) until an operator sets the cap. */
  readonly secretEgressMaxBody: number | undefined
  /** jun-7 TLS-MITM (Phase-2 of exfil-rail (B)) — whether the operator has
   *  EXPLICITLY opted into terminating + scanning HTTPS CONNECT traffic. STRONGER
   *  gate than the other knobs (MITM mints a trust anchor the agent's client
   *  accepts): requires BOTH `QUANTA_TLS_MITM=1` AND the verbatim ack phrase in
   *  `QUANTA_TLS_MITM_ACK`. Either missing ⇒ `false` ⇒ the CONNECT path stays a
   *  raw tunnel + `connect-tunnel-unscanned` marker (byte-identical). The
   *  composition root only constructs an ephemeral MITM CA when this is `true`
   *  AND `secretEgress` is set (nothing to scan otherwise). */
  readonly tlsMitm: boolean
  /** jun-7 TLS-MITM — fail-closed policy on a termination/scan error
   *  (`QUANTA_TLS_MITM_ON_FAILURE` = `deny` | `opaque-tunnel`). `deny`
   *  (recommended) hard-blocks an un-scannable host; `opaque-tunnel` falls back
   *  to the raw tunnel + a VISIBLE `connect-tunnel-unscanned` marker. Any other
   *  value ⇒ `deny` (fail closed by default). Inert unless {@link tlsMitm}. */
  readonly tlsMitmOnFailure: "deny" | "opaque-tunnel"
  /** jun-7-misc 02 (manifest codex-compat) — read-only codex-shape manifest
   *  ingest normalizer gate (`QUANTA_MANIFEST_COMPAT`). Strict opt-in
   *  (`=== "1"`). SECURITY-relevant: it LOOSENS manifest validation (accepts a
   *  foreign/codex-shaped manifest by coercing its shape on ingest), so an
   *  accidental loose-truthy enable must NOT arm it — strict `=1` only. Default
   *  false ⇒ the loader rejects non-quanta manifests exactly as today
   *  (byte-identical validation). The normalizer never widens a grant; it only
   *  renames/coerces SHAPE on read. */
  readonly manifestCompat: boolean
  /** jun-7-misc 03 (guardian per-action assessor) — per-action LLM risk
   *  assessor gate (`QUANTA_GUARDIAN_ASSESSOR`). Strict opt-in (`=== "1"`).
   *  Default false ⇒ no guardian assessor is constructed, the admissibility gate
   *  consults no per-action LLM risk pass, and tool dispatch is byte-identical.
   *  When ON *and* a judge LLM + the guardian wiring are assembled at the
   *  composition root, a candidate action may be routed through the assessor for
   *  an advisory risk signal (it NEVER auto-grants — it can only add caution /
   *  route to HITL, never widen a grant). */
  readonly guardianAssessor: boolean
  /** jun-7-misc 04 (auto-mode rule overlay) — user-authored rule overlay onto
   *  the auto-mode classifier system prompt (`QUANTA_AUTO_MODE_RULES`). Strict
   *  opt-in (`=== "1"`). Default false ⇒ `evaluateAuto` flows the exact current
   *  `CLASSIFIER_SYSTEM_PROMPT` (or scout-overlaid prompt) unchanged
   *  (byte-identical classification). When ON, `withUserRuleOverlay` splices the
   *  operator's rule text into the classifier prompt. */
  readonly autoModeRules: boolean
  /** jun-7-misc 04 (auto-mode circumvention detect) — denied-effect re-attempt
   *  tracker gate (`QUANTA_CIRCUMVENT_DETECT`). Strict opt-in (`=== "1"`).
   *  Default false ⇒ no `CircumventionTracker` is constructed, zero effect
   *  signatures are recorded, and the auto-mode gate is byte-identical. When ON,
   *  a sibling tracker records a denied action's effect-signature so a
   *  semantically-equivalent retry via a DIFFERENT tool surfaces an advisory
   *  circumvention signal (never an auto-deny — advisory only). */
  readonly circumventDetect: boolean
  /** §20.4 (ticket-12) — HARD-enforce subagent `ownedSurfaces`/`forbiddenSurfaces`
   *  at the dispatch FS-write seam (`QUANTA_FS_OWNERSHIP_ENFORCE`). Strict opt-in
   *  (`=== "1"`). OFF ⇒ those surfaces stay advisory seed-prompt guidance only
   *  (byte-identical legacy). */
  readonly fsOwnershipEnforce: boolean
  /** jun-7-misc 05 (central-config trust) — repo-local central config loader
   *  gate (`QUANTA_CENTRAL_CONFIG`). Strict opt-in (`=== "1"`). SECURITY:
   *  reading a repo-local config file is RCE-adjacent (a hostile repo could plant
   *  config that steers tool behavior), so it must be a deliberate `=1` opt-in.
   *  Default false ⇒ NO repo-local config file is discovered, read, or merged
   *  (byte-identical startup). When ON, the config lane's disk loader (wired
   *  LATER — only the gate field lives here) reads + merges a trust-gated
   *  repo-local central config. */
  readonly centralConfig: boolean
  /** jun-7-misc 06 (model-based fast-apply) — model-apply MERGE rung gate
   *  (`QUANTA_FAST_APPLY_MERGE`). Strict opt-in (`=== "1"`). DISTINCT from the
   *  existing `QUANTA_FAST_APPLY` (the V4A re-emit rung, gated in
   *  `agent/optional-ports.ts`) — this knob adds a NEW optional model-apply rung.
   *  Default false ⇒ no `FastApplyPort` (merge) is constructed, `ctx.fastApplyMerge`
   *  is undefined, and the edit fallback ladder is the byte-identical
   *  `exact → fuzzy → V4A re-emit` with ZERO apply-model dispatches. Requires BOTH
   *  this gate AND a configured {@link fastApplyModel} for any provider call
   *  (advertise-iff-able). */
  readonly fastApplyMerge: boolean
  /** jun-7-misc 06 — operator-chosen apply-model id for the fast-apply MERGE rung
   *  (`QUANTA_FAST_APPLY_MODEL`, mirrors `QUANTA_COMPACT_MODEL`). Absent ⇒ no
   *  `FastApplyPort` is built even when {@link fastApplyMerge} is on (both must be
   *  present — advertise-iff-able). NO default model: the apply model is
   *  operator-set (a cheap specialist) and must be measured against the re-emit
   *  baseline, not guessed (`no-heuristics-only-validated`). Never defaults to the
   *  main agent model (that would defeat the cost win). */
  readonly fastApplyModel: string | undefined
  /** jun-7-misc 01 (MCP protocol version) — OPTIONAL max-offered MCP protocol
   *  version override (`QUANTA_MCP_PROTOCOL_MAX`, a protocol-version string).
   *  Absent ⇒ undefined ⇒ negotiation offers the code-side SSOT max version
   *  (the SSOT list lives in `src/mcp`); negotiation is otherwise ALWAYS-ON and
   *  backward-compatible, so there is NO gate. When set, it pins the MAX version
   *  the client/server offers (e.g. to cap at an older spec for a peer that
   *  mis-handles a newer one). An unknown/unsupported value is the mcp lane's
   *  concern to validate against its SSOT; this field only carries the raw
   *  override string. */
  readonly mcpProtocolMax: string | undefined
  /** jun-7-misc 05 (central-config trust) — user-config-dir override for the
   *  `@/config` USER layer (`QUANTA_CONFIG_DIR`, analogous to Claude's
   *  `CLAUDE_CONFIG_DIR`). Absent ⇒ undefined ⇒ the config lane defaults to
   *  `~/.quanta`. PURELY a path string carried for the loader; it has NO effect
   *  unless {@link centralConfig} is on (the loader is never invoked otherwise),
   *  so a set-but-disabled value is byte-identical. */
  readonly centralConfigDir: string | undefined
  /** jun-7-misc 05 (central-config trust) — the `--setting-sources` analogue
   *  (`QUANTA_SETTING_SOURCES`, a comma list subset of
   *  `managed,user,project,local`). Absent ⇒ undefined ⇒ the config lane honors
   *  ALL layers. Carried raw; the `@/config` lane parses + validates it. No
   *  effect unless {@link centralConfig} is on. */
  readonly centralConfigSources: string | undefined
  /** jun-7-misc 05 (central-config trust) — static trusted-path allow-list for
   *  HEADLESS/CI grants (`QUANTA_TRUSTED_PATHS`, a comma/`:`-free path list,
   *  §9 Q3). Absent ⇒ undefined ⇒ NO path is statically trusted (headless ⇒
   *  untrusted, period — the safe default). When set, the config lane
   *  canonicalizes each entry into the trust set. This is the EXPLICIT CI
   *  opt-in; it NEVER auto-trusts cwd. No effect unless {@link centralConfig}
   *  is on. */
  readonly trustedPaths: string | undefined
}

/** jun-6 — default watchdog cap (ms) for a `block`-tool critical section. The
 *  critical-section slice has NO embedded magic number (it takes `maxMs` by
 *  injection), so this measured one-rename budget is the SSOT default. 5s is
 *  generous for a single atomic FS-write window yet bounds a withheld abort so
 *  `block` can never permanently swallow a cancel. */
export const DEFAULT_CRITICAL_SECTION_MAX_MS = 5_000

const stringOrUndef = (raw: string | undefined): string | undefined =>
  typeof raw === "string" && raw.length > 0 ? raw : undefined

const loadFromEnv = (env: NodeJS.ProcessEnv): RuntimeConfig => {
  return Object.freeze({
    logLevel: parseLogLevel(env["QUANTA_LOG_LEVEL"]),
    compactTokens: parsePositiveInt(env["QUANTA_COMPACT_TOKENS"], "QUANTA_COMPACT_TOKENS"),
    // ADR-0473 — strict `=== "1"` opt-in (matches the `bgCompactionEnabled`
    // slice gate; `parseBool` also accepts true/on but the slice gate is the
    // SSOT, so keep it strict here too).
    bgCompaction: gateOnStrict(env, "QUANTA_BG_COMPACTION"),
    // RFC jun-6-microcompaction — strict `=== "1"` opt-in. Default false ⇒ the
    // tier-1 eviction pre-pass is never constructed (byte-identical). The
    // keep/floor/interval tunables are positive ints (no magic literals); absent
    // ⇒ the wire applies its own named defaults.
    microcompact: gateOn(env, "QUANTA_MICROCOMPACT"),
    microcompactKeepRecent: parsePositiveInt(
      env["QUANTA_MICROCOMPACT_KEEP_RECENT"],
      "QUANTA_MICROCOMPACT_KEEP_RECENT",
    ),
    microcompactFloorTokens: parsePositiveInt(
      env["QUANTA_MICROCOMPACT_FLOOR_TOKENS"],
      "QUANTA_MICROCOMPACT_FLOOR_TOKENS",
    ),
    microcompactIntervalMs: parsePositiveInt(
      env["QUANTA_MICROCOMPACT_INTERVAL_MS"],
      "QUANTA_MICROCOMPACT_INTERVAL_MS",
    ),
    // ADR-0471 — strict `=== "1"` opt-in (matches the `untrustedEnvelopeEnabled`
    // slice gate, which is the SSOT). Default false ⇒ dispatch wraps nothing.
    untrustedEnvelope: gateOnStrict(env, "QUANTA_UNTRUSTED_ENVELOPE"),
    // ADR-0472 — strict `=== "1"` opt-in (matches the `editRepairLoopEnabled`
    // slice gate, the SSOT). Default false ⇒ no lint-delta attached.
    editRepairLoop: gateOnStrict(env, "QUANTA_EDIT_REPAIR_LOOP"),
    // ADR-0476 — strict `=== "1"` opt-in (matches the `skillMcpDepsEnabled`
    // slice gate). Default false ⇒ no deps lifted, no auto-attach.
    skillMcpDeps: gateOnStrict(env, "QUANTA_SKILL_MCP_DEPS"),
    // ADR-0470 B1 follow-up — strict `=== "1"` opt-in. SEAM (validated, not yet
    // composed at the root): no production code reads this field, so it is a
    // no-op today (byte-identical ON or OFF). Default false ⇒ MCP `sampling` is
    // NOT advertised and the headless rejecter declines (`no-handler`). Intended
    // end state: the composition root wires a handler (and advertises) only when
    // this is on AND an LLM + consent prompter are present.
    mcpSampling: gateOn(env, "QUANTA_MCP_SAMPLING"),
    // delta-token-accounting (RFC jun-6) — strict `=== "1"` opt-in. Default
    // false ⇒ the loop never constructs the counter and calls `estimateTokens`
    // directly at every site (byte-identical). ON guards CONSTRUCTION/perf only;
    // the counter's numbers are byte-identical to a full re-scan by §4.1.
    deltaTokenCount: gateOn(env, "QUANTA_DELTA_TOKEN_COUNT"),
    // H19 — strict `=== "1"` opt-in. Default false ⇒ MCP `roots` is NOT
    // advertised and inbound `roots/list` answers an empty list (byte-identical).
    // The composition root advertises + wires the RootsProviderPort together
    // only when this is on AND a workspace roots source is available.
    mcpRoots: gateOn(env, "QUANTA_MCP_ROOTS"),
    // H18 — strict `=== "1"` opt-in. Default false ⇒ no OAuth provider is wired,
    // the McpClient falls back to the headless rejecter (no token), every MCP
    // load is byte-identical (no discovery, no flow, no Authorization header).
    mcpOAuth: gateOn(env, "QUANTA_MCP_OAUTH"),
    // H9 — strict `=== "1"` opt-in. Default false ⇒ the read tool renders full
    // content on every call and allocates no per-range dedup state.
    readDedup: gateOn(env, "QUANTA_READ_DEDUP"),
    // H6 — strict `=== "1"` opt-in. Default false ⇒ the bash post-exec hook
    // classifies nothing and touches no sink (byte-identical).
    passiveVcs: gateOn(env, "QUANTA_PASSIVE_VCS"),
    // H14a — strict `=== "1"` opt-in. Default false ⇒ no image_gen port wired,
    // tool not registered (byte-identical default menu).
    imageGen: gateOn(env, "QUANTA_IMAGE_GEN"),
    // H14b — strict `=== "1"` opt-in. Default false ⇒ no office authoring tools.
    officeAuthoring: gateOn(env, "QUANTA_OFFICE_AUTHORING"),
    // H15 — strict `=== "1"` opt-in. Default false ⇒ responses-wire byte-identical
    // (encrypted reasoning dropped, no include, no re-emit). OpenAI-Responses only.
    reasoningCarryover: gateOn(env, "QUANTA_REASONING_CARRYOVER"),
    // H17 — idle goal-continuation + budget enforcement. Strict `=== "1"` opt-in;
    // default false ⇒ objective stays informational-only (byte-identical).
    goalContinuationEnforce: gateOn(env, "QUANTA_GOAL_ENFORCE"),
    // H13 — strict `=== "1"` opt-in. Default false ⇒ no config-migration detect,
    // no prompt, no ledger (byte-identical startup).
    migrateConfig: gateOn(env, "QUANTA_MIGRATE_CONFIG"),
    // H17 — strict `=== "1"` opt-in. Default false ⇒ objective budget stays
    // informational (status never flips, idle-continuation byte-identical).
    objectiveBudgetEnforce: gateOn(env, "QUANTA_OBJECTIVE_BUDGET_ENFORCE"),
    // Capability A — strict `=== "1"` opt-in. Default false ⇒ batch fan-out is
    // the existing flat parallel pool (byte-identical, no DAG ordering).
    teamDag: gateOn(env, "QUANTA_TEAM_DAG"),
    // Capability B — strict `=== "1"` opt-in. Default false ⇒ a denied worker
    // tool stays a hard failure (no escalation broker, byte-identical).
    teamBroker: gateOn(env, "QUANTA_TEAM_BROKER"),
    // Capability C — strict `=== "1"` opt-in. Default false ⇒ no idle beacons /
    // no fan-in barrier (the leader polls, byte-identical).
    teamIdle: gateOn(env, "QUANTA_TEAM_IDLE"),
    // Peer teammate messaging (RFC jun-6) — strict `=== "1"` opt-in. Default
    // false ⇒ no peerInbox drain (turn loop byte-identical), no TeamScopedMailbox
    // decorator (raw global mailbox), no team registry / team_* tools. Builds ON
    // the existing QUANTA_TEAM_* peer mailbox + wake-idle.
    teamPeerMsg: gateOn(env, "QUANTA_TEAM_PEER_MSG"),
    // C1 — strict `=== "1"` opt-in. Default false ⇒ no artifact registry / tools
    // (byte-identical).
    artifactStore: gateOn(env, "QUANTA_ARTIFACT_STORE"),
    // code-mode (RFC jun-6-code-mode, Phase 1) — strict `=== "1"` opt-in. Default
    // false ⇒ no codeCellDispatch port wired, no code_cell tool, the QuickJS-WASM
    // module is never instantiated (byte-identical default menu + cold path).
    // STRICT `=== "1"` (NOT the loose `gateOn`): code-mode is a SECURITY gate
    // (arbitrary in-cell JS that dispatches tools), so a typo'd/loose truthy
    // spelling (`true`/`on`) must NOT enable it — strict opt-in is the contract
    // (jun-7 hellgate: `codeMode true ONLY for "1"`). The uniform-gateOn refactor
    // is correct for ordinary gates; security gates stay strict by design —
    // `gateOnStrict` is the SSOT primitive for that (exact "1", refuses loose on/true).
    codeMode: gateOnStrict(env, "QUANTA_CODE_MODE"),
    // code-mode Phase 3 — strict `"1"` opt-in (same security rationale).
    // Default false ⇒ no steering directive (byte-identical dynamic tail).
    codeModeOnly: gateOnStrict(env, "QUANTA_CODE_MODE_ONLY"),
    codeModeMemBytes: parsePositiveInt(
      env["QUANTA_CODE_MODE_MEM_BYTES"],
      "QUANTA_CODE_MODE_MEM_BYTES",
    ),
    codeModeTimeoutMs: parsePositiveInt(
      env["QUANTA_CODE_MODE_TIMEOUT_MS"],
      "QUANTA_CODE_MODE_TIMEOUT_MS",
    ),
    codeModeMaxCalls: parsePositiveInt(
      env["QUANTA_CODE_MODE_MAX_CALLS"],
      "QUANTA_CODE_MODE_MAX_CALLS",
    ),
    codeModeOutputCap: parsePositiveInt(
      env["QUANTA_CODE_MODE_OUTPUT_CAP"],
      "QUANTA_CODE_MODE_OUTPUT_CAP",
    ),
    // file_history_rewind — strict `=== "1"` opt-in. Default false ⇒ no per-file
    // history store, no capture sink, no file_history_rewind tool (byte-identical).
    fileHistory: gateOn(env, "QUANTA_FILE_HISTORY"),
    // CLUSTER D #5 — strict `=== "1"` opt-in. Default false ⇒ no PatternGrantStore
    // constructed, no permission_propose_pattern tool (byte-identical).
    rememberPatterns: gateOn(env, "QUANTA_REMEMBER_PATTERNS"),
    // CLUSTER D #5 residual — strict `=== "1"` opt-in. Default false ⇒ a
    // dangerous self-proposal is always rejected (reviewer-routed), byte-identical.
    // ON ⇒ the propose port is wired with `allowDangerous: true` (lifts ONLY the
    // dangerous-gate; the no-widen gate still rejects an uncovered proposal).
    rememberPatternsDangerous: gateOn(env, "QUANTA_REMEMBER_PATTERNS_DANGEROUS"),
    // jun-6 paste-burst — positive-integer min-char threshold. Absent / invalid
    // ⇒ undefined ⇒ the CLI reader echoes a paste inline (byte-identical).
    pasteBurstMinChars: parsePositiveInt(env["QUANTA_PASTE_BURST"], "QUANTA_PASTE_BURST"),
    // jun-6 skill-creator — strict `=== "1"` opt-in. Default false ⇒ no writer
    // port, `skill_create` not registered (byte-identical default tool surface).
    skillCreator: gateOn(env, "QUANTA_SKILL_CREATOR"),
    // C6 — strict `=== "1"` opt-in. Default false ⇒ no structured deny reason
    // attached / no content prefix / DecisionEvent unchanged (byte-identical).
    surfaceDenyReason: gateOn(env, "QUANTA_DENY_REASON"),
    // sandbox-escalation (RFC jun-6) — strict `=== "1"` opt-in. Default false ⇒
    // classifySandboxDenial is never consulted, no denialReason is ever set, no
    // escalation prompt, no post-denial record (a sandboxed nonzero exit is
    // byte-identical to a plain failure). Default-ON flip is OUT OF SCOPE.
    sandboxEscalation: gateOn(env, "QUANTA_SANDBOX_ESCALATION"),
    sandboxEscalationMax: parsePositiveInt(
      env["QUANTA_SANDBOX_ESCALATION_MAX"],
      "QUANTA_SANDBOX_ESCALATION_MAX",
    ),
    // account-ratelimit — strict `=== "1"` opt-in. Default false ⇒ adapters
    // capture no ratelimit headers and the loop inserts no pre-request delay
    // (byte-identical).
    proactiveRateLimit: gateOn(env, "QUANTA_RATELIMIT_PROACTIVE"),
    ratelimitNotice: ratelimitNoticeWanted(env.QUANTA_RATELIMIT_NOTICE),
    // N6 PTY backend selector. Default "tmux" ⇒ byte-identical to pre-slice path.
    ptyBackend: parsePtyBackend(env["QUANTA_PTY_BACKEND"]),
    // H18/keyring — strict `=== "1"` opt-in. Default false ⇒ MCP OAuth uses the
    // plain 0600 file token store (byte-identical, no keyring wrap).
    mcpOAuthKeyring: gateOn(env, "QUANTA_MCP_OAUTH_KEYRING"),
    // ADR-0487 — strict `=== "1"` opt-in. Default false ⇒ scheduler built without
    // admissionQueue (throw-at-cap) and no 4th tool (byte-identical).
    subagentQueue: gateOn(env, "QUANTA_SUBAGENT_QUEUE"),
    // ADR-0487 — strict `=== "1"` opt-in. Default false ⇒ subagentBgTools mints no
    // subagent_force_background tool (byte-identical).
    forceBackground: gateOn(env, "QUANTA_FORCE_BACKGROUND"),
    // G1 — strict `=== "1"` opt-in. Default false ⇒ no DefaultToolPorts.appshot
    // slot, appshot_verify not registered (byte-identical default menu).
    appshot: gateOn(env, "QUANTA_APPSHOT"),
    // N1 — strict `=== "1"` opt-in. Default false ⇒ no side-agent daemons/tools.
    sideAgent: gateOn(env, "QUANTA_SIDE_AGENT"),
    // N2 — strict `=== "1"` opt-in. Default false ⇒ no MCP connector tools.
    mcpConnectors: gateOn(env, "QUANTA_MCP_CONNECTORS"),
    // N3 — strict `=== "1"` opt-in. Default false ⇒ no MCP resource/prompt tools.
    mcpResources: gateOn(env, "QUANTA_MCP_RESOURCES"),
    // §19.1 — opt-in honoring of server-declared tool annotations. SSOT with the
    // `mcp-tool-annotations` KNOB (Finding 2): both channels share the standard
    // boolean vocabulary (`1`/`true`/`on`) via `parseBool`, so `=on`/`=true`
    // activate the LIVE bridge identically to `=1` (the knob registry/telemetry
    // no longer disagree with the consumer). Unset ⇒ false (annotationsHonored
    // stays false; every MCP tool keeps its conservative read/concurrency
    // classification, byte-identical default).
    mcpToolAnnotations: parseBool(env["QUANTA_MCP_TOOL_ANNOTATIONS"]),
    progressUpdate: gateOn(env, "QUANTA_PROGRESS_UPDATE"),
    // #8 — strict `=== "1"` opt-in. Default false ⇒ no mid-turn capture facade.
    midTurnCapture: gateOn(env, "QUANTA_MIDTURN_CAPTURE"),
    midTurnVisible: gateOn(env, "QUANTA_MIDTURN_VISIBLE"),
    managedSettingsPath: env.QUANTA_MANAGED_SETTINGS_PATH,
    ptyAttach: gateOn(env, "QUANTA_PTY_ATTACH"),
    // D3 — PTY env-inherit escape hatch. Default false ⇒ scrubbed (secure).
    // Truthy (`1`/`true`/`on`) ⇒ full parent-env inherit (interactive opt-out).
    ptyInheritEnv: parseBool(env["QUANTA_PTY_INHERIT_ENV"]),
    // C3 — brief-mode SEED. Uses the standard boolean knob vocabulary (1/true/on)
    // so it reads like the `effort` env seed; default-OFF ⇒ byte-identical.
    brief: parseBool(env["QUANTA_BRIEF"]),
    // §5 prompt-directive bundle — strict `=== "1"` opt-in per directive. Each
    // default false ⇒ `selectActiveDirectives` emits nothing ⇒ byte-identical.
    directiveAutonomous: gateOn(env, "QUANTA_DIRECTIVE_AUTONOMOUS"),
    directiveReadComplete: gateOn(env, "QUANTA_DIRECTIVE_READ_COMPLETE"),
    directiveProgress: gateOn(env, "QUANTA_DIRECTIVE_PROGRESS"),
    directiveMemoryVerify: gateOn(env, "QUANTA_DIRECTIVE_MEMORY_VERIFY"),
    directiveThinkFreq: gateOn(env, "QUANTA_DIRECTIVE_THINK_FREQ"),
    directiveAntiPlatitude: gateOn(env, "QUANTA_DIRECTIVE_ANTI_PLATITUDE"),
    directiveParallelTools: gateOn(env, "QUANTA_DIRECTIVE_PARALLEL_TOOLS"),
    // Advisor timing-rail directive (RFC jun-6 §5.2) — strict `=== "1"` opt-in.
    directiveAdvisorRail: gateOn(env, "QUANTA_ADVISOR_RAIL"),
    // adaptive-thinking — strict `=== "1"` opt-in. Default false ⇒ the producer
    // emits manual `{type:"enabled",budget_tokens}` for every model (byte-identical).
    adaptiveThinking: gateOn(env, "QUANTA_ADAPTIVE_THINKING"),
    // RFC jun-6 §5.1 — advisor full-history forward (strict `=== "1"` opt-in).
    advisorForwardHistory: gateOn(env, "QUANTA_ADVISOR_FORWARD_HISTORY"),
    // SECURITY protection (filesystem jail) — tearing it down requires the
    // deliberate, unambiguous `=off`; a loose `=0` must NOT silently drop the jail.
    fsJailDisabled: gateDisabledStrict(env, "QUANTA_FS_JAIL"),
    capEnforce: parseBool(env["QUANTA_CAP_ENFORCE"]),
    gitSha: stringOrUndef(env["QUANTA_GIT_SHA"]),
    pricingVersion: stringOrUndef(env["QUANTA_PRICING_VERSION"]),
    sessionsDir: stringOrUndef(env["QUANTA_SESSIONS_DIR"]),
    sessionTranscriptMaxBytes: parsePositiveInt(
      env["QUANTA_SESSION_TRANSCRIPT_MAX_BYTES"],
      "QUANTA_SESSION_TRANSCRIPT_MAX_BYTES",
    ),
    hitlOverridesPath: stringOrUndef(env["QUANTA_HITL_OVERRIDES"]),
    toolOutputMaxChars: parsePositiveInt(env["QUANTA_TOOL_OUTPUT_MAX"], "QUANTA_TOOL_OUTPUT_MAX"),
    toolOutputSpillKeep: parsePositiveInt(
      env["QUANTA_TOOL_OUTPUT_SPILL_KEEP"],
      "QUANTA_TOOL_OUTPUT_SPILL_KEEP",
    ),
    llmStreamFirstChunkMs: parsePositiveInt(
      env["QUANTA_LLM_STREAM_FIRST_CHUNK_MS"],
      "QUANTA_LLM_STREAM_FIRST_CHUNK_MS",
    ),
    llmStreamIdleMs: parsePositiveInt(
      env["QUANTA_LLM_STREAM_IDLE_MS"],
      "QUANTA_LLM_STREAM_IDLE_MS",
    ),
    quantaHome: stringOrUndef(env["QUANTA_HOME"]),
    benchHome: stringOrUndef(env["QUANTA_BENCH_HOME"]),
    cachePathspecsExtra: parseStringList(env["QUANTA_BENCH_CACHE_PATHSPECS_EXTRA"]),
    dedupEnvPrefixesExtra: parseStringList(env["QUANTA_DEDUP_ENV_PREFIXES_EXTRA"]),
    permissionStateFile: stringOrUndef(env["QUANTA_PERMISSION_STATE"]),
    profilesDir: stringOrUndef(env["QUANTA_PROFILES_DIR"]),
    sshConnection: stringOrUndef(env["SSH_CONNECTION"]),
    swebenchCacheLevel: parseSwebenchCacheLevel(env["QUANTA_SWEBENCH_CACHE_LEVEL"]),
    swebenchClean: parseBool(env["QUANTA_SWEBENCH_CLEAN"]),
    swebenchMaxWorkers: parsePositiveInt(
      env["QUANTA_SWEBENCH_MAX_WORKERS"],
      "QUANTA_SWEBENCH_MAX_WORKERS",
    ),
    swebenchNamespace: stringOrUndef(env["QUANTA_SWEBENCH_NAMESPACE"]),
    swebenchForceRebuild: parseBool(env["QUANTA_SWEBENCH_FORCE_REBUILD"]),
    swebenchPythonBin: stringOrUndef(env["QUANTA_SWEBENCH_PYTHON_BIN"]),
    benchTimeoutMs: parsePositiveInt(env["QUANTA_BENCH_TIMEOUT_MS"], "QUANTA_BENCH_TIMEOUT_MS"),
    maxTurnsBatch: parsePositiveInt(env["QUANTA_MAX_TURNS"], "QUANTA_MAX_TURNS"),
    swebenchPrepareForce: parseBool(env["QUANTA_SWEBENCH_PREPARE_FORCE"]),
    runId: stringOrUndef(env["QUANTA_RUN_ID"]),
    prefsHome: stringOrUndef(env["QUANTA_PREFS_HOME"]),
    lastTokens: stringOrUndef(env["QUANTA_LAST_TOKENS"]),
    sessionListFormat: parseSessionListFormat(env["QUANTA_SESSION_LIST_FORMAT"]),
    sessionListMax: parsePositiveInt(env["QUANTA_SESSION_LIST_MAX"], "QUANTA_SESSION_LIST_MAX"),
    hookTimeoutMs: parsePositiveInt(env["QUANTA_HOOK_TIMEOUT_MS"], "QUANTA_HOOK_TIMEOUT_MS"),
    hookMaxHandlers: parsePositiveInt(env["QUANTA_HOOK_MAX_HANDLERS"], "QUANTA_HOOK_MAX_HANDLERS"),
    hookMaxPayloadBytes: parsePositiveInt(
      env["QUANTA_HOOK_MAX_PAYLOAD_BYTES"],
      "QUANTA_HOOK_MAX_PAYLOAD_BYTES",
    ),
    asyncTools: parseBool(env["QUANTA_ASYNC_TOOLS"]),
    deferredCap: parsePositiveInt(env["QUANTA_DEFERRED_CAP"], "QUANTA_DEFERRED_CAP"),
    // H16 — strict `=== "1"` opt-in (matches the slice gate; default-OFF).
    // OFF ⇒ no CrossSessionDreamTrigger constructed, byte-identical.
    autoDream: gateOn(env, "QUANTA_AUTO_DREAM"),
    autoDreamSessions: parsePositiveInt(
      env["QUANTA_AUTO_DREAM_SESSIONS"],
      "QUANTA_AUTO_DREAM_SESSIONS",
    ),
    autoDreamHours: parsePositiveNumber(env["QUANTA_AUTO_DREAM_HOURS"], "QUANTA_AUTO_DREAM_HOURS"),
    // Log rate-limit is a DoS guard; disabling it requires the unambiguous `=off`.
    logRateLimitDisabled: gateDisabledStrict(env, "QUANTA_LOG_RATE_LIMIT"),
    // H7 — rotating cloud credentials. All default-UNSET ⇒ no helper, no
    // pre-call refresh, byte-identical provider paths.
    apiKeyHelper: stringOrUndef(env["QUANTA_API_KEY_HELPER"]),
    apiKeyHelperTtlMs: parsePositiveInt(
      env["QUANTA_API_KEY_HELPER_TTL_MS"],
      "QUANTA_API_KEY_HELPER_TTL_MS",
    ),
    awsAuthRefresh: stringOrUndef(env["QUANTA_AWS_AUTH_REFRESH"]),
    gcpAuthRefresh: stringOrUndef(env["QUANTA_GCP_AUTH_REFRESH"]),
    // H7 / ADR-0139 — explicit main-agent cloud-transport selector. Absent ⇒
    // the surface uses the registry env precedence ladder; the legacy vendor
    // path stays byte-identical when neither this nor a cloud env signal is set.
    llmTransport: stringOrUndef(env["QUANTA_LLM_TRANSPORT"]),
    // H7 — explicit fail-closed trust attestation for the credential-helper
    // shell. Strict `=== "1"`: only an explicit opt-in authorizes arbitrary
    // command execution; unset / anything else ⇒ untrusted (no shell). Strict
    // (`gateOnStrict`) — a dangerous gate authorizing arbitrary command exec must
    // NOT honor loose spellings (`on`/`true`/`yes`); only the literal `1` opts in.
    // Pinned by `dangerous-gate-strict-ratchet-hellgate`.
    llmCredentialTrusted: gateOnStrict(env, "QUANTA_LLM_CREDENTIAL_TRUSTED"),
    // Prompt-cache 1h TTL — only the literal "1h" opts in; any other value
    // (incl. absent) ⇒ "5m" (byte-identical fixed-5m cache_control). The
    // factory additionally gates "1h" behind a model allowlist.
    cacheTtl: env["QUANTA_PROMPT_CACHE_TTL"] === "1h" ? "1h" : "5m",
    // OAuth revoke-on-logout — strict `=== "1"` opt-in. Default false ⇒ logout
    // only clears local state (byte-identical, no network revoke call).
    oauthRevokeOnLogout: gateOn(env, "QUANTA_OAUTH_REVOKE_ON_LOGOUT"),
    // jun-6 (ADR-0481) — DEFAULT-ON (the only default-true knob). Toggles only
    // whether `.ipynb` TEXTUAL outputs are appended; cell-source render + base64
    // stripping are unconditional. NO effect on non-`.ipynb` reads (extension
    // gate). Off only when explicitly set to 0/false/off.
    ipynbIncludeOutputs: parseBoolDefaultTrue(env["QUANTA_IPYNB_OUTPUTS"]),
    // jun-6 BYOK — strict `=== "1"` opt-in. Default false ⇒ the legacy LLM-build
    // seam passes `source: undefined` (byte-identical key resolution).
    apiKeyHelperLegacyVendor: gateOn(env, "QUANTA_API_KEY_HELPER_LEGACY_VENDOR"),
    // jun-6 AI session title — boolean knob vocabulary (1/true/on). Default false
    // ⇒ no autoTitlePort built, loop branch dead (byte-identical). Both this and
    // sessionTitleModel must be present for the feature to arm.
    sessionAutoTitle: parseBool(env["QUANTA_SESSION_AUTO_TITLE"]),
    sessionTitleModel: stringOrUndef(env["QUANTA_SESSION_TITLE_MODEL"]),
    // jun-6 tool-interrupt — strict `=== "1"` opt-in. Default false ⇒ dispatch
    // threads the raw signal, no criticalSection (block behaves like cancel).
    toolInterruptBlock: gateOn(env, "QUANTA_TOOL_INTERRUPT_BLOCK"),
    // jun-6 — watchdog cap (ms). Absent / invalid ⇒ DEFAULT_CRITICAL_SECTION_MAX_MS.
    criticalSectionMaxMs:
      parsePositiveInt(env["QUANTA_CRITICAL_SECTION_MAX_MS"], "QUANTA_CRITICAL_SECTION_MAX_MS") ??
      DEFAULT_CRITICAL_SECTION_MAX_MS,
    // jun-6 permission_request hook — strict `=== "1"` opt-in kill-switch.
    // Default false ⇒ the gate does NOT emit permission_request (byte-identical;
    // falls through to the policy stack). Extra guard atop HookBus presence.
    permissionHook: gateOn(env, "QUANTA_PERMISSION_HOOK"),
    // jun-6 exfil-rail (b) — strict `=== "1"` opt-in. Default false ⇒ no glob
    // check threaded onto ToolContext (write/edit accept a glob path as a
    // literal filename, byte-identical).
    globWriteGuard: gateOnStrict(env, "QUANTA_GLOB_WRITE_GUARD"),
    // jun-6 exfil-rail (a) — strict `=== "1"` opt-in. Default false ⇒ no budget
    // port wired (byte-identical). Also requires a configured cap below.
    writeBudget: gateOn(env, "QUANTA_WRITE_BUDGET"),
    // jun-6 exfil-rail (a) — the CONFIGURABLE cap N (positive integer). No
    // hardcoded default (no-heuristics rule): absent/invalid ⇒ undefined ⇒ the
    // budget stays inert even when QUANTA_WRITE_BUDGET=1.
    writeBudgetMax: parsePositiveInt(env["QUANTA_WRITE_BUDGET_MAX"], "QUANTA_WRITE_BUDGET_MAX"),
    // jun-6 exfil-rail (c) — strict `=== "1"` opt-in. Default false ⇒ detector
    // never called + scouting taxonomy line omitted (byte-identical). Requires
    // a configured K below to fire.
    exfilScouting: gateOnStrict(env, "QUANTA_EXFIL_SCOUTING"),
    // jun-6 exfil-rail (c) — the CONFIGURABLE threshold K (positive integer). No
    // hardcoded default (no-heuristics rule): absent/invalid ⇒ undefined ⇒ the
    // detector stays inert even when QUANTA_EXFIL_SCOUTING=1.
    exfilScoutingK: parsePositiveInt(env["QUANTA_EXFIL_SCOUTING_K"], "QUANTA_EXFIL_SCOUTING_K"),
    // jun-6 exfil-rail (B) — egress mode token (`deny`|`redact`). Any other
    // value ⇒ undefined (OFF) ⇒ host-only egress decision (byte-identical).
    secretEgress:
      env["QUANTA_SECRET_EGRESS"] === "deny" || env["QUANTA_SECRET_EGRESS"] === "redact"
        ? env["QUANTA_SECRET_EGRESS"]
        : undefined,
    // jun-6 exfil-rail (B) — buffered-body byte cap (positive integer). No
    // hardcoded default (no-heuristics rule): absent/invalid ⇒ undefined ⇒ the
    // wire treats secret-egress as inert until an operator sets the cap.
    secretEgressMaxBody: parsePositiveInt(
      env["QUANTA_SECRET_EGRESS_MAX_BODY"],
      "QUANTA_SECRET_EGRESS_MAX_BODY",
    ),
    // jun-7 TLS-MITM — OPERATOR-OPT-IN (stronger gate). Requires BOTH the master
    // switch `=1` AND the verbatim ack phrase, so a stray `=1` cannot mint a
    // trust anchor. Either missing ⇒ false ⇒ CONNECT stays a raw tunnel
    // (byte-identical). See `mitm-gate.ts`.
    tlsMitm: tlsMitmAuthorized(env),
    // jun-7 TLS-MITM — fail-closed policy. `opaque-tunnel` only on the exact
    // token; everything else (incl. unset) ⇒ `deny` (fail closed by default).
    tlsMitmOnFailure:
      env["QUANTA_TLS_MITM_ON_FAILURE"] === "opaque-tunnel" ? "opaque-tunnel" : "deny",
    // syntax-aware-chunking (RFC jun-6) — strict `=== "1"` opt-in. Default
    // false ⇒ indexer uses the line-window chunkFile (byte-identical), parser
    // never constructed, no WASM.
    syntaxChunk: gateOn(env, "QUANTA_SYNTAX_CHUNK"),
    // read-outline (RFC jun-6) — strict `=== "1"` opt-in. Default false ⇒
    // `read outline:true` returns the line-range fallback, parser never built.
    readOutline: gateOn(env, "QUANTA_READ_OUTLINE"),
    // Grammar-wasm dir override. Absent ⇒ resolve tree-sitter-wasms/out.
    treeSitterDir: stringOrUndef(env["QUANTA_TREE_SITTER_DIR"]),
    // jun-7-misc 02 — strict `=== "1"` opt-in. SECURITY-relevant (LOOSENS
    // manifest validation by accepting a coerced foreign/codex shape on ingest),
    // so it stays strict — a loose truthy spelling must NOT arm it. Default false
    // ⇒ non-quanta manifests are rejected exactly as today (byte-identical).
    manifestCompat: gateOnStrict(env, "QUANTA_MANIFEST_COMPAT"),
    // jun-7-misc 03 — strict `=== "1"` opt-in. Default false ⇒ no guardian
    // assessor constructed, no per-action LLM risk pass, tool dispatch
    // byte-identical. The assessor (when wired) is advisory-only — never grants.
    guardianAssessor: gateOnStrict(env, "QUANTA_GUARDIAN_ASSESSOR"),
    // jun-7-misc 04 — strict `=== "1"` opt-in. Default false ⇒ `evaluateAuto`
    // flows the exact current CLASSIFIER_SYSTEM_PROMPT unchanged (byte-identical).
    autoModeRules: gateOnStrict(env, "QUANTA_AUTO_MODE_RULES"),
    // jun-7-misc 04 — strict `=== "1"` opt-in. Default false ⇒ no
    // CircumventionTracker constructed, zero signatures recorded, the auto-mode
    // gate is byte-identical. Advisory-only signal when ON (never an auto-deny).
    circumventDetect: gateOnStrict(env, "QUANTA_CIRCUMVENT_DETECT"),
    fsOwnershipEnforce: gateOnStrict(env, "QUANTA_FS_OWNERSHIP_ENFORCE"),
    // jun-7-misc 05 — strict `=== "1"` opt-in. SECURITY: reading a repo-local
    // config is RCE-adjacent, so a deliberate `=1` is required. Default false ⇒
    // no repo-local config discovered/read/merged (byte-identical startup). The
    // disk loader's structural wiring lands LATER (config lane); only the gate
    // field lives here.
    centralConfig: gateOnStrict(env, "QUANTA_CENTRAL_CONFIG"),
    // jun-7-misc 06 — strict `=== "1"` opt-in. DISTINCT from QUANTA_FAST_APPLY
    // (the existing V4A re-emit rung gated in agent/optional-ports.ts). Default
    // false ⇒ no FastApplyPort (merge) constructed, ctx.fastApplyMerge undefined,
    // the edit ladder is the byte-identical exact→fuzzy→V4A re-emit with ZERO
    // apply-model dispatches. Requires BOTH this gate AND a configured model below.
    fastApplyMerge: gateOnStrict(env, "QUANTA_FAST_APPLY_MERGE"),
    // jun-7-misc 06 — operator-chosen apply-model id (mirrors QUANTA_COMPACT_MODEL).
    // Absent ⇒ no port built even when fastApplyMerge is on (both required —
    // advertise-iff-able). NO default model (no-heuristics rule: measure vs the
    // re-emit baseline; never default to the main agent model).
    fastApplyModel: stringOrUndef(env["QUANTA_FAST_APPLY_MODEL"]),
    // jun-7-misc 01 — OPTIONAL max-offered MCP protocol version override. Absent
    // ⇒ undefined ⇒ negotiation offers the code-side SSOT max (src/mcp);
    // negotiation is otherwise always-on/backward-compatible (NO gate). When set,
    // pins the MAX version offered. The raw string is carried as-is; the mcp lane
    // validates it against its SSOT version list.
    mcpProtocolMax: stringOrUndef(env["QUANTA_MCP_PROTOCOL_MAX"]),
    // jun-7-misc 05 — user-config-dir override for the @/config USER layer.
    // Absent ⇒ undefined ⇒ config lane defaults to ~/.quanta. No effect unless
    // centralConfig is on (loader never invoked otherwise) ⇒ byte-identical.
    centralConfigDir: stringOrUndef(env["QUANTA_CONFIG_DIR"]),
    // jun-7-misc 05 — `--setting-sources` analogue (subset of
    // managed,user,project,local). Absent ⇒ undefined ⇒ all layers. Carried
    // raw; the @/config lane parses/validates. No effect unless centralConfig.
    centralConfigSources: stringOrUndef(env["QUANTA_SETTING_SOURCES"]),
    // jun-7-misc 05 — static trusted-path allow-list for headless/CI (§9 Q3).
    // Absent ⇒ undefined ⇒ NO static trust (headless ⇒ untrusted, the safe
    // default). EXPLICIT CI opt-in; never auto-trusts cwd. No effect unless
    // centralConfig is on.
    trustedPaths: stringOrUndef(env["QUANTA_TRUSTED_PATHS"]),
  })
}

let cached: RuntimeConfig | undefined
let cachedVersion = -1

/** Read the runtime config. `process.env` is read once + cached; but LIVE
 *  session overrides (`/knobs set`, the `@/shared/knob-overrides` store) are
 *  merged ON TOP and the cache is keyed on {@link knobOverridesVersion}, so a
 *  set takes effect on the next read (ADR-0503 P4 live-control). With NO
 *  overrides the merged bag === `process.env` → byte-identical to the legacy
 *  frozen behavior. Raw ad-hoc `process.env` mutation mid-run is still ignored
 *  (intentional) — only the override store is a live channel. */
export const runtimeConfig = (): RuntimeConfig => {
  const version = knobOverridesVersion()
  if (cached === undefined || cachedVersion !== version) {
    cached =
      knobOverrideCount() === 0
        ? loadFromEnv(process.env)
        : loadFromEnv({ ...process.env, ...knobOverrides() })
    cachedVersion = version
  }
  return cached
}

/** Test-only: reset the cache so a test can drive a different env snapshot.
 *  Production code MUST NOT call this — the scanner forbids it outside tests. */
export const __resetRuntimeConfig = (): void => {
  cached = undefined
}
