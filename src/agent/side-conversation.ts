/**
 * Side-conversation seam (ADR-0049).
 *
 * A side conversation is a lightweight read-only sub-thread that runs in
 * parallel to the main agent turn. The user can ask "what does this regex do?"
 * mid-task without interrupting the main thread. Codex ships the system prompt
 * (verbatim string, see {@link SIDE_CONVERSATION_PROMPT}) and the
 * `codex.thread.side` telemetry key but offers no public surface; v3 exposes
 * it as a first-class API from day one.
 *
 * Side-conversation semantics (deliberately narrow):
 *   - Read-only: the LLM cannot mutate filesystem / spawn shells / write
 *     working state. Enforced at the tool-set seam: only the static
 *     {@link SIDE_CONVERSATION_TOOLS} list is forwarded to the adapter, every
 *     entry classified `null` (read-only) in the mode table.
 *   - Separate context window: the parent thread's messages are NOT forwarded.
 *     The side conv sees only its own system prompt + the user's question.
 *   - Separate system prompt: the Codex side-conversation prompt (verbatim).
 *   - No subagent: this is NOT a Task-style fork. There is no session, no
 *     working tree, no separate logs — just one extra LLM round-trip threaded
 *     into the parent's process.
 *   - No nested side conversations: a side conv may not spawn another side
 *     conv (caller responsibility — enforced indirectly by not forwarding any
 *     spawn capability).
 *   - Bounded reasoning effort: `effort` is `"low" | "medium"`. The type alone
 *     forbids `"high"` / `"xhigh"`; a runtime guard catches `as any` casts.
 *
 * Telemetry: one log line per side conv with the `codex.thread.side=true`
 * attribute plus latency + tokens. The attribute keys ride the canonical
 * vocabulary ({@link QUANTA_ATTRS.thread.side}) so dashboards do not drift.
 */

import { assembleFromEvents, type LLMPort, type ToolSchema } from "@/llm"
import { log } from "@/observability"
import { attrs } from "@/observability/attrs"
import { QUANTA_ATTRS } from "@/observability/vocabulary"

/** Verbatim Codex side-conversation system prompt. DO NOT paraphrase — the
 *  string must be byte-identical to Codex's so tooling that grep's either
 *  codebase's prompt corpus stays in agreement. Tests assert byte equality. */
export const SIDE_CONVERSATION_PROMPT =
  "You are a side-conversation assistant, separate from the main thread. " +
  "Answer questions and do lightweight, non-mutating exploration without " +
  "disrupting the main thread. If there is no user question after this " +
  "boundary yet, wait for one."

/** Read-only tool allowlist forwarded to the side-conversation turn.
 *  Intentionally minimal: read + grep + glob cover the "look something up
 *  without touching anything" use case the Codex prompt describes. Mutating
 *  tools (write/edit/bash/update_working_state) are NEVER added — the dispatch
 *  seam already classifies them as mutating, but the side conv's defense is
 *  not even sending them to the LLM in the first place.
 *
 *  These tool NAMES must match the registry's read-only entries
 *  (`MUTATING_TOOL_TABLE` in `src/agent/mode.ts`); a mismatch is caught by
 *  the unit test that cross-checks `SIDE_CONVERSATION_TOOL_NAMES` against the
 *  mutating-table classification (`null` ⇒ read-only). */
export const SIDE_CONVERSATION_TOOL_NAMES: readonly string[] = Object.freeze([
  "read",
  "grep",
  "glob",
])

/** Schema entries for the read-only tools. Description strings are kept
 *  intentionally terse — the side conv prompt sets the posture, so the tool
 *  descriptions only need to remind the LLM what each tool does and that they
 *  are non-mutating. */
const SIDE_CONVERSATION_TOOL_SCHEMAS: readonly ToolSchema[] = Object.freeze([
  {
    name: "read",
    description: "Read a file from the working tree. Non-mutating.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "Path to the file" } },
      required: ["path"],
    },
  },
  {
    name: "grep",
    description: "Search the working tree with a regex. Non-mutating.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern" },
        path: { type: "string", description: "Optional directory to scope" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "glob",
    description: "List files matching a glob. Non-mutating.",
    input_schema: {
      type: "object",
      properties: { pattern: { type: "string", description: "Glob pattern" } },
      required: ["pattern"],
    },
  },
])

/** Reasoning effort cap. The TYPE alone rejects "high"/"xhigh" — a runtime
 *  guard catches `as any` casts. Side conv is meant to be cheap and fast;
 *  burning a "high"-effort token budget here defeats the point. */
export type SideConversationEffort = "low" | "medium"

