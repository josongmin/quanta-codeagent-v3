/**
 * ADR-0280 — `automation_update` tool.
 *
 * 6-action closed input schema (`create | list | pause | resume | cancel
 * | get`) over an `AutomationEnginePort`. Registered in `buildDefaultTools`
 * ONLY when `QUANTA_AUTOMATION === "on"` — absent ⇒ the model never sees
 * the tool (byte-identical default set).
 *
 * The tool is a CLOSURE-OVER-ENGINE factory (`automationUpdateTool(engine)`)
 * — no `ToolContext` seam is added, keeping the wire loose. The closure is
 * what `src/tool/index.ts` conditionally appends behind the env gate.
 *
 * NO-THROW: every engine port call returns a typed `EngineResult<T>`; the
 * tool branches on `ok:false` rather than throwing. RRULE parse failures
 * surface as `ok:false` tool results with a model-visible message.
 *
 * pause / resume are simplified to `cancel` for v1 (no `paused` state in
 * `EngineStatus`). A future ADR may introduce soft-pause; for now both
 * actions collapse to cancel.
 */

import { z } from "zod"
import type { AutomationEnginePort, EngineAutomation } from "@/scheduler/automation-engine"
import { parseRRule } from "@/scheduler/rrule-parser"
import { defineTool } from "./factory"
import type { Tool, ToolEvent } from "./types"

// ── Input schema — discriminated by `action` ──────────────────────────────

const createSchema = z.object({
  action: z.literal("create"),
  id: z.string().min(1).max(200).describe("Unique id for the automation."),
  title: z.string().min(1).max(200).describe("Human-readable title."),
  rule: z
    .string()
    .min(1)
    .max(500)
    .describe("RFC 5545 RRULE (subset). E.g. 'FREQ=DAILY;BYDAY=MO,TU'."),
  prompt: z
    .string()
    .min(1)
    .max(8000)
    .describe("The prompt to dispatch onto the agent loop when the automation fires."),
  nextRunAt: z
    .number()
    .int()
    .nonnegative()
    .describe("ms-epoch of the first scheduled fire (the engine advances later via the rule)."),
  createdAt: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("ms-epoch of creation. Defaults to Date.now() when omitted."),
  model: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Optional per-task first-choice model. Omitted ⇒ host default."),
  modelFallbacks: z
    .array(z.string().min(1).max(200))
    .max(20)
    .optional()
    .describe("Optional ordered fallback model probe list."),
})

const idOnlySchema = z.object({
  action: z.enum(["pause", "resume", "cancel", "get"]),
  id: z.string().min(1).max(200),
})

const listSchema = z.object({
  action: z.literal("list"),
})

const inputSchema = z.discriminatedUnion("action", [createSchema, idOnlySchema, listSchema])

type Input = z.infer<typeof inputSchema>

// ── Tool factory ──────────────────────────────────────────────────────────

/** Build the `automation_update` tool closed over an
 *  `AutomationEnginePort`. The factory is the registration seam — the
 *  composition root calls this from `src/tool/index.ts` only when the env
 *  gate is on. */
export const automationUpdateTool = (engine: AutomationEnginePort): Tool<Input> =>
  defineTool({
    name: "automation_update",
    description:
      "Manage recurring automations: create / list / pause / resume / cancel / get. " +
      "All actions are NO-THROW; failures surface as typed results.",
    inputSchema,
    isReadOnly: () => false,
    // Each call is engine-atomic; the engine port handles concurrency.
    isConcurrencySafe: () => true,
    async *execute(input: Input): AsyncIterable<ToolEvent> {
      switch (input.action) {
        case "create":
          yield await actionCreate(engine, input)
          return
        case "list":
          yield await actionList(engine)
          return
        case "get":
          yield await actionGet(engine, input.id)
          return
        case "pause":
        case "resume":
        case "cancel":
          yield await actionCancel(engine, input.id, input.action)
          return
        default: {
          // Closed-union exhaustiveness guard.
          const _never: never = input
          yield {
            type: "result",
            result: {
              ok: false,
              output: `unknown action: ${String((_never as { action?: unknown }).action)}`,
              failure: {
                mode: "error",
                modelVisibleError: "unknown automation_update action",
              },
            },
          }
          return
        }
      }
    },
  })

// ── Action handlers (pure given engine) ────────────────────────────────────

const actionCreate = async (
  engine: AutomationEnginePort,
  input: z.infer<typeof createSchema>,
): Promise<ToolEvent> => {
  const parsed = parseRRule(input.rule)
  if (!parsed.ok) {
    return errResult(`invalid RRULE '${input.rule}': ${parsed.code} — ${parsed.message}`)
  }
  const { ok: _ok, ...rule } = parsed
  const createdAt = input.createdAt ?? Date.now()
  const r = await engine.schedule({
    id: input.id,
    title: input.title,
    rule,
    prompt: input.prompt,
    nextRunAt: input.nextRunAt,
    createdAt,
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.modelFallbacks !== undefined ? { modelFallbacks: input.modelFallbacks } : {}),
  })
  if (!r.ok) {
    return errResult(`schedule failed: ${r.code} — ${r.message}`)
  }
  return okResult(`scheduled automation '${r.value.id}'`, { automation: shapeFor(r.value) })
}

const actionList = async (engine: AutomationEnginePort): Promise<ToolEvent> => {
  const r = await engine.list()
  if (!r.ok) return errResult(`list failed: ${r.code} — ${r.message}`)
  return okResult(`${r.value.length} automation(s)`, {
    automations: r.value.map(shapeFor),
  })
}

const actionGet = async (engine: AutomationEnginePort, id: string): Promise<ToolEvent> => {
  const r = await engine.list()
  if (!r.ok) return errResult(`list failed: ${r.code} — ${r.message}`)
  const found = r.value.find((a) => a.id === id)
  if (found === undefined) {
    return errResult(`automation '${id}' not found`)
  }
  return okResult(`automation '${id}'`, { automation: shapeFor(found) })
}

const actionCancel = async (
  engine: AutomationEnginePort,
  id: string,
  action: "pause" | "resume" | "cancel",
): Promise<ToolEvent> => {
  const r = await engine.cancel(id)
  if (!r.ok) return errResult(`${action} failed: ${r.code} — ${r.message}`)
  return okResult(`${action} ok (id='${id}')`)
}

// ── Result helpers ─────────────────────────────────────────────────────────

const okResult = (output: string, structured?: Record<string, unknown>): ToolEvent => ({
  type: "result",
  result: {
    ok: true,
    output,
    ...(structured !== undefined ? { structured } : {}),
  },
})

const errResult = (msg: string): ToolEvent => ({
  type: "result",
  result: {
    ok: false,
    output: msg,
    failure: { mode: "error", modelVisibleError: msg },
  },
})

/** Project the engine row to a model-friendly shape (drops the parsed RRULE
 *  object — the model only needs the surface fields). */
const shapeFor = (a: EngineAutomation): Record<string, unknown> => ({
  id: a.id,
  title: a.title,
  prompt: a.prompt,
  nextRunAt: a.nextRunAt,
  status: a.status,
  createdAt: a.createdAt,
  fireCount: a.fireCount,
  ...(a.lastRunAt !== undefined ? { lastRunAt: a.lastRunAt } : {}),
  ...(a.lastError !== undefined ? { lastError: a.lastError } : {}),
  ...(a.model !== undefined ? { model: a.model } : {}),
  ...(a.modelFallbacks !== undefined ? { modelFallbacks: a.modelFallbacks } : {}),
})
