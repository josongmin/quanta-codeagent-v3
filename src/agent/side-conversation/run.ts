/**
 * Side-conversation executor (ADR-0049).
 *
 * The seam itself: a lightweight read-only sub-thread that runs alongside the
 * main agent loop without disrupting it. Patterned after Codex Desktop's
 * `codex.thread.side` surface (build 2867, round-4 capture
 * [[codex-desktop-build-2867-round-4]] §G).
 *
 * Split out of `side-conversation.ts` (#10): this module holds the EXECUTOR
 * (`runSideConversation`), the tool allowlist + filter, the options/result
 * types, the four error classes, the effort guard, and token estimation. The
 * byte-identical prompt constants live in `./prompt.ts`; the external dispatch
 * indirection lives in `./dispatch.ts`.
 *
 * ## What this is, and what it is NOT
 *
 * It IS:
 *   - A separate model invocation against a restricted tool subset
 *     ({@link SIDE_CONVERSATION_TOOL_NAMES}, all read-only).
 *   - A child OTel span tagged with `quanta.thread.side = true` and
 *     `quanta.thread.kind = "side"`, parented to the caller's thread span via
 *     `quanta.thread.parent_id`.
 *   - A one-shot exchange: one user question → one assistant answer. No
 *     tool-loop, no multi-turn, no memory persistence.
 *
 * It is NOT:
 *   - A subagent (ADR-0041). Subagents own their own working tree, get a
 *     nickname from the pool (ADR-0042), have a full 6-tool surface
 *     (spawn/wait/close + exec/write_stdin/send_input), and run an `runAgent`
 *     fork. Side-conversations get NO nickname, NO worktree, NO mutating
 *     tools, NO recursion.
 *   - Plan-mode (ADR-0036). Plan-mode is a sticky posture of the MAIN thread.
 *     Side-conv is a separate thread with its own (much stricter) gating.
 *   - A way to inject prompts that the main thread will obey. The
 *     side-conversation answer is returned to the CALLER, never spliced into
 *     the main message history. The caller (UI, CLI, parent agent) decides
 *     what to do with it.
 *
 * The `quanta.thread.side` attribute is INTENTIONALLY namespaced (not
 * `codex.thread.side`) — we are mirroring the seam, not the wire format.
 */

import type { LLMPort, Message, StreamEvent, ToolSchema } from "@/llm"
import { assembleFromEvents } from "@/llm"
import { GEN_AI_ATTRS, QUANTA_ATTRS } from "@/observability"
import { QuantaError } from "@/shared"
import { SIDE_CONVERSATION_PROMPT } from "./prompt"

// ===========================================================================
// Tool allowlist — read-only by construction
// ===========================================================================

/**
 * Tools a side-conversation is permitted to call.
 *
 * Two invariants enforced by tests:
 *   1. Every name here MUST appear in `planModeMutatingTable()` as
 *      classification `null` (read-only).
 *   2. EVERY read-only name in `planModeMutatingTable()`, MINUS the documented
 *      {@link SIDE_CONVERSATION_TOOL_EXCLUSIONS}, MUST appear here (otherwise
 *      the allowlist has silently desynced — a new read-only tool that should
 *      also be available to side-conv has been added but forgotten). Toggling
 *      that invariant requires updating BOTH lists consciously.
 *
 * No mutating tool may be added here. Any attempt is caught by
 * `tests/unit/side-conversation.test.ts::"allowlist is exactly the read-only complement"`.
 */
