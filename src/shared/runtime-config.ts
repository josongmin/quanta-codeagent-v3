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
import { knobOverrideCount, knobOverridesVersion, sessionSafeKnobOverrides } from "./knob-overrides"
import {
  DEFAULT_CRITICAL_SECTION_MAX_MS,
  parseBashAutoBackground,
  parseBool,
  parseBoolDefaultTrue,
  parseLogLevel,
  parseNonNegativeInt,
  parsePositiveInt,
  parsePositiveNumber,
  parsePtyBackend,
  parseSessionListFormat,
  parseStatusLineConfig,
  parseStringList,
  parseSwebenchCacheLevel,
  ratelimitNoticeWanted,
  stringOrUndef,
} from "./runtime-config/parsers"
import type { RuntimeConfig } from "./runtime-config/types"

/** Shared parser input for process and injected composition-root env views. */
export type RuntimeConfigEnv = Readonly<Record<string, string | undefined>>

// Re-export the COMPLETE original public surface so every importer of
// `@/shared/runtime-config` (and the `@/shared` barrel) stays byte-compatible
// after the god-module split. The value vocabulary + parsers live in
// `./runtime-config/parsers`; the typed surface lives in `./runtime-config/types`.
export {
  BASH_AUTO_BACKGROUND_MODES,
  type BashAutoBackgroundMode,
  DEFAULT_CRITICAL_SECTION_MAX_MS,
  LOG_LEVELS,
  type LogLevel,
  type PtyBackend,
  parseBool,
  ratelimitNoticeWanted,
  type StatusLineConfig,
  SWEBENCH_CACHE_LEVELS,
  type SwebenchCacheLevel,
} from "./runtime-config/parsers"
export type { RuntimeConfig } from "./runtime-config/types"

/** Thin composer. Spreads the per-domain slices (declared below) in their
 *  ORIGINAL field-declaration order and freezes once — byte-identical to the
 *  legacy single object literal (same keys, defaults, coercion, insertion order).
 *  Each slice is a `const` arrow initialized during module eval, so it is defined
 *  before the first `runtimeConfigFromEnv` call (which only happens later, from
 *  `runtimeConfig()`). Kept ABOVE the slices so the runtime-config-knobs parity
 *  gate — which scans the source between `runtimeConfigFromEnv` and `let cached`
 *  — still sees every `env.QUANTA_*` read (they now live in the slices). */
