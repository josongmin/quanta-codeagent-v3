/**
 * Side-chat (Claude Code A9 pattern) — an ISOLATED agent loop run alongside
 * the main conversation, dedicated to a single user-initiated quick question
 * ("what's the test command?", "where is X defined?", …) whose answer must
 * NOT pollute the main turn's history / working state / cost.
 *
 * ## Relation to existing seams
 *
 * 1. {@link runOnce} — orchestrates ONE turn of the MAIN session. Always
 *    persists into the main history. Side-chat does NOT use it: persistence
 *    + main session deps must stay out.
 *
 * 2. `@/agent/side-conversation` (ADR-0046) — a one-shot SINGLE LLM stream
 *    against the read-only tool ALLOWLIST. No tool loop. Used internally by
 *    the agent's own composition (e.g. parent-agent micro-queries). The
 *    side-chat below runs a FULL `runAgent` (multi-turn tool-loop, capped
 *    short) so the user can ask questions that legitimately require a `grep`
 *    → `read` sequence.
 *
 * 3. Subagent (ADR-0041) — task-oriented + parent-managed lifecycle (worktree,
 *    nickname pool, recursion, 6-tool surface). Side-chat is user-initiated +
 *    immediate, has NO worktree / NO nickname / READ-ONLY tools by default,
 *    and returns directly to the user surface.
 *
 * ## Isolation invariants (test-locked)
 *
 *   I1. The caller's main `messages` array is NEVER mutated. The side-chat
 *       constructs its OWN message list (either empty or a slice the caller
 *       opts in to via {@link SideChatInput.contextInheritance}).
 *
 *   I2. No `store` / `sessionId` from the main session is propagated. We use
 *       a synthetic ephemeral sessionId (`side:<sessionId>:<nonce>`) and pass
 *       `store: undefined` so memory subsystems do not write into the main
 *       session's working-state.
 *
 *   I3. The tool registry handed to `runAgent` is a FRESH `ToolRegistry`
 *       built from the filtered (allowlisted) tools — write tools are
 *       physically absent, not just unauthorized.
 *
 *   I4. `maxTurns` is capped at {@link SIDE_CHAT_MAX_TURNS_CAP} (default 5)
 *       so a side-chat cannot consume an unbounded budget.
 *
 *   I5. Cost accounting (input/output tokens) is RETURNED on the result for
 *       the caller to surface SEPARATELY — the loop never folds it into the
 *       main session's tally because no main store/metrics is wired.
 *
 * ## Defaults
 *
 *   - `contextInheritance = "system"` — only the system prompt is reused.
 *     The main history is left out (clean slate is closer to Claude Code's
 *     A9: a fresh thread that happens to share the system identity).
 *   - `toolAllowlist = SIDE_CHAT_DEFAULT_READ_ONLY` — read/grep/glob/lsp_X/
 *     git-read tools. Mutating tools are excluded by name even if the
 *     caller's registry includes them.
 *
 * The module is byte-identical default-OFF: it adds a NEW exported symbol
 * (`runSideChat`) and reads ZERO env (per the slice-boundary guard). The
 * surface (`apps/cli/side-cmd.ts`) maps `QUANTA_SIDE_*` env → typed input.
 */

import { type AgentOutcome, runAgent } from "@/agent"
import type { Message } from "@/llm"
import { type Tool, ToolRegistry } from "@/tool"
import type { OrchestrateDeps } from "./run-once"

/**
 * Hard cap on `maxTurns` for any side-chat invocation. Even a caller that
 * explicitly wires a higher value cannot exceed this — a side-chat is by
 * contract a SHORT lookup, not a workflow.
 */
export const SIDE_CHAT_MAX_TURNS_CAP = 5

/**
 * Default tool name allowlist — purely read-only / analysis surfaces. Every
 * entry MUST also be present in the caller's registry; missing entries are
 * silently dropped (they are not a programming error — the surface may run
 * with a smaller tool set, e.g. if LSP is unwired).
 *
 * Mirrors the side-conversation allowlist (`@/agent/side-conversation`) but
 * intentionally drops `request_user_input` (a side-chat is non-interactive —
 * the user is ALREADY asking; we should not bounce back to them) and adds
 * `file_tree_summary` / `parse_test_failure` (analysis surfaces useful for
 * "where" / "why" lookups that A9 use-cases ask about).
 */
export const SIDE_CHAT_DEFAULT_READ_ONLY: readonly string[] = Object.freeze([
  "read",
  "grep",
  "glob",
  "file_tree_summary",
  "parse_test_failure",
  "localize",
  "diagnostics",
  "git_log",
  "git_diff",
  "git_blame",
  "git_blame_heatmap",
  "git_churn",
  "git_status",
  "lsp_definition",
  "lsp_references",
  "lsp_hover",
  "lsp_type_definition",
  "lsp_implementation",
  "lsp_document_symbol",
  "lsp_workspace_symbol",
])