export const SIDE_CONVERSATION_TOOL_NAMES: readonly string[] = Object.freeze([
  "read",
  // ADR-0278 caller-wired search facade. Delegated read-only surfaces should
  // retain the broad repo-search entrypoint when the host wires it.
  "search_codebase",
  "grep",
  "find_references",
  "glob",
  // ADR-0296 — `bash_await` is pure polling over the in-memory background-
  // shell registry (no FS / network / shell side effect); safe inside a
  // side conversation.
  "bash_await",
  "memory_search",
  "task_output",
  "localize",
  "diagnostics",
  "test_runner",
  "budget_status",
  "shadow_snapshots",
  "read_image",
  "read_image_url",
  "web_fetch",
  "web_search",
  "csv_read",
  "ndjson_read",
  "yaml_read",
  "pdf_read",
  "xlsx_read",
  // jun-04 — `docx_read` / `pptx_read` are pure OOXML readers (sibling to
  // `xlsx_read`); read-only + side-conv-safe (no FS write, no shell, no network).
  "docx_read",
  "pptx_read",
  "lsp_definition",
  "lsp_references",
  "lsp_hover",
  "lsp_type_definition",
  "lsp_implementation",
  "lsp_document_symbol",
  "lsp_workspace_symbol",
  "lsp_rename_preview",
  // jun-6 wave-2 — call-hierarchy navigation. Pure read-only LSP queries (no FS
  // write, no shell, no network), so side-conversation-safe.
  "lsp_incoming_calls",
  "lsp_outgoing_calls",
  "git_status",
  "git_log",
  "git_diff",
  "git_blame",
  "git_blame_heatmap",
  "git_churn",
  "git_upstream_check",
  "gh_check_status",
  "gh_issue_view",
  "gh_pr_blame",
  "gh_pr_list",
  "gh_pr_review_diff",
  "gh_pr_view",
  // ADR-0109 + ADR-0111 git-skill-bundle: 3 new read-only git tools — also
  // safe in a side-conversation (pure analysis surfaces, no FS mutation).
  "git_review_diff",
  "git_moved_code",
  "git_conflict_inspect",
  // jun-09 long-tail — 4 NEW read-only tools classified `null` (read-only) in
  // planModeMutatingTable; listed here to keep the allowlist in 1-1 correspondence
  // (the side-conversation drift invariant enforces equality). All pure analysis:
  // git_co_change (co-occurrence over history), gh_pr_code_tour (PR-diff walk),
  // ci_finding (structured CI finding — no FS/shell/network), worktree_status
  // (worktree slot + porcelain read). No mutation ⇒ side-conversation-safe.
  "git_co_change",
  "gh_pr_code_tour",
  "ci_finding",
  "worktree_status",
  "file_tree_summary",
  "parse_test_failure",
  "subagent_poll",
  "subagent_await",
  "Skill",
  "ToolSearch",
  // ADR-0097 — `request_user_input` is read-only and operator-facing. Listed
  // here so the side-conv allowlist stays in 1-1 correspondence with the
  // planModeMutatingTable read-only set (the drift detector at
  // `tests/unit/side-conversation.test.ts` enforces equality).
  "request_user_input",
  // Same posture: `request_plan_exit` is operator-facing and read-only in
  // planModeMutatingTable. Added per the same drift-detector invariant.
  "request_plan_exit",
])

/**
 * Tools that `planModeMutatingTable()` classifies `null` (plan-mode-permissive)
 * but which are DELIBERATELY excluded from the side-conversation allowlist.
 *
 * The plan-mode table answers a narrower question than the side-conv contract:
 * "may this run in plan *collaboration* mode?" A tool can be plan-mode-permissive
 * yet still be mutating-by-contract at the dispatch seam (the operative runtime
 * gate keys off the tool's own `isReadOnly()`), which violates the side-conv
 * contract "non-mutating exploration ... read-only by construction".
 *
 *   - `session_config`: classified `null` in `planModeMutatingTable` so that an
 *     in-plan effort bump mirrors the operator `/effort` slash. But the tool
 *     itself declares `isReadOnly() === false` and carries `op:set_effort`,
 *     which mutates the PARENT session's EffortStore. A delegated, isolated
 *     side-conversation must not be able to mutate the parent session's posture
 *     (effort / identity / model / provider), so it is excluded here.
 *
 * This set is the seam that makes invariant 2 (allowlist == read-only set MINUS
 * exclusions) fail loudly on genuine drift while permitting this one documented
 * divergence. Adding a tool here requires the same conscious BOTH-list edit.
 */
