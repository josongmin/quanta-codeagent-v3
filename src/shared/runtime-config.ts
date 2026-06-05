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
 */

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

const parseBool = (raw: string | undefined): boolean => {
  if (raw === undefined) return false
  return raw === "1" || raw.toLowerCase() === "true" || raw.toLowerCase() === "on"
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
   *  When ON, the spawning agent (the leader) runs a `brokerLoop`
   *  (`@/subagent/coordination`) that reads pending escalation `request`s from
   *  the subagent mailbox, runs each through the host's permission decide/HITL,
   *  and sends a leader-authored `response` back. The worker applies ONLY a
   *  leader-authored response matching its outstanding correlationId — it can
   *  NEVER self-grant (load-bearing security invariant, plan §5). */
  readonly teamBroker: boolean
  /** Capability C — team-idle barrier (`QUANTA_TEAM_IDLE`). Strict opt-in
   *  (`=== "1"`). Default false ⇒ the leader polls / no fan-in barrier (today).
   *  When ON, each subagent emits an idle beacon at turn-end and the leader
   *  awaits `teamIdle` (`@/subagent/coordination`) — every member idle — before
   *  fanning in (next phase / handoff / shutdown). Pure predicate + injected
   *  clock; absent ⇒ no beacons, byte-identical. */
  readonly teamIdle: boolean
  /** C1 — Canvas / artifact persistence store (`QUANTA_ARTIFACT_STORE`). Strict
   *  opt-in (`=== "1"`). Default false ⇒ no registry, the artifact tools are NOT
   *  registered (byte-identical). When ON, the composition root mints ONE
   *  per-session `@/artifact` registry and passes it to
   *  `DefaultToolPorts.artifactRegistry` (the generation tools register their
   *  outputs; the model lists/inspects/destroys via `artifact_*`). */
  readonly artifactStore: boolean
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
}

const stringOrUndef = (raw: string | undefined): string | undefined =>
  typeof raw === "string" && raw.length > 0 ? raw : undefined