/**
 * Tool names that may NEVER appear in a side-chat registry, even if the
 * caller passes them on `toolAllowlist`. Side-chat is read-only by
 * construction; this set is the deny-default backstop so a typo in the
 * caller's allowlist cannot smuggle a mutating tool through.
 */
export const SIDE_CHAT_FORBIDDEN: ReadonlySet<string> = new Set<string>([
  "write",
  "edit",
  "apply_patch",
  "scripted_replace",
  "bash",
  "git_commit",
  "git_push",
  "git_reset",
  "git_revert",
  "git_checkout",
  "git_branch_delete",
  "spawn_agent",
  "wait_agent",
  "close_agent",
  "exec_command",
  "write_stdin",
  "send_input",
])

/** Which slice of the main session context the side-chat inherits. */
export type SideChatContextInheritance =
  /** Empty message list (closest to Claude A9's fresh-thread feel). */
  | "none"
  /** System prompt only; message history empty. DEFAULT — keeps the model's
   *  persona / repo rules but drops topic-specific context. */
  | "system"
  /** System prompt + LAST user/assistant pair from history (when present).
   *  Useful when the question is about the previous reply. */
  | "last-turn"

export interface SideChatInput {
  /** The standalone question / instruction. */
  readonly prompt: string
  /** Main session's deps (LLM, registry, permission, …). The side-chat
   *  PICKS a subset: it reuses the LLM port + stream port but replaces the
   *  registry with the filtered one and drops `store`. */
  readonly deps: OrchestrateDeps
  /** Build the per-turn `AgentConfig` from `(messages, deps)`. Same shape as
   *  {@link OrchestrateDeps}'s assembleConfig — typically the surface's
   *  `assembleConfig` from `@/runner/assemble`. */
  readonly assembleConfig: (
    messages: Message[],
    deps: OrchestrateDeps,
  ) => Parameters<typeof runAgent>[0]
  /** Main session message history. Read ONLY — never mutated. */
  readonly mainHistory: readonly Message[]
  /** Inherit which slice of the main context. Default `"system"`. */
  readonly contextInheritance?: SideChatContextInheritance
  /** Override the default read-only tool allowlist. Forbidden tools
   *  (mutating) are still dropped — see {@link SIDE_CHAT_FORBIDDEN}. */
  readonly toolAllowlist?: readonly string[]
  /** Max turns for the side-chat agent loop. Capped at
   *  {@link SIDE_CHAT_MAX_TURNS_CAP}. Default 3. */
  readonly maxTurns?: number
  /** Abort signal. Forwarded to `runAgent` as-is. */
  readonly signal: AbortSignal
}

export interface SideChatResult {
  /** Outcome of the isolated `runAgent` call. */
  readonly outcome: AgentOutcome
  /** Concatenated `text` blocks from the FINAL assistant message — the
   *  answer to surface to the user. Empty string if the loop ended without
   *  an assistant text block (e.g. max_turns with only tool calls). */
  readonly answerText: string
  /** Input tokens consumed by the side-chat (sum across its internal turns).
   *  Accounted SEPARATELY from the main session — the caller is responsible
   *  for any cost dashboard rendering. */
  readonly inputTokens: number
  /** Output tokens produced by the side-chat. */
  readonly outputTokens: number
  /** Number of tools the side-chat had access to (post-filter). Surfaced so
   *  the UI can render `· N tools ·`. */
  readonly toolsAvailable: number
}

/**
 * Filter a registry down to side-chat-safe tools. Returns a NEW
 * {@link ToolRegistry} built from `(allowlist ∩ registry) \ forbidden` —
 * physical absence is the deny mechanism, not a runtime gate.
 *
 * Order of operations matters:
 *   1. Drop any allowlist entry that is also in {@link SIDE_CHAT_FORBIDDEN}.
 *   2. Keep only entries the source registry actually holds (a Tool object
 *      must exist — we cannot construct one from a name).
 *   3. Build a fresh ToolRegistry. The source registry is NEVER mutated.
 */
export const buildSideChatRegistry = (
  source: ToolRegistry,
  allowlist: readonly string[],
): ToolRegistry => {
  const allowed: Tool[] = []
  for (const name of allowlist) {
    if (SIDE_CHAT_FORBIDDEN.has(name)) continue
    const tool = source.get(name)
    if (tool === undefined) continue
    allowed.push(tool)
  }
  return new ToolRegistry(allowed)
}

/**
 * Build the message history for the side-chat per the inheritance mode.
 * Pure function — does NOT mutate `mainHistory`.
 */
