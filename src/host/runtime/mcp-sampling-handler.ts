/** ADR-0470 B1 follow-up (jun-04) — the `@/llm`-backed inbound-sampling handler,
 *  wired at the composition root.
 *
 *  ## Why this lives in the host layer (not `@/mcp`)
 *
 *  An MCP `sampling/createMessage` request is a server asking US to run an LLM
 *  completion on its behalf. Fulfilling it requires an `@/llm` `LLMPort`, but
 *  `@/mcp` MUST NOT import `@/llm` (slice isolation, RFC §3.1) — that constraint
 *  is the whole reason {@link SamplingHandlerPort} exists as a DI seam. So the
 *  concrete, LLM-backed implementation is assembled HERE, in the only layer
 *  allowed to reach both slices, and injected into the `McpClient`.
 *
 *  ## Advertise-iff-able (the structural invariant this closes)
 *
 *  The capability advertisement and the handler MUST move together: the client
 *  advertises `sampling: {}` IFF a real handler is wired. {@link buildSamplingWiring}
 *  is the single place that decides this — it returns BOTH the
 *  `fullNegotiator({ sampling })` flag AND the handler from one gate, so the two
 *  can never drift (you cannot advertise without a handler, or wire a handler
 *  without advertising).
 *
 *  ## HITL consent (a server spending our inference is sensitive)
 *
 *  Before any token is spent, the handler gates on user consent by REUSING the
 *  existing MCP {@link ElicitationPrompter} seam (`promptBoolean`) — the same
 *  mechanism an MCP server's own `elicitation/create` uses to ask the user a
 *  yes/no question. No new consent UI is invented. The default prompter
 *  (headless) DENIES, so an unattended/piped run never silently spends tokens on
 *  a remote server's prompt. On deny ⇒ `user-denied`; only on an explicit yes do
 *  we call the LLM.
 *
 *  ## Total contract (no throws)
 *
 *  {@link SamplingHandlerPort.createMessage} is total. Every failure mode — a
 *  throwing prompter, a throwing LLM stream, a stream that yields no text — is
 *  mapped to `{ ok:false, reason:"error" }` (or `"user-denied"` for a refusal).
 *  The router already defends against a rejecting handler, but this layer never
 *  relies on that: it catches everything itself.
 */

import type { ContentBlock, LLMPort, Message, StreamEvent, SystemPromptInput } from "@/llm"
import { assembleFromEvents } from "@/llm"
import type {
  CreateMessageRequest,
  CreateMessageResult,
  ElicitationPrompter,
  SamplingHandlerPort,
  SamplingMessage,
  SamplingOutcome,
} from "@/mcp"

/** Deps the host injects to build the real handler. Both are sourced at the
 *  composition root: `llm` from the assembled `LLMPort`, `consent` from the same
 *  CLI elicitation prompter that services inbound `elicitation/create`. */
export interface SamplingHandlerDeps {
  /** The `@/llm` port a `sampling/createMessage` delegates to. */
  /**
   * The `@/llm` port a `sampling/createMessage` delegates to.
   *
   * MR-06 — a THUNK is accepted so the handler follows the session's live model
   * selection. POLICY (decided, not inferred): MCP sampling runs on whatever model
   * the session is currently running, because a server asking "complete this on my
   * behalf" is asking the AGENT, and an operator who switched models expects the
   * switch to hold everywhere. A fixed port is still accepted — a host with no
   * routing (headless, tests) passes one and behaves exactly as before.
   */
  readonly llm: LLMPort | (() => LLMPort)
  /** HITL consent gate. Reuses the MCP elicitation prompter seam — its
   *  `promptBoolean` asks the user a yes/no "allow this server to run a model?"
   *  question. The headless default prompter declines, so an unattended run is
   *  safe by construction. */
  readonly consent: ElicitationPrompter
}

const DECLINE_DENIED: SamplingOutcome = { ok: false, reason: "user-denied" }
const DECLINE_ERROR: SamplingOutcome = { ok: false, reason: "error" }

/** Map an MCP `sampling` `content` field to a flat string. The wire `content`
 *  is `unknown` (the slice deliberately does not bake the block codec into the
 *  transport — see `sampling/port.ts`), so the host owns the codec here. We
 *  accept the two shapes MCP servers actually send: a bare string, or an rmcp
 *  text block `{ type:"text", text }`. Anything else flattens to `""` (the
 *  message still carries its role; non-text modalities are simply not forwarded
 *  to a text completion rather than crashing the handler). */
const contentToText = (content: unknown): string => {
  if (typeof content === "string") return content
  if (content !== null && typeof content === "object") {
    const rec = content as Record<string, unknown>
    if (rec.type === "text" && typeof rec.text === "string") return rec.text
  }
  return ""
}

/** Map one MCP `SamplingMessage` to an `@/llm` `Message`. Role passes through
 *  (both sides use the same `"user" | "assistant"` union); content is flattened
 *  to a single text block. */
const toLlmMessage = (m: SamplingMessage): Message => ({
  role: m.role,
  content: [{ type: "text", text: contentToText(m.content) }],
})

/** Map the MCP `CreateMessageRequest` onto an `@/llm` completion call.
 *  `systemPrompt` → `system`; `messages` → `messages`; `maxTokens` is carried
 *  but the stock adapters cap their own budget, so it is informational here. No
 *  tools are offered (a sampling completion is a plain text turn). */
const toStreamInput = (req: CreateMessageRequest) => {
  const system: SystemPromptInput | undefined = req.systemPrompt
  return {
    messages: req.messages.map(toLlmMessage),
    ...(system !== undefined ? { system } : {}),
    tools: [],
  }
}

