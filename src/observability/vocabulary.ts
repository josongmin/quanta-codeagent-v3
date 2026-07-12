/**
 * Canonical OTel attribute vocabulary.
 *
 * Single source of truth for telemetry attribute keys across the codebase.
 * Two namespaces:
 *   - `quanta.*`  — product-specific keys (this codebase's domain model).
 *   - `gen_ai.*`  — provider-neutral OpenTelemetry GenAI semantic conventions
 *                   (https://opentelemetry.io/docs/specs/semconv/gen-ai/).
 *
 * Why a vocabulary module:
 *   - Eliminate typos / drift — TypeScript proves at compile time that an
 *     emitter only ever uses a canonical key.
 *   - Stable dashboards — once a key ships, renaming it requires touching
 *     this file, which surfaces every consumer in code review.
 *   - Aligns with Codex's 70+ canonical OTel keys without coupling to their
 *     wire format.
 *
 * This module is intentionally **standalone**: it does not import from any
 * other observability file and does not mutate global state. Emitters wire
 * it up via `attrs.ts`.
 *
 * Related: ADR-0010 (observability trajectory), ADR-0032 (this vocabulary).
 */

// ---------------------------------------------------------------------------
// Quanta-specific namespace (`quanta.*`)
// ---------------------------------------------------------------------------

