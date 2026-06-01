/**
 * Tier-1 per-subsystem builder: ADVISOR block (ADR-0257).
 *
 * Returns the `advisor` tool when `config.advisor` is wired; empty array
 * otherwise.
 *
 * DEFAULT-OFF: `config.advisor` absent ⇒ this builder returns [], so the loop
 * sees no extra tool and the ToolRegistry stays byte-identical. Mirrors
 * `buildDelegateBlock` / `buildWebSearchBlock` posture.
 *
 * SLICE FENCE: the `@/tool/advisor` slice declares a DUCK-TYPED `AdvisorPort`
 * (`consult` + `listModels`) so it never imports `@/agent` nor the concrete LLM
 * wiring. This builder is the composition root that adapts the
 * `AgentConfig.advisor` slot (host-built one-shot `consult` + `models`
 * allowlist) into that port.
 *
 * The host typically builds `config.advisor.consult` via
 * {@link advisorConsultFromLLM}, which runs a genuine ONE-SHOT `LLMPort`
 * completion against a resolved advisor model — that is where the "consult a
 * stronger / different model" mechanism actually lives. The tool itself stays a
 * pure pass-through.
 */

import { assembleFromEvents, type LLMPort, type StreamEvent } from "@/llm"
import { errMessage } from "@/shared"
import type { Tool } from "@/tool"
import {
  type AdvisorConsultRequest,
  type AdvisorConsultResult,
  type AdvisorPort,
  advisorTools,
} from "@/tool/advisor"
import type { AgentConfig } from "../types"

/** Build the advisor tool when the slot is wired. */
export const buildAdvisorBlock = (config: AgentConfig): Tool[] => {
  const advisor = config.advisor
  if (advisor === undefined) return []
  const port: AdvisorPort = {
    consult: advisor.consult,
    listModels: () => advisor.models ?? [],
  }
  return advisorTools(port)
}

/** Options for {@link advisorConsultFromLLM}. */
export interface AdvisorConsultFromLLMOptions {
  /** The configured advisor LLM (the STRONGER / DIFFERENT model). */
  readonly llm: LLMPort
  /** Resolve the model id to use for a consult. The composition root composes
   *  ADR-0256 role-model-override here by closing over a `RoleModelResolver`
   *  and returning `resolver.resolve(<advisor-role>, default)` — kept as a
   *  callback so this helper does NOT widen the user-owned closed `Role` enum.
   *  `requested` is the EXPLICIT model the model asked for (already validated
   *  against the allowlist by the tool); when present the resolver SHOULD honor
   *  it. */
  readonly resolveModel: (requested?: string) => string
  /** Optional system framing for the advisor turn. */
  readonly system?: string
}

/** Compose the single user turn handed to the advisor: the question, plus the
 *  optional context appended verbatim. */
const composeUserText = (req: AdvisorConsultRequest): string =>
  req.context !== undefined && req.context.length > 0
    ? `${req.question}\n\nContext:\n${req.context}`
    : req.question

/** Drain a one-shot assistant turn into the assembled, trimmed text. */
const collectAnalysis = (events: readonly StreamEvent[]): string =>
  assembleFromEvents([...events])
    .message.content.filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim()

/** Stream the single advisor turn into events. NO-THROW: a provider throw
 *  collapses to a typed `ok:false` result (cancelled when the signal tripped,
 *  else advisor-error). */
const streamConsultTurn = async (
  opts: AdvisorConsultFromLLMOptions,
  req: AdvisorConsultRequest,
): Promise<{ ok: true; events: StreamEvent[] } | { ok: false; result: AdvisorConsultResult }> => {
  const events: StreamEvent[] = []
  try {
    const stream = opts.llm.stream({
      messages: [{ role: "user", content: [{ type: "text", text: composeUserText(req) }] }],
      tools: [],
      ...(opts.system !== undefined ? { system: opts.system } : {}),
      ...(req.signal !== undefined ? { signal: req.signal } : {}),
    })
    for await (const ev of stream) events.push(ev)
  } catch (e) {
    // Re-read the signal at catch time — flow narrowing from any pre-stream
    // guard does NOT apply to an externally mutable AbortSignal.
    const errorKind = (req.signal?.aborted ?? false) ? "cancelled" : "advisor-error"
    return { ok: false, result: { ok: false, errorKind, errorMessage: errMessage(e) } }
  }
  return { ok: true, events }
}

/**
 * Build a one-shot `consult` from a concrete `LLMPort`. This is the genuine
 * "run a ONE-SHOT LLMPort completion using a configured advisor model"
 * mechanism: it streams a SINGLE assistant turn (no tools offered ⇒ the advisor
 * cannot call tools or mutate anything), assembles the text, and returns it.
 *
 * NO-THROW: every operational failure (provider error, empty output, abort)
 * collapses to a typed `ok:false` {@link AdvisorConsultResult} — the tool's
 * port contract.
 */
export const advisorConsultFromLLM =
  (opts: AdvisorConsultFromLLMOptions) =>
  async (req: AdvisorConsultRequest): Promise<AdvisorConsultResult> => {
    const modelUsed = opts.resolveModel(req.model)
    if (req.signal?.aborted === true) {
      return { ok: false, errorKind: "cancelled", errorMessage: "aborted before consult" }
    }
    const turn = await streamConsultTurn(opts, req)
    if (!turn.ok) return turn.result
    const analysis = collectAnalysis(turn.events)
    if (analysis.length === 0) {
      return { ok: false, errorKind: "empty-analysis", errorMessage: "advisor returned no text" }
    }
    return { ok: true, analysis, modelUsed }
  }