export const runtimeConfigFromEnv = (env: RuntimeConfigEnv): RuntimeConfig => {
  return Object.freeze({
    ...parseCompactionSlice(env),
    ...parseCapabilitySlice(env),
    ...parseToolSurfaceSlice(env),
    ...parseSessionBenchSlice(env),
    ...parseSecuritySlice(env),
    ...parseConfigTailSlice(env),
  }) as RuntimeConfig
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-domain env sub-parsers. Each is a PURE function that reads only from `env`
// and returns its contiguous slice of the config as a `Partial<RuntimeConfig>`.
// The composer (`runtimeConfigFromEnv`) spreads them in the SAME order the fields were
// originally declared, so the assembled object is BYTE-IDENTICAL to the legacy
// single object literal (same keys, same defaults, same coercion, same insertion
// order) — this is a mechanical size split of a god-function, not a behavior
// change. The single `Object.freeze` is applied once, at the end, in the composer.
// ─────────────────────────────────────────────────────────────────────────────

/** Compaction, micro-compaction, and the dispatch/edit/skill/MCP capability
 *  gates (the leading run of the legacy literal, up to `mcpSampling`). */
const parseCompactionSlice = (env: RuntimeConfigEnv): Partial<RuntimeConfig> => {
  return {
    logLevel: parseLogLevel(env.QUANTA_LOG_LEVEL),
    compactTokens: parsePositiveInt(env.QUANTA_COMPACT_TOKENS, "QUANTA_COMPACT_TOKENS"),
    // ADR-0473 — strict `=== "1"` opt-in (matches the `bgCompactionEnabled`
    // slice gate; `parseBool` also accepts true/on but the slice gate is the
    // SSOT, so keep it strict here too).
    bgCompaction: gateOnStrict(env, "QUANTA_BG_COMPACTION"),
    // RFC-01 A7 — context-headroom advisory: strict `=== "1"` opt-in. Owned here
    // so the @/agent compaction wire reads a resolved boolean (never process.env).
    contextHeadroomAdvisory: gateOnStrict(env, "QUANTA_CONTEXT_HEADROOM_ADVISORY"),
    // ADR-0296 auto-background — default bash `timeout_behavior` + detach
    // deadline. Default `background` (ships ON, Claude-Code-style): a command
    // past its deadline DETACHES into the bg-registry instead of being killed.
    // Completion before the deadline is byte-identical; opt out per-session with
    // `QUANTA_BASH_AUTO_BACKGROUND=kill` or per-call.
    bashAutoBackground: parseBashAutoBackground(env.QUANTA_BASH_AUTO_BACKGROUND),
    bashAutoBackgroundThresholdMs: parsePositiveInt(
      env.QUANTA_BASH_AUTO_BACKGROUND_THRESHOLD_MS,
      "QUANTA_BASH_AUTO_BACKGROUND_THRESHOLD_MS",
    ),
    // RFC jun-6-microcompaction — opt-in (gateOn vocab `1`/`on`/`true`/`yes`;
    // #24 doc-fix — resolver is `gateOn`, NOT strict the `gateOn` truthy vocab (#24)). Default false ⇒ the
    // tier-1 eviction pre-pass is never constructed (byte-identical). The
    // keep/floor/interval tunables are positive ints (no magic literals); absent
    // ⇒ the wire applies its own named defaults.
    microcompact: gateOn(env, "QUANTA_MICROCOMPACT"),
    microcompactKeepRecent: parsePositiveInt(
      env.QUANTA_MICROCOMPACT_KEEP_RECENT,
      "QUANTA_MICROCOMPACT_KEEP_RECENT",
    ),
    microcompactFloorTokens: parsePositiveInt(
      env.QUANTA_MICROCOMPACT_FLOOR_TOKENS,
      "QUANTA_MICROCOMPACT_FLOOR_TOKENS",
    ),
    microcompactIntervalMs: parsePositiveInt(
      env.QUANTA_MICROCOMPACT_INTERVAL_MS,
      "QUANTA_MICROCOMPACT_INTERVAL_MS",
    ),
    // ADR-0471 — strict `=== "1"` opt-in (matches the `untrustedEnvelopeEnabled`
    // slice gate, which is the SSOT). Default false ⇒ dispatch wraps nothing.
    untrustedEnvelope: gateOnStrict(env, "QUANTA_UNTRUSTED_ENVELOPE"),
    // RFC02-3 (A8) — strict `=== "1"` opt-in. Default false ⇒ the host bootstrap
    // attaches NO route sink (no forwarder, no `model_route_changed` event) so a
    // real FallbackLLM swap is byte-identical to today.
    modelRerouteEvent: gateOnStrict(env, "QUANTA_MODEL_REROUTE_EVENT"),
    // ADR-0472 — strict `=== "1"` opt-in (matches the `editRepairLoopEnabled`
    // slice gate, the SSOT). Default false ⇒ no lint-delta attached.
    editRepairLoop: gateOnStrict(env, "QUANTA_EDIT_REPAIR_LOOP"),
    // ADR-0476 — strict `=== "1"` opt-in (matches the `skillMcpDepsEnabled`
    // slice gate). Default false ⇒ no deps lifted, no auto-attach.
    skillMcpDeps: gateOnStrict(env, "QUANTA_SKILL_MCP_DEPS"),
    // ADR-0470 B1 follow-up — opt-in (gateOn vocab `1`/`on`/`true`/`yes`; #24
    // doc-fix — resolver is `gateOn`, NOT strict the `gateOn` truthy vocab (#24)). SEAM (validated, not yet
    // composed at the root): no production code reads this field, so it is a
    // no-op today (byte-identical ON or OFF). Default false ⇒ MCP `sampling` is
    // NOT advertised and the headless rejecter declines (`no-handler`). Intended
    // end state: the composition root wires a handler (and advertises) only when
    // this is on AND an LLM + consent prompter are present.
    mcpSampling: gateOn(env, "QUANTA_MCP_SAMPLING"),
  }
}

/** Token-accounting, MCP roots/oauth, read/vcs/lang tool gates, and the
 *  capability/team/artifact/code-mode cluster. */
const parseCapabilitySlice = (env: RuntimeConfigEnv): Partial<RuntimeConfig> => {
  return {
    // delta-token-accounting (RFC jun-6) — strict `=== "1"` opt-in. Default
    // false ⇒ the loop never constructs the counter and calls `estimateTokens`
    // directly at every site (byte-identical). ON guards CONSTRUCTION/perf only;
    // the counter's numbers are byte-identical to a full re-scan by §4.1.
    deltaTokenCount: gateOnStrict(env, "QUANTA_DELTA_TOKEN_COUNT"),
    // H19 — opt-in (`gateOn` vocab; #24). Default false ⇒ MCP `roots` is NOT
    // advertised and inbound `roots/list` answers an empty list (byte-identical).
    // The composition root advertises + wires the RootsProviderPort together
    // only when this is on AND a workspace roots source is available.
    mcpRoots: gateOn(env, "QUANTA_MCP_ROOTS"),
    // H18 — opt-in (`gateOn` vocab; #24). Default false ⇒ no OAuth provider is wired,
    // the McpClient falls back to the headless rejecter (no token), every MCP
    // load is byte-identical (no discovery, no flow, no Authorization header).
    mcpOAuth: gateOn(env, "QUANTA_MCP_OAUTH"),
    // H9 — opt-in (`gateOn` vocab; #24). Default false ⇒ the read tool renders full
    // content on every call and allocates no per-range dedup state.
    readDedup: gateOn(env, "QUANTA_READ_DEDUP"),
    // H6 — opt-in (`gateOn` vocab; #24). Default false ⇒ the bash post-exec hook
    // classifies nothing and touches no sink (byte-identical).
    passiveVcs: gateOn(env, "QUANTA_PASSIVE_VCS"),
    // N1 — strict opt-in. Default false ⇒ no language notice (byte-identical).
    langDetect: gateOn(env, "QUANTA_LANG_DETECT"),
    // H14a — opt-in (`gateOn` vocab; #24). Default false ⇒ no image_gen port wired,
    // tool not registered (byte-identical default menu).
    imageGen: gateOn(env, "QUANTA_IMAGE_GEN"),
    // H14b — opt-in (`gateOn` vocab; #24). Default false ⇒ no office authoring tools.
    officeAuthoring: gateOn(env, "QUANTA_OFFICE_AUTHORING"),
    // W6 — strict opt-in. Default false ⇒ no notebook_edit tool (byte-identical).
    notebookEdit: gateOn(env, "QUANTA_NOTEBOOK_EDIT"),
    debugTools: gateOn(env, "QUANTA_DEBUG_TOOLS"),
    // ADR-0249 — strict opt-in. Default false ⇒ no node_repl tool (byte-identical).
    nodeRepl: gateOn(env, "QUANTA_NODE_REPL"),
    testRunner: gateOn(env, "QUANTA_TEST_RUNNER"),
    evidence: gateOn(env, "QUANTA_EVIDENCE"),
    // H15 — opt-in (`gateOn` vocab; #24). Default false ⇒ responses-wire byte-identical
    // (encrypted reasoning dropped, no include, no re-emit). OpenAI-Responses only.
    reasoningCarryover: gateOn(env, "QUANTA_REASONING_CARRYOVER"),
    // ADR-0512 — skill tool-scoping v2 (availability filter + escalation ask).
    // Default false ⇒ ADR-0011 dispatch-deny behavior (byte-identical).
    skillScopeV2: gateOn(env, "QUANTA_SKILL_SCOPE_V2"),
    // H17 — idle goal-continuation + budget enforcement. Strict the `gateOn` truthy vocab (#24) opt-in;
    // default false ⇒ objective stays informational-only (byte-identical).
    goalContinuationEnforce: gateOn(env, "QUANTA_GOAL_ENFORCE"),
    // H13 — opt-in (`gateOn` vocab; #24). Default false ⇒ no config-migration detect,
    // no prompt, no ledger (byte-identical startup).
    migrateConfig: gateOn(env, "QUANTA_MIGRATE_CONFIG"),
    // H17 — opt-in (`gateOn` vocab; #24). Default false ⇒ objective budget stays
    // informational (status never flips, idle-continuation byte-identical).
    objectiveBudgetEnforce: gateOn(env, "QUANTA_OBJECTIVE_BUDGET_ENFORCE"),
    // Capability A — opt-in (`gateOn` vocab; #24). Default false ⇒ batch fan-out is
    // the existing flat parallel pool (byte-identical, no DAG ordering).
    teamDag: gateOn(env, "QUANTA_TEAM_DAG"),
    // Capability B — opt-in (`gateOn` vocab; #24). Default false ⇒ a denied worker
    // tool stays a hard failure (no escalation broker, byte-identical).
    teamBroker: gateOn(env, "QUANTA_TEAM_BROKER"),
    // Capability C — opt-in (`gateOn` vocab; #24). Default false ⇒ no idle beacons /
    // no fan-in barrier (the leader polls, byte-identical).
    teamIdle: gateOn(env, "QUANTA_TEAM_IDLE"),
    // Peer teammate messaging (RFC jun-6) — opt-in (`gateOn` vocab; #24). Default
    // false ⇒ no peerInbox drain (turn loop byte-identical), no TeamScopedMailbox
    // decorator (raw global mailbox), no team registry / team_* tools. Builds ON
    // the existing QUANTA_TEAM_* peer mailbox + wake-idle.
    teamPeerMsg: gateOn(env, "QUANTA_TEAM_PEER_MSG"),
    // RFC11-1 — subagent observability projection. Opt-in (`gateOn` vocab; #24).
    // Default false ⇒ no stream tap, nothing projected onto the result
    // (byte-identical result / TaskRecord JSON).
    subagentObs: gateOn(env, "QUANTA_SUBAGENT_OBS"),
    // C1 — opt-in (`gateOn` vocab; #24). Default false ⇒ no artifact registry / tools
    // (byte-identical).
    artifactStore: gateOn(env, "QUANTA_ARTIFACT_STORE"),
    // RFC12-1 — plan DAG visualization. Opt-in (`gateOn` vocab; #24). Default false
    // ⇒ `current_plan view:"graph"` is ignored (byte-identical text render) and the
    // web PlanPanel renders no graph toggle (flat list only). Reuses the existing
    // mermaid renderer + RFC07-3 edges — no new protocol kind / store.
    planGraph: gateOn(env, "QUANTA_PLAN_GRAPH"),
    // ADR-0503 P3 — capability-layer master gate. STRICT `=== "1"` opt-in (arming
    // a cross-cutting layer is deliberate). Default false ⇒ resolveExposure is
    // unused, each surface keeps its legacy gate (byte-identical degrade).
    capabilityLayer: gateOnStrict(env, "QUANTA_CAPABILITY_LAYER"),
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
      env.QUANTA_CODE_MODE_MEM_BYTES,
      "QUANTA_CODE_MODE_MEM_BYTES",
    ),
    codeModeTimeoutMs: parsePositiveInt(
      env.QUANTA_CODE_MODE_TIMEOUT_MS,
      "QUANTA_CODE_MODE_TIMEOUT_MS",
    ),
    codeModeMaxCalls: parsePositiveInt(
      env.QUANTA_CODE_MODE_MAX_CALLS,
      "QUANTA_CODE_MODE_MAX_CALLS",
    ),
    codeModeOutputCap: parsePositiveInt(
      env.QUANTA_CODE_MODE_OUTPUT_CAP,
      "QUANTA_CODE_MODE_OUTPUT_CAP",
    ),
  }
}

