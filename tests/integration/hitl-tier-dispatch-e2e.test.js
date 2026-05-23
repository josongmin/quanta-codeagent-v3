/**
 * ADR-0047 — HITL tier gate end-to-end through dispatchTool.
 *
 * The unit tests above cover the gate in isolation. This integration test
 * exercises the full `dispatchTool` path with the registry + onHandoff
 * seam wired through, asserting that:
 *
 *   1. An override that escalates a tool to `hand-off-required` is honored
 *      end-to-end (dispatch rejects + fires onHandoff).
 *   2. The classic HARD_DENY path fires onHandoff exactly once and produces
 *      a deny with `preview === "handoff"`.
 *   3. The registry's one-way ratchet survives the full dispatch path
 *      (override cannot relax a built-in tier under dispatchTool).
 *   4. Override file absent (default) ⇒ byte-identical legacy behaviour.
 *   5. always-confirm escalation by override is enforced through dispatch.
 *   6. onHandoff is NOT fired when the tier is non-handoff (allow / ask /
 *      always-confirm declined).
 *   7. Telemetry vocabulary keys exist for hitl tier / handoff (smoke; the
 *      attribute emitter wiring is owned by the observability slice but the
 *      keys must be canonical — drift here is the kind of bug that breaks
 *      dashboards silently).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { dispatchTool } from "@/agent/dispatch";
import { __resetHitlOverrides } from "@/agent/hitl-tier-registry";
import { QUANTA_ATTRS } from "@/observability/vocabulary";
import { __resetRuntimeConfig } from "@/shared";
import { ToolRegistry } from "@/tool";
let tmp;
beforeEach(() => {
    tmp = join(tmpdir(), `hitl-e2e-${process.pid}-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
});
afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    delete process.env["QUANTA_HITL_OVERRIDES"];
    __resetRuntimeConfig();
    __resetHitlOverrides();
});
const setOverrides = (annotations) => {
    const path = join(tmp, "h.json");
    writeFileSync(path, JSON.stringify({ version: 1, annotations }), "utf8");
    process.env["QUANTA_HITL_OVERRIDES"] = path;
    __resetRuntimeConfig();
    __resetHitlOverrides();
    return path;
};
const makeTool = (name, opts = {}) => {
    const tool = {
        name,
        description: `${name}`,
        inputSchema: (opts.schema ?? z.object({}).passthrough()),
        isReadOnly: () => opts.readOnly ?? false,
        isConcurrencySafe: () => opts.readOnly ?? false,
        execute: () => opts.run
            ? opts.run()
            : (async function* () {
                yield { type: "result", result: { ok: true, output: "ran" } };
            })(),
    };
    if (opts.hitlTier) {
        ;
        tool.hitlTier = opts.hitlTier;
    }
    return tool;
};
const call = (name, input = {}, id = "c1") => ({
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
describe("dispatchTool + HITL registry (ADR-0047) e2e", () => {
    test("override escalates pre-approval-ok ⇒ hand-off-required and fires onHandoff", async () => {
        setOverrides([
            {
                tool: "write",
                tier: "hand-off-required",
                reason: "audit policy: writes always handed off",
            },
        ]);
        const captured = [];
        const write = makeTool("write", { hitlTier: () => "pre-approval-ok" });
        const res = await dispatchTool(call("write", { path: "x", content: "y" }), cfg({
            registry: new ToolRegistry([write]),
            hitl: { enabled: true },
            permission: { mode: "default" },
            onHandoff: (e) => captured.push(e),
        }), { mode: "default" });
        expect(res.ok).toBe(false);
        expect(res.preview).toBe("handoff");
        expect(captured).toHaveLength(1);
        expect(captured[0]?.reason).toBe("registry:write");
        expect(captured[0]?.handoffMessage).toContain("audit policy");
    });
    test("HARD_DENY fires onHandoff exactly once", async () => {
        const captured = [];
        const bash = makeTool("bash", { schema: z.object({ command: z.string() }) });
        bash.extractShellCommand =
            (i) => typeof i === "object" &&
                i !== null &&
                typeof i.command === "string"
                ? i.command
                : null;
        const res = await dispatchTool(call("bash", { command: "rm -rf /" }), cfg({
            registry: new ToolRegistry([bash]),
            hitl: { enabled: true },
            permission: { mode: "bypass" },
            onHandoff: (e) => captured.push(e),
        }), { mode: "bypass" });
        expect(res.ok).toBe(false);
        expect(res.preview).toBe("handoff");
        expect(captured).toHaveLength(1);
        expect(captured[0]?.reason.startsWith("hard-deny:")).toBe(true);
    });
    test("override cannot RELAX a hand-off-required from the tool — ratchet survives dispatch", async () => {
        setOverrides([{ tool: "sensitive", tier: "none", reason: "wrongly relaxed" }]);
        const sensitive = makeTool("sensitive", { hitlTier: () => "hand-off-required" });
        const res = await dispatchTool(call("sensitive"), cfg({
            registry: new ToolRegistry([sensitive]),
            hitl: { enabled: true },
            permission: { mode: "bypass" },
        }), { mode: "bypass" });
        expect(res.ok).toBe(false);
        expect(res.preview).toBe("handoff");
    });
    test("absent override file ⇒ byte-identical legacy behavior (no handoff for pre-approval-ok)", async () => {
        delete process.env["QUANTA_HITL_OVERRIDES"];
        __resetRuntimeConfig();
        __resetHitlOverrides();
        const captured = [];
        const write = makeTool("write", { hitlTier: () => "pre-approval-ok" });
        const res = await dispatchTool(call("write", { path: "x", content: "y" }), cfg({
            registry: new ToolRegistry([write]),
            hitl: { enabled: true },
            permission: { mode: "acceptEdits" },
            onHandoff: (e) => captured.push(e),
        }), { mode: "acceptEdits" });
        expect(res.ok).toBe(true);
        expect(captured).toHaveLength(0);
    });
    test("override escalates pre-approval-ok ⇒ always-confirm; onConfirm is called", async () => {
        setOverrides([
            {
                tool: "write",
                commandPrefix: undefined,
                tier: "always-confirm",
                reason: "writes need confirm in this deploy",
            },
        ]);
        let confirmCalls = 0;
        const handoffEvents = [];
        const write = makeTool("write", { hitlTier: () => "pre-approval-ok" });
        const res = await dispatchTool(call("write", { path: "x", content: "y" }), cfg({
            registry: new ToolRegistry([write]),
            hitl: { enabled: true },
            permission: { mode: "bypass" },
            onConfirm: async () => {
                confirmCalls++;
                return true;
            },
            onHandoff: (e) => handoffEvents.push(e),
        }), { mode: "bypass" });
        expect(confirmCalls).toBe(1);
        expect(res.ok).toBe(true);
        expect(handoffEvents).toHaveLength(0);
    });
    test("always-confirm declined does NOT fire onHandoff (only handoff tier does)", async () => {
        const captured = [];
        const tool = makeTool("custom", { hitlTier: () => "always-confirm" });
        const res = await dispatchTool(call("custom"), cfg({
            registry: new ToolRegistry([tool]),
            hitl: { enabled: true },
            permission: { mode: "default" },
            onConfirm: async () => false,
            onHandoff: (e) => captured.push(e),
        }), { mode: "default" });
        expect(res.ok).toBe(false);
        expect(res.preview).toBe("declined");
        expect(captured).toHaveLength(0);
    });
    test("OTel vocabulary keys exist for hitl tier_resolved / registry_escalated / handoff_emitted", () => {
        // Smoke: the canonical keys MUST be present on QUANTA_ATTRS.hitl. A
        // typo / drop would break dashboards silently — this assertion catches
        // it at test time. Wiring of the emitter into the gate is owned by
        // the observability slice (separate ADR / PR).
        expect(QUANTA_ATTRS.hitl.tierResolved).toBe("quanta.hitl.tier_resolved");
        expect(QUANTA_ATTRS.hitl.registryEscalated).toBe("quanta.hitl.registry_escalated");
        expect(QUANTA_ATTRS.hitl.handoffEmitted).toBe("quanta.hitl.handoff_emitted");
    });
});
