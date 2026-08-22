/** `advisor` — agent-callable SECOND-OPINION consult (ADR-0429).
 *
 *  Lets the model DELIBERATELY consult a STRONGER / DIFFERENT model mid-loop and
 *  get its analysis back in-band. Claude cc-cli ships `advisor_20260301{model}`;
 *  this is quanta's equivalent. It is ORTHOGONAL to the three things quanta
 *  already had:
 *   - model-swap-on-retry (ADR-0066) is FAILURE-DRIVEN and invisible to the
 *     model; advisor is a deliberate tool call.
 *   - role-model-override (ADR-0256) is a RESOLVER, not a callable tool.
 *   - delegate (ADR-0393) picks a MODE (and spawns a child agent), not a MODEL,
 *     and the child can mutate; advisor is a PURE one-shot consult.
 *
 *  PURE CONSULT — it runs ONE model completion and returns the text. It does
 *  NOT mutate files, run shells, or call other tools: `isReadOnly:true`,
 *  `hitlTier:"none"`, `isConcurrencySafe:true`. It exposes no
 *  `extractShellCommand`, so the permission gate can never route it through a
 *  shell / HARD_DENY path.
 *
 *  Output contract: NEVER throws past the loop. An explicit `model` outside the
 *  allowlist is rejected BEFORE the port is reached (typed `rejected`
 *  ToolFailure, port never consulted). Operational failures from the port
 *  (advisor-error / timeout / cancelled / empty-analysis) surface as an
 *  `ok:false` ToolResult whose `output` leads with the typed errorKind and whose
 *  `failure` carries the mapped {@link ToolFailure} so the model can branch on
 *  the KIND. A port that breaks its no-throw contract is caught and collapsed to
 *  a graceful `ok:false`.
 *
 *  Plane-clean: imports only `../types` + `zod` + `@/shared`. NO `@/agent`,
 *  NO `@/llm` — the consult mechanism lives behind {@link AdvisorPort}. */

import { z } from "zod"
import { errMessage } from "@/shared"
import type { Tool, ToolContext, ToolEvent, ToolFailure } from "../types"
import type {
  AdvisorConsultRequest,
  AdvisorConsultResult,
  AdvisorErrorKind,
  AdvisorPort,
} from "./port"

export const advisorInputSchema = z.object({
  question: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The question to put to the advisor model — a focused ask for a SECOND " +
        "OPINION (design trade-off, a tricky bug hypothesis, a review of your " +
        "plan). Be specific; the advisor sees this question + the optional " +
        "context. OPTIONAL — omit ONLY when you set forwardHistory:true.",
    ),
  context: z
    .string()
    .optional()
    .describe(
      "Optional supporting context handed to the advisor verbatim (a code " +
        "snippet, an error trace, the relevant constraints). Keep it tight — the " +
        "advisor is a one-shot consult, not a full session.",
    ),
  forwardHistory: z
    .boolean()
    .optional()
    .describe(
      "Forward your (REDACTED) conversation transcript to the advisor instead " +
        "of a hand-written context, so it sees the full task, tool calls, and " +
        "results. Use for a holistic 'review where I'm at' second opinion. " +
        "Secrets/PII in the transcript are scrubbed before they leave the loop.",
    ),
  model: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional explicit advisor model id. MUST be one of the configured " +
        "allowlist; an unlisted value is rejected (ok:false). Omit to let the " +
        "host resolve the default advisor model.",
    ),
})
export type AdvisorInput = z.infer<typeof advisorInputSchema>

/** Map a typed {@link AdvisorErrorKind} onto the canonical {@link ToolFailure}
 *  discriminant so the model branches on the KIND rather than regex-matching
 *  prose. */
const failureFor = (kind: AdvisorErrorKind, message: string): ToolFailure => {
  switch (kind) {
    case "timeout":
      return { mode: "timeout" }
    case "model-not-allowlisted":
      return { mode: "rejected", reason: "advisor_model_not_allowlisted" }
    case "cancelled":
      return { mode: "rejected", reason: "advisor_cancelled" }
    case "advisor-error":
    case "empty-analysis":
      return { mode: "error", modelVisibleError: message }
    default: {
      const _exhaustive: never = kind
      return { mode: "error", modelVisibleError: String(_exhaustive) }
    }
  }
}