/** File-history, remember-patterns, paste/skill-creator, deny-reason/hunk,
 *  sandbox-escalation, rate-limit, PTY, subagent/appshot, MCP connectors/
 *  resources/annotations, mid-turn capture, and the prompt-directive bundle. */
const parseToolSurfaceSlice = (env: RuntimeConfigEnv): Partial<RuntimeConfig> => {
  return {
    // file_history_rewind — opt-in (`gateOn` vocab; #24). Default false ⇒ no per-file
    // history store, no capture sink, no file_history_rewind tool (byte-identical).
    fileHistory: gateOn(env, "QUANTA_FILE_HISTORY"),
    // CLUSTER D #5 — opt-in (`gateOn` vocab; #24). Default false ⇒ no PatternGrantStore
    // constructed, no permission_propose_pattern tool (byte-identical).
    rememberPatterns: gateOn(env, "QUANTA_REMEMBER_PATTERNS"),
    // CLUSTER D #5 residual — strict `=== "1"` opt-in. Default false ⇒ a
    // dangerous self-proposal is always rejected (reviewer-routed), byte-identical.
    // ON ⇒ the propose port is wired with `allowDangerous: true` (lifts ONLY the
    // dangerous-gate; the no-widen gate still rejects an uncovered proposal).
    rememberPatternsDangerous: gateOnStrict(env, "QUANTA_REMEMBER_PATTERNS_DANGEROUS"),
    // jun-6 paste-burst — positive-integer min-char threshold. Absent / invalid
    // ⇒ undefined ⇒ the CLI reader echoes a paste inline (byte-identical).
    pasteBurstMinChars: parsePositiveInt(env.QUANTA_PASTE_BURST, "QUANTA_PASTE_BURST"),
    // jun-6 skill-creator — opt-in (`gateOn` vocab; #24). Default false ⇒ no writer
    // port, `skill_create` not registered (byte-identical default tool surface).
    skillCreator: gateOn(env, "QUANTA_SKILL_CREATOR"),
    // ADR-0252 skill template-literal — opt-in (`gateOn` vocab; #24). Default false
    // ⇒ the `Skill` body is never scanned for `{{ name }}` (a literal `{{ x }}`
    // emits verbatim, byte-identical). ON ⇒ `createDefaultTemplateExpander` resolves
    // `{{ name }}` against the caller's `key=value` args tokens; unknown var ⇒ typed
    // short-circuit surfaced to the model (no guess).
    skillTemplateVars: gateOn(env, "QUANTA_SKILL_TEMPLATE_VARS"),
    // C6 — opt-in (`gateOn` vocab; #24). Default false ⇒ no structured deny reason
    // attached / no content prefix / DecisionEvent unchanged (byte-identical).
    surfaceDenyReason: gateOn(env, "QUANTA_DENY_REASON"),
    // T05 — opt-in (`gateOn` vocab; #24). Default false ⇒ no [h]unk verb in the
    // confirm prompt, no partial apply; whole-call approve/deny only (byte-
    // identical). See `@/runner/hunk-apply` for the apply executor.
    hunkApproval: gateOn(env, "QUANTA_HUNK_APPROVAL"),
    // RFC06-4 (B5) — opt-in (`gateOn` vocab; #24). Default false ⇒ per-hunk
    // apply does NOT persist a durable mutation receipt / CAS undo journal
    // (the apply itself is byte-identical; no receipt is written, undo is
    // unavailable). ON ⇒ each per-hunk apply is wrapped by
    // `@/runner/hunk-mutation-journal` so the mutation is undoable via a
    // content-verified CAS journal. Independent of `hunkApproval` (that gates
    // the [h]unk verb; this gates the receipt/undo durability).
    hunkMutationReceipt: gateOn(env, "QUANTA_HUNK_MUTATION_RECEIPT"),
    // RFC-def restore surface — opt-in (`gateOn` vocab; #24). Default false ⇒
    // `/undo` unregistered + no durable journal store (byte-identical). See
    // `hunkUndo` in `runtime-config/types.ts` for the ON behaviour.
    hunkUndo: gateOn(env, "QUANTA_HUNK_UNDO"),
    // sandbox-escalation (RFC jun-6) — opt-in (`gateOn` vocab; #24). Default false ⇒
    // classifySandboxDenial is never consulted, no denialReason is ever set, no
    // escalation prompt, no post-denial record (a sandboxed nonzero exit is
    // byte-identical to a plain failure). Default-ON flip is OUT OF SCOPE.
    sandboxEscalation: gateOn(env, "QUANTA_SANDBOX_ESCALATION"),
    sandboxEscalationMax: parsePositiveInt(
      env.QUANTA_SANDBOX_ESCALATION_MAX,
      "QUANTA_SANDBOX_ESCALATION_MAX",
    ),
    // account-ratelimit — opt-in (`gateOn` vocab; #24). Default false ⇒ adapters
    // capture no ratelimit headers and the loop inserts no pre-request delay
    // (byte-identical).
    proactiveRateLimit: gateOn(env, "QUANTA_RATELIMIT_PROACTIVE"),
    ratelimitNotice: ratelimitNoticeWanted(env.QUANTA_RATELIMIT_NOTICE),
    // N6 PTY backend selector. Default "tmux" ⇒ byte-identical to pre-slice path.
    ptyBackend: parsePtyBackend(env.QUANTA_PTY_BACKEND),
    // H18/keyring — opt-in (`gateOn` vocab; #24). Default false ⇒ MCP OAuth uses the
    // plain 0600 file token store (byte-identical, no keyring wrap).
    mcpOAuthKeyring: gateOn(env, "QUANTA_MCP_OAUTH_KEYRING"),
    // ADR-0159 Phase 2 work-resume (GROUP B1) — opt-in (gateOn vocab
    // `1`/`on`/`true`/`yes`; #24). Default false ⇒ interrupted handles are
    // left as-is in the store (normalizeBgStatus maps them to "failed" on
    // poll/list but the store is untouched — byte-identical). When ON,
    // `buildSharedExecutionPlaneRuntimeAugments` sweeps interrupted handles
    // and re-forks them via the persistent scheduler before returning.
    subagentResume: gateOn(env, "QUANTA_SUBAGENT_RESUME"),
    // ADR-0487 — opt-in (gateOn vocab `1`/`on`/`true`/`yes`; #24 doc-fix). Default
    // false ⇒ scheduler built without
    // admissionQueue (throw-at-cap) and no 4th tool (byte-identical).
    subagentQueue: gateOn(env, "QUANTA_SUBAGENT_QUEUE"),
    // ADR-0487 — opt-in (gateOn vocab `1`/`on`/`true`/`yes`; #24 doc-fix). Default
    // false ⇒ subagentBgTools mints no
    // subagent_force_background tool (byte-identical).
    forceBackground: gateOn(env, "QUANTA_FORCE_BACKGROUND"),
    // G1 — opt-in (gateOn vocab `1`/`on`/`true`/`yes`; #24 doc-fix). Default false
    // ⇒ no DefaultToolPorts.appshot
    // slot, appshot_verify not registered (byte-identical default menu).
    appshot: gateOn(env, "QUANTA_APPSHOT"),
    // N1 — opt-in (gateOn vocab `1`/`on`/`true`/`yes`; #24 doc-fix). Default false ⇒ no side-agent daemons/tools.
    sideAgent: gateOn(env, "QUANTA_SIDE_AGENT"),
    // §4.4 — opt-in. Default false ⇒ agent_type is the legacy free string.
    subagentTypedKind: gateOn(env, "QUANTA_SUBAGENT_TYPED_KIND"),
    // C5059-05 — opt-in single-agent-first delegation suppression. Default false
    // ⇒ byte-identical prompt (fan-out-biased). Measurement arm before default-ON.
    subagentDelegateSuppress: gateOn(env, "QUANTA_SUBAGENT_DELEGATE_SUPPRESS"),
    // RFC jul-13 §4.2/§6.5 A (rev.4) — MAX DESCENDANT DEPTH a spawn may create.
    // NUMERIC POLICY (not a bool gate): default 1 = root-only (rev.4 canonical,
    // RFC line 273 "현재 default 1 유지" — the user's leaf intent). This is THE
    // authoritative OPERATOR ceiling; the per-config `subagent.maxDepth` is a
    // tightening-only override (`effectiveCap = min(policy, requested)`). The two
    // derived predicates (`canExposeSpawnTools`/`canAdmitChildDepth`,
    // @/agent/spawn-depth) read THIS as the policy: `1` = root-only, `0` = total
    // KILL-SWITCH (parsed with `parseNonNegativeInt` so `0` is a valid value — no
    // agent, incl. root, gets spawn tools). Unset / negative / non-integer ⇒
    // `undefined` ⇒ default 1. (Renamed from `maxSpawnDepth`/`QUANTA_MAX_SPAWN_DEPTH`,
    // off-by-one fixed: the cap names the max descendant depth, not the max depth
    // that receives tools.)
    maxDescendantDepth:
      parseNonNegativeInt(env.QUANTA_MAX_DESCENDANT_DEPTH, "QUANTA_MAX_DESCENDANT_DEPTH") ?? 1,
    // §4.3 — opt-in OS-process side-agent daemon V1. Default false ⇒ in-process.
    sideAgentProcess: gateOn(env, "QUANTA_SIDE_AGENT_PROCESS"),
    // N2 — opt-in (gateOn vocab `1`/`on`/`true`/`yes`; #24 doc-fix). Default false ⇒ no MCP connector tools.
    mcpConnectors: gateOn(env, "QUANTA_MCP_CONNECTORS"),
    // N3 — opt-in (gateOn vocab `1`/`on`/`true`/`yes`; #24 doc-fix). Default false ⇒ no MCP resource/prompt tools.
    mcpResources: gateOn(env, "QUANTA_MCP_RESOURCES"),
    // §19.1 — opt-in honoring of server-declared tool annotations. SSOT with the
    // `mcp-tool-annotations` KNOB (Finding 2): both channels share the standard
    // boolean vocabulary (`1`/`true`/`on`) via `parseBool`, so `=on`/`=true`
    // activate the LIVE bridge identically to `=1` (the knob registry/telemetry
    // no longer disagree with the consumer). Unset ⇒ false (annotationsHonored
    // stays false; every MCP tool keeps its conservative read/concurrency
    // classification, byte-identical default).
    mcpToolAnnotations: parseBool(env.QUANTA_MCP_TOOL_ANNOTATIONS),
    progressUpdate: gateOn(env, "QUANTA_PROGRESS_UPDATE"),
    // #8 — opt-in (gateOn vocab `1`/`on`/`true`/`yes`; #24 doc-fix). Default false ⇒ no mid-turn capture facade.
    midTurnCapture: gateOn(env, "QUANTA_MIDTURN_CAPTURE"),
    midTurnVisible: gateOn(env, "QUANTA_MIDTURN_VISIBLE"),
    managedSettingsPath: env.QUANTA_MANAGED_SETTINGS_PATH,
    ptyAttach: gateOn(env, "QUANTA_PTY_ATTACH"),
    // D3 — PTY env-inherit escape hatch. Default false ⇒ scrubbed (secure).
    // Truthy (`1`/`true`/`on`) ⇒ full parent-env inherit (interactive opt-out).
    ptyInheritEnv: parseBool(env.QUANTA_PTY_INHERIT_ENV),
    // C3 — brief-mode SEED. Uses the standard boolean knob vocabulary (1/true/on)
    // so it reads like the `effort` env seed; default-OFF ⇒ byte-identical.
    brief: parseBool(env.QUANTA_BRIEF),
    // §5 prompt-directive bundle — CANONICAL opt-in (gateOn: full truthy vocab
    // 1/on/true/yes) per the gate-vocab unification; directives are behavior
    // toggles, NOT security gates (the SSOT carve-out in session-knobs keeps only
    // code-mode/bg-compaction/etc. strict-`1`). Each default false ⇒
    // `selectActiveDirectives` emits nothing ⇒ byte-identical.
    directiveAutonomous: gateOn(env, "QUANTA_DIRECTIVE_AUTONOMOUS"),
    directiveReadComplete: gateOn(env, "QUANTA_DIRECTIVE_READ_COMPLETE"),
    directiveProgress: gateOn(env, "QUANTA_DIRECTIVE_PROGRESS"),
    directiveMemoryVerify: gateOn(env, "QUANTA_DIRECTIVE_MEMORY_VERIFY"),
    directiveThinkFreq: gateOn(env, "QUANTA_DIRECTIVE_THINK_FREQ"),
    directiveAntiPlatitude: gateOn(env, "QUANTA_DIRECTIVE_ANTI_PLATITUDE"),
    directiveParallelTools: gateOn(env, "QUANTA_DIRECTIVE_PARALLEL_TOOLS"),
    // Advisor timing-rail directive (RFC jun-6 §5.2) — canonical opt-in (gateOn).
    directiveAdvisorRail: gateOn(env, "QUANTA_ADVISOR_RAIL"),
    // adaptive-thinking — opt-in (`gateOn` vocab; #24). Default false ⇒ the producer
    // emits manual `{type:"enabled",budget_tokens}` for every model (byte-identical).
    adaptiveThinking: gateOn(env, "QUANTA_ADAPTIVE_THINKING"),
    // RFC jun-6 §5.1 — advisor full-history forward (opt-in (`gateOn` vocab; #24)).
    advisorForwardHistory: gateOn(env, "QUANTA_ADVISOR_FORWARD_HISTORY"),
  }
}

