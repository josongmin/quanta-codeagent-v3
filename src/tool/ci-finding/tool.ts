/**
 * `ci_finding` — structured CI-investigation finding tool (§7.3 long-tail).
 *
 * A CI-investigation skill today concludes in PROSE; this tool lets the agent
 * RECORD a structured `CiFinding` (job + category + root-cause + evidence +
 * suggested fix + confidence) into a session store, then LIST / GET them. The
 * structured record is rendererable, dedupable, and feedable to a next stage
 * (Codex/Cursor CI-investigation parity).
 *
 * Three ops:
 *   - `record` — capture a new finding (job/category/summary/root_cause REQUIRED).
 *   - `list`   — enumerate recorded findings (optional job/category filter).
 *   - `get`    — fetch one by id.
 *
 * READ-ish: `record` mutates only the in-SESSION store (no FS/shell/git/network),
 * so it is classified `working_state_write`-equivalent — but to keep the tool
 * surface simple and plan-safe (it records the agent's OWN analysis, never the
 * workspace) it self-reports `isReadOnly: true` / `hitlTier: none`, mirroring
 * `communicate_update` / `objective_*` (pure in-session bookkeeping). NO-THROW.
 */
import { z } from "zod"
import { errMessage } from "@/shared"
import type { Tool, ToolContext, ToolEvent } from "../types"
import {
  type CiFindingCategory,
  type CiFindingConfidence,
  type CiFindingStore,
  renderFinding,
  renderFindings,
} from "./store"

/** Per-field cap — a finding is a focused record, not a log dump. */
const MAX_FIELD = 4000

const CATEGORY = [
  "test-failure",
  "build-error",
  "lint",
  "type-error",
  "flaky",
  "timeout",
  "dependency",
  "infra",
  "config",
  "other",
] as const

const CONFIDENCE = ["low", "medium", "high"] as const

export const ciFindingSchema = z
  .object({
    op: z.enum(["record", "list", "get"]).describe("record a finding | list all | get one by id"),
    // record fields
    job: z.string().min(1).max(200).optional().describe("Failing CI job/check name (record)"),
    category: z.enum(CATEGORY).optional().describe("Failure category (record)"),
    summary: z.string().min(1).max(MAX_FIELD).optional().describe("One-line summary (record)"),
    root_cause: z
      .string()
      .min(1)
      .max(MAX_FIELD)
      .optional()
      .describe("Investigated root cause (record)"),
    evidence: z
      .string()
      .max(MAX_FIELD)
      .optional()
      .describe("Log excerpt / file:line / test name (record)"),
    suggested_fix: z.string().max(MAX_FIELD).optional().describe("Suggested fix (record)"),
    confidence: z.enum(CONFIDENCE).optional().describe("Confidence in the root cause (record)"),
    // get / list fields
    id: z.string().min(1).optional().describe("Finding id (get)"),
    filter_job: z.string().min(1).optional().describe("Only list findings for this job (list)"),
    filter_category: z.enum(CATEGORY).optional().describe("Only list this category (list)"),
  })
  .describe("Structured CI-investigation finding store: record / list / get.")
export type CiFindingInput = z.infer<typeof ciFindingSchema>

type Outcome = { readonly ok: boolean; readonly output: string }

/** op:record — validate the required fields then store. Pure (mutates only the
 *  injected store). Extracted to keep the tool's `execute` complexity bounded. */
const doRecord = (store: CiFindingStore, d: CiFindingInput): Outcome => {
  const missing: string[] = []
  if (d.job === undefined) missing.push("job")
  if (d.category === undefined) missing.push("category")
  if (d.summary === undefined) missing.push("summary")
  if (d.root_cause === undefined) missing.push("root_cause")
  if (missing.length > 0) return { ok: false, output: `record requires: ${missing.join(", ")}` }
  const rec = store.record({
    job: d.job as string,
    category: d.category as CiFindingCategory,
    summary: d.summary as string,
    rootCause: d.root_cause as string,
    ...(d.evidence !== undefined ? { evidence: d.evidence } : {}),
    ...(d.suggested_fix !== undefined ? { suggestedFix: d.suggested_fix } : {}),
    confidence: (d.confidence ?? "medium") as CiFindingConfidence,
  })
  return { ok: true, output: `recorded:\n${renderFinding(rec)}` }
}

/** op:list — enumerate with the optional job/category filter. */
const doList = (store: CiFindingStore, d: CiFindingInput): Outcome => {
  const filter: { job?: string; category?: CiFindingCategory } = {}
  if (d.filter_job !== undefined) filter.job = d.filter_job
  if (d.filter_category !== undefined) filter.category = d.filter_category
  return { ok: true, output: renderFindings(store.list(filter)) }
}

/** op:get — fetch one by id. */
const doGet = (store: CiFindingStore, d: CiFindingInput): Outcome => {
  if (d.id === undefined) return { ok: false, output: "get requires: id" }
  const f = store.get(d.id)
  if (f === undefined) return { ok: false, output: `no finding with id '${d.id}'` }
  return { ok: true, output: renderFinding(f) }
}

/** Pure op-dispatcher — NO-THROW: a thrown store collapses to ok:false. */
const runCiFinding = (store: CiFindingStore, d: CiFindingInput): Outcome => {
  try {
    switch (d.op) {
      case "record":
        return doRecord(store, d)
      case "list":
        return doList(store, d)
      case "get":
        return doGet(store, d)
    }
  } catch (e) {
    return { ok: false, output: `ci_finding failed: ${errMessage(e)}` }
  }
}

export const ciFindingTool = (store: CiFindingStore): Tool<CiFindingInput> => ({
  name: "ci_finding",
  description:
    "Record a STRUCTURED CI-investigation finding (job + category + root cause + " +
    "evidence + suggested fix + confidence), then list/get them — vs leaving the " +
    "conclusion as prose. op: record | list | get. The structured record is " +
    "rendererable and feedable to a next stage. Records your OWN analysis only " +
    "(no FS/shell side effect).",
  inputSchema: ciFindingSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  hitlTier: () => "none",
  async *execute(input: CiFindingInput, _ctx: ToolContext): AsyncIterable<ToolEvent> {
    const parsed = ciFindingSchema.safeParse(input)
    if (!parsed.success) {
      yield {
        type: "result",
        result: { ok: false, output: `invalid input: ${parsed.error.message}` },
      }
      return
    }
    yield { type: "result", result: runCiFinding(store, parsed.data) }
  },
})
