/**
 * ADR-0047 — HITL tier gate: `HandoffRequiredEvent` emission tests.
 *
 * Covers the admissibility-gate's behaviour around the new typed handoff
 * event seam:
 *   - HARD_DENY hit fires onHandoff(event) with `reason: "hard-deny:..."`
 *   - explicit hand-off-required tier fires onHandoff(event) with
 *     `reason: "tier:hand-off-required"` (no registry escalation)
 *   - registry-promoted hand-off-required fires onHandoff with
 *     `reason: "registry:<tool>"`
 *   - event payload is fully populated (tool, args, handoffMessage,
 *     timestamp)
 *   - absent `onHandoff` ⇒ byte-identical legacy behaviour (no event)
 *   - throwing `onHandoff` is swallowed; deny result is stable
 *   - `isHandoffRequiredEvent` predicate accepts canonical shape +
 *     rejects malformed
 *   - non-handoff tiers do NOT fire the event
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { runAdmissibilityGate } from "@/agent/admissibility-gate";
import { isHandoffRequiredEvent } from "@/agent/hitl-tier";
import { __resetHitlOverrides } from "@/agent/hitl-tier-registry";
import { __resetRuntimeConfig } from "@/shared";
import { ToolRegistry } from "@/tool";
let tmp;
beforeEach(() => {
    tmp = join(tmpdir(), `hitl-gate-${process.pid}-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
});
afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    delete process.env["QUANTA_HITL_OVERRIDES"];
    __resetRuntimeConfig();
    __resetHitlOverrides();
});
const makeTool = (name, opts = {}) => {
    const tool = {
        name,
        description: `${name}`,
        inputSchema: z.object({}).passthrough(),
        isReadOnly: () => opts.readOnly ?? false,
        isConcurrencySafe: () => opts.readOnly ?? false,
        execute: () => (async function* () {
            yield { type: "result", result: { ok: true, output: "ran" } };
        })(),
    };
    if (opts.hitlTier) {
        ;
        tool.hitlTier = opts.hitlTier;
    }
    return tool;
};
const callBlock = (name, input = {}, id = "c1") => ({
    type: "tool_use",
    id,
    name,
    input,
});
const cfg = (over = {}) => ({
    cwd: "/repo",
    signal: new AbortController().signal,
    planMode: false,
    permission: { mode: "default" },
    ...over,
});
describe("onHandoff event seam", () => {
    test("HARD_DENY fires onHandoff(event) with hard-deny reason tag", async () => {
        const captured = [];
        const bash = makeTool("bash");
        const call = callBlock("bash", { command: "rm -rf /" });
        const before = Date.now();
        const res = await runAdmissibilityGate(call, cfg({
            registry: new ToolRegistry([bash]),
            hitl: { enabled: true },
            permission: { mode: "bypass" },
            onHandoff: (e) => captured.push(e),
        }), { mode: "bypass" }, 
        // shellCommand is consumed by hardDenyReason via duck-typing — we
        // structurally widen here so the gate sees the same surface dispatch
        // would have populated.
        Object.assign({ tool: "bash", input: { command: "rm -rf /" }, isReadOnly: false }, { shellCommand: "rm -rf /" }));
        expect(res?.preview).toBe("handoff");
        expect(captured).toHaveLength(1);
        const ev = captured[0];
        if (!ev)
            throw new Error("expected event");
        expect(ev.kind).toBe("hitl-handoff");
        expect(ev.tool).toBe("bash");
        expect(ev.args).toEqual({ command: "rm -rf /" });
        expect(ev.handoffMessage).toContain("human handoff");
        expect(ev.reason.startsWith("hard-deny:")).toBe(true);
        expect(ev.timestamp).toBeGreaterThanOrEqual(before);
        expect(ev.timestamp).toBeLessThanOrEqual(Date.now());
    });
    test("explicit hand-off-required tier fires onHandoff with tier reason tag", async () => {
        const captured = [];
        const sensitive = makeTool("sensitive", { hitlTier: () => "hand-off-required" });
        const res = await runAdmissibilityGate(callBlock("sensitive", { x: 1 }), cfg({
            registry: new ToolRegistry([sensitive]),
            hitl: { enabled: true },
            permission: { mode: "bypass" },
            onHandoff: (e) => captured.push(e),
        }), { mode: "bypass" }, { tool: "sensitive", input: { x: 1 }, isReadOnly: false });
        expect(res?.preview).toBe("handoff");
        expect(captured).toHaveLength(1);
        const ev = captured[0];
        if (!ev)
            throw new Error("expected event");
        expect(ev.reason).toBe("tier:hand-off-required");
        expect(ev.tool).toBe("sensitive");
        expect(ev.args).toEqual({ x: 1 });
    });
    test("registry-promoted hand-off-required fires onHandoff with registry reason tag", async () => {
        const overridePath = join(tmp, "h.json");
        writeFileSync(overridePath, JSON.stringify({
            version: 1,
            annotations: [
                {
                    tool: "write",
                    tier: "hand-off-required",
                    reason: "audit policy: writes always handed off",
                },
            ],
        }), "utf8");
        process.env["QUANTA_HITL_OVERRIDES"] = overridePath;
        __resetRuntimeConfig();
        __resetHitlOverrides();
        const captured = [];
        const write = makeTool("write", { hitlTier: () => "pre-approval-ok" });
        const res = await runAdmissibilityGate(callBlock("write", { path: "x", content: "y" }), cfg({
            registry: new ToolRegistry([write]),
            hitl: { enabled: true },
            permission: { mode: "default" },
            onHandoff: (e) => captured.push(e),
        }), { mode: "default" }, { tool: "write", input: { path: "x", content: "y" }, isReadOnly: false });
        expect(res?.preview).toBe("handoff");
        expect(captured).toHaveLength(1);
        const ev = captured[0];
        if (!ev)
            throw new Error("expected event");
        expect(ev.reason).toBe("registry:write");
        expect(ev.handoffMessage).toContain("audit policy: writes always handed off");
    });
    test("absent onHandoff ⇒ byte-identical legacy deny (no throw, same preview)", async () => {
        const sensitive = makeTool("sensitive", { hitlTier: () => "hand-off-required" });
        const res = await runAdmissibilityGate(callBlock("sensitive"), cfg({
            registry: new ToolRegistry([sensitive]),
            hitl: { enabled: true },
            permission: { mode: "default" },
            // onHandoff intentionally absent
        }), { mode: "default" }, { tool: "sensitive", input: {}, isReadOnly: false });
        expect(res?.preview).toBe("handoff");
        expect(res?.block.content).toContain("human handoff");
    });
    test("throwing onHandoff is swallowed; deny result stays stable", async () => {
        const sensitive = makeTool("sensitive", { hitlTier: () => "hand-off-required" });
        const res = await runAdmissibilityGate(callBlock("sensitive"), cfg({
            registry: new ToolRegistry([sensitive]),
            hitl: { enabled: true },
            permission: { mode: "default" },
            onHandoff: () => {
                throw new Error("UI listener exploded");
            },
        }), { mode: "default" }, { tool: "sensitive", input: {}, isReadOnly: false });
        expect(res?.preview).toBe("handoff");
        expect(res?.block.content).toContain("human handoff");
    });
    test("non-handoff tier (always-confirm) does NOT fire onHandoff", async () => {
        const captured = [];
        const tool = makeTool("custom", { hitlTier: () => "always-confirm" });
        await runAdmissibilityGate(callBlock("custom"), cfg({
            registry: new ToolRegistry([tool]),
            hitl: { enabled: true },
            permission: { mode: "bypass" },
            onConfirm: async () => true,
            onHandoff: (e) => captured.push(e),
        }), { mode: "bypass" }, { tool: "custom", input: {}, isReadOnly: false });
        expect(captured).toHaveLength(0);
    });
    test("none tier (read-only) does NOT fire onHandoff", async () => {
        const captured = [];
        const ro = makeTool("read-thing", { readOnly: true });
        await runAdmissibilityGate(callBlock("read-thing"), cfg({
            registry: new ToolRegistry([ro]),
            hitl: { enabled: true },
            permission: { mode: "default" },
            onHandoff: (e) => captured.push(e),
        }), { mode: "default" }, { tool: "read-thing", input: {}, isReadOnly: true });
        expect(captured).toHaveLength(0);
    });
});
describe("isHandoffRequiredEvent predicate", () => {
    test("accepts canonical shape", () => {
        const ev = {
            kind: "hitl-handoff",
            tool: "bash",
            args: { command: "x" },
            handoffMessage: "boom",
            reason: "tier:hand-off-required",
            timestamp: 123,
        };
        expect(isHandoffRequiredEvent(ev)).toBe(true);
    });
    test("rejects null / undefined / primitive / wrong kind", () => {
        expect(isHandoffRequiredEvent(null)).toBe(false);
        expect(isHandoffRequiredEvent(undefined)).toBe(false);
        expect(isHandoffRequiredEvent("hitl-handoff")).toBe(false);
        expect(isHandoffRequiredEvent({ kind: "other" })).toBe(false);
        expect(isHandoffRequiredEvent({
            kind: "hitl-handoff",
            tool: 42,
            args: {},
            handoffMessage: "x",
            reason: "y",
            timestamp: 0,
        })).toBe(false);
    });
});
