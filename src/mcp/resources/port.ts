/** H19 (jun-3-misc §3) — typed shapes for the MCP `resources/*`, `prompts/*`,
 *  and `roots/*` method families (rmcp 0.15 / MCP spec 2025-06-18).
 *
 *  ## Direction split
 *
 *  `resources/*` and `prompts/*` are OUTBOUND (client → server): the client asks
 *  a connected server to list/read its resources or fetch a prompt template.
 *
 *  `roots/list` is INBOUND (server → client): the server asks US which
 *  filesystem roots the agent is operating in. We answer from a configured
 *  {@link RootsProviderPort}, mirroring the elicitation/sampling inbound DI seam
 *  — `@/mcp` never reaches the host's notion of "the workspace", so the host
 *  injects the roots source.
 *
 *  ## Advertise-iff-able (same rule as B1 sampling)
 *
 *  The client advertises `roots` to the server IFF a real {@link RootsProviderPort}
 *  is wired. Advertising `roots` while having no source would promise a
 *  `roots/list` answer we can't honestly produce. Default-OFF: no provider ⇒ no
 *  advertisement ⇒ byte-identical negotiation.
 */

// --- resources -------------------------------------------------------------

/** One entry from `resources/list`. Only `uri` is required by the spec; the
 *  rest are optional descriptors. Extra wire fields are ignored, not rejected. */
export interface McpResource {
  readonly uri: string
  readonly name?: string
  readonly mimeType?: string
  readonly description?: string
}

/** One content block from `resources/read`. The spec returns `contents:[{...}]`
 *  where each block is EITHER `text` (UTF-8) OR `blob` (base64). We pass both
 *  through optionally; a well-formed block has exactly one populated. */
export interface McpResourceContent {
  readonly uri: string
  readonly mimeType?: string
  readonly text?: string
  readonly blob?: string
}

// --- prompts ---------------------------------------------------------------

/** A declared argument for a prompt template (from `prompts/list`). */
export interface McpPromptArgument {
  readonly name: string
  readonly description?: string
  readonly required?: boolean
}

/** One entry from `prompts/list`. */
export interface McpPrompt {
  readonly name: string
  readonly description?: string
  readonly arguments?: ReadonlyArray<McpPromptArgument>
}

/** One message from `prompts/get`. `content` is passed through verbatim (text /
 *  image / resource block union) — the consumer owns the block codec, exactly
 *  as the sampling slice leaves `SamplingMessage.content` as `unknown`. */
export interface McpPromptMessage {
  readonly role: "user" | "assistant"
  readonly content: unknown
}

/** Typed `prompts/get` result. `description` is the optional human label the
 *  server returns alongside the rendered `messages`. */
export interface McpPromptResult {
  readonly messages: ReadonlyArray<McpPromptMessage>
  readonly description?: string
}

// --- roots (inbound) -------------------------------------------------------

/** One filesystem root the agent is operating in (MCP spec `Root`). `uri` is a
 *  `file://` URI; `name` is an optional display label. */
export interface McpRoot {
  readonly uri: string
  readonly name?: string
}

/** Closed-port the host injects to answer inbound `roots/list`. The host is the
 *  only slice that knows the workspace layout; `@/mcp` must not reach it (slice
 *  isolation), so the source arrives through this seam. A wired provider is the
 *  single signal that authorizes advertising `roots`. */
export interface RootsProviderPort {
  /** Current roots. SYNC + total: the client answers an inbound `roots/list`
   *  immediately, so this must not throw and must not be async. */
  listRoots(): ReadonlyArray<McpRoot>
}

// --- typed result union ----------------------------------------------------

/** Why a resources/prompts call could not be fulfilled. A closed union so
 *  callers branch without string-matching.
 *   - `unsupported` — the server did not advertise the required capability
 *     (we refuse locally rather than emitting a request the server answers with
 *     a raw `-32601`);
 *   - `malformed` — the server's response did not match the expected shape;
 *   - `transport` — the underlying request failed (timeout, server error,
 *     transport exit). */
export type McpResourceFailure = "unsupported" | "malformed" | "transport"

/** No-throw result for every outbound typed method: a fulfilled value or a
 *  typed failure. Mirrors {@link import("../sampling/port").SamplingOutcome}. */
export type McpResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: McpResourceFailure; readonly message: string }
