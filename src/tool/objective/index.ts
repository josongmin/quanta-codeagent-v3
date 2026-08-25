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
import type {
  CommitRejection,
  CommitResult,
  CriterionDeclaration,
  GoalDefinition,
  ModelObjectiveMutation,
  Objective,
  ObjectiveCommands,
  ObjectiveReadPort,
  ObjectiveStatus,
  ObjectiveVerificationPort,
  WaitingOn,
} from "@/objective"
import { errMessage } from "@/shared"
import type { ObjectiveApprovalRequest, Tool, ToolContext, ToolEvent, ToolResult } from "../types"

/** GOAL-02 — what the composition root hands this slice: the MODEL-actor
 *  command capability (definition minting is a gated proposal; status,
 *  criterion completion and usage are host-owned) plus the read port. */
export interface ObjectiveToolPorts {
  readonly model: ObjectiveCommands<ModelObjectiveMutation>
  readonly read: ObjectiveReadPort
  /** GOAL-03 — the host verifier; absent ⇒ `objective_verify` is not registered. */
  readonly verify?: ObjectiveVerificationPort | undefined
}

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
// GOAL-01 — the goal-text ceiling is DOMAIN-owned (`MAX_GOAL_CHARS` in `@/objective`);
// this slice may not value-import the domain, so it mirrors the number and a
// parity test pins the two together.
const MAX_GOAL_CHARS = 4000
const MAX_REASON_CHARS = 8000
const MAX_LIST_ITEM_CHARS = 2000
const MAX_LIST_ITEMS = 256

// RFC-03 C4 — the model may DECLARE a machine check on a criterion (argv +
// timeout + success exit codes). It CANNOT supply a check `id`/`cwdPolicy` (both
// domain-minted) nor any completion receipt — a checked criterion is completed
// ONLY by a verifier, never through tool input (forgery stop-rule). The check is
// a *declaration* only; execution is C5 (PARKED).
const MAX_ARGV_ITEMS = 64
const MAX_EXIT_CODES = 32
const checkDeclarationSchema = z.object({
  kind: z.literal("command"),
  argv: z.array(z.string().max(MAX_LIST_ITEM_CHARS)).min(1).max(MAX_ARGV_ITEMS),
  timeout_ms: z.number().int().positive().finite(),
  success_exit_codes: z.array(z.number().int().finite()).max(MAX_EXIT_CODES),
})
// A success criterion is either a plain string (manual) or an object that may
// carry a `check` (⇒ checked / verifier-only).
const criterionEntrySchema = z.union([
  z.string().max(MAX_LIST_ITEM_CHARS),
  z.object({
    text: z.string().min(1).max(MAX_LIST_ITEM_CHARS),
    check: checkDeclarationSchema.optional(),
  }),
])

export const objectiveSetSchema = z.object({
  // GOAL-02 — deprecated and IGNORED: the thread is host-bound (`ctx.ownerId`).
  thread_id: z
    .string()
    .optional()
    .describe(
      "Deprecated and ignored — the objective thread is bound by the session, not this argument",
    ),
  goal: z.string().min(1).max(MAX_GOAL_CHARS).describe("The current objective in 1-2 sentences"),
  success_criteria: z
    .array(criterionEntrySchema)
    .max(MAX_LIST_ITEMS)
    .optional()
    .describe(
      "List of testable criteria. Each is a string (manual, self-attested) OR " +
        "{ text, check:{ kind:'command', argv, timeout_ms, success_exit_codes } } " +
        "for a machine-CHECKED criterion (verifier-only — you cannot mark it met).",
    ),
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
  thread_id: z.string().optional().describe("Deprecated and ignored"),
  op: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("addBlocker"),
      reason: z.string().min(1).max(MAX_REASON_CHARS),
      waiting_on: z.enum(WAITING_ENUM),
    }),
    z.object({
      kind: z.literal("nextActions"),
      actions: z.array(z.string().max(MAX_LIST_ITEM_CHARS)).max(MAX_LIST_ITEMS),
    }),
  ]),
})
export type ObjectiveUpdateInput = z.infer<typeof objectiveUpdateSchema>

