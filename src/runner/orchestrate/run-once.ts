import { type AgentConfig, type AgentOutcome, runAgent } from "@/agent"
import type { ContentBlock, ImageBlock, LLMPort, Message } from "@/llm"
import type { EmbedderPort, PersistentStorePort } from "@/memory"
import type { Metrics } from "@/observability"
import type { PermissionContext, ToolAction } from "@/permission"
import type { SessionMeta } from "@/session"
import type { RunContext } from "@/shared"
import type { StreamPort } from "@/stream"
import type { ToolRegistry } from "@/tool"
import { persistTurn } from "./persist-turn"
import { normalizePromptPayload, type PromptPayload } from "./prompt-source"

/**
 * Surface-AGNOSTIC one-shot turn orchestration.
 *
 * Extracted from `apps/cli/repl.ts::runRepl` (the argv-prompt branch) so the
 * "assemble + one turn + persist + shutdown" path is reusable from any
 * surface (CLI argv-prompt, Web HTTP POST, Tauri IPC). Per RFC 3.1, this
 * Layer-2 slice takes plain typed config — surface entries do their own
 * argv/env/HTTP parsing into a {@link RunOnceInput} and call us.
 *
 * BYTE-IDENTICAL invariant:
 *   - Every default-OFF gate (`store`/`metrics`/`run`/`mcpClients`/...) is
 *     preserved verbatim — the gates that were inline in `runRepl` are now
 *     inline here with the same shape.
 *   - `runAgent(assembleConfig(history, deps))` is called identically.
 *   - `persistTurn` is called identically.
 *   - Mcp shutdown is in a `finally` block, identical ordering.
 *
 * NON-GOALS:
 *   - Status bar, raw-line-reader, Esc-Esc keypress cancel — those are
 *     UI primitives that stay in `apps/cli/repl.ts` (surface-specific).
 *   - Interactive loop — covered by a sibling `run-interactive.ts` in a
 *     follow-up (partial adoption per RFC).
 */

/** Per-turn `AgentConfig` assembly inputs — mirror of `SessionDeps` from
 *  `apps/cli/config-assemble.ts`, but lifted into the Layer-2 slice so a
 *  non-CLI surface can build it without depending on `apps/cli`. The CLI
 *  surface keeps using its own `SessionDeps` (a structural superset) and
 *  passes it here unchanged.
 *
 *  Kept as a plain object so a Web/Tauri surface can construct one directly
 *  without importing CLI-only types. */
export interface OrchestrateDeps {
  llm: LLMPort
  registry: ToolRegistry
  stream: StreamPort
  permission: PermissionContext
  system: string
  cwd: string
  maxTurns: number
  signal: AbortSignal
  onConfirm: (action: ToolAction) => Promise<boolean>
  store: PersistentStorePort | undefined
  sessionId: string
  embedder: EmbedderPort | undefined
  memoryConfig: AgentConfig["memory"] | undefined
  planMode: boolean
  metrics: Metrics | undefined
  run: RunContext | undefined
  subagentConfig: AgentConfig["subagent"] | undefined
  skillsConfig: AgentConfig["skills"] | undefined
  compactionBreakerConfig: AgentConfig["compactionBreaker"] | undefined
  verifyGuardConfig: AgentConfig["verifyGuard"] | undefined
  summarizerLlm: LLMPort | undefined
  onShellEvent: AgentConfig["onShellEvent"] | undefined
  workMetricsSink: AgentConfig["workMetricsSink"] | undefined
}

/** Inputs for {@link runOnce}. All fields are typed config — no argv/env
 *  reads happen in this module. */
