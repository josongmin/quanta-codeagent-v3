import { LLMError } from "@/shared"
import type { LLMPort } from "../ports"
import type { StreamEvent, StreamInput } from "../types"

export interface ChatGPTOAuthConfig {
  readonly model: string
}

/** Phase 1 stub adapter for the ChatGPT-OAuth provider.
 *
 *  The OAuth credential plumbing (login / refresh / token store) ships in
 *  this slice. Actual model invocation against
 *  `https://chatgpt.com/backend-api/codex/...` is deferred to ADR-0094
 *  Phase 2: the precise endpoint path (`responses` vs `chat/completions`),
 *  SSE shape, and tool/usage payload diverge from the BYOK Chat Completions
 *  adapter, so it gets its own adapter rather than a baseURL switch on
 *  `OpenAIAdapter`.
 *
 *  Behavior today: `stream()` throws a typed LLMError with
 *  `kind: "not_implemented"` — never silent. The kind is fallback-eligible
 *  (FallbackLLM advances to the next provider) but NOT retry-eligible
 *  (same-provider retries are hopeless: the stub throws identically every
 *  time). `bad_request` would have been silently fatal — every retry/fallback
 *  predicate treats it as caller-bug and refuses to advance. `/login` +
 *  `/status` work fully against the token store; this stub only fires if a
 *  caller actually selects the provider for a model call.
 */
export class ChatGPTOAuthAdapter implements LLMPort {
  readonly model: string
  constructor(config: ChatGPTOAuthConfig) {
    this.model = config.model
  }

  // biome-ignore lint/correctness/useYield: Phase 1 stub — throws before any yield (ADR-0094).
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    throw new LLMError(
      "ChatGPT-OAuth model invocation is not wired in Phase 1 (ADR-0094). " +
        "Login + /status are functional; until Phase 2 lands, set " +
        "QUANTA_PROVIDER=openai (BYOK) for actual model calls.",
      { kind: "not_implemented", provider: "chatgpt-oauth" },
    )
  }
}
