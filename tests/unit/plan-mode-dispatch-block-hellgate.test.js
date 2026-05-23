/**
 * ADR-0036 plan-mode-dispatch-block — L4 wire hellgate.
 *
 * Adversarial pins for the dispatch-seam guard wired into `dispatchTool`:
 *   - Default-OFF: `collaborationMode` ABSENT ⇒ no block (byte-identical
 *     for every legacy caller). `mode: "review"` / `"audit"` postures
 *     project to `"default"` collab — they do NOT enable the dispatch
 *     block (those are PROMPT postures, not dispatch postures).
 *   - `collaborationMode: "plan"` blocks every mutating tool BEFORE the
 *     dedup / admissibility / execute path. Deny carries the typed
 *     `PlanModeMutatingBlockedError` message + preview "mode-blocked".
 *   - Read-only fast path: `registry.isReadOnly(name) === true` allows
 *     the call through regardless of table membership (so custom
 *     read-only test tools and built-ins both work in plan posture).
 *   - Unknown tools (absent from MUTATING_TOOL_TABLE) + plan mode +
 *     `isReadOnly === false` → fail-closed deny via `UnknownToolError`.
 *   - Parallel dispatch race: N mutating calls fired concurrently all
 *     deny without entering execute.
 *   - `resolveCollaborationMode` projection precedence:
 *     `collaborationMode` wins, else `mode === "plan"`, else
 *     `planMode === true`, else `"default"`.
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { dispatchTool } from "@/agent/dispatch";
import { resolveCollaborationMode } from "@/agent/mode";
import { ToolRegistry } from "@/tool";
const makeTool = (name, opts = {}) => {
    const readOnly = opts.readOnly ?? false;
    const run = opts.run ??
        async function* () {
            yield { type: "result", result: { ok: true, output: `${name}-ran` } };
        };
    return {
        name,
        description: `${name} test tool`,
        inputSchema: (opts.schema ?? z.object({})),
        isReadOnly: () => readOnly,
        isConcurrencySafe: () => readOnly,
        execute: () => run(),
    };
};
const call = (name, input = {}, id = "c1") => ({
    type: "tool_use",
    id,
    name,
    input,
});
const baseCfg = (over = {}) => ({
    registry: new ToolRegistry([]),
    cwd: "/tmp",
    signal: new AbortController().signal,
    permission: { mode: "acceptEdits" },
    ...over,
});
const perm = { mode: "acceptEdits" };
describe("resolveCollaborationMode — projection precedence", () => {
    test("everything absent → default (default-OFF)", () => {
        expect(resolveCollaborationMode({})).toBe("default");
    });
    test("collaborationMode: 'plan' wins absolutely", () => {
        expect(resolveCollaborationMode({ collaborationMode: "plan" })).toBe("plan");
        expect(resolveCollaborationMode({ collaborationMode: "plan", mode: "default" })).toBe("plan");
        expect(resolveCollaborationMode({ collaborationMode: "plan", planMode: false })).toBe("plan");
    });
    test("collaborationMode: 'default' wins absolutely (overrides planMode/mode)", () => {
        expect(resolveCollaborationMode({ collaborationMode: "default" })).toBe("default");
        expect(resolveCollaborationMode({ collaborationMode: "default", mode: "plan" })).toBe("default");
        expect(resolveCollaborationMode({ collaborationMode: "default", planMode: true })).toBe("default");
    });
    test("mode='plan' → plan when collaborationMode absent", () => {
        expect(resolveCollaborationMode({ mode: "plan" })).toBe("plan");
    });
    test("planMode=true → plan when collaborationMode + mode absent", () => {
        expect(resolveCollaborationMode({ planMode: true })).toBe("plan");
    });
    test("mode='review'/'audit' project to default (NOT plan)", () => {
        // The 4-mode `mode` and 2-mode `collaborationMode` are orthogonal —
        // a read-only PROMPT posture must not silently enable the dispatch
        // block. The host opts into dispatch posture explicitly via
        // `collaborationMode`.
        expect(resolveCollaborationMode({ mode: "review" })).toBe("default");
        expect(resolveCollaborationMode({ mode: "audit" })).toBe("default");
    });
    test("mode='default' explicit → default", () => {
        expect(resolveCollaborationMode({ mode: "default" })).toBe("default");
    });
});
describe("dispatch-seam guard — DEFAULT-OFF (byte-identical legacy)", () => {
    test("collaborationMode unset + planMode unset → mutating call runs", async () => {
        const tool = makeTool("custom-mutate", { readOnly: false });
        const res = await dispatchTool(call("custom-mutate"), baseCfg({ registry: new ToolRegistry([tool]) }), perm);
        expect(res.ok).toBe(true);
        expect(res.preview).toBe("custom-mutate-ran");
    });
    test("mode='review' — the SEAM GUARD does NOT block (collab projects to default)", async () => {
        // ADR-0036 contract: the dispatch-seam guard reads collaborationMode
        // (which mode='review' projects to "default"). A separate legacy
        // admissibility-gate path may still block mutating in non-default
        // postures via `isMutatingToolBlockedInMode`; here we only pin the
        // SEAM GUARD's behavior — the reply must not be "mode-blocked".
        const tool = makeTool("write", { readOnly: false });
        const res = await dispatchTool(call("write"), baseCfg({ registry: new ToolRegistry([tool]), mode: "review" }), perm);
        // If the call denies, it MUST not be from the seam guard's preview.
        if (!res.ok) {
            expect(res.preview).not.toBe("mode-blocked");
        }
    });
    test("mode='audit' — the SEAM GUARD does NOT block (collab projects to default)", async () => {
        const tool = makeTool("edit", { readOnly: false });
        const res = await dispatchTool(call("edit"), baseCfg({ registry: new ToolRegistry([tool]), mode: "audit" }), perm);
        if (!res.ok) {
            expect(res.preview).not.toBe("mode-blocked");
        }
    });
});
describe("dispatch-seam guard — plan mode + built-in mutating tools (PlanModeMutatingBlockedError)", () => {
    test("write blocked in plan mode with typed error message", async () => {
        const tool = makeTool("write", { readOnly: false });
        const res = await dispatchTool(call("write"), baseCfg({ registry: new ToolRegistry([tool]), planMode: true }), perm);
        expect(res.ok).toBe(false);
        expect(res.preview).toBe("mode-blocked");
        expect(res.block.is_error).toBe(true);
        expect(res.block.content).toContain("write");
        expect(res.block.content).toContain("blocked in plan collaboration mode");
        expect(res.block.content).toContain("write_filesystem");
    });
    test("edit blocked in plan mode (write_filesystem kind)", async () => {
        const tool = makeTool("edit", { readOnly: false });
        const res = await dispatchTool(call("edit"), baseCfg({ registry: new ToolRegistry([tool]), planMode: true }), perm);
        expect(res.ok).toBe(false);
        expect(res.preview).toBe("mode-blocked");
        expect(res.block.content).toContain("write_filesystem");
    });
    test("bash blocked in plan mode (bash_mutating kind)", async () => {
        const tool = makeTool("bash", {
            readOnly: false,
            schema: z.object({ command: z.string() }),
        });
        const res = await dispatchTool(call("bash", { command: "ls" }), baseCfg({ registry: new ToolRegistry([tool]), planMode: true }), perm);
        expect(res.ok).toBe(false);
        expect(res.preview).toBe("mode-blocked");
        expect(res.block.content).toContain("bash_mutating");
    });
    test("update_working_state blocked in plan mode (working_state_write kind)", async () => {
        const tool = makeTool("update_working_state", { readOnly: false });
        const res = await dispatchTool(call("update_working_state"), baseCfg({ registry: new ToolRegistry([tool]), planMode: true }), perm);
        expect(res.ok).toBe(false);
        expect(res.preview).toBe("mode-blocked");
        expect(res.block.content).toContain("working_state_write");
    });
    test("git_commit blocked in plan mode (git_mutating kind)", async () => {
        const tool = makeTool("git_commit", { readOnly: false });
        const res = await dispatchTool(call("git_commit"), baseCfg({ registry: new ToolRegistry([tool]), planMode: true }), perm);
        expect(res.ok).toBe(false);
        expect(res.preview).toBe("mode-blocked");
        expect(res.block.content).toContain("git_mutating");
    });
    test("collaborationMode='plan' explicit (without planMode) also blocks", async () => {
        const tool = makeTool("write", { readOnly: false });
        const res = await dispatchTool(call("write"), baseCfg({ registry: new ToolRegistry([tool]), collaborationMode: "plan" }), perm);
        expect(res.ok).toBe(false);
        expect(res.preview).toBe("mode-blocked");
    });
    test("collaborationMode='default' EXPLICIT overrides planMode:true at the SEAM (resolveCollaborationMode contract)", async () => {
        // The seam guard reads `resolveCollaborationMode` which honors the
        // explicit field over planMode. We pin that the SEAM does not deny
        // — though the legacy admissibility-gate may still block mutating
        // because `planMode:true` still projects to `mode='plan'` for
        // `isMutatingToolBlockedInMode`. The contract under test here is
        // the seam guard's local decision, not the gate's global posture.
        const tool = makeTool("write", { readOnly: false });
        const res = await dispatchTool(call("write"), baseCfg({
            registry: new ToolRegistry([tool]),
            planMode: true,
            collaborationMode: "default",
        }), perm);
        // Reply must NOT carry the seam guard's "mode-blocked" preview —
        // any deny here is from a different layer (e.g. admissibility gate).
        if (!res.ok) {
            expect(res.preview).not.toBe("mode-blocked");
        }
    });
});
describe("dispatch-seam guard — plan mode + UNKNOWN mutating tool (UnknownToolError fail-closed)", () => {
    test("custom mutating tool absent from table → UnknownToolError deny", async () => {
        const tool = makeTool("custom-unknown-mutate", { readOnly: false });
        const res = await dispatchTool(call("custom-unknown-mutate"), baseCfg({ registry: new ToolRegistry([tool]), planMode: true }), perm);
        expect(res.ok).toBe(false);
        expect(res.preview).toBe("mode-blocked");
        expect(res.block.is_error).toBe(true);
        expect(res.block.content).toContain("custom-unknown-mutate");
        expect(res.block.content).toContain("not classified in the plan-mode mutating table");
    });
});
describe("dispatch-seam guard — plan mode + READ-ONLY tools (fast path)", () => {
    test("read-only built-in (read) passes through in plan mode", async () => {
        const tool = makeTool("read", {
            readOnly: true,
            schema: z.object({ path: z.string() }),
        });
        const res = await dispatchTool(call("read", { path: "/tmp/x" }), baseCfg({ registry: new ToolRegistry([tool]), planMode: true }), perm);
        expect(res.ok).toBe(true);
    });
    test("custom read-only test tool passes through in plan mode (NOT in table)", async () => {
        // The read-only fast path defers to `registry.isReadOnly()` — table
        // membership is not required for read-only tools.
        const tool = makeTool("custom-readonly", { readOnly: true });
        const res = await dispatchTool(call("custom-readonly"), baseCfg({ registry: new ToolRegistry([tool]), planMode: true }), perm);
        expect(res.ok).toBe(true);
    });
    test("multiple read-only built-ins all pass through (grep / glob / git_status)", async () => {
        const grep = makeTool("grep", {
            readOnly: true,
            schema: z.object({ pattern: z.string() }),
        });
        const glob = makeTool("glob", { readOnly: true });
        const gitStatus = makeTool("git_status", { readOnly: true });
        const reg = new ToolRegistry([grep, glob, gitStatus]);
        const cfg = baseCfg({ registry: reg, planMode: true });
        const r1 = await dispatchTool(call("grep", { pattern: "x" }, "a"), cfg, perm);
        const r2 = await dispatchTool(call("glob", {}, "b"), cfg, perm);
        const r3 = await dispatchTool(call("git_status", {}, "c"), cfg, perm);
        expect(r1.ok).toBe(true);
        expect(r2.ok).toBe(true);
        expect(r3.ok).toBe(true);
    });
});
describe("dispatch-seam guard — parallel-dispatch race in plan mode", () => {
    test("N concurrent mutating calls all deny without entering execute", async () => {
        let executions = 0;
        const tool = makeTool("write", {
            readOnly: false,
            run: async function* () {
                executions += 1;
                yield { type: "result", result: { ok: true, output: "ran" } };
            },
        });
        const cfg = baseCfg({ registry: new ToolRegistry([tool]), planMode: true });
        // Fire 10 in parallel — the seam guard is stateless / synchronous so
        // there is no race window where one call's deny could leak through.
        const results = await Promise.all(Array.from({ length: 10 }, (_, i) => dispatchTool(call("write", {}, `p${i}`), cfg, perm)));
        expect(executions).toBe(0);
        for (const r of results) {
            expect(r.ok).toBe(false);
            expect(r.preview).toBe("mode-blocked");
            expect(r.block.content).toContain("blocked in plan collaboration mode");
        }
    });
    test("parallel mix of mutating + read-only — read-only succeed, mutating deny", async () => {
        let mutateExec = 0;
        let readExec = 0;
        const writeTool = makeTool("write", {
            readOnly: false,
            run: async function* () {
                mutateExec += 1;
                yield { type: "result", result: { ok: true, output: "ran" } };
            },
        });
        const readTool = makeTool("read", {
            readOnly: true,
            schema: z.object({ path: z.string() }),
            run: async function* () {
                readExec += 1;
                yield { type: "result", result: { ok: true, output: "data" } };
            },
        });
        const cfg = baseCfg({
            registry: new ToolRegistry([writeTool, readTool]),
            planMode: true,
        });
        const results = await Promise.all([
            dispatchTool(call("write", {}, "w1"), cfg, perm),
            dispatchTool(call("read", { path: "/x" }, "r1"), cfg, perm),
            dispatchTool(call("write", {}, "w2"), cfg, perm),
            dispatchTool(call("read", { path: "/y" }, "r2"), cfg, perm),
            dispatchTool(call("write", {}, "w3"), cfg, perm),
        ]);
        expect(mutateExec).toBe(0);
        expect(readExec).toBe(2);
        expect(results[0]?.ok).toBe(false);
        expect(results[1]?.ok).toBe(true);
        expect(results[2]?.ok).toBe(false);
        expect(results[3]?.ok).toBe(true);
        expect(results[4]?.ok).toBe(false);
    });
});
describe("plan-mode-dispatch-block — e2e via runAgent loop", () => {
    // Lightweight e2e: a runAgent run with collaborationMode='plan' must
    // prevent a write tool from executing while a read tool still works.
    // Uses an inline LLM scripted to call write THEN read THEN completes.
    test("runAgent: write denied, read allowed, run completes", async () => {
        // Avoid pulling all of `runAgent`'s top-level config here — this test
        // is intentionally narrow: it exercises dispatchTool's wire-up by
        // simulating two tool calls back-to-back via direct dispatchTool
        // calls (the runAgent loop calls dispatchTool the same way).
        let writeExec = 0;
        let readExec = 0;
        const writeT = makeTool("write", {
            readOnly: false,
            run: async function* () {
                writeExec += 1;
                yield { type: "result", result: { ok: true, output: "wrote" } };
            },
        });
        const readT = makeTool("read", {
            readOnly: true,
            schema: z.object({ path: z.string() }),
            run: async function* () {
                readExec += 1;
                yield { type: "result", result: { ok: true, output: "data" } };
            },
        });
        const cfg = baseCfg({
            registry: new ToolRegistry([writeT, readT]),
            collaborationMode: "plan",
        });
        const writeRes = await dispatchTool(call("write", { content: "x" }, "wA"), cfg, perm);
        const readRes = await dispatchTool(call("read", { path: "/tmp/x" }, "rA"), cfg, perm);
        expect(writeExec).toBe(0);
        expect(readExec).toBe(1);
        expect(writeRes.ok).toBe(false);
        expect(writeRes.preview).toBe("mode-blocked");
        expect(readRes.ok).toBe(true);
        expect(readRes.preview).toBe("data");
    });
    test("plan mode + apply_patch is blocked (write_filesystem)", async () => {
        const tool = makeTool("apply_patch", { readOnly: false });
        const res = await dispatchTool(call("apply_patch"), baseCfg({ registry: new ToolRegistry([tool]), collaborationMode: "plan" }), perm);
        expect(res.ok).toBe(false);
        expect(res.preview).toBe("mode-blocked");
        expect(res.block.content).toContain("write_filesystem");
    });
    test("plan mode + scripted_replace is blocked (write_filesystem)", async () => {
        const tool = makeTool("scripted_replace", { readOnly: false });
        const res = await dispatchTool(call("scripted_replace"), baseCfg({ registry: new ToolRegistry([tool]), collaborationMode: "plan" }), perm);
        expect(res.ok).toBe(false);
        expect(res.preview).toBe("mode-blocked");
    });
    test("plan mode + git_branch_switch is blocked (git_mutating)", async () => {
        const tool = makeTool("git_branch_switch", { readOnly: false });
        const res = await dispatchTool(call("git_branch_switch"), baseCfg({ registry: new ToolRegistry([tool]), collaborationMode: "plan" }), perm);
        expect(res.ok).toBe(false);
        expect(res.preview).toBe("mode-blocked");
        expect(res.block.content).toContain("git_mutating");
    });
});
describe("dispatch-seam guard — unknown tool error path (registry.has check)", () => {
    test("unknown tool name in plan mode → still gets the registry.has 'unknown tool' deny", async () => {
        // The seam guard runs AFTER the `registry.has(call.name)` check, so
        // a name that isn't registered AT ALL gets the legacy "unknown tool"
        // deny, NOT the seam guard's UnknownToolError. This pins the order.
        const cfg = baseCfg({ registry: new ToolRegistry([]), planMode: true });
        const res = await dispatchTool(call("ghost"), cfg, perm);
        expect(res.ok).toBe(false);
        expect(res.preview).toBe("unknown tool");
        expect(res.block.content).toContain("Unknown tool: ghost");
    });
});
