/** `reflect` — mid-turn self-correction tool (gap-other-agent GAP 11).
 *
 *  When the agent notices its actions are NOT having the desired effect, it calls
 *  `reflect` with its current situation + the new plan it proposes, and gets a
 *  critique back in-band. It is DELIBERATELY EXPENSIVE — gated by a per-session
 *  call quota (Cursor: "use it sparingly") and REQUIRES `next_steps` (the forcing
 *  function: you must commit a concrete plan to reflect on).
 *
 *  PURE-ish: it does not mutate files / run shells; the reflection itself rides an
 *  injected {@link ReflectPort}. `isReadOnly:true`, `hitlTier:"none"`, no shell
 *  extractor. NEVER throws past the loop — bad input, quota exhaustion, or a
 *  thrown port all collapse to a graceful `ok:false`. Plane-clean: `../types` +
 *  `zod` + `@/shared` only.
 */
import { z } from "zod"
import { errMessage } from "@/shared"
import type { Tool, ToolContext, ToolEvent } from "../types"
import type { ReflectPort, ReflectRequest } from "./port"

/** Per-field input cap — reflect is a focused consult, not a context dump. Bounds
 *  the sub-request so one degenerate turn cannot balloon it (R1 audit F1; sibling
 *  tools cap their inputs the same way). */
export const REFLECT_MAX_CHARS = 8000

export const reflectInputSchema = z.object({
  situation: z
    .string()
    .min(1)
    .max(REFLECT_MAX_CHARS)
    .describe(
      "What you tried, what is happening, and WHY the current approach is not " +
        "working — the trigger for reflecting (e.g. 'the same edit keeps failing the " +
        "fuzzy match'). Be concrete.",
    ),
  next_steps: z
    .string()
    .min(1)
    .max(REFLECT_MAX_CHARS)
    .describe(
      "REQUIRED — the concrete, DIFFERENT plan you propose to try next. reflect " +
        "exists to pressure-test a committed plan, not to think out loud; you must " +
        "state one.",
    ),
})
export type ReflectInput = z.infer<typeof reflectInputSchema>

export interface ReflectToolOptions {
  /** Per-session quota — reflect is expensive. Default 5. */
  readonly maxCalls?: number
}

const DEFAULT_MAX_CALLS = 5

const render = (r: { analysis: string; recommendNewApproach?: boolean }): string =>
  `reflection${r.recommendNewApproach ? " (recommends a new approach)" : ""}:\n${r.analysis}`

export const reflectTool = (
  port: ReflectPort,
  opts: ReflectToolOptions = {},
): Tool<ReflectInput> => {
  const maxCalls = opts.maxCalls ?? DEFAULT_MAX_CALLS
  let used = 0
  return {
    name: "reflect",
    description:
      "Reflect on the current state and pressure-test a DIFFERENT plan when your " +
      "actions are not working. EXPENSIVE — use sparingly (a per-session quota " +
      "applies). REQUIRES next_steps: state the concrete plan you propose to try. " +
      "Returns a critique; it does not edit files or run anything.",
    inputSchema: reflectInputSchema,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    hitlTier: () => "none",
    async *execute(input, c: ToolContext): AsyncIterable<ToolEvent> {
      const parsed = reflectInputSchema.safeParse(input)
      if (!parsed.success) {
        yield {
          type: "result",
          result: { ok: false, output: `invalid input: ${parsed.error.message}` },
        }
        return
      }
      if (c.signal.aborted) {
        yield { type: "result", result: { ok: false, output: "aborted before start" } }
        return
      }
      if (used >= maxCalls) {
        yield {
          type: "result",
          result: {
            ok: false,
            output: `reflect quota exhausted (${maxCalls}/session) — act on your last reflection instead`,
          },
        }
        return
      }
      const req: ReflectRequest = {
        situation: parsed.data.situation,
        nextSteps: parsed.data.next_steps,
      }
      let result: Awaited<ReturnType<ReflectPort["reflect"]>>
      try {
        result = await port.reflect(req, c.signal)
      } catch (e) {
        // R1 audit: a THROW is infra failure (the host reflect backend is down),
        // NOT a real reflection — do NOT consume quota for it, or a flaky transport
        // would permanently disarm the agent's self-correction. Quota is consumed
        // only once the port actually RETURNS (success or a typed ok:false below).
        yield {
          type: "result",
          result: { ok: false, output: `reflect failed (reflect-error): ${errMessage(e)}` },
        }
        return
      }
      used++
      yield {
        type: "result",
        result: result.ok
          ? { ok: true, output: render(result) }
          : { ok: false, output: `reflect failed (${result.reason})` },
      }
    },
  }
}
