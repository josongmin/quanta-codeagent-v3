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
  },
  permission: {
    /** ADR-0029 reviewer enum. */
    reviewerTier: "quanta.permission.reviewer_tier",
    /** ADR-0029 8-state final approval outcome. */
    outcome: "quanta.permission.outcome",
    /** `"low" | "medium" | "high"`. */
    riskLevel: "quanta.permission.risk_level",
  },
  patch: {
    /** ADR-0028 V4A patch op: `"add" | "delete" | "update"`. */
    op: "quanta.patch.op",
    path: "quanta.patch.path",
    hunkCount: "quanta.patch.hunk_count",
    fuzzyMatched: "quanta.patch.fuzzy_matched",
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
