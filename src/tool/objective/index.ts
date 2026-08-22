/** ADR-0402 — Objective LLM tools (`objective_set` / `objective_update` /
 *  `objective_get`) wired to the ADR-0394 `ObjectivePort`.
 *
 *  This slice exposes the per-thread `Objective` substrate (goal / status /
 *  blockers / nextActions / successCriteria / budget) to the LLM. The agent
 *  itself can therefore declare its own objective, surface blockers, list
 *  next actions — closing the structural gap that quanta inferred intent
 *  from message scrollback instead of reading a typed object.
 *
 *  Three tools, one closed port:
 *    - `objective_set`    — set/replace the per-thread objective.
 *    - `objective_update` — partial mutate via a 6-arm discriminated union.
 *    - `objective_get`    — fetch current objective (read-only).
 *
 *  HITL tier: ALL three are `pre-approval-ok` (information-class — no
 *  destructive side effect, no FS / shell / network).
 *
 *  NO-THROW: every tool wraps the port call in a try/catch and surfaces
 *  failures as `{ ok: false, output: "..." }`. Schema validation errors are
 *  caught at the zod `safeParse` boundary so an unknown op / bad enum / missing
 *  thread_id can never reach the port.
 *
 *  SLICE FENCE: imports `@/objective` (the closed ADR-0394 substrate)
 *  for typed `ObjectivePort` + `Objective` + `WaitingOn` + `ObjectiveStatus`,
 *  plus `../types` (Tool / ToolContext / ToolEvent / ToolResult) and `zod`.
 *  Nothing from `@/agent` core. */

import { z } from "zod"
import type { Objective, ObjectivePort, ObjectiveStatus, WaitingOn } from "@/objective"
import { errMessage } from "@/shared"
import type { Tool, ToolContext, ToolEvent, ToolResult } from "../types"

// ─────────────────────────────────────────────────────────────────────────────
// SCHEMAS
// ─────────────────────────────────────────────────────────────────────────────

// H17 6-state machine. The DERIVED statuses (`blocked` / `usage_limited` /
// `budget_limited`) are listed so the two-way drift guard below stays
// exhaustive over `ObjectiveStatus` and a stored objective carrying one passes
// schema validation — but `updateStatus` treats them (like `blocked`) as a
// no-op: only "active" / "paused" / "completed" are explicit caller intents.
const STATUS_ENUM = [
  "active",
  "paused",
  "usage_limited",
  "budget_limited",
  "completed",
  "blocked",
] as const satisfies readonly ObjectiveStatus[]
const WAITING_ENUM = [
  "user",
  "tool",
  "network",
  "child_agent",
] as const satisfies readonly WaitingOn[]
// Two-way drift guard: `satisfies` proves array⊆union; these Asserts prove the
// REVERSE (every union member is in the zod enum). Without them, adding a status
// or waiting-on kind to the union but forgetting it here means the LLM can never
// set it via the tool AND a stored objective carrying it fails schema validation.
type _AssertObj<T extends true> = T
export type _ObjectiveEnumDriftGuard =
  | _AssertObj<ObjectiveStatus extends (typeof STATUS_ENUM)[number] ? true : false>
  | _AssertObj<WaitingOn extends (typeof WAITING_ENUM)[number] ? true : false>

// R3 audit-M2/M3 caps: every free-form string field gets a finite upper bound
// so an adversarial LLM cannot push the per-thread Objective into a memory-
// blow-up surface, and every numeric field is restricted to safe-integer
// + non-negative + finite (rejecting NaN / Infinity / negatives / floats).
// The constants are the structural ceilings (not heuristics): 8000 chars
// covers ~2k tokens, the practical free-form ceiling; 2000 chars per list
// item + 256 items per array bound the worst-case payload at ~512KB which
// stays under any LLM tool-call ceiling.
const MAX_GOAL_CHARS = 8000
const MAX_REASON_CHARS = 8000
const MAX_LIST_ITEM_CHARS = 2000
const MAX_LIST_ITEMS = 256

export const objectiveSetSchema = z.object({
  thread_id: z.string().min(1).describe("Thread/conversation id this objective belongs to"),
  goal: z.string().min(1).max(MAX_GOAL_CHARS).describe("The current objective in 1-2 sentences"),
  success_criteria: z
    .array(z.string().max(MAX_LIST_ITEM_CHARS))
    .max(MAX_LIST_ITEMS)
    .optional()
    .describe("List of testable criteria (e.g. 'tests pass', 'tsc 0')"),
  budget: z
    .object({
      max_tokens: z.number().int().nonnegative().finite().optional(),
      max_turns: z.number().int().nonnegative().finite().optional(),
    })
    .optional()
    .describe("Optional budget envelope (caller-side caps; informational)"),
})
export type ObjectiveSetInput = z.infer<typeof objectiveSetSchema>