export const QUANTA_ATTRS = {
  conversation: {
    id: "quanta.conversation.id",
    sessionId: "quanta.conversation.session_id",
    startedAt: "quanta.conversation.started_at",
  },
  thread: {
    id: "quanta.thread.id",
    parentId: "quanta.thread.parent_id",
    depth: "quanta.thread.depth",
    tokensUsed: "quanta.thread.tokens_used",
    archived: "quanta.thread.archived",
    /** True for a side-conversation thread (ADR-0049). Read-only sub-thread
     *  that runs separately from the main agent loop and is NEVER spliced
     *  back into the parent's message history. Paired with
     *  {@link kind} = `"side"`. */
    side: "quanta.thread.side",
    /** `"main" | "side" | "subagent"`. The non-`"main"` values are emitted
     *  by ADR-0041 (subagent) and ADR-0049 (side-conv). */
    kind: "quanta.thread.kind",
  },
  turn: {
    id: "quanta.turn.id",
    /** Non-steerable kind from ADR-0030 (e.g. agent-reflect, compaction). */
    kind: "quanta.turn.kind",
    durationMs: "quanta.turn.duration_ms",
    interrupted: "quanta.turn.interrupted",
    /** ADR-0030: whether the turn went through user steering. */
    steered: "quanta.turn.steered",
    rolledBack: "quanta.turn.rolled_back",
  },
  tool: {
    name: "quanta.tool.name",
    callId: "quanta.tool.call_id",
    durationMs: "quanta.tool.call.duration_ms",
    /** `"success" | "error" | "blocked"` (kept as `string` here — the literal
     * union is enforced by `toolAttrs()` in `attrs.ts`). */
    status: "quanta.tool.call.status",
    /** Truncated preview of the tool-call INPUT args (the bash command, the
     *  edited path + patch, the grep pattern …) — the "what event was sent"
     *  payload an operator sees when clicking a `handle_tool_call` span in the
     *  live trace UI. Bounded to a few hundred chars and ONLY built when a span
     *  sink is active, so the default-OFF loop stays allocation-free. */
    input: "quanta.tool.input",
    /** Truncated preview of the tool-call OUTPUT (result preview / error text).
     *  Same bounded + sink-gated discipline as {@link input}. */
    output: "quanta.tool.output",
  },
  mcp: {
    serverName: "quanta.mcp.server.name",
    /** `"stdio" | "http"`. */
    transport: "quanta.mcp.transport",
    elicitationRequired: "quanta.mcp.elicitation_required",
  },
  task: {
    id: "quanta.task.id",
    kind: "quanta.task.kind",
    status: "quanta.task.status",
  },
  multiAgent: {
    /** `"explorer" | "worker" | "none"`. */
    agentRole: "quanta.multi_agent.agent_role",
    parentTurnId: "quanta.multi_agent.parent_turn_id",
    /** CoT leak prevention flag (follow-up ADR, not in current slice). */
    cotLeakPrevented: "quanta.multi_agent.cot_leak_prevented",
  },
  memory: {
    phaseE2eMs: "quanta.memory.phase_e2e_ms",
    /** `"1" | "2"` — ADR-0008 phase identifier. */
    phase: "quanta.memory.phase",
    /** `"INIT" | "incremental"`. */
    consolidationMode: "quanta.memory.consolidation_mode",
    tokensUsed: "quanta.memory.tokens_used",
    // ADR-0068 — 2-Phase consolidator (Codex absorption). Distinct from
    // the legacy `phase_e2e_ms` (ADR-0008 SOTA hybrid recall) so dashboards
    // can split per-turn recall cost from per-thread/per-global distill.
    phase1: {
      e2eMs: "quanta.memory.phase1.e2e_ms",
      /** Turn count of the source session — drives MIN_TURN_THRESHOLD skip. */
      turns: "quanta.memory.phase1.turns",
      /** `"distilled" | "skipped"`. */
      outcome: "quanta.memory.phase1.outcome",
    },
    phase2: {
      e2eMs: "quanta.memory.phase2.e2e_ms",
      /** `"INIT" | "incremental"` — same enum as `consolidationMode` but
       *  scoped to phase2 spans to avoid attribute collision. */
      mode: "quanta.memory.phase2.mode",
      /** Stage1 entries consolidated this run. */
      stage1Count: "quanta.memory.phase2.stage1_count",
      tokensUsed: "quanta.memory.phase2.tokens_used",
      /** `.git` commit SHA produced by the writer; null when git disabled. */
      gitCommitSha: "quanta.memory.phase2.git_commit_sha",
      bytesMemory: "quanta.memory.phase2.bytes.memory",
      bytesRawMemories: "quanta.memory.phase2.bytes.raw_memories",
      bytesMemorySummary: "quanta.memory.phase2.bytes.memory_summary",
    },
  },
  permission: {
    /** ADR-0029 reviewer enum. */
    reviewerTier: "quanta.permission.reviewer_tier",
    /** ADR-0029 8-state final approval outcome. */
    outcome: "quanta.permission.outcome",
    /** `"low" | "medium" | "high"`. */
    riskLevel: "quanta.permission.risk_level",
    /** ADR-0046 stack axis that produced the verdict — one of
     *  `"read-only-bypass" | "post-denial-override" | "per-thread" | "per-host" |
     *  "global-default"`. Used to attribute a deny/allow to its source axis. */
    stackSource: "quanta.permission.stack.source",
    /** ADR-0046 stack verdict — `"allow" | "deny" | "ask"`. Set every time
     *  the gate consults the stack (independent of `outcome` which is the
     *  reviewer's final word). */
    stackVerdict: "quanta.permission.stack.verdict",
    /** ADR-0046 actionSignature (32-hex). Anchors a per-(thread, action)
     *  trace across the deny → seen-risk → override sequence. */
    actionSignature: "quanta.permission.action_signature",
    /** ADR-0046 thread-id resolved from `sessionId` at gate time. Distinct
     *  from `quanta.thread.id` (which is the conversation thread); the
     *  permission slice uses sessionId as its thread anchor. */
    threadId: "quanta.permission.thread_id",
    /** ADR-0046 host-id from `resolveHostId()` — `${user}@${host}` or
     *  `localhost`. */
    hostId: "quanta.permission.host_id",
    /** ADR-0046 post-denial state transition kind — `"denied" | "risk-seen" |
     *  "user-override"`. Emitted by the `post-denial` facade so a dashboard
     *  can render the 3-step funnel. */
    postDenialEvent: "quanta.permission.post_denial.event",
    /** Which decision layer produced the final verdict — coarser than
     *  `stackSource`, used by the vocabulary-migration dashboards to bucket
     *  decisions by owning subsystem (`"reviewer" | "stack" | "hitl" |
     *  "hook"`). */
    decidedBy: "quanta.permission.decided_by",
  },
  hitl: {
    /** ADR-0047: final tier the admissibility-gate resolved for a tool call.
     *  Literal union: `"hand-off-required" | "always-confirm" |
     *  "pre-approval-ok" | "none"`. Emitted on every dispatch that runs the
     *  HITL gate (i.e. `config.hitl.enabled === true`). */
    tierResolved: "quanta.hitl.tier_resolved",
    /** ADR-0047: `true` when the resolved tier was promoted by the
     *  annotation registry (built-in or operator override) above the
     *  upstream classifier's baseline. `false` when the baseline already
     *  matched. */
    registryEscalated: "quanta.hitl.registry_escalated",
    /** ADR-0047: short kebab-case tag describing why a handoff event
     *  fired (`"hard-deny:<rule-name>"`, `"registry:<tool>"`, or
     *  `"tier:hand-off-required"`). Only set on handoff emissions. */
    handoffEmitted: "quanta.hitl.handoff_emitted",
  },
  patch: {
    /** ADR-0028 V4A patch op: `"add" | "delete" | "update"`. */
    op: "quanta.patch.op",
    path: "quanta.patch.path",
    hunkCount: "quanta.patch.hunk_count",
    fuzzyMatched: "quanta.patch.fuzzy_matched",
    /** ADR-0028 V4A fuzzy-match confidence tier when a hunk applied without
     *  an exact context match — `"exact" | "whitespace" | "fuzzy"`. */
    fuzzyMatchTier: "quanta.patch.fuzzy_match_tier",
  },
  rules: {
    /** `"system" | "user" | "project"`. */
    layer: "quanta.rules.layer",
    /** `"allow" | "deny" | "ask"`. */
    action: "quanta.rules.action",
    matched: "quanta.rules.matched",
  },
  sqlite: {
    queryDurationMs: "quanta.sqlite.query.duration_ms",
    walCheckpointMode: "quanta.sqlite.wal_checkpoint.mode",
  },
  /** absorb #6 (v0.dev `workMetrics`): per-turn cost/work transparency —
   *  files touched, lines added/removed, agent actions, lines read, and the
   *  best-effort USD cost. Emitted per-turn (and folded per-session) once the
   *  loop wiring lands. */
  work: {
    filesChanged: "quanta.work.files_changed",
    linesAdded: "quanta.work.lines_added",
    linesRemoved: "quanta.work.lines_removed",
    actions: "quanta.work.actions",
    linesRead: "quanta.work.lines_read",
    costUsd: "quanta.work.cost_usd",
  },
  /** ADR-0217 — per-slice OTel emit. Six canonical keys shared across the
   *  four new leaf slices (error-routing, stream-timeout, shell-snapshot,
   *  git-directives). The slices themselves NEVER reference these literals
   *  directly — the observability adapter
   *  (`metrics/new-slice-instruments.ts`) is the only call site. */
  error: {
    /** counter, label: `kind` (16-arm `TypedErrorKind` from ADR-0203). */
    kind: "quanta.error.kind",
    /** counter, label: `action` (5-arm `RetryAction` from ADR-0203). */
    action: "quanta.error.action",
  },
  stream: {
    /** histogram — wall-clock ms the stream was idle before a timeout fired
     *  (ADR-0200). */
    idleMs: "quanta.stream.idle_ms",
    /** counter, label: `action` — `abort | degrade | prompt-user`
     *  (ADR-0200 `TimeoutAction`). */
    timeoutAction: "quanta.stream.timeout_action",
  },
  shell: {
    /** histogram — ms spent in `capture()` for one shell snapshot
     *  (ADR-0204). */
    snapshotDurationMs: "quanta.shell.snapshot_duration_ms",
    /** histogram — byte size of the persisted snapshot file (ADR-0204). */
    snapshotBytes: "quanta.shell.snapshot_bytes",
  },
  git: {
    /** counter, label: `kind` (5-arm `GitDirectiveKind` from ADR-0205). */
    directive: "quanta.git.directive",
  },
  /** ADR-0452 — session-startup prewarm (Codex `session_startup_prewarm`
   *  absorption). Mirrors Codex's `codex.startup_prewarm.*` family. Recorded
   *  ONCE per session and only when the `prewarm` config block is wired
   *  (`QUANTA_PREWARM`); absent ⇒ no keys touched (byte-identical). */
  startup: {
    /** gauge — Time-To-First-Message: wall-clock ms from session start to the
     *  first turn's LLM-stream dispatch. The headline latency the user feels
     *  before the model begins answering. Sourced from the injected clock so
     *  it is deterministic under test. (Codex `age_at_first_turn_ms` parity.) */
    timeToFirstMessageMs: "quanta.startup.time_to_first_message_ms",
    /** gauge — ms the connection-prewarm step itself took (handshake / pool
     *  warm). 0 when the port had no prewarm capability (skipped). (Codex
     *  `startup_prewarm.duration_ms` parity.) */
    prewarmDurationMs: "quanta.startup.prewarm_duration_ms",
    /** counter, label: `outcome` — one of `skipped | warmed | failed`
     *  (`PrewarmOutcome` from `@/llm`). Lets a dashboard split sessions whose
     *  connection was actually pre-opened from those whose adapter had no
     *  prewarm hook. */
    prewarmOutcome: "quanta.startup.prewarm_outcome",
  },
  run: {
    /** Resource attribute identifying ONE logical run a process streams its
     *  spans under (a bench invocation / campaign arm). Set from
     *  `QUANTA_OTEL_RUN_ID` (auto-issued when unset), it lets the trace-viewer
     *  filter one run out of a sink that mixes many concurrent runs — the
     *  `?run=<id>` deep-link. Unlike the other keys (per-span attrs) this rides
     *  the OTLP *resource*, so it applies to every span of the run. */
    id: "quanta.run.id",
  },
  /** Bench SWE-instance identity, stamped on the top-level `session_loop` span
   *  (F3). Together with the `quanta.run.id` resource attr these form the JOIN
   *  KEY that lets the trace-viewer link an OTLP span back to its bench
   *  trajectory line (`<runId>/<instanceId>.<attempt>.jsonl` — see
   *  `runner/batch/observe.ts` `RunContext`). Without it a trajectory turn keyed
   *  by runId/instanceId could NOT be joined to its OTEL span: the trajectory's
   *  synthetic `llm:tN` spanId is a different namespace from the OTLP random
   *  spanId (false friends). Per-SPAN (not resource): one bench PROCESS streams
   *  many instances, so instanceId varies per session and cannot ride the
   *  process-wide resource the way runId does. Absent (non-bench sessions) ⇒ key
   *  omitted ⇒ byte-identical. */
  instance: {
    id: "quanta.instance.id",
    /** Best-of-N / retry attempt index for THIS instance (the `.<attempt>`
     *  segment of the trajectory filename). Completes the full trajectory key
     *  `{runId, instanceId, attempt}`. Omitted when the driver did not thread an
     *  attempt index (single-pass / attempt unknown at span-open) ⇒ join still
     *  works on `runId+instanceId` (attempt is only a same-instance
     *  discriminator). */
    attempt: "quanta.instance.attempt",
  },
} as const

