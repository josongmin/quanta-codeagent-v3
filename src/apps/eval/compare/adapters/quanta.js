import { errMessage, logger } from "@/shared";
import { runScenario } from "../../synthetic/runner";
export class QuantaAdapter {
    opts;
    name = "quanta";
    constructor(opts) {
        this.opts = opts;
    }
    async available() {
        return { ok: true };
    }
    async runOne(scenario) {
        const start = Date.now();
        try {
            const r = await runScenario(scenario, {
                llm: this.opts.llm,
                ...(this.opts.timeoutMs !== undefined ? { timeoutMs: this.opts.timeoutMs } : {}),
            });
            // `aborted` and `timeout` are infrastructure failures that the pairwise
            // judge would otherwise score as completed runs — treat them as
            // `exitOk:false` so the result is recorded as a real failure, not a
            // silently-truncated "win or lose against the other agent".
            const failedStopReasons = new Set(["error", "aborted", "timeout"]);
            const exitOk = !failedStopReasons.has(r.stopReason);
            return {
                agent: this.name,
                transcript: r.assistantText,
                toolsUsed: r.toolsUsed,
                durationMs: r.durationMs,
                exitOk,
                ...(exitOk ? {} : { failureReason: `stopReason=${r.stopReason}` }),
            };
        }
        catch (e) {
            const reason = errMessage(e);
            logger.warn("compare.quanta: runOne failed", { reason });
            return {
                agent: this.name,
                transcript: "",
                toolsUsed: [],
                durationMs: Date.now() - start,
                exitOk: false,
                failureReason: reason,
            };
        }
    }
}