export const objectiveUpdateSchema = z.object({
  thread_id: z.string().min(1),
  op: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("status"),
      status: z.enum(STATUS_ENUM),
    }),
    z.object({
      kind: z.literal("addBlocker"),
      reason: z.string().min(1).max(MAX_REASON_CHARS),
      waiting_on: z.enum(WAITING_ENUM),
    }),
    z.object({
      kind: z.literal("clearBlocker"),
      blocker_id: z.string().min(1).max(MAX_LIST_ITEM_CHARS),
    }),
    z.object({
      kind: z.literal("nextActions"),
      actions: z.array(z.string().max(MAX_LIST_ITEM_CHARS)).max(MAX_LIST_ITEMS),
    }),
    z.object({
      kind: z.literal("markCriterion"),
      criterion_id: z.string().min(1).max(MAX_LIST_ITEM_CHARS),
      met: z.boolean(),
    }),
    z.object({
      kind: z.literal("recordUsage"),
      tokens: z.number().int().nonnegative().finite().optional(),
      turns: z.number().int().nonnegative().finite().optional(),
    }),
  ]),
})
export type ObjectiveUpdateInput = z.infer<typeof objectiveUpdateSchema>

export const objectiveGetSchema = z.object({
  thread_id: z.string().min(1),
})
export type ObjectiveGetInput = z.infer<typeof objectiveGetSchema>

// ─────────────────────────────────────────────────────────────────────────────
// RENDER
// ─────────────────────────────────────────────────────────────────────────────

/** H17 — the budget line: a ratio (used/max) when a cap is set so the user sees
 *  how close the objective is to exhaustion; bare `*_used` otherwise. */
const renderBudgetLine = (b: Objective["budget"]): string => {
  const tok =
    b.maxTokens !== undefined
      ? `tokens=${b.tokensUsed}/${b.maxTokens}`
      : `tokens_used=${b.tokensUsed}`
  const turns =
    b.maxTurns !== undefined ? `turns=${b.turnsUsed}/${b.maxTurns}` : `turns_used=${b.turnsUsed}`
  return `budget: ${tok} ${turns}`
}

/** H17 — when enforcement flips the status to a LIMIT/PAUSE state, make the gate
 *  explicit so the model/user understands the goal will NOT auto-resume on idle
 *  (idle-continuation only fires for an `active` goal). `""` for other states. */
const renderLimitNote = (status: Objective["status"]): string => {
  switch (status) {
    case "budget_limited":
      return "budget_limited: objective budget exhausted — continuation suppressed"
    case "usage_limited":
      return "usage_limited: transient usage/rate window active — continuation deferred until reset"
    case "paused":
      return "paused: objective manually paused — continuation suppressed until resumed"
    default:
      return ""
  }
}

/** Render an `Objective` to concise model-facing text.
 *  Includes goal + status + blockers count + nextActions + (optional) criteria. */
const renderObjective = (o: Objective): string => {
  const lines: string[] = []
  lines.push(`goal: ${o.goal}`)
  lines.push(`status: ${o.status}`)
  lines.push(`blockers: ${o.blockers.length}`)
  if (o.blockers.length > 0) {
    for (const b of o.blockers) {
      lines.push(`  - [${b.id}] (waiting_on=${b.waitingOn}) ${b.reason}`)
    }
  }
  if (o.successCriteria.length > 0) {
    lines.push("criteria:")
    for (const c of o.successCriteria) {
      lines.push(`  - [${c.met ? "x" : " "}] (${c.id}) ${c.text}`)
    }
  }
  if (o.nextActions.length > 0) {
    lines.push("nextActions:")
    for (const a of o.nextActions) lines.push(`  - ${a}`)
  }
  lines.push(renderBudgetLine(o.budget))
  const limitNote = renderLimitNote(o.status)
  if (limitNote !== "") lines.push(limitNote)
  return lines.join("\n")
}

const okResult = (o: Objective): ToolResult => ({
  ok: true,
  output: renderObjective(o),
})

const errResult = (msg: string): ToolResult => ({ ok: false, output: msg })

// ─────────────────────────────────────────────────────────────────────────────
// TOOLS
// ─────────────────────────────────────────────────────────────────────────────