/** FS-jail / cap-enforce, session + transcript, tool-output caps, LLM stream
 *  timings, bench/swebench dirs + knobs, hooks, deferred/async, auto-dream. */
const parseSessionBenchSlice = (env: RuntimeConfigEnv): Partial<RuntimeConfig> => {
  return {
    // SECURITY protection (filesystem jail) — tearing it down requires the
    // deliberate, unambiguous `=off`; a loose `=0` must NOT silently drop the jail.
    fsJailDisabled: gateDisabledStrict(env, "QUANTA_FS_JAIL"),
    capEnforce: parseBool(env.QUANTA_CAP_ENFORCE),
    gitSha: stringOrUndef(env.QUANTA_GIT_SHA),
    pricingVersion: stringOrUndef(env.QUANTA_PRICING_VERSION),
    sessionsDir: stringOrUndef(env.QUANTA_SESSIONS_DIR),
    sessionTranscriptMaxBytes: parsePositiveInt(
      env.QUANTA_SESSION_TRANSCRIPT_MAX_BYTES,
      "QUANTA_SESSION_TRANSCRIPT_MAX_BYTES",
    ),
    hitlOverridesPath: stringOrUndef(env.QUANTA_HITL_OVERRIDES),
    toolOutputMaxChars: parsePositiveInt(env.QUANTA_TOOL_OUTPUT_MAX, "QUANTA_TOOL_OUTPUT_MAX"),
    toolOutputSpillKeep: parsePositiveInt(
      env.QUANTA_TOOL_OUTPUT_SPILL_KEEP,
      "QUANTA_TOOL_OUTPUT_SPILL_KEEP",
    ),
    llmStreamFirstChunkMs: parsePositiveInt(
      env.QUANTA_LLM_STREAM_FIRST_CHUNK_MS,
      "QUANTA_LLM_STREAM_FIRST_CHUNK_MS",
    ),
    llmStreamIdleMs: parsePositiveInt(env.QUANTA_LLM_STREAM_IDLE_MS, "QUANTA_LLM_STREAM_IDLE_MS"),
    llmEmptyStreamBreakerK: parsePositiveInt(
      env.QUANTA_LLM_EMPTY_STREAM_BREAKER_K,
      "QUANTA_LLM_EMPTY_STREAM_BREAKER_K",
    ),
    llmStreamTraceMs: parseNonNegativeInt(
      env.QUANTA_LLM_STREAM_TRACE_MS,
      "QUANTA_LLM_STREAM_TRACE_MS",
    ),
    quantaHome: stringOrUndef(env.QUANTA_HOME),
    benchHome: stringOrUndef(env.QUANTA_BENCH_HOME),
    benchResultsDir: stringOrUndef(env.QUANTA_BENCH_RESULTS_DIR),
    // Daemon/persistence path knobs (ADR-0503 P4 read-routing) — string-or-undef
    // (no fixed default); the consumers keep their exact HOME-based fallback +
    // non-empty guards, so absent ⇒ byte-identical to the prior raw process.env reads.
    webDbDir: stringOrUndef(env.QUANTA_WEB_DB_DIR),
    sessionRegistrySqlitePath: stringOrUndef(env.QUANTA_SESSION_REGISTRY_SQLITE_PATH),
    sessionRegistryDiskDir: stringOrUndef(env.QUANTA_SESSION_REGISTRY_DISK_DIR),
    cachePathspecsExtra: parseStringList(env.QUANTA_BENCH_CACHE_PATHSPECS_EXTRA),
    dedupEnvPrefixesExtra: parseStringList(env.QUANTA_DEDUP_ENV_PREFIXES_EXTRA),
    permissionStateFile: stringOrUndef(env.QUANTA_PERMISSION_STATE),
    profilesDir: stringOrUndef(env.QUANTA_PROFILES_DIR),
    sshConnection: stringOrUndef(env.SSH_CONNECTION),
    swebenchCacheLevel: parseSwebenchCacheLevel(env.QUANTA_SWEBENCH_CACHE_LEVEL),
    swebenchClean: parseBool(env.QUANTA_SWEBENCH_CLEAN),
    swebenchMaxWorkers: parsePositiveInt(
      env.QUANTA_SWEBENCH_MAX_WORKERS,
      "QUANTA_SWEBENCH_MAX_WORKERS",
    ),
    swebenchNamespace: stringOrUndef(env.QUANTA_SWEBENCH_NAMESPACE),
    swebenchRepoCacheDir: stringOrUndef(env.QUANTA_SWEBENCH_REPO_CACHE),
    swebenchForceRebuild: parseBool(env.QUANTA_SWEBENCH_FORCE_REBUILD),
    swebenchPythonBin: stringOrUndef(env.QUANTA_SWEBENCH_PYTHON_BIN),
    benchTimeoutMs: parsePositiveInt(env.QUANTA_BENCH_TIMEOUT_MS, "QUANTA_BENCH_TIMEOUT_MS"),
    maxTurnsBatch: parsePositiveInt(env.QUANTA_MAX_TURNS, "QUANTA_MAX_TURNS"),
    lspReadyTimeoutMs: parsePositiveInt(
      env.QUANTA_LSP_READY_TIMEOUT_MS,
      "QUANTA_LSP_READY_TIMEOUT_MS",
    ),
    fullRemoteRelaunch:
      parsePositiveInt(
        env.QUANTA_BENCH_FULL_REMOTE_RELAUNCH,
        "QUANTA_BENCH_FULL_REMOTE_RELAUNCH",
      ) ?? 1,
    swebenchPrepareForce: parseBool(env.QUANTA_SWEBENCH_PREPARE_FORCE),
    runId: stringOrUndef(env.QUANTA_RUN_ID),
    prefsHome: stringOrUndef(env.QUANTA_PREFS_HOME),
    lastTokens: stringOrUndef(env.QUANTA_LAST_TOKENS),
    sessionListFormat: parseSessionListFormat(env.QUANTA_SESSION_LIST_FORMAT),
    sessionListMax: parsePositiveInt(env.QUANTA_SESSION_LIST_MAX, "QUANTA_SESSION_LIST_MAX"),
    hookTimeoutMs: parsePositiveInt(env.QUANTA_HOOK_TIMEOUT_MS, "QUANTA_HOOK_TIMEOUT_MS"),
    hookMaxHandlers: parsePositiveInt(env.QUANTA_HOOK_MAX_HANDLERS, "QUANTA_HOOK_MAX_HANDLERS"),
    hookMaxPayloadBytes: parsePositiveInt(
      env.QUANTA_HOOK_MAX_PAYLOAD_BYTES,
      "QUANTA_HOOK_MAX_PAYLOAD_BYTES",
    ),
    asyncTools: parseBool(env.QUANTA_ASYNC_TOOLS),
    deferredCap: parsePositiveInt(env.QUANTA_DEFERRED_CAP, "QUANTA_DEFERRED_CAP"),
    // H16 — opt-in (`gateOn` vocab; #24) (matches the slice gate; default-OFF).
    // OFF ⇒ no CrossSessionDreamTrigger constructed, byte-identical.
    autoDream: gateOn(env, "QUANTA_AUTO_DREAM"),
    autoDreamSessions: parsePositiveInt(
      env.QUANTA_AUTO_DREAM_SESSIONS,
      "QUANTA_AUTO_DREAM_SESSIONS",
    ),
    autoDreamHours: parsePositiveNumber(env.QUANTA_AUTO_DREAM_HOURS, "QUANTA_AUTO_DREAM_HOURS"),
  }
}

