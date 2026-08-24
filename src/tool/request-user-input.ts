import { z } from "zod"
import { errMessage } from "@/shared"
import { zodToJsonSchema } from "./schema"
import type { Tool, ToolContext, ToolEvent, ToolSpec, UserInputOutcome } from "./types"

/**
 * `request_user_input` tool (ADR-0097 draft) — sister tool of
 * `request_plan_exit`. Lets the model ask the operator a question and block on
 * a typed reply when it cannot infer the decision itself. Designed for use
 * inside plan-mode (a missing piece of information that turns the plan into a
 * gamble) but registered globally so any sub-agent can reach for it.
 *
 * Dispatch routes the call through `ToolContext.requestUserInput`, built (in a
 * future phase, P5/P6) from `AgentConfig.userInputPort`. The requester
 * resolves with a CLOSED 2-arm {@link UserInputOutcome}:
 *
 *   - `answer`    → the operator typed/selected a reply; the tool surfaces the
 *                   text as `ToolResult.output` and the model continues.
 *   - `cancelled` → the operator declined; the tool yields a typed `rejected`
 *                   failure (`reason: "user_cancelled"`) so the model can
 *                   branch on the KIND, not regex-match the output text.
 *
 * Absent port ⇒ graceful `ok:false` (mode `error`); never throws past the
 * loop. Read-only (it does not touch the FS or shell) + concurrency-UNSAFE
 * (it blocks on an operator decision and must never overlap other work).
 *
 * The closed-union discipline is structural: a future 3rd arm on
 * `UserInputOutcome` is a compile error at the `switch (outcome.decision)`
 * `never` default — there is NO heuristic / string-tag fallthrough.
 */
const schema = z.object({
  prompt: z
    .string()
    .min(1)
    .max(2000)
    .describe("The question to ask the operator (markdown ok). Required, ≤2000 chars."),
  choices: z
    .array(z.string().min(1))
    .max(12)
    .optional()
    .describe(
      "OPTIONAL fixed-choice list (each non-empty, ≤12 items) a surface may render as buttons.",
    ),
  multiline: z
    .boolean()
    .optional()
    .describe("OPTIONAL hint that the answer may span multiple lines."),
})
type Input = z.infer<typeof schema>

/** The tool's static model-facing description — hoisted so the static field and
 *  the RFC-05 E5b live `getSpec()` project the SAME bytes (the availability arm
 *  only decides PRESENT-vs-HIDDEN, never re-words the tool). */
const DESCRIPTION =
  "Ask the operator a question and wait for an answer. Returns answer text " +
  "or cancelled. Use inside plan-mode when you need a decision that the " +
  "model cannot infer."

/** RFC-05 E5b options. `available` is the LIVE question-posture predicate the
 *  block builder threads from `AgentConfig.questionGuard` (the SAME reader the
 *  pre-dispatch consult resolves through). When supplied, the tool implements
 *  the {@link ToolDynamicSpec} `getSpec` arm so the model-visible spec tracks the
 *  live posture PER MODEL REQUEST — hidden while it DENIES, present while it
 *  ADMITS — instead of being frozen at session build. ABSENT (default-OFF, no
 *  `questionGuard` wired) ⇒ NO `getSpec` arm ⇒ a plain static tool, byte-identical
 *  to the pre-E5b surface (and to a call site that never opts in). */
export interface RequestUserInputOptions {
  readonly available: () => boolean
}

export const requestUserInputTool = (opts?: RequestUserInputOptions): Tool<Input> => {
  const available = opts?.available
  return {
    name: "request_user_input",
    description: DESCRIPTION,
    inputSchema: schema,
    isReadOnly: () => true,
    // Blocks on an operator decision — must never overlap other work.
    isConcurrencySafe: () => false,
    // RFC-05 E5b — dynamic-spec arm. ABSENT unless an `available` predicate was
    // threaded (i.e. a `questionGuard` is wired), so a tool built without it is a
    // plain static tool (no `getSpec`) and its spec bytes are byte-identical to
    // pre-E5b. When wired, `ToolRegistry.specs()` re-reads this EVERY model
    // request: DENY ⇒ `undefined` HIDES the tool from that request's spec (the
    // model no longer sees a handle it cannot use); ADMIT ⇒ the static spec, whose
    // {name, input_schema} are identical to the static fields (only visibility
    // changes, never identity — dispatch keys by the static name). This is the
    // model-SPEC projection of the SAME reader the pre-dispatch consult resolves,
    // so spec-visibility and dispatch-admission can never diverge per request.
    ...(available !== undefined
      ? {
          getSpec: (): ToolSpec | undefined =>
            available()
              ? {
                  name: "request_user_input",
                  description: DESCRIPTION,
                  input_schema: zodToJsonSchema(schema),
                }
              : undefined,
        }
      : {}),
    async *execute(input: Input, ctx: ToolContext): AsyncIterable<ToolEvent> {
      const requester = ctx.requestUserInput
      if (requester === undefined) {
        yield {
          type: "result",
          result: {
            ok: false,
            output: "request_user_input is unavailable: no user-input port wired.",
            failure: {
              mode: "error",
              modelVisibleError: "request_user_input is unavailable: no user-input port wired",
            },
          },
        }
        return
      }

      const promptId = crypto.randomUUID()
      yield { type: "progress", message: "awaiting user input" }

      let outcome: UserInputOutcome
      try {
        // Build the request payload without explicit-undefined fields so the
        // requester's optional fields stay omitted under
        // `exactOptionalPropertyTypes: true`.
        const req: {
          promptId: string
          prompt: string
          choices?: readonly string[]
          multiline?: boolean
        } = { promptId, prompt: input.prompt }
        if (input.choices !== undefined) req.choices = input.choices
        if (input.multiline !== undefined) req.multiline = input.multiline
        outcome = await requester(req)
      } catch (e) {
        const msg = errMessage(e)
        yield {
          type: "result",
          result: {
            ok: false,
            output: `request_user_input failed: ${msg}`,
            failure: { mode: "error", modelVisibleError: msg },
          },
        }
        return
      }

      switch (outcome.decision) {
        case "answer":
          yield { type: "result", result: { ok: true, output: outcome.text } }
          return
        case "cancelled":
          yield {
            type: "result",
            result: {
              ok: false,
              output: "User cancelled the request.",
              failure: { mode: "rejected", reason: "user_cancelled" },
            },
          }
          return
        default: {
          // Closed-union exhaustiveness guard. A new arm on `UserInputOutcome`
          // becomes a compile error here — there is NO heuristic fallthrough.
          const _never: never = outcome
          const tag = (_never as { decision?: unknown })?.decision
          yield {
            type: "result",
            result: {
              ok: false,
              output: `request_user_input received an unknown decision: ${String(tag)}.`,
              failure: {
                mode: "error",
                modelVisibleError: `unknown decision: ${String(tag)}`,
              },
            },
          }
          return
        }
      }
    },
  }
}
