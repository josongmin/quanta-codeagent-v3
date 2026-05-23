import { z } from "zod";
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
        .describe("OPTIONAL fixed-choice list (each non-empty, ≤12 items) a surface may render as buttons."),
    multiline: z
        .boolean()
        .optional()
        .describe("OPTIONAL hint that the answer may span multiple lines."),
});
export const requestUserInputTool = () => ({
    name: "request_user_input",
    description: "Ask the operator a question and wait for an answer. Returns answer text " +
        "or cancelled. Use inside plan-mode when you need a decision that the " +
        "model cannot infer.",
    inputSchema: schema,
    isReadOnly: () => true,
    // Blocks on an operator decision — must never overlap other work.
    isConcurrencySafe: () => false,
    async *execute(input, ctx) {
        const requester = ctx.requestUserInput;
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
            };
            return;
        }
        const promptId = crypto.randomUUID();
        yield { type: "progress", message: "awaiting user input" };
        let outcome;
        try {
            // Build the request payload without explicit-undefined fields so the
            // requester's optional fields stay omitted under
            // `exactOptionalPropertyTypes: true`.
            const req = { promptId, prompt: input.prompt };
            if (input.choices !== undefined)
                req.choices = input.choices;
            if (input.multiline !== undefined)
                req.multiline = input.multiline;
            outcome = await requester(req);
        }
        catch (e) {
            const msg = e?.message ?? String(e);
            yield {
                type: "result",
                result: {
                    ok: false,
                    output: `request_user_input failed: ${msg}`,
                    failure: { mode: "error", modelVisibleError: msg },
                },
            };
            return;
        }
        switch (outcome.decision) {
            case "answer":
                yield { type: "result", result: { ok: true, output: outcome.text } };
                return;
            case "cancelled":
                yield {
                    type: "result",
                    result: {
                        ok: false,
                        output: "User cancelled the request.",
                        failure: { mode: "rejected", reason: "user_cancelled" },
                    },
                };
                return;
            default: {
                // Closed-union exhaustiveness guard. A new arm on `UserInputOutcome`
                // becomes a compile error here — there is NO heuristic fallthrough.
                const _never = outcome;
                const tag = _never?.decision;
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
                };
                return;
            }
        }
    },
});