const buildObjectiveSet = (port: ObjectivePort): Tool<ObjectiveSetInput> => ({
  name: "objective_set",
  description:
    "Set or replace the per-thread Objective: goal (1-2 sentences), optional " +
    "success_criteria (testable list), optional budget (max_tokens/max_turns). " +
    "Use at the START of work to declare what you are doing and what 'done' " +
    "means. Returns the new objective state (goal/status/blockers/nextActions).",
  inputSchema: objectiveSetSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  hitlTier: () => "pre-approval-ok",
  async *execute(input, _ctx: ToolContext): AsyncIterable<ToolEvent> {
    const parsed = objectiveSetSchema.safeParse(input)
    if (!parsed.success) {
      yield { type: "result", result: errResult(`invalid input: ${parsed.error.message}`) }
      return
    }
    try {
      const initBudget: { maxTokens?: number; maxTurns?: number } = {}
      if (parsed.data.budget?.max_tokens !== undefined) {
        initBudget.maxTokens = parsed.data.budget.max_tokens
      }
      if (parsed.data.budget?.max_turns !== undefined) {
        initBudget.maxTurns = parsed.data.budget.max_turns
      }
      const init: {
        goal: string
        successCriteria?: readonly string[]
        budget?: { maxTokens?: number; maxTurns?: number }
      } = { goal: parsed.data.goal }
      if (parsed.data.success_criteria !== undefined) {
        init.successCriteria = parsed.data.success_criteria
      }
      if (Object.keys(initBudget).length > 0) init.budget = initBudget
      const o = port.set(parsed.data.thread_id, init)
      yield { type: "result", result: okResult(o) }
    } catch (e) {
      const msg = errMessage(e)
      yield { type: "result", result: errResult(`objective_set error: ${msg}`) }
    }
  },
})

const applyUpdate = (
  port: ObjectivePort,
  threadId: string,
  op: ObjectiveUpdateInput["op"],
): Objective | null => {
  switch (op.kind) {
    case "status":
      return port.updateStatus(threadId, op.status)
    case "addBlocker":
      return port.addBlocker(threadId, { reason: op.reason, waitingOn: op.waiting_on })
    case "clearBlocker":
      return port.clearBlocker(threadId, op.blocker_id)
    case "nextActions":
      return port.setNextActions(threadId, op.actions)
    case "markCriterion":
      return port.markCriterion(threadId, op.criterion_id, op.met)
    case "recordUsage": {
      const used: { tokens?: number; turns?: number } = {}
      if (op.tokens !== undefined) used.tokens = op.tokens
      if (op.turns !== undefined) used.turns = op.turns
      return port.recordUsage(threadId, used)
    }
  }
}

const buildObjectiveUpdate = (port: ObjectivePort): Tool<ObjectiveUpdateInput> => ({
  name: "objective_update",
  description:
    "Partially mutate the per-thread Objective. `op.kind` selects: " +
    "status (active|paused|completed — the limit states blocked/usage_limited/budget_limited are DERIVED, not settable) / " +
    "addBlocker (reason + waiting_on=user|tool|network|child_agent) / " +
    "clearBlocker (blocker_id) / nextActions (list of strings) / " +
    "markCriterion (criterion_id, met) / recordUsage (tokens? + turns?). " +
    "Returns the NEW objective state after the mutation.",
  inputSchema: objectiveUpdateSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  hitlTier: () => "pre-approval-ok",
  async *execute(input, _ctx: ToolContext): AsyncIterable<ToolEvent> {
    const parsed = objectiveUpdateSchema.safeParse(input)
    if (!parsed.success) {
      yield { type: "result", result: errResult(`invalid input: ${parsed.error.message}`) }
      return
    }
    try {
      const result = applyUpdate(port, parsed.data.thread_id, parsed.data.op)
      if (result === null) {
        yield {
          type: "result",
          result: errResult(`no objective set for thread ${parsed.data.thread_id}`),
        }
        return
      }
      yield { type: "result", result: okResult(result) }
    } catch (e) {
      const msg = errMessage(e)
      yield { type: "result", result: errResult(`objective_update error: ${msg}`) }
    }
  },
})

const buildObjectiveGet = (port: ObjectivePort): Tool<ObjectiveGetInput> => ({
  name: "objective_get",
  description:
    "Read the current per-thread Objective. Returns goal/status/blockers/" +
    "criteria/nextActions/budget; if no objective is set for the thread, " +
    "returns ok:false with 'no objective set for thread <id>'.",
  inputSchema: objectiveGetSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  hitlTier: () => "pre-approval-ok",
  async *execute(input, _ctx: ToolContext): AsyncIterable<ToolEvent> {
    const parsed = objectiveGetSchema.safeParse(input)
    if (!parsed.success) {
      yield { type: "result", result: errResult(`invalid input: ${parsed.error.message}`) }
      return
    }
    try {
      const o = port.get(parsed.data.thread_id)
      if (o === null) {
        yield {
          type: "result",
          result: errResult(`no objective set for thread ${parsed.data.thread_id}`),
        }
        return
      }
      yield { type: "result", result: okResult(o) }
    } catch (e) {
      const msg = errMessage(e)
      yield { type: "result", result: errResult(`objective_get error: ${msg}`) }
    }
  },
})

/** Build the 3 objective tools wired to a single `ObjectivePort`. Returned as
 *  a stable array so the tier-1 composer can spread it uniformly (mirrors
 *  `delegateTools` / `subagentBgTools` shape). */
export const objectiveTools = (port: ObjectivePort): Tool[] => [
  buildObjectiveSet(port) as Tool,
  buildObjectiveUpdate(port) as Tool,
  buildObjectiveGet(port) as Tool,
]