export const SIDE_CONVERSATION_TOOL_EXCLUSIONS: readonly string[] = Object.freeze([
  "session_config",
  // jun-04 — gated meta/observability read tools. `coverage_check` (V8
  // coverage report) + `prompt_cache_status` (cache-hit snapshot) are read-only
  // but are operator-axis introspection tools, not relevant to a lightweight
  // side conversation; excluded so the allowlist stays a CONSCIOUS subset.
  "coverage_check",
  "prompt_cache_status",
  // jun-05 — read-only SURFACES from the recent absorption waves (C1 canvas /
  // C2 communicate / N1 side-agent / N3 mcp-resources / N6 pty). Each is
  // `null` (plan-mode-permissive) in `planModeMutatingTable`, but none belongs
  // in a lightweight patch-re-emit side-conversation: they are operator-/host-
  // axis introspection or inter-agent channels (artifact store, progress
  // emitter, MCP resource/prompt browsing, PTY observation, side-agent daemon
  // status), not the minimal exploration surface a delegated side-conversation
  // needs. Excluded so the allowlist stays a CONSCIOUS subset (drift detector
  // at tests/unit/side-conversation.test.ts enforces both directions).
  "artifact_get",
  "artifact_list",
  "communicate_update",
  "mcp_connector_list",
  "mcp_get_prompt",
  "mcp_list_prompts",
  "mcp_list_resources",
  "mcp_list_resource_templates",
  // B4 — `mcp_read_resource` is now `write_filesystem` (blob-to-disk), so it is
  // excluded from a read-only side-conversation by its MUTATION, not by this
  // conscious read-only-exclusion list (which the drift detector requires to hold
  // only `null`/read-only entries). `mcp_read_resource_dir` stays: it is a pure
  // read-only resources/list + filter, consciously excluded like the sibling
  // browsing tools above.
  "mcp_read_resource_dir",
  "pty_list",
  "pty_read",
  "side_agent_findings",
  "side_agent_list",
  // jun-06 — `poll_deferred` (ADR-0287 async-tools) is read-only (`null` in
  // planModeMutatingTable) but polls a DEFERRED async-tool result owned by the
  // main session's async registry — like `subagent_poll`, it is a main-session
  // async-control surface, not the minimal exploration set a delegated
  // side-conversation needs. Excluded so the allowlist stays a CONSCIOUS subset.
  "poll_deferred",
  // jun-06 — `subagent_force_background` (ADR-0487) is read-only-classified
  // (`null`, plan-safe — it only reorders the agent's own background pool) but
  // is a main-session background-scheduler control surface (like `subagent_poll`),
  // not part of a lightweight side-conversation's exploration set. Excluded.
  "subagent_force_background",
])

// ===========================================================================
// Public types
// ===========================================================================

/**
 * Reasoning effort cap. Side-conversations are LIGHTWEIGHT by contract; the
 * type rejects `"high"`/`"xhigh"` at compile time, and {@link runSideConversation}
 * additionally guards against `as any` / JSON-deserialization bypass at
 * runtime.
 */
export type SideConversationEffort = "low" | "medium"

/** Default token budget. Mirrors the Codex side-conv ceiling. */
export const DEFAULT_SIDE_CONVERSATION_INPUT_TOKEN_BUDGET = 8192
export const DEFAULT_SIDE_CONVERSATION_OUTPUT_TOKEN_BUDGET = 4096

/** Coarse token estimate — same heuristic the loop uses for compaction.
 *  4 chars/token is intentionally pessimistic and avoids importing the
 *  larger compaction module. */
export const estimateSideConversationTokens = (text: string): number => Math.ceil(text.length / 4)

