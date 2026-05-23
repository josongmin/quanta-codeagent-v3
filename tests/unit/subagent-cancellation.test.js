import { describe, expect, test } from "bun:test";
import { createAgentTool, createTaskOutputTool, createTaskStopTool, TaskRegistry, } from "../../src/subagent";
/**
 * Regression: the forked runner MUST observe `req.signal` so `task_stop`
 * actually unwinds the child. The historical bug was `agent-tool.ts#
 * launchBackground` discarding the AbortController returned by
 * `registry.register()`. With the fix, calling `task_stop` aborts the per-task
 * controller AND the runner sees `req.signal.aborted === true`, which it
 * MUST chain into the child loop.
 */
const ctxAt = (depth) => ({
    cwd: "/tmp",
    signal: new AbortController().signal,
    ...(depth !== undefined ? { depth } : {}),
});
const run = async (tool, input, ctx) => {
    let last;
    for await (const ev of tool.execute(input, ctx))
        last = ev;
    if (!last)
        throw new Error("tool yielded no events");
    return last;
};
const result = (r = {}) => ({
    ok: true,
    finalText: "done",
    turns: 1,
    ...r,
});
/** A runner that resolves when `req.signal` aborts. Returns a runner + a probe
 *  promise that resolves with the request the runner OBSERVED, so the test can
 *  inspect signal wiring AND coordinate with abort. */
const abortObservingRunner = () => {
    let seeReq;
    let resolveExited;
    const observed = new Promise((res) => {
        seeReq = res;
    });
    const exited = new Promise((res) => {
        resolveExited = res;
    });
    const runner = (req) => new Promise((resolve) => {
        seeReq(req);
        const sig = req.signal;
        if (!sig) {
            // Foreground path: no per-task signal — never resolves here. Caller
            // shouldn't rely on this runner exiting in the foreground.
            return;
        }
        const onAbort = () => {
            const r = result({ ok: false, finalText: "aborted by req.signal", turns: 0 });
            resolveExited(r);
            resolve(r);
        };
        if (sig.aborted) {
            onAbort();
            return;
        }
        sig.addEventListener("abort", onAbort, { once: true });
    });
    return { runner, observed, exited };
};
describe("agent-tool — req.signal wiring (HIGH regression)", () => {
    test("background launch threads registry's AbortController into req.signal", async () => {
        const { runner, observed } = abortObservingRunner();
        const reg = new TaskRegistry();
        const agent = createAgentTool({ runner, registry: reg });
        const ev = await run(agent, { prompt: "long job", background: true }, ctxAt(0));
        if (ev.type !== "result")
            throw new Error("expected result");
        const seen = await observed;
        expect(seen.signal).toBeDefined();
        // Newly registered ⇒ not yet aborted.
        expect(seen.signal?.aborted).toBe(false);
    });
    test("task_stop unwinds the runner that observes req.signal", async () => {
        const { runner, exited } = abortObservingRunner();
        const reg = new TaskRegistry();
        const agent = createAgentTool({ runner, registry: reg });
        const stop = createTaskStopTool(reg);
        const out = createTaskOutputTool(reg);
        const ev = await run(agent, { prompt: "never ends", background: true }, ctxAt(0));
        if (ev.type !== "result")
            throw new Error("expected result");
        const taskId = ev.result.output.match(/task_id: (\S+)/)[1];
        const ownerToken = ev.result.output.match(/owner_token: (\S+)/)[1];
        // Stop it. The registry aborts its controller; the runner's listener fires.
        const s = await run(stop, { task_id: taskId, owner_token: ownerToken }, ctxAt(0));
        if (s.type !== "result")
            throw new Error("expected result");
        expect(s.result.ok).toBe(true);
        // The runner's promise resolves PROVING it observed the abort (proves the
        // fix — pre-fix, ac.signal was discarded and this would hang).
        const finalResult = await exited;
        expect(finalResult.finalText).toBe("aborted by req.signal");
        // Registry status flipped to "stopped".
        const after = await run(out, { task_id: taskId }, ctxAt(0));
        if (after.type !== "result")
            throw new Error("expected result");
        expect(after.result.output).toContain("status: stopped");
    });
    test("foreground launch leaves req.signal undefined (legacy path)", async () => {
        let seen;
        const runner = async (req) => {
            seen = req;
            return result();
        };
        const tool = createAgentTool({ runner });
        const ev = await run(tool, { prompt: "fg" }, ctxAt(0));
        if (ev.type !== "result")
            throw new Error("expected result");
        expect(ev.result.ok).toBe(true);
        expect(seen?.signal).toBeUndefined();
    });
    test("double-stop is a no-op failure", async () => {
        const runner = () => new Promise(() => { });
        const reg = new TaskRegistry();
        const agent = createAgentTool({ runner, registry: reg });
        const stop = createTaskStopTool(reg);
        const ev = await run(agent, { prompt: "x", background: true }, ctxAt(0));
        if (ev.type !== "result")
            throw new Error("expected result");
        const taskId = ev.result.output.match(/task_id: (\S+)/)[1];
        const ownerToken = ev.result.output.match(/owner_token: (\S+)/)[1];
        const first = await run(stop, { task_id: taskId, owner_token: ownerToken }, ctxAt(0));
        if (first.type !== "result")
            throw new Error("expected result");
        expect(first.result.ok).toBe(true);
        const second = await run(stop, { task_id: taskId, owner_token: ownerToken }, ctxAt(0));
        if (second.type !== "result")
            throw new Error("expected result");
        expect(second.result.ok).toBe(false);
        expect(second.result.output).toContain("unknown or already settled");
    });
    test("registry.waitForSettle(taskId) coordinates with task_stop end-to-end", async () => {
        const { runner } = abortObservingRunner();
        const reg = new TaskRegistry();
        const agent = createAgentTool({ runner, registry: reg });
        const stop = createTaskStopTool(reg);
        const ev = await run(agent, { prompt: "x", background: true }, ctxAt(0));
        if (ev.type !== "result")
            throw new Error("expected result");
        const taskId = ev.result.output.match(/task_id: (\S+)/)[1];
        const ownerToken = ev.result.output.match(/owner_token: (\S+)/)[1];
        // W1-D / W2 audit fix: previous body raced settle Promises against
        // `setTimeout(5)` and `setTimeout(100)` to assert "running ⇒ pending"
        // and "stopped ⇒ settled". Both are CI-flaky (GC pause / loaded
        // runner can fire the timer before a genuinely-settled .then). Probe
        // via micro-task drain: a settled-now Promise resolves its .then
        // callback within a finite number of micro-task turns; a still-pending
        // Promise stays pending no matter how many turns we drain.
        const probe = async (p) => {
            let done = false;
            void p.then(() => {
                done = true;
            }, () => {
                done = true;
            });
            for (let i = 0; i < 4; i++)
                await Promise.resolve();
            return done ? "settled" : "pending";
        };
        // Task is running and no one has stopped it — settle must stay pending.
        expect(await probe(reg.waitForSettle(taskId))).toBe("pending");
        // Now stop. waitForSettle must resolve via the internal event handler
        // before any further micro-task turn.
        const settle = reg.waitForSettle(taskId);
        await run(stop, { task_id: taskId, owner_token: ownerToken }, ctxAt(0));
        expect(await probe(settle)).toBe("settled");
        expect(reg.get(taskId)?.status).toBe("stopped");
    });
});
