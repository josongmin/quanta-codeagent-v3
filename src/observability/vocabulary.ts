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
} as const

// ---------------------------------------------------------------------------
// OpenTelemetry GenAI semantic conventions (`gen_ai.*`)
// ---------------------------------------------------------------------------

export const GEN_AI_ATTRS = {
  request: {
    model: "gen_ai.request.model",
    maxTokens: "gen_ai.request.max_tokens",
    temperature: "gen_ai.request.temperature",
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
