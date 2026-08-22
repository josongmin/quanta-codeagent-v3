/**
 * In-process Quanta adapter — delegates to `synthetic/runner.runScenario`
 * (which already wires `runAgent`/`defaultTools`/sandbox). This is the
 * baseline competitor; other adapters compare AGAINST it.
 *
 * No trajectory persistence: compare-tier records a `ComparePayload`, not a
 * per-agent JSONL. Replay / fixture promotion stays the job of Tier 1/3.
 */
import type { LLMPort } from "@/llm"
import { errMessage, logger } from "@/shared"
import { runScenario } from "../../synthetic/runner"
import type { Scenario } from "../../synthetic/scenario"
import type { AgentAdapter, CompareRunResult } from "../adapter"

export interface QuantaAdapterOpts {
  llm: LLMPort
  /** Optional per-scenario timeout (ms). Default 120s (matches Tier 1). */
  timeoutMs?: number
}

export class QuantaAdapter implements AgentAdapter {
  readonly name = "quanta"
  constructor(private readonly opts: QuantaAdapterOpts) {}

  async available(): Promise<{ ok: boolean; reason?: string }> {
    return { ok: true }
  }

  async runOne(scenario: Scenario): Promise<CompareRunResult> {
    const start = Date.now()
    try {
      const r = await runScenario(scenario, {
        llm: this.opts.llm,
        ...(this.opts.timeoutMs !== undefined ? { timeoutMs: this.opts.timeoutMs } : {}),
      })
      // `aborted` and `timeout` are infrastructure failures that the pairwise
      // judge would otherwise score as completed runs — treat them as
      // `exitOk:false` so the result is recorded as a real failure, not a
      // silently-truncated "win or lose against the other agent".
      const failedStopReasons = new Set(["error", "aborted", "timeout"])
      const exitOk = !failedStopReasons.has(r.stopReason)
      return {
        agent: this.name,
        transcript: r.assistantText,
        toolsUsed: r.toolsUsed,
        durationMs: r.durationMs,
        exitOk,
        ...(exitOk ? {} : { failureReason: `stopReason=${r.stopReason}` }),
      }
    } catch (e) {
      const reason = errMessage(e)
      logger.warn("compare.quanta: runOne failed", { reason })
      return {
        agent: this.name,
        transcript: "",
        toolsUsed: [],
        durationMs: Date.now() - start,
        exitOk: false,
        failureReason: reason,
      }
    }
  }
}