/**
 * Canonical SPAN NAMES that live in the `quanta.*` namespace (as opposed to
 * attribute KEYS in {@link QUANTA_ATTRS}). Kept here — the single vocabulary
 * owner — so the orphan-literal scan (`vocabulary-migration.test.ts`) does not
 * flag them as un-migrated raw `"quanta.*"` strings scattered across `src/`.
 * NOT part of {@link ALL_ATTR_KEYS} (those are attribute keys); a span name is
 * a different axis and must not inflate the attribute-count budget.
 */
export const QUANTA_SPAN_NAMES = {
  /** INTERNAL root span opened once per bench instance ATTEMPT
   *  (`withBenchInstanceRoot`) — the per-attempt trace root under which the
   *  whole sandbox→agent→verify tree hangs. One trace per attempt. */
  benchInstance: "quanta.bench.instance",
} as const

// ---------------------------------------------------------------------------
// OpenTelemetry GenAI semantic conventions (`gen_ai.*`)
// ---------------------------------------------------------------------------

export const GEN_AI_ATTRS = {
  /** OTel GenAI semconv `gen_ai.operation.name` — the logical operation the
   *  span represents (`chat` / `execute_tool` / `invoke_agent` / …). Canonical
   *  discriminator for the span tree. */
  operation: {
    name: "gen_ai.operation.name",
  },
  /** OTel GenAI semconv `gen_ai.provider.name` — the provider slug
   *  (`openai` / `anthropic`). Canonical replacement for the legacy
   *  `gen_ai.system` (kept below for the compat window). */
  provider: {
    name: "gen_ai.provider.name",
  },
  /** OTel GenAI semconv `gen_ai.conversation.id` — stable id correlating every
   *  turn of one agent conversation into a single thread. */
  conversation: {
    id: "gen_ai.conversation.id",
  },
  /** OTel GenAI semconv `gen_ai.agent.name` — the logical agent identity that
   *  owns the invoke_agent span (root / subagent name). */
  agent: {
    name: "gen_ai.agent.name",
  },
  request: {
    model: "gen_ai.request.model",
    maxTokens: "gen_ai.request.max_tokens",
    temperature: "gen_ai.request.temperature",
  },
  /** Truncated preview of the LAST input message text shipped to the provider
   *  — the "what did we ask" payload surfaced when an operator clicks a
   *  `run_sampling_request` span in the live trace UI. Bounded + only built
   *  when a span sink is active (no cost on the default-OFF path). OTel GenAI
   *  semconv `gen_ai.prompt`. */
  prompt: "gen_ai.prompt",
  /** OTel GenAI semconv `gen_ai.input.messages` — the structured input message
   *  sequence sent to the provider (canonical successor to {@link prompt};
   *  emitted as a serialized/homogeneous form by C2 call sites). */
  input: {
    messages: "gen_ai.input.messages",
  },
  /** OTel GenAI semconv `gen_ai.output.messages` — the structured output
   *  message sequence returned by the provider (canonical successor to
   *  {@link response.completion}). */
  output: {
    messages: "gen_ai.output.messages",
  },
  response: {
    model: "gen_ai.response.model",
    finishReason: "gen_ai.response.finish_reasons",
    /** ADR-0077 TTFT — wall-clock ms from the actual provider POST boundary
     *  to the FIRST model-output chunk (text / thinking / tool_use start).
     *  Emitted per sampling-request span; omitted when no chunk was observed
     *  (e.g. empty stream / immediate abort). Sourced from
     *  `TurnTiming.firstTokenLatencyMs`. */
    timeToFirstTokenMs: "gen_ai.response.time_to_first_token_ms",
    /** Truncated preview of the model's text/tool-call output — the "what came
     *  back" payload for the trace UI. Same bounded + sink-gated discipline as
     *  {@link prompt}. OTel GenAI semconv `gen_ai.completion`. */
    completion: "gen_ai.completion",
  },
  usage: {
    inputTokens: "gen_ai.usage.input_tokens",
    outputTokens: "gen_ai.usage.output_tokens",
    cacheCreationInputTokens: "gen_ai.usage.cache_creation_input_tokens",
    cacheReadInputTokens: "gen_ai.usage.cache_read_input_tokens",
  },
  tool: {
    callId: "gen_ai.tool.call.id",
    input: "gen_ai.tool.input",
    output: "gen_ai.tool.output",
    name: "gen_ai.tool.name",
    type: "gen_ai.tool.type",
  },
  /** `"openai" | "anthropic"`. */
  system: "gen_ai.system",
} as const