export const objectiveGetSchema = z.object({
  thread_id: z.string().optional().describe("Deprecated and ignored"),
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
// AUTHORITY ROUTING (RFC-03 C1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the SESSION-BOUND objective thread id. RFC-03 §8: thread identity must
 * come from the caller/session, NEVER model input. The dispatch seam stamps
 * `ctx.ownerId` from `AgentConfig.sessionId` — the same id the objective is bound
 * to elsewhere (`/goal`, the continuation ticker). The model's `thread_id`
 * argument is accepted for schema compatibility but is NOT the identity source;
 * a missing session binding fails CLOSED rather than trusting the model.
 */
const boundThreadId = (ctx: ToolContext): string | null => {
  const id = ctx.ownerId
  return typeof id === "string" && id.length > 0 ? id : null
}

const NO_SESSION_THREAD =
  "objective tools require a session-bound thread (no ctx.ownerId); refusing model-supplied identity"

/** Model-facing message per closed rejection reason (heuristic-free, exhaustive:
 *  adding a `CommitRejection` member without a message fails compile). */
const COMMIT_ERROR_MESSAGE: Record<CommitRejection, string> = {
  stale: "objective changed since read (stale revision) — re-read and retry",
  "approval-required": "objective mutation requires approval (denied or not yet granted)",
  "approval-unavailable":
    "objective mutation requires approval but no confirmation surface is available",
  "forbidden-completion":
    "a criterion cannot be self-completed by the model; only a verifier may mark it met",
  "checked-verifier-only":
    "this is a CHECKED criterion — it can be marked met only by a verifier, never by an update",
  "objective-exists":
    "an objective already exists for this thread — use objective_update, or ask the user to edit the goal",
  "objective-missing": "no objective set for this thread",
  "objective-mismatch":
    "evidence belongs to a previous objective generation — re-read the objective",
  "attempt-replayed": "this attempt was already settled",
  "goal-too-long": "goal text exceeds the 4000-character ceiling",
  "actor-forbidden": "this mutation is not available to the model",
  "invalid-transition": "that status change is not allowed from the objective's current state",
  "terminal-objective": "the objective is completed; it can no longer be mutated by the model",
  "definition-change-forbidden":
    "the goal definition is user-owned and cannot be changed autonomously",
  "manual-attestation-required": "a manual criterion can only be completed by the user",
  "validation-contract-missing":
    "the objective has no success criteria or checks to complete against",
  "attempt-in-flight": "an attributed attempt is still running; wait for it to settle",
  "hard-cap-exhausted": "the product autonomous attempt cap for this goal is exhausted",
  "budget-exhausted": "the goal's turn budget is exhausted",
  invalid: "objective mutation could not be applied (no objective set for this thread)",
}

const commitError = (res: Extract<CommitResult, { ok: false }>): string =>
  COMMIT_ERROR_MESSAGE[res.reason]

/** Render a successful commit into the tool result, or a typed error. */
const commitResult = (res: CommitResult): ToolResult => {
  if (!res.ok) return errResult(commitError(res))
  const o = res.snapshot.state?.objective
  return o !== undefined && o !== null
    ? okResult(o)
    : errResult("objective mutation applied but not readable")
}

const NO_CONFIRM_SURFACE =
  "objective proposal requires approval but no confirmation surface is available (fail-closed)"

/** Clip a proposed goal for the one-line approval dialog. */
const clipGoal = (goal: string): string => (goal.length > 160 ? `${goal.slice(0, 157)}…` : goal)

/** RFC-03 C3 — build the operator-facing proposal from the closed mutation. */
const buildApprovalRequest = (mutation: ModelObjectiveMutation): ObjectiveApprovalRequest => {
  if (mutation.kind === "create") {
    return {
      operation: "create",
      goal: mutation.definition.goal,
      summary: `Set goal: ${clipGoal(mutation.definition.goal)}`,
    }
  }
  return { operation: mutation.kind, summary: `Objective ${mutation.kind}` }
}

/**
 * RFC-03 C3 / GOAL-02 — prepare + (gated) approve + commit ONE model-actor
 * mutation through the actor-fixed capability.
 *
 *   - `approvalRequired:false`: commit immediately (the policy table already
 *     admitted or refused it — a refusal surfaces as a typed message).
 *   - `approvalRequired:true` (a gated definition proposal): the capability is
 *     first PROBED with an un-admitted commit — a pure no-op — to surface a
 *     structural rejection an approval could never cure WITHOUT prompting. For a
 *     genuine proposal the EXISTING confirm port is awaited BETWEEN `prepare` and
 *     `commit` (no store lock across the wait). On DENY nothing commits; on
 *     APPROVE the commit re-checks CAS, so a concurrent edit yields `stale`.
 */
const routeModelMutation = async (
  ports: ObjectiveToolPorts,
  threadId: string,
  mutation: ModelObjectiveMutation,
  ctx: ToolContext,
): Promise<ToolResult> => {
  const prepared = ports.model.prepare(threadId, mutation)
  if (!prepared.approvalRequired) return commitResult(prepared.commit({ admitted: true }))
  // Probe for a rejection that approval cannot cure (no store effect, no prompt).
  const probe = prepared.commit({ admitted: false })
  if (!probe.ok && probe.reason !== "approval-required") return commitResult(probe)
  const requester = ctx.requestObjectiveApproval
  if (requester === undefined) return errResult(NO_CONFIRM_SURFACE)
  const decision = await requester(buildApprovalRequest(mutation))
  if (!decision.admitted) {
    const suffix = decision.note !== undefined && decision.note !== "" ? ` — ${decision.note}` : ""
    return errResult(`objective proposal declined by operator${suffix}`)
  }
  return commitResult(prepared.commit({ admitted: true }))
}

// ─────────────────────────────────────────────────────────────────────────────
// TOOLS
// ─────────────────────────────────────────────────────────────────────────────

/** RFC-03 C4 — map a validated success-criteria entry (string OR object) to a
 *  domain {@link CriterionDeclaration}. A `check` (snake_case tool shape) becomes
 *  a checked declaration; the check `id`/`cwdPolicy` are NOT accepted here — they
 *  are domain-minted so the model cannot choose them (nor mint a receipt). */
type CriterionEntry = NonNullable<ObjectiveSetInput["success_criteria"]>[number]
const toCriterionDeclaration = (entry: CriterionEntry): CriterionDeclaration => {
  if (typeof entry === "string") return { text: entry }
  if (entry.check === undefined) return { text: entry.text }
  return {
    text: entry.text,
    check: {
      kind: "command",
      argv: entry.check.argv,
      timeoutMs: entry.check.timeout_ms,
      successExitCodes: entry.check.success_exit_codes,
    },
  }
}

/** GOAL-01 — map the validated `objective_set` payload to a domain definition. */
const toGoalDefinition = (data: ObjectiveSetInput): GoalDefinition => {
  const budget: { maxTokens?: number; maxTurns?: number } = {}
  if (data.budget?.max_tokens !== undefined) budget.maxTokens = data.budget.max_tokens
  if (data.budget?.max_turns !== undefined) budget.maxTurns = data.budget.max_turns
  return {
    goal: data.goal,
    ...(data.success_criteria !== undefined
      ? { criteria: data.success_criteria.map(toCriterionDeclaration) }
      : {}),
    ...(Object.keys(budget).length > 0 ? { budget } : {}),
  }
}

const buildObjectiveSet = (ports: ObjectiveToolPorts): Tool<ObjectiveSetInput> => ({
  name: "objective_set",
  description:
    "PROPOSE the per-thread Objective (the operator approves it): goal (1-2 sentences), optional " +
    "success_criteria (testable list), optional budget (max_tokens/max_turns). " +
    "Use at the START of work to declare what you are doing and what 'done' " +
    "means. Returns the new objective state (goal/status/blockers/nextActions).",
  inputSchema: objectiveSetSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  hitlTier: () => "pre-approval-ok",
  async *execute(input, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const parsed = objectiveSetSchema.safeParse(input)
    if (!parsed.success) {
      yield { type: "result", result: errResult(`invalid input: ${parsed.error.message}`) }
      return
    }
    const threadId = boundThreadId(ctx)
    if (threadId === null) {
      yield { type: "result", result: errResult(NO_SESSION_THREAD) }
      return
    }
    try {
      // GOAL-02 — the model may only PROPOSE a new objective; a live one is the
      // user's to edit (the policy answers `objective-exists`).
      const mutation: ModelObjectiveMutation = {
        kind: "create",
        definition: toGoalDefinition(parsed.data),
      }
      yield { type: "result", result: await routeModelMutation(ports, threadId, mutation, ctx) }
    } catch (e) {
      yield { type: "result", result: errResult(`objective_set error: ${errMessage(e)}`) }
    }
  },
})

/** Translate a validated `objective_update` op into the authority mutation. */
const opToMutation = (op: ObjectiveUpdateInput["op"]): ModelObjectiveMutation => {
  switch (op.kind) {
    case "addBlocker":
      return { kind: "addBlocker", reason: op.reason, waitingOn: op.waiting_on }
    case "nextActions":
      return { kind: "setNextActions", actions: op.actions }
  }
}

const buildObjectiveUpdate = (ports: ObjectiveToolPorts): Tool<ObjectiveUpdateInput> => ({
  name: "objective_update",
  description:
    "Partially mutate the per-thread Objective. `op.kind` selects: " +
    "addBlocker (reason + waiting_on=user|tool|network|child_agent) / " +
    "nextActions (list of strings). Status, criterion completion and usage are " +
    "OWNED BY THE HOST: completion is derived from user attestations and verifier " +
    "receipts, never from a model update. Returns the NEW objective state.",
  inputSchema: objectiveUpdateSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  hitlTier: () => "pre-approval-ok",
  async *execute(input, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const parsed = objectiveUpdateSchema.safeParse(input)
    if (!parsed.success) {
      yield { type: "result", result: errResult(`invalid input: ${parsed.error.message}`) }
      return
    }
    const threadId = boundThreadId(ctx)
    if (threadId === null) {
      yield { type: "result", result: errResult(NO_SESSION_THREAD) }
      return
    }
    try {
      yield {
        type: "result",
        result: await routeModelMutation(ports, threadId, opToMutation(parsed.data.op), ctx),
      }
    } catch (e) {
      yield { type: "result", result: errResult(`objective_update error: ${errMessage(e)}`) }
    }
  },
})

const buildObjectiveGet = (ports: ObjectiveToolPorts): Tool<ObjectiveGetInput> => ({
  name: "objective_get",
  description:
    "Read the current per-thread Objective. Returns goal/status/blockers/" +
    "criteria/nextActions/budget; if no objective is set for the thread, " +
    "returns ok:false with 'no objective set for thread <id>'.",
  inputSchema: objectiveGetSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  hitlTier: () => "pre-approval-ok",
  async *execute(input, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const parsed = objectiveGetSchema.safeParse(input)
    if (!parsed.success) {
      yield { type: "result", result: errResult(`invalid input: ${parsed.error.message}`) }
      return
    }
    const threadId = boundThreadId(ctx)
    if (threadId === null) {
      yield { type: "result", result: errResult(NO_SESSION_THREAD) }
      return
    }
    try {
      const o = ports.read.get(threadId)
      if (o === null) {
        yield { type: "result", result: errResult(`no objective set for thread ${threadId}`) }
        return
      }
      yield { type: "result", result: okResult(o) }
    } catch (e) {
      yield { type: "result", result: errResult(`objective_get error: ${errMessage(e)}`) }
    }
  },
})

/** Build the 3 objective tools over the revisioned mutation AUTHORITY (RFC-03 C1).
 *  Model-originated mutations carry `actor:"model"` + a SESSION-bound thread id.
 *
 *  SLICE FENCE: this slice takes the authority INJECTED and only ever imports
 *  `@/objective` as TYPES. Recovering it from a bare `ObjectivePort` needs the
 *  `asObjectiveAuthority` VALUE, which `@/tool` is denied (see
 *  `tests/unit/_arch/slice-boundary-configs.ts` — "`@/objective` … added to the
 *  explicit deny lists of the hand-written peer slices … so a future VALUE
 *  import of `@/objective` from any of them fires"). So the BRIDGE composes it:
 *  production via `buildObjectiveBlock` (`@/agent/tier1/objective.ts`), tests by
 *  wrapping their double themselves. */
export const objectiveTools = (ports: ObjectiveToolPorts): Tool[] => {
  return [
    buildObjectiveSet(ports) as Tool,
    buildObjectiveUpdate(ports) as Tool,
    buildObjectiveGet(ports) as Tool,
    ...(ports.verify !== undefined ? [buildObjectiveVerify(ports, ports.verify) as Tool] : []),
  ]
}

export const objectiveVerifySchema = z.object({
  thread_id: z.string().optional().describe("Deprecated and ignored"),
  criterion_ids: z
    .array(z.string().min(1).max(MAX_LIST_ITEM_CHARS))
    .max(MAX_LIST_ITEMS)
    .optional()
    .describe("Optional subset of CHECKED criterion ids to run; default all checked criteria"),
})
export type ObjectiveVerifyInput = z.infer<typeof objectiveVerifySchema>

/** GOAL-03 — the model's verification REQUEST. It carries no argv: the host runs
 *  the objective's stored immutable checks and commits the verifier batch; the
 *  model only learns the typed outcome. */
const buildObjectiveVerify = (
  ports: ObjectiveToolPorts,
  verify: ObjectiveVerificationPort,
): Tool<ObjectiveVerifyInput> => ({
  name: "objective_verify",
  description:
    "Run the objective's stored machine checks (CHECKED criteria) against the current " +
    "workspace and record the verifier receipts. You cannot supply commands here; only " +
    "the checks declared on the objective run. Returns the typed outcome " +
    "(verified with pass/fail counts, stale-source, no-checks, ...).",
  inputSchema: objectiveVerifySchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  hitlTier: () => "pre-approval-ok",
  async *execute(input, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const parsed = objectiveVerifySchema.safeParse(input)
    if (!parsed.success) {
      yield { type: "result", result: errResult(`invalid input: ${parsed.error.message}`) }
      return
    }
    const threadId = boundThreadId(ctx)
    if (threadId === null) {
      yield { type: "result", result: errResult(NO_SESSION_THREAD) }
      return
    }
    try {
      const outcome = await verify.verify(threadId, parsed.data.criterion_ids, ctx.signal)
      const objective = ports.read.get(threadId)
      if (outcome.kind !== "verified" || objective === null) {
        const reason = "reason" in outcome ? ` (${outcome.reason})` : ""
        yield {
          type: "result",
          result: errResult(`objective verification: ${outcome.kind}${reason}`),
        }
        return
      }
      yield {
        type: "result",
        result: {
          ok: true,
          output: `verified: passed=${outcome.passed} failed=${outcome.failed} rev=${outcome.revision}\n${renderObjective(objective)}`,
        },
      }
    } catch (e) {
      yield { type: "result", result: errResult(`objective_verify error: ${errMessage(e)}`) }
    }
  },
})
