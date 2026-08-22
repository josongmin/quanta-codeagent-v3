/** ADR-0470 (jun-04) — closed-port for the inbound MCP `sampling/createMessage`
 *  RPC (server → client inference delegation).
 *
 *  ## Why a port (the advertise-iff-able principle)
 *
 *  A connected MCP server may ask US to run an LLM completion on its behalf
 *  (`sampling/createMessage`, rmcp 0.15). Fulfilling that requires an LLM, but
 *  `@/mcp` MUST NOT import `@/llm` (slice isolation, RFC §3.1) — exactly the
 *  same constraint that forced {@link ElicitationPrompter} to be an injected
 *  DI seam. So sampling fulfillment arrives through THIS port, wired at the
 *  composition root (the only slice allowed to reach `@/llm`).
 *
 *  The structural rule this port enforces: **never advertise a capability you
 *  cannot fulfill.** The MCP client advertises `sampling: {}` to the server
 *  IFF a real {@link SamplingHandlerPort} is wired. When none is wired the
 *  client falls back to {@link headlessSamplingRejecter}, which DECLINES, and
 *  the capability is NOT advertised — so a well-behaved server never sends the
 *  request, and a misbehaving one gets a well-defined decline rather than a
 *  dropped request or a `-32601` after a false promise.
 *
 *  ## Consent posture (HITL)
 *
 *  Running a model on a remote server's prompt is a privileged action. The
 *  default ({@link headlessSamplingRejecter}) declines, so consent is OPT-IN:
 *  a deployment must deliberately wire a handler (which can itself prompt the
 *  user before delegating). No throws — the contract is total.
 */

/** A single message in the sampling conversation. Mirrors the rmcp 0.15
 *  `SamplingMessage` shape narrowly — only the fields we pass through. The
 *  `content` is left as `unknown` (text / image block union) because the
 *  composition-root handler owns the codec, exactly as `@/mcp/tasks` owns the
 *  per-method task codec rather than baking shapes into the transport core. */
export interface SamplingMessage {
  readonly role: "user" | "assistant"
  readonly content: unknown
}

/** The inbound `sampling/createMessage` request params (rmcp 0.15). Only the
 *  fields a handler needs to run a completion are narrowed; unknown extras on
 *  the wire are ignored, not rejected. */
export interface CreateMessageRequest {
  readonly messages: ReadonlyArray<SamplingMessage>
  readonly systemPrompt?: string
  readonly maxTokens?: number
  readonly modelPreferences?: unknown
  readonly metadata?: unknown
}

/** The successful `sampling/createMessage` result the server is waiting for
 *  (rmcp 0.15 `CreateMessageResult`). The handler decides the concrete model
 *  text/role/stopReason; this is the shape we serialize back as the JSON-RPC
 *  `result`. */
export interface CreateMessageResult {
  readonly role: "assistant"
  readonly content: unknown
  readonly model: string
  readonly stopReason?: string
}

/** Why a sampling request was declined. A closed union so callers branch
 *  without string-matching. `no-handler` is the default-OFF case (no real
 *  handler wired); `user-denied` is an interactive refusal; `error` is any
 *  unexpected handler failure mapped to a total result. */
export type SamplingDeclineReason = "no-handler" | "user-denied" | "error"

/** Closed result union for the port: a fulfilled completion or a typed
 *  decline. No throws — the handler contract is total, mirroring
 *  {@link import("../elicitation/port").ElicitationResult}. */
export type SamplingOutcome =
  | { readonly ok: true; readonly result: CreateMessageResult }
  | { readonly ok: false; readonly reason: SamplingDeclineReason }

/** Closed-port: the only thing the MCP client needs is "given the inbound
 *  request, produce an outcome (fulfilled or declined), never throwing." The
 *  composition root supplies an `@/llm`-backed impl; the slice ships only the
 *  seam + a safe default. */
export interface SamplingHandlerPort {
  createMessage(req: CreateMessageRequest, signal?: AbortSignal): Promise<SamplingOutcome>
}