/** Log-rate-limit, cloud credential helpers + transport, prompt-cache TTL,
 *  oauth-revoke, ipynb outputs, BYOK, session auto-title, tool-interrupt +
 *  critical-section, permission hook, and the exfil-rail (glob/budget/scouting/
 *  secret-egress). */
const parseSecuritySlice = (env: RuntimeConfigEnv): Partial<RuntimeConfig> => {
  return {
    // Log rate-limit is a DoS guard; disabling it requires the unambiguous `=off`.
    logRateLimitDisabled: gateDisabledStrict(env, "QUANTA_LOG_RATE_LIMIT"),
    // H7 — rotating cloud credentials. All default-UNSET ⇒ no helper, no
    // pre-call refresh, byte-identical provider paths.
    apiKeyHelper: stringOrUndef(env.QUANTA_API_KEY_HELPER),
    apiKeyHelperTtlMs: parsePositiveInt(
      env.QUANTA_API_KEY_HELPER_TTL_MS,
      "QUANTA_API_KEY_HELPER_TTL_MS",
    ),
    awsAuthRefresh: stringOrUndef(env.QUANTA_AWS_AUTH_REFRESH),
    gcpAuthRefresh: stringOrUndef(env.QUANTA_GCP_AUTH_REFRESH),
    // H7 / ADR-0139 — explicit main-agent cloud-transport selector. Absent ⇒
    // the surface uses the registry env precedence ladder; the legacy vendor
    // path stays byte-identical when neither this nor a cloud env signal is set.
    llmTransport: stringOrUndef(env.QUANTA_LLM_TRANSPORT),
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
    cacheTtl: env.QUANTA_PROMPT_CACHE_TTL === "1h" ? "1h" : "5m",
    // OAuth revoke-on-logout — opt-in (`gateOn` vocab; #24). Default false ⇒ logout
    // only clears local state (byte-identical, no network revoke call).
    oauthRevokeOnLogout: gateOn(env, "QUANTA_OAUTH_REVOKE_ON_LOGOUT"),
    // jun-6 (ADR-0481) — DEFAULT-ON (the only default-true knob). Toggles only
    // whether `.ipynb` TEXTUAL outputs are appended; cell-source render + base64
    // stripping are unconditional. NO effect on non-`.ipynb` reads (extension
    // gate). Off only when explicitly set to 0/false/off.
    ipynbIncludeOutputs: parseBoolDefaultTrue(env.QUANTA_IPYNB_OUTPUTS),
    // jun-6 BYOK — opt-in (`gateOn` vocab; #24). Default false ⇒ the legacy LLM-build
    // seam passes `source: undefined` (byte-identical key resolution).
    apiKeyHelperLegacyVendor: gateOn(env, "QUANTA_API_KEY_HELPER_LEGACY_VENDOR"),
    // jun-6 AI session title — boolean knob vocabulary (1/true/on). Default false
    // ⇒ no autoTitlePort built, loop branch dead (byte-identical). Both this and
    // sessionTitleModel must be present for the feature to arm.
    sessionAutoTitle: parseBool(env.QUANTA_SESSION_AUTO_TITLE),
    sessionTitleModel: stringOrUndef(env.QUANTA_SESSION_TITLE_MODEL),
    // jun-6 tool-interrupt — opt-in (`gateOn` vocab; #24). Default false ⇒ dispatch
    // threads the raw signal, no criticalSection (block behaves like cancel).
    toolInterruptBlock: gateOn(env, "QUANTA_TOOL_INTERRUPT_BLOCK"),
    // jun-6 — watchdog cap (ms). Absent / invalid ⇒ DEFAULT_CRITICAL_SECTION_MAX_MS.
    criticalSectionMaxMs:
      parsePositiveInt(env.QUANTA_CRITICAL_SECTION_MAX_MS, "QUANTA_CRITICAL_SECTION_MAX_MS") ??
      DEFAULT_CRITICAL_SECTION_MAX_MS,
    // jun-6 permission_request hook — opt-in (`gateOn` vocab; #24) kill-switch.
    // Default false ⇒ the gate does NOT emit permission_request (byte-identical;
    // falls through to the policy stack). Extra guard atop HookBus presence.
    permissionHook: gateOn(env, "QUANTA_PERMISSION_HOOK"),
    // jun-6 exfil-rail (b) — strict `=== "1"` opt-in. Default false ⇒ no glob
    // check threaded onto ToolContext (write/edit accept a glob path as a
    // literal filename, byte-identical).
    globWriteGuard: gateOnStrict(env, "QUANTA_GLOB_WRITE_GUARD"),
    // jun-6 exfil-rail (a) — opt-in (`gateOn` vocab; #24). Default false ⇒ no budget
    // port wired (byte-identical). Also requires a configured cap below.
    writeBudget: gateOn(env, "QUANTA_WRITE_BUDGET"),
    // jun-6 exfil-rail (a) — the CONFIGURABLE cap N (positive integer). No
    // hardcoded default (no-heuristics rule): absent/invalid ⇒ undefined ⇒ the
    // budget stays inert even when QUANTA_WRITE_BUDGET=1.
    writeBudgetMax: parsePositiveInt(env.QUANTA_WRITE_BUDGET_MAX, "QUANTA_WRITE_BUDGET_MAX"),
    // jun-6 exfil-rail (c) — strict `=== "1"` opt-in. Default false ⇒ detector
    // never called + scouting taxonomy line omitted (byte-identical). Requires
    // a configured K below to fire.
    exfilScouting: gateOnStrict(env, "QUANTA_EXFIL_SCOUTING"),
    // jun-6 exfil-rail (c) — the CONFIGURABLE threshold K (positive integer). No
    // hardcoded default (no-heuristics rule): absent/invalid ⇒ undefined ⇒ the
    // detector stays inert even when QUANTA_EXFIL_SCOUTING=1.
    exfilScoutingK: parsePositiveInt(env.QUANTA_EXFIL_SCOUTING_K, "QUANTA_EXFIL_SCOUTING_K"),
    // jun-6 exfil-rail (B) — egress mode token (`deny`|`redact`). Any other
    // value ⇒ undefined (OFF) ⇒ host-only egress decision (byte-identical).
    secretEgress:
      env.QUANTA_SECRET_EGRESS === "deny" || env.QUANTA_SECRET_EGRESS === "redact"
        ? env.QUANTA_SECRET_EGRESS
        : undefined,
    // jun-6 exfil-rail (B) — buffered-body byte cap (positive integer). No
    // hardcoded default (no-heuristics rule): absent/invalid ⇒ undefined ⇒ the
    // wire treats secret-egress as inert until an operator sets the cap.
    secretEgressMaxBody: parsePositiveInt(
      env.QUANTA_SECRET_EGRESS_MAX_BODY,
      "QUANTA_SECRET_EGRESS_MAX_BODY",
    ),
  }
}