/**
 * Caller-facing input to {@link runSideConversation}.
 *
 * `parentSessionId` is informational — it tags the OTel span so traces can be
 * stitched but the side-conv does NOT inherit the parent's tool registry,
 * memory, or message history.
 */
export interface SideConversationOptions {
  parentSessionId: string
  /** The user-facing question to answer. */
  question: string
  /** LLM port to run against. Caller picks the model (typically a cheaper
   *  one — see ADR-0049 §"model selection"). */
  llm: LLMPort
  /** Read-only tools to expose. Caller is responsible for ensuring every
   *  entry's `name` is in {@link SIDE_CONVERSATION_TOOL_NAMES}; the runner
   *  re-validates and rejects unknown / mutating entries. */
  tools?: ToolSchema[]
  /** Reasoning effort — `"low"` / `"medium"` only at the type level, with a
   *  runtime guard against `as any` / JSON-deserialization bypass. */
  effort?: SideConversationEffort
  /** Abort signal — typically the PARENT turn's signal, so cancelling the
   *  parent also cancels the side-conv. */
  signal?: AbortSignal
  /** Override budgets (default = {@link DEFAULT_SIDE_CONVERSATION_INPUT_TOKEN_BUDGET}
   *  / {@link DEFAULT_SIDE_CONVERSATION_OUTPUT_TOKEN_BUDGET}). */
  inputTokenBudget?: number
  outputTokenBudget?: number
  /** Observability sink. Optional — when absent, attributes are dropped
   *  silently (consistent with the rest of the agent's observability
   *  pattern). */
  observe?: (span: SideConversationSpanAttributes) => void
  /** Injection seam for tests: clock used to measure side-conv `durationMs`.
   *  Reported on the result + observed span only — never affects routing.
   *  Default `Date.now`. */
  now?: () => number
}

/** Wire keys for the side-conversation span — all sourced from the
 *  vocabulary SSOT (`@/observability`) so the orphan-literal scan stays
 *  green and a key rename surfaces in one place. */
type SideConvRequiredKey =
  | typeof QUANTA_ATTRS.thread.side
  | typeof QUANTA_ATTRS.thread.kind
  | typeof QUANTA_ATTRS.thread.parentId
  | typeof QUANTA_ATTRS.turn.durationMs
type SideConvOptionalKey =
  | typeof GEN_AI_ATTRS.usage.inputTokens
  | typeof GEN_AI_ATTRS.usage.outputTokens

/** OTel-shaped attribute set emitted for one side-conversation invocation. */
export type SideConversationSpanAttributes = Record<
  SideConvRequiredKey,
  string | number | boolean
> &
  Partial<Record<SideConvOptionalKey, number>>

/**
 * Result of one side-conversation invocation.
 */
export interface SideConversationResult {
  answer: string
  tokens: { input: number; output: number }
  durationMs: number
  /** Stop reason as reported by the LLM stream (`"end_turn"`, etc.). */
  stopReason: string
}

// ===========================================================================
// Errors
// ===========================================================================

/** Effort outside the {@link SideConversationEffort} domain (caught at
 *  runtime so `as any` / `JSON.parse` cannot smuggle `"high"` / `"xhigh"`). */
export class SideConversationEffortError extends QuantaError {
  readonly attempted: string
  constructor(attempted: string) {
    super(
      "side_conversation_effort",
      `Side-conversation rejects effort=${JSON.stringify(attempted)}. ` +
        `Allowed: "low" | "medium" (side-conv is read-only-lightweight by contract).`,
    )
    this.attempted = attempted
  }
}

/** Tool not in the allowlist (mutating or unknown). */
export class SideConversationToolError extends QuantaError {
  readonly toolName: string
  constructor(toolName: string) {
    super(
      "side_conversation_tool",
      `Tool "${toolName}" is not in SIDE_CONVERSATION_TOOL_NAMES. ` +
        `Side-conversations are read-only by construction.`,
    )
    this.toolName = toolName
  }
}