/** Render a finished {@link AdvisorConsultResult} into model-facing text. On
 *  failure the typed `errorKind` leads the output. */
const formatResult = (r: AdvisorConsultResult): string =>
  r.ok
    ? `advisor (${r.modelUsed}):\n${r.analysis}`
    : `advisor failed (${r.errorKind}): ${r.errorMessage}`

/** Build the {@link AdvisorConsultRequest} from validated input + the abort
 *  signal, OMITTING absent optionals (exactOptionalPropertyTypes — never
 *  `undefined`-set). */
const inputToRequest = (input: AdvisorInput, signal: AbortSignal): AdvisorConsultRequest => ({
  // `question` is optional in forwardHistory mode; the port assembles the
  // (redacted) transcript and the question is purely supplementary. We forward
  // an empty string when omitted so the port's composeUserText stays total.
  question: input.question ?? "",
  ...(input.context !== undefined ? { context: input.context } : {}),
  ...(input.forwardHistory !== undefined ? { forwardHistory: input.forwardHistory } : {}),
  ...(input.model !== undefined ? { model: input.model } : {}),
  signal,
})

export const advisorTool = (port: AdvisorPort): Tool<AdvisorInput> => ({
  name: "advisor",
  description:
    "Consult a STRONGER or DIFFERENT model for a SECOND OPINION and get its " +
    "analysis back in-band. Use it deliberately for a hard design trade-off, a " +
    "stubborn bug hypothesis, or to have your plan reviewed by another model. " +
    "This is a PURE consult: the advisor only reads your question + optional " +
    "context and returns text — it cannot edit files, run commands, or call " +
    "tools. WHEN NOT TO USE: for routine steps you can do yourself, or when you " +
    "need the other model to actually DO work (use delegate for that).",
  inputSchema: advisorInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  hitlTier: () => "none",
  async *execute(input, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const parsed = advisorInputSchema.safeParse(input)
    if (!parsed.success) {
      yield {
        type: "result",
        result: { ok: false, output: `invalid input: ${parsed.error.message}` },
      }
      return
    }
    if (ctx.signal.aborted) {
      yield { type: "result", result: { ok: false, output: "aborted before start" } }
      return
    }
    // At-least-one-of {question, forwardHistory:true}. Neither ⇒ ok:false BEFORE
    // the port is reached (RFC jun-6 §5.1) — a bare `{}` is not a valid consult.
    const hasQuestion = typeof parsed.data.question === "string" && parsed.data.question.length > 0
    if (!hasQuestion && parsed.data.forwardHistory !== true) {
      yield {
        type: "result",
        result: { ok: false, output: "supply question or forwardHistory" },
      }
      return
    }
    // Fail-closed allowlist check for an EXPLICIT model BEFORE touching the
    // port — an unlisted model is a typed `rejected` and the port is never
    // consulted (so a stronger/costly model can't be invoked off-allowlist).
    if (parsed.data.model !== undefined && !port.listModels().includes(parsed.data.model)) {
      const message = `model "${parsed.data.model}" is not in the advisor allowlist`
      yield {
        type: "result",
        result: {
          ok: false,
          output: `advisor failed (model-not-allowlisted): ${message}`,
          failure: failureFor("model-not-allowlisted", message),
        },
      }
      return
    }
    const req = inputToRequest(parsed.data, ctx.signal)
    let result: AdvisorConsultResult
    try {
      result = await port.consult(req)
    } catch (e) {
      // The port contract is NO-THROW for operational failures; a throw here is
      // an unexpected (programmer-bug) path. Surface it as a graceful ok:false
      // rather than letting it bubble past the loop.
      const msg = errMessage(e)
      yield {
        type: "result",
        result: {
          ok: false,
          output: `advisor failed (advisor-error): ${msg}`,
          failure: { mode: "error", modelVisibleError: msg },
        },
      }
      return
    }
    yield {
      type: "result",
      result: result.ok
        ? { ok: true, output: formatResult(result) }
        : {
            ok: false,
            output: formatResult(result),
            failure: failureFor(result.errorKind, result.errorMessage),
          },
    }
  },
})