const loadFromEnv = (env: NodeJS.ProcessEnv): RuntimeConfig => {
  return Object.freeze({
    logLevel: parseLogLevel(env["QUANTA_LOG_LEVEL"]),
    compactTokens: parsePositiveInt(env["QUANTA_COMPACT_TOKENS"], "QUANTA_COMPACT_TOKENS"),
    // ADR-0473 — strict `=== "1"` opt-in (matches the `bgCompactionEnabled`
    // slice gate; `parseBool` also accepts true/on but the slice gate is the
    // SSOT, so keep it strict here too).
    bgCompaction: env["QUANTA_BG_COMPACTION"] === "1",
    // ADR-0471 — strict `=== "1"` opt-in (matches the `untrustedEnvelopeEnabled`
    // slice gate, which is the SSOT). Default false ⇒ dispatch wraps nothing.
    untrustedEnvelope: env["QUANTA_UNTRUSTED_ENVELOPE"] === "1",
    // ADR-0472 — strict `=== "1"` opt-in (matches the `editRepairLoopEnabled`
    // slice gate, the SSOT). Default false ⇒ no lint-delta attached.
    editRepairLoop: env["QUANTA_EDIT_REPAIR_LOOP"] === "1",
    // ADR-0476 — strict `=== "1"` opt-in (matches the `skillMcpDepsEnabled`
    // slice gate). Default false ⇒ no deps lifted, no auto-attach.
    skillMcpDeps: env["QUANTA_SKILL_MCP_DEPS"] === "1",
    // ADR-0470 B1 follow-up — strict `=== "1"` opt-in. SEAM (validated, not yet
    // composed at the root): no production code reads this field, so it is a
    // no-op today (byte-identical ON or OFF). Default false ⇒ MCP `sampling` is
    // NOT advertised and the headless rejecter declines (`no-handler`). Intended
    // end state: the composition root wires a handler (and advertises) only when
    // this is on AND an LLM + consent prompter are present.
    mcpSampling: env["QUANTA_MCP_SAMPLING"] === "1",
    // H19 — strict `=== "1"` opt-in. Default false ⇒ MCP `roots` is NOT
    // advertised and inbound `roots/list` answers an empty list (byte-identical).
    // The composition root advertises + wires the RootsProviderPort together
    // only when this is on AND a workspace roots source is available.
    mcpRoots: env["QUANTA_MCP_ROOTS"] === "1",
    // H18 — strict `=== "1"` opt-in. Default false ⇒ no OAuth provider is wired,
    // the McpClient falls back to the headless rejecter (no token), every MCP
    // load is byte-identical (no discovery, no flow, no Authorization header).
    mcpOAuth: env["QUANTA_MCP_OAUTH"] === "1",
    // H9 — strict `=== "1"` opt-in. Default false ⇒ the read tool renders full
    // content on every call and allocates no per-range dedup state.
    readDedup: env["QUANTA_READ_DEDUP"] === "1",
    // H6 — strict `=== "1"` opt-in. Default false ⇒ the bash post-exec hook
    // classifies nothing and touches no sink (byte-identical).
    passiveVcs: env["QUANTA_PASSIVE_VCS"] === "1",
    // H14a — strict `=== "1"` opt-in. Default false ⇒ no image_gen port wired,
    // tool not registered (byte-identical default menu).
    imageGen: env["QUANTA_IMAGE_GEN"] === "1",
    // H14b — strict `=== "1"` opt-in. Default false ⇒ no office authoring tools.
    officeAuthoring: env["QUANTA_OFFICE_AUTHORING"] === "1",
    // H15 — strict `=== "1"` opt-in. Default false ⇒ responses-wire byte-identical
    // (encrypted reasoning dropped, no include, no re-emit). OpenAI-Responses only.
    reasoningCarryover: env["QUANTA_REASONING_CARRYOVER"] === "1",
    // H17 — idle goal-continuation + budget enforcement. Strict `=== "1"` opt-in;
    // default false ⇒ objective stays informational-only (byte-identical).
    goalContinuationEnforce: env["QUANTA_GOAL_ENFORCE"] === "1",
    // H13 — strict `=== "1"` opt-in. Default false ⇒ no config-migration detect,
    // no prompt, no ledger (byte-identical startup).
    migrateConfig: env["QUANTA_MIGRATE_CONFIG"] === "1",
    // H17 — strict `=== "1"` opt-in. Default false ⇒ objective budget stays
    // informational (status never flips, idle-continuation byte-identical).
    objectiveBudgetEnforce: env["QUANTA_OBJECTIVE_BUDGET_ENFORCE"] === "1",
    // Capability A — strict `=== "1"` opt-in. Default false ⇒ batch fan-out is
    // the existing flat parallel pool (byte-identical, no DAG ordering).
    teamDag: env["QUANTA_TEAM_DAG"] === "1",
    // Capability B — strict `=== "1"` opt-in. Default false ⇒ a denied worker
    // tool stays a hard failure (no escalation broker, byte-identical).
    teamBroker: env["QUANTA_TEAM_BROKER"] === "1",
    // Capability C — strict `=== "1"` opt-in. Default false ⇒ no idle beacons /
    // no fan-in barrier (the leader polls, byte-identical).
    teamIdle: env["QUANTA_TEAM_IDLE"] === "1",
    // C1 — strict `=== "1"` opt-in. Default false ⇒ no artifact registry / tools
    // (byte-identical).
    artifactStore: env["QUANTA_ARTIFACT_STORE"] === "1",
    fsJailDisabled: parseBool(env["QUANTA_FS_JAIL"] === "off" ? "1" : undefined),
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
    autoDream: env["QUANTA_AUTO_DREAM"] === "1",
    autoDreamSessions: parsePositiveInt(
      env["QUANTA_AUTO_DREAM_SESSIONS"],
      "QUANTA_AUTO_DREAM_SESSIONS",
    ),
    autoDreamHours: parsePositiveNumber(env["QUANTA_AUTO_DREAM_HOURS"], "QUANTA_AUTO_DREAM_HOURS"),
    logRateLimitDisabled: env["QUANTA_LOG_RATE_LIMIT"] === "off",
    // H7 — rotating cloud credentials. All default-UNSET ⇒ no helper, no
    // pre-call refresh, byte-identical provider paths.
    apiKeyHelper: stringOrUndef(env["QUANTA_API_KEY_HELPER"]),
    apiKeyHelperTtlMs: parsePositiveInt(
      env["QUANTA_API_KEY_HELPER_TTL_MS"],
      "QUANTA_API_KEY_HELPER_TTL_MS",
    ),
    awsAuthRefresh: stringOrUndef(env["QUANTA_AWS_AUTH_REFRESH"]),
    gcpAuthRefresh: stringOrUndef(env["QUANTA_GCP_AUTH_REFRESH"]),
  })
}

let cached: RuntimeConfig | undefined

/** Read the frozen runtime config. First call evaluates + freezes; subsequent
 *  calls return the cached value. Env changes during a run have NO effect on
 *  the returned object — intentional, so a test/harness that mutates env mid-
 *  run can't desync feature behavior. */
export const runtimeConfig = (): RuntimeConfig => {
  if (cached === undefined) cached = loadFromEnv(process.env)
  return cached
}

/** Test-only: reset the cache so a test can drive a different env snapshot.
 *  Production code MUST NOT call this — the scanner forbids it outside tests. */
export const __resetRuntimeConfig = (): void => {
  cached = undefined
}