/** Token budget exceeded. */
export class SideConversationBudgetError extends QuantaError {
  readonly direction: "input" | "output"
  readonly observed: number
  readonly limit: number
  constructor(direction: "input" | "output", observed: number, limit: number) {
    super(
      "side_conversation_budget",
      `Side-conversation ${direction} token budget exceeded: ` +
        `observed=${observed} > limit=${limit}. ` +
        `Raise the budget explicitly or trim the question.`,
    )
    this.direction = direction
    this.observed = observed
    this.limit = limit
  }
}

/** Parent signal aborted before the side-conv produced a result. */
export class SideConversationAbortedError extends QuantaError {
  constructor() {
    super("side_conversation_aborted", "Side-conversation aborted (parent turn signalled abort).")
  }
}

// ===========================================================================
// Effort guard
// ===========================================================================

const ALLOWED_EFFORTS: ReadonlySet<string> = new Set(["low", "medium"])

/**
 * Runtime guard against `as any` / JSON-deserialization bypass. The type
 * already rejects `"high"` / `"xhigh"` at compile time, but values arriving
 * from JSON, RPC, or untyped boundaries can smuggle invalid strings; this
 * throws on anything outside the allowed set, including `undefined` only when
 * the caller explicitly set the field (we treat unset = `"low"`).
 */
export const assertSideConversationEffort: (
  value: unknown,
) => asserts value is SideConversationEffort = (value: unknown) => {
  if (typeof value !== "string" || !ALLOWED_EFFORTS.has(value)) {
    throw new SideConversationEffortError(String(value))
  }
}

// ===========================================================================
// Tool allowlist guard
// ===========================================================================

const SIDE_CONVERSATION_TOOL_SET: ReadonlySet<string> = new Set(SIDE_CONVERSATION_TOOL_NAMES)

/** Filter a tool-schema list down to exactly the side-conv-allowed names.
 *  Throws on any name not in the allowlist (no silent drops — a mistake at
 *  the caller is a bug). */
export const filterSideConversationTools = (tools: readonly ToolSchema[]): ToolSchema[] => {
  for (const t of tools) {
    if (!SIDE_CONVERSATION_TOOL_SET.has(t.name)) {
      throw new SideConversationToolError(t.name)
    }
  }
  return [...tools]
}

// ===========================================================================
// runSideConversation — the seam
// ===========================================================================

/**
 * Run one side-conversation invocation against {@link SideConversationOptions.llm}.
 *
 * Contract:
 *   - Single LLM call; no tool-loop.
 *   - Returns the assembled assistant text answer (plus token accounting).
 *   - Throws {@link SideConversationEffortError} on out-of-range effort
 *     (including `as any` bypass).
 *   - Throws {@link SideConversationToolError} on a tool not in
 *     {@link SIDE_CONVERSATION_TOOL_NAMES}.
 *   - Throws {@link SideConversationBudgetError} when input estimate or
 *     observed output exceeds the budget.
 *   - Throws {@link SideConversationAbortedError} when the abort signal
 *     fires before completion.
 *
 * The parent agent loop is NEVER touched. The caller — UI composer, CLI
 * slash-command, or another agent — handles routing the answer back to
 * whatever surface asked for it.
 *
 * Deliberate hold (absorb #3 cont.): plan-exit-flow is NOT consumed here.
 * The side-conv is model→model with no tool-loop and no in-band "plan
 * complete" marker, so there is no structurally clean observation point at
 * which to invoke the port. The CALLER of `runSideConversation` is the
 * natural site to consult `planExitPort` — and it already does, via
 * `runPlanExitFlow` imported directly (dispatch.ts wiring). Promotion path:
 * introduce a side-conv-emitted plan-complete signal (structured tag in the
 * assistant text, or a sentinel stop reason) that this runner can pattern-
 * match on without perturbing the prompt's byte-identical invariant. Until
 * then this comment is the contract.
 */