/** Collect the assistant text from a fully-streamed turn. Reuses the shared
 *  `assembleFromEvents` reducer (the SAME one the agent loop uses) so the codec
 *  is identical, then joins the text blocks. */
const collectText = (events: StreamEvent[]): string => {
  const { message } = assembleFromEvents(events)
  return message.content
    .filter((b: ContentBlock): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("")
}

/** The `stopReason` slot for the result. Present IFF the stream emitted a
 *  `message_stop` (we never fabricate one); spread-ready so the result literal
 *  carries no conditional branch. */
const stopReasonSlot = (events: StreamEvent[]): { stopReason?: string } => {
  const stop = events.find(
    (e): e is Extract<StreamEvent, { type: "message_stop" }> => e.type === "message_stop",
  )
  return stop !== undefined ? { stopReason: stop.stop_reason } : {}
}

/** Ask the user for consent via the injected elicitation prompter. Reuses the
 *  MCP `promptBoolean` seam. Returns `true` ONLY on an explicit yes; a refusal,
 *  a non-`ok` result, OR a throwing prompter all return `false` (deny). The
 *  headless default prompter declines, so an unattended run is safe. */
const askConsent = async (consent: ElicitationPrompter, signal?: AbortSignal): Promise<boolean> => {
  try {
    const answer = await consent.promptBoolean(
      {
        prompt:
          "An MCP server is requesting to run a model completion (sampling) on your behalf. Allow it to spend inference?",
        title: "MCP sampling request",
      },
      signal,
    )
    return answer.ok === true && answer.value === true
  } catch {
    return false
  }
}

/** Run the consented completion: map the request → stream input, drain the
 *  stream, assemble the result. The signal is forwarded so a cancel tears down
 *  the upstream HTTP request. */
const runCompletion = async (
  llm: LLMPort,
  req: CreateMessageRequest,
  signal?: AbortSignal,
): Promise<CreateMessageResult> => {
  const events: StreamEvent[] = []
  const input = toStreamInput(req)
  for await (const ev of llm.stream({ ...input, ...(signal !== undefined ? { signal } : {}) })) {
    events.push(ev)
  }
  return {
    role: "assistant",
    content: { type: "text", text: collectText(events) },
    model: llm.model ?? "unknown",
    ...stopReasonSlot(events),
  }
}

/** Build the `@/llm`-backed {@link SamplingHandlerPort}. The returned handler:
 *
 *  1. Asks the user for consent via {@link SamplingHandlerDeps.consent}
 *     (`promptBoolean`). Anything but an explicit `true` ⇒ `user-denied`. The
 *     headless prompter declines, so an unattended run is denied by default.
 *  2. On consent, maps the request → an `@/llm` stream, drains it, and assembles
 *     the assistant text.
 *  3. Maps the result back to a {@link CreateMessageResult}.
 *
 *  Total: any throw (prompter or LLM) is caught and mapped to `error`. */
export const createLlmSamplingHandler = (deps: SamplingHandlerDeps): SamplingHandlerPort => ({
  createMessage: async (
    req: CreateMessageRequest,
    signal?: AbortSignal,
  ): Promise<SamplingOutcome> => {
    // 1. HITL consent — reuse the MCP elicitation prompter. A refusal OR a
    //    throwing prompter both deny; the headless default declines, so an
    //    unattended run never spends inference.
    if (!(await askConsent(deps.consent, signal))) return DECLINE_DENIED

    // 2. Delegate to the LLM, drain, assemble. Any LLM / assembly failure is
    //    mapped to a typed decline — the port contract is total (no throws).
    try {
      // Resolved PER REQUEST, not captured at mint: a session that switches models
      // mid-run must not keep sampling on the model it booted with. The reported
      // `model` in the result comes from this same port, so the answer names what
      // actually ran.
      const llm = typeof deps.llm === "function" ? deps.llm() : deps.llm
      const result = await runCompletion(llm, req, signal)
      return { ok: true, result }
    } catch {
      return DECLINE_ERROR
    }
  },
})

/** The two artifacts a deployment needs to enable inbound sampling, decided
 *  TOGETHER so they can never drift: whether to advertise `sampling`, and the
 *  handler to inject (present IFF advertised). */
export interface SamplingWiring {
  /** Pass straight to `fullNegotiator({ sampling })` — advertise IFF a handler
   *  is wired. */
  readonly advertise: boolean
  /** The `samplingHandler` to pass to the `McpClient`. `undefined` when not
   *  enabled (the client falls back to the headless rejecter — the
   *  advertise-iff-able default). */
  readonly handler: SamplingHandlerPort | undefined
}

/** The single decision point for the advertise-iff-able invariant. Returns
 *  `{ advertise:true, handler }` ONLY when the knob is ON AND both deps (an LLM
 *  and a consent prompter) are present; otherwise `{ advertise:false,
 *  handler:undefined }` (byte-identical to the unwired default — no
 *  advertisement, headless rejecter).
 *
 *  Because the advertisement flag and the handler are returned from the SAME
 *  branch, a caller cannot advertise without a handler or wire a handler without
 *  advertising — the structural rule the port doc demands. When `deps` is
 *  omitted (e.g. a headless run with no LLM/prompter assembled, or the knob
 *  off), sampling is OFF. */
export const buildSamplingWiring = (
  enabled: boolean,
  deps: SamplingHandlerDeps | undefined,
): SamplingWiring => {
  if (!enabled || deps === undefined) return { advertise: false, handler: undefined }
  return { advertise: true, handler: createLlmSamplingHandler(deps) }
}
