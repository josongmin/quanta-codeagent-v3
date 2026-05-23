/**
 * HELL-GATE for the L4 review-kind matrix gate wiring (ADR-0070 promotion).
 *
 * Coverage:
 *   R-1   ReviewContext.reviewKind is attached on the reviewer dispatch (the
 *         port observes the kind the gate inferred).
 *   R-2   `reviewKindOverride` short-circuits inference.
 *   R-3   A reviewer returning a verb LEGAL for the kind is admitted.
 *   R-4   A reviewer returning a verb ILLEGAL for the kind is rejected with
 *         preview='reviewer_verb_illegal' (no silent allow).
 *   R-5   A reviewer returning `reject_and_tell` with a message surfaces
 *         `DispatchResult.steerInjection` AND preview='deny_steer'.
 *   R-6   `allowlist_escalated`: a prior approval recorded actionKey ⇒ a
 *         second call with the same actionKey BYPASSES the reviewer entirely
 *         (port not invoked).
 *   R-7   `allowlist_escalated` only tracks APPROVED actionKeys — a denied
 *         call does NOT add to the cache.
 *   R-8   Without `allowlistEscalated` set wired, every call re-invokes the
 *         reviewer (legacy byte-identical).
 *   R-9   Reviewer rejection via legacy outcome (no verb) keeps the legacy
 *         message phrasing.
 *   R-10  G-1d guard: the gate file still has EXACTLY ONE `steerInjection:`
 *         assignment site (regression guard from
 *         admissibility-deny-steer-hell.test.ts — re-asserted here so a Feature-3
 *         author who forgets the constraint trips THIS test too).
 *   R-11  reviewKind inference picks the right kind for the bash tool (terminal),
 *         not 'edit'.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { runAdmissibilityGate } from "@/agent/admissibility-gate";
import { ToolRegistry } from "@/tool";
const bashShell = {
    name: "bash",
    description: "shell",
    inputSchema: z.object({ command: z.string() }),
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    extractShellCommand: (input) => {
        const parsed = input;
        return typeof parsed?.command === "string" ? parsed.command : null;
    },
    execute: async function* () {
        yield { type: "result", result: { ok: true, output: "ran" } };
    },
};
const annotateHitl = (tool, tier) => {
    const out = { ...tool };
    out.hitlTier = () => tier;
    return out;
};
const call = (command, id = "c1") => ({
    type: "tool_use",
    id,
    name: "bash",
    input: { command },
});
const action = (command) => ({
    tool: "bash",
    input: { command },
    isReadOnly: false,
});
const cfg = (over) => ({
    cwd: "/repo",
    signal: new AbortController().signal,
    permission: { mode: "default" },
    ...over,
});
const makePort = (decisionFor, capture) => ({
    userReview: async (a, c) => {
        capture.observedCtx.push(c);
        capture.observedActions.push(a);
        return decisionFor(a, c);
    },
    autoReview: async (a, c) => {
        capture.observedCtx.push(c);
        capture.observedActions.push(a);
        return decisionFor(a, c);
    },
    guardianReview: async (a, c) => {
        capture.observedCtx.push(c);
        capture.observedActions.push(a);
        return decisionFor(a, c);
    },
});
describe("review-kind gate wiring — HELL", () => {
    test("R-1: ReviewContext.reviewKind attached on dispatch (inferred from tool)", async () => {
        const capture = { observedCtx: [], observedActions: [] };
        const port = makePort((_, ctx) => ({
            reviewer: "user",
            outcome: "user_approved",
            riskLevel: "low",
            rationale: `kind=${ctx.reviewKind ?? "missing"}`,
            decidedAt: 0,
        }), capture);
        const c = cfg({
            registry: new ToolRegistry([annotateHitl(bashShell, "always-confirm")]),
            hitl: { enabled: true },
        });
        await runAdmissibilityGate(call("git status"), c, { mode: "default" }, action("git status"), undefined, { reviewerPort: port });
        expect(capture.observedCtx.length).toBe(1);
        expect(capture.observedCtx[0]?.reviewKind).toBe("terminal");
    });
    test("R-2: reviewKindOverride short-circuits inference", async () => {
        const capture = { observedCtx: [], observedActions: [] };
        const port = makePort(() => ({
            reviewer: "user",
            outcome: "user_approved",
            riskLevel: "low",
            rationale: "ok",
            decidedAt: 0,
        }), capture);
        const c = cfg({
            registry: new ToolRegistry([annotateHitl(bashShell, "always-confirm")]),
            hitl: { enabled: true },
        });
        await runAdmissibilityGate(call("git status"), c, { mode: "default" }, action("git status"), undefined, { reviewerPort: port, reviewKindOverride: "mcp" });
        expect(capture.observedCtx[0]?.reviewKind).toBe("mcp");
    });
    test("R-3: legal verb (run on terminal) ⇒ admitted", async () => {
        const capture = { observedCtx: [], observedActions: [] };
        const port = makePort(() => ({
            reviewer: "user",
            outcome: "user_approved",
            riskLevel: "low",
            rationale: "ok",
            decidedAt: 0,
            verb: { verb: "run" },
        }), capture);
        const c = cfg({
            registry: new ToolRegistry([annotateHitl(bashShell, "always-confirm")]),
            hitl: { enabled: true },
        });
        const r = await runAdmissibilityGate(call("ls"), c, { mode: "default" }, action("ls"), undefined, { reviewerPort: port });
        expect(r).toBeNull();
    });
    test("R-4: illegal verb (allowlist_commands on edit kind) ⇒ rejected", async () => {
        const capture = { observedCtx: [], observedActions: [] };
        const port = makePort(() => ({
            reviewer: "user",
            outcome: "user_approved",
            riskLevel: "low",
            rationale: "ok",
            decidedAt: 0,
            verb: { verb: "allowlist_commands", commands: ["ls"] },
        }), capture);
        const editTool = {
            name: "write_file", // edit-shaped
            description: "edit",
            inputSchema: z.object({ path: z.string() }),
            isReadOnly: () => false,
            isConcurrencySafe: () => false,
            execute: async function* () {
                yield { type: "result", result: { ok: true, output: "" } };
            },
        };
        const c = cfg({
            registry: new ToolRegistry([annotateHitl(editTool, "always-confirm")]),
            hitl: { enabled: true },
        });
        const r = await runAdmissibilityGate({ type: "tool_use", id: "c1", name: "write_file", input: { path: "/x" } }, c, { mode: "default" }, { tool: "write_file", input: { path: "/x" }, isReadOnly: false }, undefined, { reviewerPort: port });
        expect(r?.preview).toBe("reviewer_verb_illegal");
        expect(r?.block.is_error).toBe(true);
    });
    test("R-5: reject_and_tell ⇒ deny_steer + steerInjection on the DispatchResult", async () => {
        const capture = { observedCtx: [], observedActions: [] };
        const port = makePort(() => ({
            reviewer: "user",
            outcome: "user_denied",
            riskLevel: "high",
            rationale: "wrong tool",
            decidedAt: 0,
            verb: { verb: "reject_and_tell", message: "use Glob instead" },
        }), capture);
        const c = cfg({
            registry: new ToolRegistry([annotateHitl(bashShell, "always-confirm")]),
            hitl: { enabled: true },
        });
        const r = await runAdmissibilityGate(call("find / -name foo"), c, { mode: "default" }, action("find / -name foo"), undefined, { reviewerPort: port });
        expect(r?.preview).toBe("deny_steer");
        expect(r?.steerInjection).toBe("use Glob instead");
        expect(r?.block.content).toContain("use Glob instead");
        expect(r?.block.content).toContain("Steer:");
    });
    test("R-6: allowlist_escalated — prior approval ⇒ second call SKIPS reviewer", async () => {
        const capture = { observedCtx: [], observedActions: [] };
        const port = makePort(() => ({
            reviewer: "user",
            outcome: "user_approved",
            riskLevel: "low",
            rationale: "ok",
            decidedAt: 0,
        }), capture);
        const c = cfg({
            registry: new ToolRegistry([annotateHitl(bashShell, "always-confirm")]),
            hitl: { enabled: true },
        });
        const allowlistEscalated = new Set();
        // 1st call — reviewer fires, actionKey recorded.
        await runAdmissibilityGate(call("ls"), c, { mode: "default" }, action("ls"), undefined, {
            reviewerPort: port,
            allowlistEscalated,
        });
        expect(capture.observedActions.length).toBe(1);
        expect(allowlistEscalated.has("bash|ls")).toBe(true);
        // 2nd call same actionKey — reviewer is SKIPPED.
        const r2 = await runAdmissibilityGate(call("ls", "c2"), c, { mode: "default" }, action("ls"), undefined, { reviewerPort: port, allowlistEscalated });
        expect(capture.observedActions.length).toBe(1); // unchanged
        expect(r2).toBeNull();
    });
    test("R-7: allowlist_escalated — denied call does NOT add to cache", async () => {
        const capture = { observedCtx: [], observedActions: [] };
        const port = makePort(() => ({
            reviewer: "user",
            outcome: "user_denied",
            riskLevel: "high",
            rationale: "no",
            decidedAt: 0,
        }), capture);
        const c = cfg({
            registry: new ToolRegistry([annotateHitl(bashShell, "always-confirm")]),
            hitl: { enabled: true },
        });
        const allowlistEscalated = new Set();
        await runAdmissibilityGate(call("rm -rf /tmp"), c, { mode: "default" }, action("rm -rf /tmp"), undefined, { reviewerPort: port, allowlistEscalated });
        expect(allowlistEscalated.size).toBe(0);
    });
    test("R-8: no allowlistEscalated Set wired ⇒ reviewer fires on every call", async () => {
        const capture = { observedCtx: [], observedActions: [] };
        const port = makePort(() => ({
            reviewer: "user",
            outcome: "user_approved",
            riskLevel: "low",
            rationale: "ok",
            decidedAt: 0,
        }), capture);
        const c = cfg({
            registry: new ToolRegistry([annotateHitl(bashShell, "always-confirm")]),
            hitl: { enabled: true },
        });
        await runAdmissibilityGate(call("ls"), c, { mode: "default" }, action("ls"), undefined, {
            reviewerPort: port,
        });
        await runAdmissibilityGate(call("ls", "c2"), c, { mode: "default" }, action("ls"), undefined, {
            reviewerPort: port,
        });
        expect(capture.observedActions.length).toBe(2);
    });
    test("R-9: legacy outcome deny (no verb) keeps legacy phrasing", async () => {
        const capture = { observedCtx: [], observedActions: [] };
        const port = makePort(() => ({
            reviewer: "user",
            outcome: "user_aborted",
            riskLevel: "high",
            rationale: "cancel",
            decidedAt: 0,
        }), capture);
        const c = cfg({
            registry: new ToolRegistry([annotateHitl(bashShell, "always-confirm")]),
            hitl: { enabled: true },
        });
        const r = await runAdmissibilityGate(call("rm"), c, { mode: "default" }, action("rm"), undefined, { reviewerPort: port });
        expect(r?.block.content).toContain("User aborted");
        expect(r?.block.content).toContain("cancel");
        expect(r?.steerInjection).toBeUndefined();
    });
    test("R-10: gate still has EXACTLY ONE `steerInjection:` assignment site (regression guard)", () => {
        const gatePath = resolve(__dirname, "../../src/agent/admissibility-gate.ts");
        const src = readFileSync(gatePath, "utf8")
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/\/\/[^\n]*/g, "");
        const count = (src.match(/\bsteerInjection\s*:/g) ?? []).length;
        expect(count).toBe(1);
    });
    test("R-11: reviewKind for bash is 'terminal' not 'edit'", async () => {
        const capture = { observedCtx: [], observedActions: [] };
        const port = makePort(() => ({
            reviewer: "user",
            outcome: "user_approved",
            riskLevel: "low",
            rationale: "ok",
            decidedAt: 0,
        }), capture);
        const c = cfg({
            registry: new ToolRegistry([annotateHitl(bashShell, "always-confirm")]),
            hitl: { enabled: true },
        });
        await runAdmissibilityGate(call("ls"), c, { mode: "default" }, action("ls"), undefined, {
            reviewerPort: port,
        });
        expect(capture.observedCtx[0]?.reviewKind).toBe("terminal");
    });
});
