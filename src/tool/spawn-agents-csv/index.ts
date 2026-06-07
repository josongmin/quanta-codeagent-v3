/**
 * `spawn_agents_on_csv` — agent-callable batch fan-out (GAP7-4, ADR-0463).
 *
 * The agent hands a CSV + an instruction; the batch runner fans ONE subagent out
 * per row (bounded by poolSize), collects each row's structured result, and
 * returns a results CSV. Codex `spawn_agents_on_csv` parity — the same capability
 * the human-driven `quanta batch` CLI exposes, now agent-callable.
 *
 * Plane-clean: `../types` + `zod` only. The CSV parse + spec build + subagent
 * fan-out + durable store live behind an injected {@link BatchRunPort} (wired at
 * the composition root over `parseRowsFromCsv` + `BatchJobRunner` +
 * `SqliteJobStore` + the `RowDispatchPort`-over-`SubagentRunner` adapter). The
 * leaf NEVER imports `@/agent`. NO-THROW. Default-OFF: registered only when the
 * composition root injects the port (absent ⇒ tool absent, byte-identical).
 */
import { z } from "zod"
import { errMessage } from "@/shared"
import type { Tool, ToolContext, ToolEvent } from "../types"

/** Outcome the composition-root adapter returns after running a batch. */
export interface BatchRunOutcome {
  readonly total: number
  readonly done: number
  readonly failed: number
  /** Results CSV (input columns + `_status`/`_result`/`_error`). */
  readonly outputCsv: string
  /** Persisted job id (for resume / later inspection). */
  readonly jobId: string
}

/** Injected batch orchestrator. Parses the CSV, builds + runs the job, returns a
 *  summary + results CSV. NO-THROW: a fault resolves `{ ok:false, reason }`. */
export interface BatchRunPort {
  run(
    input: {
      readonly name: string
      readonly instruction: string
      readonly csv: string
      readonly poolSize?: number
      readonly maxAttempts?: number
    },
    signal?: AbortSignal,
  ): Promise<
    | { readonly ok: true; readonly outcome: BatchRunOutcome }
    | { readonly ok: false; readonly reason: string }
  >
}

export const spawnAgentsCsvInputSchema = z.object({
  name: z.string().min(1).max(200).describe("A short name for this batch job."),
  instruction: z
    .string()
    .min(1)
    .max(20_000)
    .describe("The instruction handed to EACH row's subagent (the row JSON is appended)."),
  csv: z
    .string()
    .min(1)
    .max(2_000_000)
    .describe("The input CSV (header row + data rows). One data row → one subagent task."),
  poolSize: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Max rows to run concurrently (bounded by the runner's safety cap)."),
  maxAttempts: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Per-row attempt cap (attempt 1 + retries). Default 1."),
})
export type SpawnAgentsCsvInput = z.infer<typeof spawnAgentsCsvInputSchema>

/** Build the `spawn_agents_on_csv` tool over a {@link BatchRunPort}. */
export const spawnAgentsCsvTool = (port: BatchRunPort): Tool<SpawnAgentsCsvInput> => ({
  name: "spawn_agents_on_csv",
  description:
    "Run a batch: fan ONE subagent out per CSV row with a shared instruction, " +
    "collect each row's structured result, and return a results CSV. Use for " +
    "repetitive per-row work (e.g. classify/transform N records). Bounded " +
    "concurrency; EXPENSIVE (one child agent per row).",
  inputSchema: spawnAgentsCsvInputSchema,
  // Spawns child agents (which may mutate) → NOT read-only; concurrency-unsafe
  // (it owns a bounded pool of its own). hitlTier escalates: a fan-out is a
  // heavy, cost-bearing action the human should be able to gate.
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  hitlTier: () => "always-confirm",
  async *execute(input, c: ToolContext): AsyncIterable<ToolEvent> {
    const parsed = spawnAgentsCsvInputSchema.safeParse(input)
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
    // NO-THROW contract §2: the port is no-throw BY CONTRACT, but guard the await
    // anyway so a misbehaving host port can never escape the tool iterator.
    let res: Awaited<ReturnType<BatchRunPort["run"]>>
    try {
      res = await port.run(
        {
          name: parsed.data.name,
          instruction: parsed.data.instruction,
          csv: parsed.data.csv,
          ...(parsed.data.poolSize !== undefined ? { poolSize: parsed.data.poolSize } : {}),
          ...(parsed.data.maxAttempts !== undefined
            ? { maxAttempts: parsed.data.maxAttempts }
            : {}),
        },
        c.signal,
      )
    } catch (e) {
      yield { type: "result", result: { ok: false, output: `batch failed: ${errMessage(e)}` } }
      return
    }
    if (!res.ok) {
      yield { type: "result", result: { ok: false, output: `batch failed: ${res.reason}` } }
      return
    }
    const o = res.outcome
    yield {
      type: "result",
      result: {
        ok: true,
        output: `batch ${o.jobId}: ${o.done}/${o.total} done, ${o.failed} failed\n\n${o.outputCsv}`,
      },
    }
  },
})
