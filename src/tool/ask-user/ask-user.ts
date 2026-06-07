/** `ask_user` — agent-callable STRUCTURED elicitation (ADR-0494).
 *
 *  Lets the model put a structured question to the user mid-task and get a typed
 *  answer back in-band: free text, yes/no, a single pick, a multi-pick, or a
 *  number/integer. It GENERALIZES the binary host `onConfirm` (allow/deny) —
 *  same host, richer question. Routed to a host {@link AskUserPort}; when the
 *  host cannot prompt (headless) the port returns a typed `headless-denied` and
 *  the tool surfaces ok:false WITHOUT blocking.
 *
 *  PURE INTERACTION — it does not mutate files, run shells, or call tools:
 *  `isReadOnly:true`, `hitlTier:"none"` (the tool IS the human touchpoint, not a
 *  permission gate), `isConcurrencySafe:true`. It exposes no shell extractor so
 *  the permission gate can never route it through a HARD_DENY path.
 *
 *  Output contract: NEVER throws past the loop. Bad input, an empty options list
 *  for select/multiselect, or a port that breaks its no-throw contract all
 *  collapse to a graceful ok:false. Plane-clean: imports only `../types` + `zod`
 *  + `@/shared`. */

import { z } from "zod"
import { errMessage, omitUndef } from "@/shared"
import type { Tool, ToolContext, ToolEvent } from "../types"
import type { AskUserPort, AskUserRequest, AskUserResult } from "./port"

export const askUserInputSchema = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("string"),
      prompt: z.string().min(1),
      title: z.string().min(1).optional(),
      minLength: z.number().int().nonnegative().optional(),
      maxLength: z.number().int().positive().optional(),
      pattern: z.string().min(1).optional(),
    }),
    z.object({
      kind: z.literal("boolean"),
      prompt: z.string().min(1),
      title: z.string().min(1).optional(),
    }),
    z.object({
      kind: z.literal("number"),
      prompt: z.string().min(1),
      title: z.string().min(1).optional(),
      // `.finite()` rejects ±Infinity: it would survive zod but serialize to `null`
      // over the JSON host bridge, silently dropping the bound (a different question).
      min: z.number().finite().optional(),
      max: z.number().finite().optional(),
    }),
    z.object({
      kind: z.literal("integer"),
      prompt: z.string().min(1),
      title: z.string().min(1).optional(),
      min: z.number().int().optional(),
      max: z.number().int().optional(),
    }),
    z.object({
      kind: z.literal("select"),
      prompt: z.string().min(1),
      title: z.string().min(1).optional(),
      options: z.array(z.string()),
    }),
    z.object({
      kind: z.literal("multiselect"),
      prompt: z.string().min(1),
      title: z.string().min(1).optional(),
      options: z.array(z.string()),
      minSelected: z.number().int().nonnegative().optional(),
      maxSelected: z.number().int().positive().optional(),
    }),
  ])
  // F5 — reject cross-field contradictions in the TOOL (don't push an
  // unsatisfiable/contradictory question to the port and rely on every host to
  // validate). Same self-containment posture as the empty-options check.
  .superRefine((v, ctx) => {
    const bad = (message: string): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message })
    }
    if (
      v.kind === "string" &&
      v.minLength !== undefined &&
      v.maxLength !== undefined &&
      v.minLength > v.maxLength
    ) {
      bad("minLength must be <= maxLength")
    }
    if (
      (v.kind === "number" || v.kind === "integer") &&
      v.min !== undefined &&
      v.max !== undefined &&
      v.min > v.max
    ) {
      bad("min must be <= max")
    }
    if (v.kind === "multiselect") {
      if (
        v.minSelected !== undefined &&
        v.maxSelected !== undefined &&
        v.minSelected > v.maxSelected
      ) {
        bad("minSelected must be <= maxSelected")
      }
      if (v.minSelected !== undefined && v.minSelected > v.options.length) {
        bad("minSelected exceeds the number of options (unsatisfiable)")
      }
    }
  })
export type AskUserInput = z.infer<typeof askUserInputSchema>

/** Build the port request from validated input, STRIPPING any `undefined`-valued
 *  optionals (zod retains an explicitly-passed `{minLength: undefined}`; the port
 *  must never see an undefined-set optional — exactOptionalPropertyTypes). */
const inputToRequest = (input: AskUserInput): AskUserRequest =>
  omitUndef(input) as unknown as AskUserRequest

const renderValue = (v: AskUserResult & { ok: true }): string =>
  Array.isArray(v.value) ? v.value.join(", ") : String(v.value)

export const askUserTool = (port: AskUserPort): Tool<AskUserInput> => ({
  name: "ask_user",
  description:
    "Ask the USER a STRUCTURED question mid-task and get a typed answer back: " +
    "free text (kind:string), yes/no (kind:boolean), a number/integer, a single " +
    "pick (kind:select, options:[…]), or a multi-pick (kind:multiselect). Use it " +
    "when you genuinely need a decision only the user can make — NOT for routine " +
    "choices you can resolve yourself or from the code. If the user is not " +
    "reachable (headless), the call returns a typed denial; do not loop on it.",
  inputSchema: askUserInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  hitlTier: () => "none",
  async *execute(input, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const parsed = askUserInputSchema.safeParse(input)
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
    // select/multiselect REQUIRE a non-empty options list — reject BEFORE the
    // port is reached (a pick with nothing to pick is never a valid question).
    if (
      (parsed.data.kind === "select" || parsed.data.kind === "multiselect") &&
      parsed.data.options.length === 0
    ) {
      yield {
        type: "result",
        result: {
          ok: false,
          output: `ask_user failed (empty-options): ${parsed.data.kind} needs a non-empty options list`,
        },
      }
      return
    }
    let result: AskUserResult
    try {
      result = await port.ask(inputToRequest(parsed.data), ctx.signal)
    } catch (e) {
      // The port contract is NO-THROW; a throw here is an unexpected bug path.
      // Collapse to a graceful ok:false rather than bubbling past the loop.
      yield {
        type: "result",
        result: { ok: false, output: `ask_user failed (port-error): ${errMessage(e)}` },
      }
      return
    }
    yield {
      type: "result",
      result: result.ok
        ? { ok: true, output: `user answered: ${renderValue(result)}` }
        : { ok: false, output: `ask_user declined (${result.reason})` },
    }
  },
})
