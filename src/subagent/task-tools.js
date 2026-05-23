import { z } from "zod";
const outputSchema = z.object({
    task_id: z.string().describe("Id returned by a background agent launch"),
    block: z
        .boolean()
        .optional()
        .describe("Wait until the task settles (or timeout) instead of a snapshot"),
    timeout_ms: z.number().optional().describe("Max ms to block when block:true (default 30000)"),
});
/** Default block timeout for `task_output(block:true)`. 30s balances "give
 *  a quick-running task time to settle" against "don't keep a tool call
 *  blocked indefinitely". Callers can override via `timeout_ms`. */
const DEFAULT_TASK_OUTPUT_BLOCK_MS = 30_000;
const stopSchema = z.object({
    task_id: z.string().describe("Id of the background task to cancel"),
    owner_token: z
        .string()
        .describe("Capability token returned by `task_run`. Without the matching token the registry refuses the stop — a sibling agent that only knows the task_id cannot cancel another task."),
});
const render = (t) => {
    const lines = [
        `task_id: ${t.id}`,
        `status: ${t.status}`,
        t.agentType ? `agent_type: ${t.agentType}` : undefined,
        `description: ${t.description}`,
    ].filter(Boolean);
    if (t.status === "completed" && t.result) {
        lines.push("", `result (${t.result.turns} turns):`, t.result.finalText);
    }
    else if (t.status === "failed") {
        lines.push("", `error: ${t.error ?? t.result?.finalText ?? "unknown"}`);
    }
    else if (t.status === "stopped") {
        lines.push("", "(task was stopped before completion)");
    }
    return lines.join("\n");
};
const settled = (t) => t.status !== "running";
const notFound = (taskId) => ({
    type: "result",
    result: { ok: false, output: `No task found with id: ${taskId}` },
});
/** Race the registry's event-driven settle Promise against a timeout and the
 *  tool context's abort signal. We race instead of polling so the wait resolves
 *  the instant the task transitions to a terminal status (registry resolves
 *  the settler in `complete`/`fail`/`stop`) — no 100ms granularity, no wakeups.
 *  Both timer and abort listener are cleaned up unconditionally so a settled-
 *  early path leaves no dangling resources. */
const waitForSettle = async (registry, taskId, ctx, timeoutMs) => {
    let timer;
    let onAbort;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
    });
    const aborted = new Promise((resolve) => {
        if (ctx.signal.aborted) {
            resolve();
            return;
        }
        onAbort = () => resolve();
        ctx.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
        await Promise.race([registry.waitForSettle(taskId), timeout, aborted]);
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
        if (onAbort)
            ctx.signal.removeEventListener("abort", onAbort);
    }
    return registry.get(taskId);
};
/** `task_output` — poll (or block on) a background subagent task by id. */
export const createTaskOutputTool = (registry) => ({
    name: "task_output",
    description: "Read the status/result of a background subagent task. Set block:true to " +
        "wait until it settles (bounded by timeout_ms).",
    inputSchema: outputSchema,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async *execute(input, ctx) {
        let rec = registry.get(input.task_id);
        if (!rec) {
            yield notFound(input.task_id);
            return;
        }
        if (input.block === true && !settled(rec)) {
            yield { type: "progress", message: `Waiting for ${input.task_id}…` };
            rec = await waitForSettle(registry, input.task_id, ctx, input.timeout_ms ?? DEFAULT_TASK_OUTPUT_BLOCK_MS);
            if (rec && !settled(rec)) {
                yield {
                    type: "result",
                    result: { ok: true, output: `timeout — task ${input.task_id} still running` },
                };
                return;
            }
        }
        rec = registry.get(input.task_id);
        if (!rec) {
            yield notFound(input.task_id);
            return;
        }
        yield {
            type: "result",
            result: { ok: rec.status !== "failed", output: render(rec) },
        };
    },
});
/** `task_stop` — cancel a running background subagent task by id. */
export const createTaskStopTool = (registry) => ({
    name: "task_stop",
    description: "Cancel a running background subagent task by its task_id.",
    inputSchema: stopSchema,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    // eslint-disable-next-line require-yield
    async *execute(input) {
        // S17: token-gated stop. Three terminal outcomes, structurally distinct
        // (not just a single boolean) so the LLM sees what actually happened:
        //   - stopped   ⇒ ok:true   — the task was running AND the token matched.
        //   - denied    ⇒ ok:false  — task exists but the token is wrong/missing.
        //   - not-found ⇒ ok:false  — id unknown or already settled.
        const result = registry.stop(input.task_id, input.owner_token);
        yield {
            type: "result",
            result: result === "stopped"
                ? { ok: true, output: `Stopped task ${input.task_id}.` }
                : result === "denied"
                    ? {
                        ok: false,
                        output: `Cannot stop ${input.task_id}: owner_token does not match. Pass the token returned by task_run.`,
                    }
                    : {
                        ok: false,
                        output: `Cannot stop ${input.task_id}: unknown or already settled.`,
                    },
        };
    },
});