// ---------------------------------------------------------------------------
// Compile-time key union derivation
// ---------------------------------------------------------------------------

/**
 * Recursively extract every leaf string literal from a nested `as const` map.
 * Object branches recurse; string leaves are collected; anything else collapses
 * to `never`.
 */
type ExtractValues<T> = T extends string
  ? T
  : T extends Readonly<Record<string, unknown>>
    ? { [K in keyof T]: ExtractValues<T[K]> }[keyof T]
    : never

/** All canonical `quanta.*` attribute keys as a string-literal union. */
export type QuantaAttrKey = ExtractValues<typeof QUANTA_ATTRS>

/** All canonical `gen_ai.*` attribute keys as a string-literal union. */
export type GenAiAttrKey = ExtractValues<typeof GEN_AI_ATTRS>

/** Union of every canonical attribute key — the only valid `Attrs` key set. */
export type AttrKey = QuantaAttrKey | GenAiAttrKey

// ---------------------------------------------------------------------------
// Attribute value typing (OTel spec)
// ---------------------------------------------------------------------------

/**
 * Allowed attribute value types per the OpenTelemetry specification:
 * primitive scalars and homogeneous arrays thereof. No nested objects, no
 * `null`, no `undefined` — emit those by omitting the key.
 */
export type AttrValue =
  | string
  | number
  | boolean
  | readonly string[]
  | readonly number[]
  | readonly boolean[]

// ---------------------------------------------------------------------------
// Runtime introspection helpers (for tests / safety nets)
// ---------------------------------------------------------------------------

/**
 * Flat, sorted snapshot of every canonical key. Built once at module load by
 * walking the const maps — no manual list to drift.
 */
const flatten = (node: unknown, out: string[]): void => {
  if (typeof node === "string") {
    out.push(node)
    return
  }
  if (node !== null && typeof node === "object") {
    for (const v of Object.values(node as Record<string, unknown>)) {
      flatten(v, out)
    }
  }
}

const collectKeys = (): readonly string[] => {
  const out: string[] = []
  flatten(QUANTA_ATTRS, out)
  flatten(GEN_AI_ATTRS, out)
  return Object.freeze([...out].sort())
}

/** Frozen, sorted list of every declared attribute key. */
export const ALL_ATTR_KEYS: readonly string[] = collectKeys()

/** Frozen set form, for O(1) membership checks at runtime. */
export const ATTR_KEY_SET: ReadonlySet<string> = new Set(ALL_ATTR_KEYS)

/** Runtime predicate — does `k` name a canonical attribute key? */
export const isAttrKey = (k: string): k is AttrKey => ATTR_KEY_SET.has(k)