/** Inputs to {@link runSideConversation}. Documented per field below. */
export interface SideConversationOptions {
  /** The parent thread's id — recorded for telemetry/tracing, never forwarded
   *  to the LLM. The side conv shares the parent's PROCESS but not its
   *  conversation. */
  parentThreadId: string
  /** The user question to answer. Becomes the sole user message of the side
   *  conv's turn (system prompt + this question; nothing else). */
  question: string
  /** Model id override. If omitted, the side conv uses the LLM port's
   *  configured model (smaller/cheaper selection is the CALLER's choice —
   *  this function does not pick provider/model on its own). */
  model?: string
  /** Reasoning effort cap. Defaults to `"low"`. Type-restricted to "low" or
   *  "medium" — `"high"` / `"xhigh"` is a compile error. */
  effort?: SideConversationEffort
  /** The LLM port to drive the side conv against. Injected so the caller
   *  controls model/provider selection. */
  llm: LLMPort
  /** Injectable clock (testing). */
  now?: () => number
}

/** Result of a side conversation. `tokens` may be zero if the provider did not
 *  emit a usage event (older models). The answer is the joined text of the
 *  assistant's content blocks; tool calls are NOT awaited or executed — the
 *  side conv operates in pure-text mode (see implementation rationale). */
export interface SideConversationResult {
  answer: string
  tokens: { input: number; output: number }
}

/** Defensive runtime guard: the type alone catches static call-sites that
 *  pass `"high"`/`"xhigh"`, but an `as any` cast or a dynamic value from JSON
 *  could slip past. Throws a typed error rather than silently degrading. */
const VALID_EFFORTS = new Set<SideConversationEffort>(["low", "medium"])
const assertValidEffort = (e: SideConversationEffort | undefined): SideConversationEffort => {
  const v = e ?? "low"
  if (!VALID_EFFORTS.has(v)) {
    throw new Error(
      `side-conversation effort must be "low" or "medium", got "${String(v)}". ` +
        "Side conversations are intentionally bounded; use the main thread for high-effort work.",
    )
  }
  return v
}

/** Resolve the effective model id. The caller's explicit `opts.model` wins;
 *  otherwise we fall back to the LLM port's configured model. Returned as a
 *  log-friendly string ("unknown" if neither is available). */
const resolveModel = (opts: SideConversationOptions): string =>
  opts.model ?? opts.llm.model ?? "unknown"

/**
 * Run one side conversation against the injected LLM. Returns the assembled
 * text answer + token usage. See file header for the full contract.
 *
 * Implementation rationale:
 *   - We DO forward the read-only tool schemas to the model so the LLM CAN
 *     answer "what does this regex do?" by reading the file. But we DO NOT
 *     wire a dispatch engine — if the model emits a tool call, the call is
 *     visible in the assembled message but no tool runs. This keeps the seam
 *     simple and read-only-by-construction: nothing the LLM emits can mutate
 *     the working tree, because no tool dispatch path exists in this flow.
 *   - A future enhancement could plug in a read-only dispatch engine to
 *     actually execute the read/grep/glob calls; the architecture supports it
 *     (the tool list is already filtered), and the change would be additive.
 */
export const runSideConversation = async (
  opts: SideConversationOptions,
): Promise<SideConversationResult> => {
  const effort = assertValidEffort(opts.effort)
  const now = opts.now ?? Date.now
  const startedAt = now()
  const model = resolveModel(opts)

  const events = []
  for await (const ev of opts.llm.stream({
    messages: [{ role: "user", content: [{ type: "text", text: opts.question }] }],
    system: SIDE_CONVERSATION_PROMPT,
    tools: [...SIDE_CONVERSATION_TOOL_SCHEMAS],
  })) {
    events.push(ev)
  }

  const { message } = assembleFromEvents(events)
  const answer = message.content
    .filter((b) => b.type === "text")
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim()

  // Pluck token usage from the (at most one) `usage` event.
  let inputTokens = 0
  let outputTokens = 0
  for (const ev of events) {
    if (ev.type === "usage") {
      inputTokens = ev.inputTokens
      outputTokens = ev.outputTokens
    }
  }

  // Emit the structured-log line that carries the `quanta.thread.side=true`
  // attribute. Builds via the canonical-vocabulary `attrs()` helper so a typo
  // would fail at compile/runtime, not silently mislabel a dashboard.
  const sideAttrs = attrs({
    [QUANTA_ATTRS.thread.side]: true,
    [QUANTA_ATTRS.thread.parentId]: opts.parentThreadId,
    [QUANTA_ATTRS.turn.kind]: "side-conversation",
    [QUANTA_ATTRS.turn.durationMs]: now() - startedAt,
  })
  log.info("side_conversation_completed", {
    attrs: sideAttrs,
    model,
    effort,
    inputTokens,
    outputTokens,
    answerChars: answer.length,
  })

  return { answer, tokens: { input: inputTokens, output: outputTokens } }
}
