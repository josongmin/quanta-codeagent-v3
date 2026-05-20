import { z } from "zod"
import type {
  Tool,
  ToolContext,
  ToolEvent,
  WorkingStateHandle,
  WorkingStateSnapshot,
} from "./types"

/**
 * `update_working_state` — Codex memory L3 meta-tool (memory-model-audit.md
 * mirror). The model uses it to maintain a free-form per-task scratchpad that
 * rides each turn's reminder: owner shortlist, hypothesis, blockers, deferred
 * validation, and the next-step queue.
 *
 * Contract: each provided field is a REPLACEMENT for the corresponding state
 * field (not a delta). Absent fields preserve current state. `hypothesis: null`
 * clears the hypothesis. The tool mutates a session-scoped `WorkingState` via
 * the closure-captured {@link WorkingStateHandle} the agent loop wires when
 * `AgentConfig.workingState` is set; the {@link ToolContext.workingState} duck
 * field is consulted as a fallback so a future dispatch that propagates it on
 * the context object continues to work.
 *
 * The tool is built via {@link createUpdateWorkingStateTool} so the handle is
 * captured at construction time — this is the same closure pattern the
 * subagent/skill tools use to avoid plumbing through ToolContext, keeping the
 * `@/tool` slice independent of `@/agent` while letting the loop wire the
 * session-scoped state at session start.
 */

// SECURITY caps (Codex Round 3 review): the working state rides every turn's
// reminder, so unbounded values let a single tool call balloon the prompt
// budget indefinitely (DOS via context-window exhaustion). Two limits:
//   - MAX_LIST: per-array entry count. 50 is well above any legitimate
//     working-set size — an agent needing more than this should write
//     durable artifacts instead (Codex memory-model rule).
//   - MAX_STR / MAX_HYPOTHESIS: per-string char cap. Round 2 audit found a
//     `hypothesis: "x".repeat(10_000_000)` attack — array caps alone don't
//     stop a single 10 MB string from being injected into the reminder.
const MAX_LIST = 50
const MAX_STR = 500
const MAX_HYPOTHESIS = 2_000

const cappedStr = (max: number, label: string) =>
  z.string().min(1).max(max, `${label} must not exceed ${max} characters`)

const ownerSchema = z.object({
  file: cappedStr(MAX_STR, "file").describe("Path to a candidate owner file."),
  reason: cappedStr(MAX_STR, "reason").describe("Why this file is a likely owner."),
})

const blockerSchema = z.object({
  what: cappedStr(MAX_STR, "what").describe("Concrete description of the blocker."),
  surface: cappedStr(MAX_STR, "surface").describe(
    'Where the blocker manifests, e.g. "type", "wire", "test", "runtime".',
  ),
})

const nextStepSchema = z.object({
  what: cappedStr(MAX_STR, "what").describe("Concrete next step."),
  deferred: z
    .boolean()
    .optional()
    .describe("True when this step is intentionally deferred (skipped for now)."),
})

const deferredValidationSchema = z.object({
  rail: cappedStr(MAX_STR, "rail").describe('Validation rail, e.g. "pytest", "bun test", "tsc".'),
  reason: cappedStr(MAX_STR, "reason").describe("Why this validation was deferred."),
})

const schema = z.object({
  ownerShortlist: z
    .array(ownerSchema)
    .max(MAX_LIST, `ownerShortlist must not exceed ${MAX_LIST} entries`)
    .optional()
    .describe("Replacement for the owner shortlist. Omit to leave unchanged."),
  hypothesis: z
    .union([
      z.string().max(MAX_HYPOTHESIS, `hypothesis must not exceed ${MAX_HYPOTHESIS} characters`),
      z.null(),
    ])
    .optional()
    .describe("Working hypothesis. Pass a string to set, null to clear, omit to leave unchanged."),
  blockers: z
    .array(blockerSchema)
    .max(MAX_LIST, `blockers must not exceed ${MAX_LIST} entries`)
    .optional()
    .describe("Replacement for the blockers list. Omit to leave unchanged."),
  nextStepQueue: z
    .array(nextStepSchema)
    .max(MAX_LIST, `nextStepQueue must not exceed ${MAX_LIST} entries`)
    .optional()
    .describe("Replacement for the next-step queue. Omit to leave unchanged."),
  deferredValidation: z
    .array(deferredValidationSchema)
    .max(MAX_LIST, `deferredValidation must not exceed ${MAX_LIST} entries`)
    .optional()
    .describe("Replacement for the deferred-validation list. Omit to leave unchanged."),
})

type Input = z.infer<typeof schema>

/** Compact one-line counts of the new state for the tool result. */
const summarize = (s: WorkingStateSnapshot, changed: readonly string[]): string => {
  const counts = [
    `owners=${s.ownerShortlist.length}`,
    `blockers=${s.blockers.length}`,
    `next=${s.nextStepQueue.length}`,
    `deferred=${s.deferredValidation.length}`,
    `hypothesis=${s.hypothesis !== undefined && s.hypothesis !== "" ? "set" : "none"}`,
  ].join(" ")
  const ch = changed.length === 0 ? "(no changes)" : `changed: ${changed.join(", ")}`
  return `working_state ${ch}\n${counts}`
}

/** Compute the list of patched fields for the result summary. */
const changedFields = (input: Input): string[] => {
  const out: string[] = []
  if (input.ownerShortlist !== undefined) out.push("ownerShortlist")
  if (input.hypothesis !== undefined) out.push("hypothesis")
  if (input.blockers !== undefined) out.push("blockers")
  if (input.nextStepQueue !== undefined) out.push("nextStepQueue")
  if (input.deferredValidation !== undefined) out.push("deferredValidation")
  return out
}

/**
 * Build the `update_working_state` meta-tool against an explicit handle (the
 * agent loop owns the handle and passes it here at session start). When no
 * handle is closure-captured (factory called with `undefined`) the tool falls
 * back to `ctx.workingState` — populated by `dispatchTool` from the agent
 * loop's session-scoped handle when `AgentConfig.workingState?.enabled` is set
 * (ADR-0021). With neither, it reports a hard error so a misconfigured caller
 * is caught early.
 */
export const createUpdateWorkingStateTool = (
  handle: WorkingStateHandle | undefined,
): Tool<Input> => ({
  name: "update_working_state",
  description:
    "Update the per-task working state (Codex memory layer L3). Each provided " +
    "field REPLACES the corresponding state field; omit a field to leave it " +
    "unchanged. Pass `hypothesis: null` to clear it. Use this to track owner " +
    "candidates, blockers, deferred validation, and the next-step queue across " +
    "turns — durable state still belongs in workspace files (artifacts), not " +
    "here.",
  inputSchema: schema,
  isReadOnly: () => false,
  // Mutates session state — must serialize w.r.t. any other call that reads
  // or writes the same handle. Cheap to gate at head-of-line.
  isConcurrencySafe: () => false,

  async *execute(input: Input, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const h = handle ?? ctx.workingState
    if (!h) {
      yield {
        type: "result",
        result: {
          ok: false,
          output:
            "update_working_state: no session WorkingState is attached (the " +
            "feature is not enabled for this run). Enable it via " +
            "`AgentConfig.workingState = { enabled: true }`.",
        },
      }
      return
    }
    const changed = changedFields(input)
    const next = h.mutate(input)
    yield { type: "result", result: { ok: true, output: summarize(next, changed) } }
  },
})