/** Validate effort + budgets up-front. Throws on violation. Pure. */
const checkPreflight = (
  opts: SideConversationOptions,
): { inputBudget: number; outputBudget: number } => {
  const effortValue = opts.effort ?? "low"
  assertSideConversationEffort(effortValue)
  const inputBudget = opts.inputTokenBudget ?? DEFAULT_SIDE_CONVERSATION_INPUT_TOKEN_BUDGET
  const outputBudget = opts.outputTokenBudget ?? DEFAULT_SIDE_CONVERSATION_OUTPUT_TOKEN_BUDGET
  const promptEstimate =
    estimateSideConversationTokens(SIDE_CONVERSATION_PROMPT) +
    estimateSideConversationTokens(opts.question)
  if (promptEstimate > inputBudget) {
    throw new SideConversationBudgetError("input", promptEstimate, inputBudget)
  }
  if (opts.signal?.aborted) throw new SideConversationAbortedError()
  return { inputBudget, outputBudget }
}

/** Drain the LLM stream with per-event abort checks. Returns the assembled
 *  event list plus the last-observed usage. Throws
 *  {@link SideConversationAbortedError} on abort; other errors propagate. */
const drainStream = async (
  opts: SideConversationOptions,
  tools: ToolSchema[],
): Promise<{ events: StreamEvent[]; inputTokens: number; outputTokens: number }> => {
  const messages: Message[] = [{ role: "user", content: [{ type: "text", text: opts.question }] }]
  const events: StreamEvent[] = []
  let inputTokens = 0
  let outputTokens = 0
  try {
    for await (const ev of opts.llm.stream({
      messages,
      system: SIDE_CONVERSATION_PROMPT,
      tools,
      ...(opts.parentSessionId.length > 0 ? { promptCacheKey: opts.parentSessionId } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    })) {
      if (opts.signal?.aborted) throw new SideConversationAbortedError()
      events.push(ev)
      if (ev.type === "usage") {
        inputTokens = ev.inputTokens
        outputTokens = ev.outputTokens
      }
    }
  } catch (e) {
    if (opts.signal?.aborted && !(e instanceof SideConversationAbortedError)) {
      throw new SideConversationAbortedError()
    }
    throw e
  }
  return { events, inputTokens, outputTokens }
}

/** Build the OTel span attribute set for one side-conv invocation. */
const buildSpan = (
  parentSessionId: string,
  durationMs: number,
  inputTokens: number,
  outputTokens: number,
): SideConversationSpanAttributes => {
  const attrs: SideConversationSpanAttributes = {
    [QUANTA_ATTRS.thread.side]: true,
    [QUANTA_ATTRS.thread.kind]: "side",
    [QUANTA_ATTRS.thread.parentId]: parentSessionId,
    [QUANTA_ATTRS.turn.durationMs]: durationMs,
  }
  if (inputTokens) attrs[GEN_AI_ATTRS.usage.inputTokens] = inputTokens
  if (outputTokens) attrs[GEN_AI_ATTRS.usage.outputTokens] = outputTokens
  return attrs
}

export const runSideConversation = async (
  opts: SideConversationOptions,
): Promise<SideConversationResult> => {
  const { outputBudget } = checkPreflight(opts)
  const tools = opts.tools ? filterSideConversationTools(opts.tools) : []

  const now = opts.now ?? Date.now
  const started = now()
  const { events, inputTokens, outputTokens } = await drainStream(opts, tools)

  if (outputTokens > outputBudget) {
    throw new SideConversationBudgetError("output", outputTokens, outputBudget)
  }

  const assembled = assembleFromEvents(events)
  const answer = assembled.message.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("")

  const durationMs = now() - started
  opts.observe?.(buildSpan(opts.parentSessionId, durationMs, inputTokens, outputTokens))

  return {
    answer,
    tokens: { input: inputTokens, output: outputTokens },
    durationMs,
    stopReason: assembled.stopReason,
  }
}