/** TLS-MITM, syntax-chunk / read-outline / tree-sitter, manifest-compat,
 *  guardian/auto-review/approval-ladder, auto-mode/circumvent, fs-ownership,
 *  central-config (dir/sources/trusted-paths), fast-apply, MCP protocol max,
 *  and the scriptable status-line config (the trailing run of the legacy literal). */
const parseConfigTailSlice = (env: RuntimeConfigEnv): Partial<RuntimeConfig> => {
  return {
    // RFC-01 A2 — post-turn durable rewind-checkpoint capture feeder. Default
    // false ⇒ no capture, /rewind --restore-files fail-closes safe (byte-identical).
    rewindCapture: gateOn(env, "QUANTA_REWIND_CAPTURE"),
    // jun-7 TLS-MITM — OPERATOR-OPT-IN (stronger gate). Requires BOTH the master
    // switch `=1` AND the verbatim ack phrase, so a stray `=1` cannot mint a
    // trust anchor. Either missing ⇒ false ⇒ CONNECT stays a raw tunnel
    // (byte-identical). See `mitm-gate.ts`.
    tlsMitm: tlsMitmAuthorized(env),
    // jun-7 TLS-MITM — fail-closed policy. `opaque-tunnel` only on the exact
    // token; everything else (incl. unset) ⇒ `deny` (fail closed by default).
    tlsMitmOnFailure: env.QUANTA_TLS_MITM_ON_FAILURE === "opaque-tunnel" ? "opaque-tunnel" : "deny",
    // syntax-aware-chunking (RFC jun-6) — opt-in (`gateOn` vocab; #24). Default
    // false ⇒ indexer uses the line-window chunkFile (byte-identical), parser
    // never constructed, no WASM.
    syntaxChunk: gateOn(env, "QUANTA_SYNTAX_CHUNK"),
    // read-outline (RFC jun-6) — opt-in (`gateOn` vocab; #24). Default false ⇒
    // `read outline:true` returns the line-range fallback, parser never built.
    readOutline: gateOn(env, "QUANTA_READ_OUTLINE"),
    // Grammar-wasm dir override. Absent ⇒ resolve tree-sitter-wasms/out.
    treeSitterDir: stringOrUndef(env.QUANTA_TREE_SITTER_DIR),
    // jun-7-misc 02 — strict `=== "1"` opt-in. SECURITY-relevant (LOOSENS
    // manifest validation by accepting a coerced foreign/codex shape on ingest),
    // so it stays strict — a loose truthy spelling must NOT arm it. Default false
    // ⇒ non-quanta manifests are rejected exactly as today (byte-identical).
    manifestCompat: gateOnStrict(env, "QUANTA_MANIFEST_COMPAT"),
    // jun-7-misc 03 — strict `=== "1"` opt-in. Default false ⇒ no guardian
    // assessor constructed, no per-action LLM risk pass, tool dispatch
    // byte-identical. The assessor (when wired) is advisory-only — never grants.
    guardianAssessor: gateOnStrict(env, "QUANTA_GUARDIAN_ASSESSOR"),
    // T03 — strict `=== "1"` opt-in. Auto-approval by an LLM side-agent must not
    // be armed by a loose-truthy spelling. Default false ⇒ no posture seeded ⇒
    // reviewer stays user ⇒ byte-identical.
    autoReview: gateOnStrict(env, "QUANTA_AUTO_REVIEW"),
    // T03 — named approval-ladder posture. Parsed/validated at the consumer
    // (`@/permission/approval-ladder#parseApprovalLadderName`); an unknown / empty
    // / `custom` value seeds NO posture (byte-identical).
    approvalLadder: env.QUANTA_APPROVAL_LADDER,
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
    // jun-26 edit-escalate (frontier-parity) — strict `=== "1"` opt-in. When ON,
    // the `edit` tool auto-escalates to the whitespace-tolerant fuzzy ladder on an
    // exact MISS even when the caller did NOT set `fuzzy:true` (Claude/Codex both
    // auto-retry whitespace-tolerant). Fail-closed ladder ⇒ never a wrong write.
    // Default false ⇒ ctx.autoEscalateFuzzy unset ⇒ fuzzy runs ONLY on explicit
    // `input.fuzzy` ⇒ BYTE-IDENTICAL legacy edit path. Reversible / measurable.
    editAutoFuzzy: gateOnStrict(env, "QUANTA_EDIT_AUTO_FUZZY"),
    // jul-13 edit-fresh-hash — DEFAULT-ON opt-out (off only for the literal `off`,
    // like the fs-jail / stale-read-guard kill-switches). A SUCCESSFUL edit/write/
    // scripted_replace appends the sha256 of the post-write bytes AND refreshes the
    // stale-read baseline so the model chains the next same-file edit without a
    // re-read (root-fixes the measured ~41% self-inflicted staleness). Not a
    // speculative lever — it removes a forced re-read (near-certain net-negative
    // tokens) and the mtime-baseline refresh is a correctness fix, so it ships ON.
    editFreshHash: !gateDisabledStrict(env, "QUANTA_EDIT_FRESH_HASH"),
    // jun-7-misc 06 — operator-chosen apply-model id (mirrors QUANTA_COMPACT_MODEL).
    // Absent ⇒ no port built even when fastApplyMerge is on (both required —
    // advertise-iff-able). NO default model (no-heuristics rule: measure vs the
    // re-emit baseline; never default to the main agent model).
    fastApplyModel: stringOrUndef(env.QUANTA_FAST_APPLY_MODEL),
    // jun-7-misc 01 — OPTIONAL max-offered MCP protocol version override. Absent
    // ⇒ undefined ⇒ negotiation offers the code-side SSOT max (src/mcp);
    // negotiation is otherwise always-on/backward-compatible (NO gate). When set,
    // pins the MAX version offered. The raw string is carried as-is; the mcp lane
    // validates it against its SSOT version list.
    mcpProtocolMax: stringOrUndef(env.QUANTA_MCP_PROTOCOL_MAX),
    // jun-7-misc 05 — user-config-dir override for the @/config USER layer.
    // Absent ⇒ undefined ⇒ config lane defaults to ~/.quanta. No effect unless
    // centralConfig is on (loader never invoked otherwise) ⇒ byte-identical.
    centralConfigDir: stringOrUndef(env.QUANTA_CONFIG_DIR),
    // jun-7-misc 05 — `--setting-sources` analogue (subset of
    // managed,user,project,local). Absent ⇒ undefined ⇒ all layers. Carried
    // raw; the @/config lane parses/validates. No effect unless centralConfig.
    centralConfigSources: stringOrUndef(env.QUANTA_SETTING_SOURCES),
    // jun-7-misc 05 — static trusted-path allow-list for headless/CI (§9 Q3).
    // Absent ⇒ undefined ⇒ NO static trust (headless ⇒ untrusted, the safe
    // default). EXPLICIT CI opt-in; never auto-trusts cwd. No effect unless
    // centralConfig is on.
    trustedPaths: stringOrUndef(env.QUANTA_TRUSTED_PATHS),
    // ticket-15 (§11.7) — DOUBLE-gated default-OFF scriptable statusLine config.
    // `undefined` unless QUANTA_STATUS_LINE is on AND QUANTA_STATUS_LINE_CONFIG
    // is a valid JSON object with a usable `command` (byte-identical otherwise —
    // the built-in segmented `/context` status render stays the sole render).
    statusLineConfig: parseStatusLineConfig(env.QUANTA_STATUS_LINE, env.QUANTA_STATUS_LINE_CONFIG),
  }
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
        ? runtimeConfigFromEnv(process.env)
        : runtimeConfigFromEnv({ ...process.env, ...sessionSafeKnobOverrides() })
    cachedVersion = version
  }
  return cached
}

/** Test-only: reset the cache so a test can drive a different env snapshot.
 *  Production code MUST NOT call this — the scanner forbids it outside tests. */
export const __resetRuntimeConfig = (): void => {
  cached = undefined
}
