/**
 * Side-conversation dispatch router seam (ADR-0049 R5 follow-up).
 *
 * Split out of `side-conversation.ts` (#10): the DISPATCH indirection layer
 * decouples external (UI/CLI/RPC) callers from the executor's
 * {@link SideConversationOptions} surface. Callers describe WHAT they want
 * ({@link SideConversationRequest}); the host-supplied {@link SideConversationResolver}
 * decides which LLM port + tool list to use; {@link dispatchSideConversation}
 * wires the two together and delegates to `runSideConversation` in `./run.ts`.
 */

import type { LLMPort, ToolSchema } from "@/llm"
import {
  assertSideConversationEffort,
  runSideConversation,
  type SideConversationEffort,
  type SideConversationOptions,
  type SideConversationSpanAttributes,
} from "./run"

/**
 * UI/CLI-facing request shape. Decouples external callers from the
 * `SideConversationOptions` surface (no need to know about `llm` / `tools` —
 * the dispatcher resolves those).
 */
export interface SideConversationRequest {
  parentSessionId: string
  question: string
  /** Model id hint (advisory; the resolver may map to a cheaper sibling). */
  model?: string
  effort?: SideConversationEffort
}

/** UI/CLI-facing response shape. */
export interface SideConversationResponse {
  answer: string
  tokens: { input: number; output: number }
  durationMs: number
}

/**
 * Resolver supplied by the host. Decides which LLM port and tool list to use
 * for a given request. The dispatcher does NOT pick the model itself — the
 * host knows which provider+key is available, so it owns that choice (and
 * therefore the cost/latency tradeoff per ADR-0049 §"model selection").
 */
export interface SideConversationResolver {
  resolveLlm(req: SideConversationRequest): LLMPort
  resolveTools?(req: SideConversationRequest): ToolSchema[]
  /** Optional observe sink; passed through to {@link runSideConversation}. */
  observe?(span: SideConversationSpanAttributes): void
  /** Optional abort signal (typically the parent turn's). */
  signal?: AbortSignal
}

/**
 * Public router. UI surfaces (composer sub-thread input, CLI slash-command,
 * desktop sidebar) call this; the host injects the resolver and the parent
 * abort signal. Parent agent loop is NEVER interrupted — this function does
 * not touch any shared state, mutex, or message buffer.
 */
export const dispatchSideConversation = async (
  req: SideConversationRequest,
  resolver: SideConversationResolver,
): Promise<SideConversationResponse> => {
  // Re-validate effort here too: the request shape arrives from an external
  // boundary (RPC/UI), so we cannot trust the type system alone.
  if (req.effort !== undefined) assertSideConversationEffort(req.effort)

  // Build the options object via spreads so `exactOptionalPropertyTypes` is
  // honored — never assign `undefined` to a non-`undefined` optional slot.
  const tools = resolver.resolveTools?.(req)
  const opts: SideConversationOptions = {
    parentSessionId: req.parentSessionId,
    question: req.question,
    llm: resolver.resolveLlm(req),
    ...(tools !== undefined ? { tools } : {}),
    ...(req.effort !== undefined ? { effort: req.effort } : {}),
    ...(resolver.signal !== undefined ? { signal: resolver.signal } : {}),
    ...(resolver.observe !== undefined ? { observe: resolver.observe } : {}),
  }
  const result = await runSideConversation(opts)
  return {
    answer: result.answer,
    tokens: result.tokens,
    durationMs: result.durationMs,
  }
}