export const buildSideChatHistory = (
  mainHistory: readonly Message[],
  mode: SideChatContextInheritance,
): Message[] => {
  if (mode === "none" || mode === "system") return []
  // "last-turn" — find the last user+assistant pair (in that order). If the
  // history ends mid-pair (e.g. tool turn) we walk back to the previous full
  // pair. Returns an empty list if no pair exists yet.
  const out: Message[] = []
  let lastAssistantIdx = -1
  for (let i = mainHistory.length - 1; i >= 0; i--) {
    const m = mainHistory[i]
    if (m === undefined) continue
    if (m.role === "assistant") {
      lastAssistantIdx = i
      break
    }
  }
  if (lastAssistantIdx < 1) return out
  // Find the user message preceding this assistant.
  for (let i = lastAssistantIdx - 1; i >= 0; i--) {
    const m = mainHistory[i]
    if (m === undefined) continue
    if (m.role === "user") {
      out.push(m, mainHistory[lastAssistantIdx] as Message)
      break
    }
  }
  return out
}

/**
 * Extract the final assistant text from a finished `AgentOutcome`. Walks the
 * messages from the END, returning the concatenated `text` blocks of the
 * LAST `role==="assistant"` message. Empty string when no such message
 * exists (max_turns with only tool turns, immediate abort, …).
 */
export const extractAnswerText = (outcome: AgentOutcome): string => {
  for (let i = outcome.messages.length - 1; i >= 0; i--) {
    const m = outcome.messages[i]
    if (m === undefined) continue
    if (m.role !== "assistant") continue
    return m.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("")
  }
  return ""
}

/**
 * Sum token usage across an agent's messages. The streaming `usage` events
 * are NOT preserved on `AgentOutcome`, so we have no per-turn counter from
 * the loop alone. The caller's surface can plug in its own per-stream
 * accounting (e.g. via `OrchestrateDeps.metrics`); for the default path we
 * return zeros — the orientation-correct invariant (cost accounted
 * SEPARATELY) is preserved because the value is never added to the main
 * session's tally. A future PR can wire a stream-observer port into
 * `runSideChat` for richer accounting.
 */
const NO_USAGE = { inputTokens: 0, outputTokens: 0 } as const

/**
 * Generate a synthetic sessionId for the side-chat — namespaced under the
 * main session id so trace stitching is possible without cross-pollution.
 */
const mintSideSessionId = (mainSessionId: string): string => {
  const nonce = Math.random().toString(36).slice(2, 10)
  return `side:${mainSessionId}:${nonce}`
}

/**
 * Run one isolated side-chat exchange. The main session is untouched — see
 * the invariants block at the top of this file.
 *
 * Failure modes propagate identically to {@link runAgent}: the caller's
 * surface decides how to render an error (the CLI typically paints a red
 * line and continues the main loop).
 */
export const runSideChat = async (input: SideChatInput): Promise<SideChatResult> => {
  const inheritance = input.contextInheritance ?? "system"
  const allowlist = input.toolAllowlist ?? SIDE_CHAT_DEFAULT_READ_ONLY
  const requestedTurns = input.maxTurns ?? 3
  const maxTurns = Math.max(1, Math.min(requestedTurns, SIDE_CHAT_MAX_TURNS_CAP))

  const filteredRegistry = buildSideChatRegistry(input.deps.registry, allowlist)
  const inherited = buildSideChatHistory(input.mainHistory, inheritance)
  const userTurn: Message = {
    role: "user",
    content: [{ type: "text", text: input.prompt }],
  }
  const messages: Message[] = [...inherited, userTurn]

  // Build an ISOLATED deps view: same LLM/stream/permission/system, FILTERED
  // registry, NO store/sessionId of the main session, NO metrics/run/memory.
  // `signal`/`maxTurns` are replaced with our caps. The `onConfirm` of the
  // main session is preserved so a user-confirm prompt (if any tool requests
  // one) still routes through the same UX — but in practice the default
  // read-only allowlist contains no tools that fire `onConfirm`.
  const isolatedDeps: OrchestrateDeps = {
    ...input.deps,
    registry: filteredRegistry,
    maxTurns,
    signal: input.signal,
    store: undefined,
    sessionId: mintSideSessionId(input.deps.sessionId),
    embedder: undefined,
    memoryConfig: undefined,
    metrics: undefined,
    run: undefined,
    subagentConfig: undefined,
    compactionBreakerConfig: undefined,
    verifyGuardConfig: undefined,
    summarizerLlm: undefined,
    workMetricsSink: undefined,
    // Plan mode is a posture of the MAIN session — never inherited by a
    // side-chat (it would change the model's sticky behavior).
    planMode: false,
  }

  const outcome = await runAgent(input.assembleConfig(messages, isolatedDeps))

  return {
    outcome,
    answerText: extractAnswerText(outcome),
    inputTokens: NO_USAGE.inputTokens,
    outputTokens: NO_USAGE.outputTokens,
    toolsAvailable: filteredRegistry.specs().length,
  }
}
