/**
 * ADR-0086 — `request_plan_exit` tool: relays the 3-way plan-exit decision
 * from `ToolContext.requestPlanExit` to the model, and degrades cleanly when
 * no requester is wired.
 */
import { describe, expect, test } from "bun:test";
import { requestPlanExitTool } from "@/tool/request-plan-exit";
const drain = async (it) => {
    const out = [];
    for await (const e of it)
        out.push(e);
    return out;
};
const ctx = (over = {}) => ({
    cwd: "/repo",
    signal: new AbortController().signal,
    ...over,
});
const result = (events) => {
    const last = events.at(-1);
    if (last?.type !== "result")
        throw new Error("no terminal result");
    return last.result;
};
const tool = requestPlanExitTool();
describe("request_plan_exit tool", () => {
    test("metadata: read-only, concurrency-UNSAFE (blocks on operator)", () => {
        expect(tool.name).toBe("request_plan_exit");
        expect(tool.isReadOnly()).toBe(true);
        expect(tool.isConcurrencySafe({ plan: "x" })).toBe(false);
    });
    test("approved → ok:true, tells the model to proceed", async () => {
        const requestPlanExit = async () => ({ decision: "approved" });
        const r = result(await drain(tool.execute({ plan: "do X" }, ctx({ requestPlanExit }))));
        expect(r.ok).toBe(true);
        expect(r.output).toContain("APPROVED");
        expect(r.output).toContain("proceed");
    });
    test("rejected → ok:true, tells the model to stop", async () => {
        const requestPlanExit = async () => ({ decision: "rejected" });
        const r = result(await drain(tool.execute({ plan: "do X" }, ctx({ requestPlanExit }))));
        expect(r.ok).toBe(true);
        expect(r.output).toContain("REJECTED");
    });
    test("changes_requested → relays the feedback", async () => {
        const requestPlanExit = async () => ({
            decision: "changes_requested",
            feedback: "scope it to src/ only",
        });
        const r = result(await drain(tool.execute({ plan: "do X" }, ctx({ requestPlanExit }))));
        expect(r.ok).toBe(true);
        expect(r.output).toContain("Changes requested");
        expect(r.output).toContain("scope it to src/ only");
    });
    test("no requester wired → ok:false (graceful, not a throw)", async () => {
        const r = result(await drain(tool.execute({ plan: "do X" }, ctx())));
        expect(r.ok).toBe(false);
        expect(r.output).toContain("no plan-exit port");
    });
    test("requester throws → ok:false error result (never throws past the loop)", async () => {
        const requestPlanExit = async () => {
            throw new Error("operator cancelled");
        };
        const r = result(await drain(tool.execute({ plan: "do X" }, ctx({ requestPlanExit }))));
        expect(r.ok).toBe(false);
        expect(r.output).toContain("operator cancelled");
    });
    test("emits a progress event before the terminal result", async () => {
        const requestPlanExit = async () => ({ decision: "approved" });
        const events = await drain(tool.execute({ plan: "x" }, ctx({ requestPlanExit })));
        expect(events[0]?.type).toBe("progress");
    });
});