export interface RunOnceInput {
  /** Per-turn deps as assembled by the surface (env → deps mapping is
   *  surface-specific; e.g. CLI does it in `internal.ts#buildTooling` +
   *  `repl.ts`). */
  deps: OrchestrateDeps
  /** Build the final per-turn `AgentConfig` from `(messages, deps)`. The
   *  CLI passes its `assembleConfig` from `apps/cli/config-assemble.ts`;
   *  other surfaces may reuse the same function (it has no surface deps)
   *  or supply their own assembler. Injected as a port so this slice stays
   *  free of CLI-internal imports. */
  assembleConfig: (messages: Message[], deps: OrchestrateDeps) => AgentConfig
  /** Conversation history at the start of the turn. The user prompt is
   *  appended to this list before `runAgent` is called. Empty for fresh
   *  one-shot runs; pre-populated when resuming a session. */
  history: Message[]
  /** The user prompt to run. Accepts either a plain string (the original
   *  shape — byte-identical for text-only callers) OR a {@link PromptPayload}
   *  envelope `{ text, images? }` so a multi-modal surface can attach images
   *  to THIS turn's user message without a separate `pendingImages` field.
   *  Internally normalized to `{ text, images }`; `pendingImages` and the
   *  payload's `images` are CONCATENATED so existing CLI seed-image callers
   *  (passing `pendingImages` directly) keep working byte-identically. */
  prompt: PromptPayload
  /** ADR-0083 multi-modal — image blocks to attach to THIS turn's user
   *  message. Empty by default (text-only, byte-identical to today).
   *  Concatenated with any images carried via {@link prompt} when both are
   *  supplied (legacy CLI uses this field; multi-modal `PromptSource`
   *  surfaces use the payload form). */
  pendingImages?: ImageBlock[]
  /** Path-mode transcript save path. Default OFF → no path-mode save. */
  state: string | undefined
  /** Id-mode session meta (set by a prior resume FSM resolution).
   *  Default OFF → no id-mode auto-save. */
  idMeta: SessionMeta | undefined
  /** Optional post-turn hook for the surface to render metrics / dashboards
   *  (the CLI uses this to paint the cost+cache dashboard to stderr). Receives
   *  the post-turn outcome + the (mutated) history list. */
  onTurnEnd?: (event: { outcome: AgentOutcome; messages: Message[] }) => void | Promise<void>
  /** Optional MCP clients to stop after the turn (mirrors the CLI's
   *  `shutdownMcp` in the `finally` of `runRepl`). Default empty. */
  mcpClients?: Array<{ stop: () => Promise<void> }>
}

/** Result of {@link runOnce}. */
export interface RunOnceResult {
  outcome: AgentOutcome
  /** Post-turn message history (includes the user prompt + every assistant
   *  + tool turn). */
  messages: Message[]
}

/**
 * Run a single agent turn end-to-end: append the user prompt to history,
 * call `runAgent`, persist the turn (path-mode + id-mode, both default-OFF),
 * fire the optional `onTurnEnd` hook, and (finally) stop any MCP clients.
 *
 * Mirrors the argv-prompt branch of `runRepl` byte-identically when the
 * caller passes equivalent inputs. Errors from `runAgent` bubble up — the
 * surface decides how to render them (the CLI prints red + status-bar
 * transient; a Web surface would convert to an HTTP 5xx).
 */
export const runOnce = async (input: RunOnceInput): Promise<RunOnceResult> => {
  const { deps, assembleConfig, history, prompt, pendingImages, state, idMeta, onTurnEnd } = input
  const mcpClients = input.mcpClients ?? []
  try {
    // ADR-0083: normalize the prompt envelope. A plain string widens into
    // `{ text, images: [] }` — byte-identical when `pendingImages` is also
    // empty/undefined (the spreads below collapse to no-ops). A structured
    // payload merges its `images` with any legacy `pendingImages` so a
    // surface can pass via either path (or both).
    const { text, images: payloadImages } = normalizePromptPayload(prompt)
    const images = [...(pendingImages ?? []), ...payloadImages]
    const content: ContentBlock[] = [{ type: "text", text }, ...images]
    const next = [...history, { role: "user", content } as Message]
    const outcome = await runAgent(assembleConfig(next, deps))
    const messages = outcome.messages
    await persistTurn({ state, idMeta, sessionId: deps.sessionId, messages, outcome })
    if (onTurnEnd) await onTurnEnd({ outcome, messages })
    return { outcome, messages }
  } finally {
    for (const c of mcpClients) await c.stop().catch(() => undefined)
  }
}
