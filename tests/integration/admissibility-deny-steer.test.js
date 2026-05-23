/**
 * Integration tests — admissibility-gate × {@link ConfirmDecision} (ADR-0076
 * Gap-4 deny_and_steer). Asserts the wired behavior:
 *
 *  1. BYTE-IDENTICAL: every legacy `onConfirm: async () => boolean` path
 *     produces the SAME DispatchResult it did before normalization existed —
 *     same `preview`, same `content`, no `steerInjection` field set.
 *  2. ConfirmDecision passthrough for `allow`/`deny` matches the boolean form
 *     (same DispatchResult shape).
 *  3. `deny_and_steer` from the HITL always-confirm branch denies AND attaches
 *     the steer to `DispatchResult.steerInjection`, with `preview === "deny_steer"`.
 *  4. `deny_and_steer` from the mode-policy ask-branch (no HITL) also denies +
 *     attaches the steer (the verb is decision-shaped, not branch-shaped).
 *  5. An onConfirm that THROWS still maps to the legacy `preview === "error"`
 *     deny (no steer attached) — failure path is unchanged.
 *  6. A malformed ConfirmDecision (unknown literal, empty steer) is caught at
 *     the gate seam and surfaced as `preview === "error"` (no steer leaks).
 *
 * Tests are isolated to the always-confirm + mode-policy ask branches, per
 * ADR-0076 file-ownership (rules/reviewer branches are NOT touched).
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { runAdmissibilityGate } from "@/agent/admissibility-gate";
import { ToolRegistry } from "@/tool";
// ─── Fixtures ─────────────────────────────────────────────────────────────
const makeTool = (name, opts = {}) => {
    const tool = {
        name,
        description: `${name} tool`,
        inputSchema: (opts.schema ?? z.object({})),
        isReadOnly: () => opts.readOnly ?? false,
        isConcurrencySafe: () => opts.readOnly ?? false,
        execute: async function* () {
            yield { type: "result", result: { ok: true, output: "ran" } };
        },
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
const actionOf = (tool, input = {}) => ({
    tool: tool.name,
    input,
    isReadOnly: tool.isReadOnly(),
});
// Reusable HITL always-confirm tool + matching config builder.
const hitlAlwaysConfirm = () => makeTool("mutate", { hitlTier: () => "always-confirm" });
const hitlCfgWith = (onConfirm, tool) => cfg({
    registry: new ToolRegistry([tool]),
    hitl: { enabled: true },
    onConfirm,
    permission: { mode: "default" },
});
// ─── 1. BYTE-IDENTICAL legacy boolean — HITL always-confirm branch ────────
describe("HITL always-confirm × boolean onConfirm — BYTE-IDENTICAL", () => {
    test("boolean true ⇒ admit (null), no DispatchResult emitted", async () => {
        const tool = hitlAlwaysConfirm();
        const c = hitlCfgWith(async () => true, tool);
        const res = await runAdmissibilityGate(call("mutate"), c, { mode: "default" }, actionOf(tool));
        // Admit ⇒ null (caller continues to hook + execute). Identical to pre-Gap-4.
        expect(res).toBeNull();
    });
    test("boolean false ⇒ deny with legacy preview 'declined' + legacy phrasing + NO steerInjection", async () => {
        const tool = hitlAlwaysConfirm();
        const c = hitlCfgWith(async () => false, tool);
        const res = await runAdmissibilityGate(call("mutate"), c, { mode: "default" }, actionOf(tool));
        expect(res).not.toBeNull();
        expect(res?.preview).toBe("declined");
        expect(res?.block.content).toBe("User declined: mutate requires explicit confirmation (always-confirm tier).");
        // CRITICAL byte-identical guarantee: the field must not appear when the
        // surface returned a boolean.
        expect(res?.steerInjection).toBeUndefined();
    });
    test("onConfirm absent ⇒ legacy 'no handler' deny, byte-identical preview/phrasing", async () => {
        const tool = hitlAlwaysConfirm();
        const c = cfg({
            registry: new ToolRegistry([tool]),
            hitl: { enabled: true },
            permission: { mode: "default" },
        });
        const res = await runAdmissibilityGate(call("mutate"), c, { mode: "default" }, actionOf(tool));
        expect(res?.preview).toBe("denied");
        expect(res?.block.content).toContain("always-confirm tier");
        expect(res?.steerInjection).toBeUndefined();
    });
});
// ─── 2. Structured allow/deny — same shape as the boolean form ────────────
describe("HITL always-confirm × ConfirmDecision allow/deny — passthrough", () => {
    test("{decision:'allow'} ⇒ admit (null), identical to boolean true", async () => {
        const tool = hitlAlwaysConfirm();
        const c = hitlCfgWith(async () => ({ decision: "allow" }), tool);
        const res = await runAdmissibilityGate(call("mutate"), c, { mode: "default" }, actionOf(tool));
        expect(res).toBeNull();
    });
    test("{decision:'deny'} ⇒ deny, identical to boolean false (preview + phrasing + no steer)", async () => {
        const tool = hitlAlwaysConfirm();
        const c = hitlCfgWith(async () => ({ decision: "deny" }), tool);
        const res = await runAdmissibilityGate(call("mutate"), c, { mode: "default" }, actionOf(tool));
        expect(res?.preview).toBe("declined");
        expect(res?.block.content).toBe("User declined: mutate requires explicit confirmation (always-confirm tier).");
        expect(res?.steerInjection).toBeUndefined();
    });
});
// ─── 3. deny_and_steer — HITL always-confirm branch (headline path) ───────
describe("HITL always-confirm × deny_and_steer (ADR-0076 Gap-4)", () => {
    test("deny_and_steer ⇒ deny preview 'deny_steer' AND steerInjection set verbatim", async () => {
        const tool = hitlAlwaysConfirm();
        const steer = "use the Glob tool with pattern 'src/**/*.ts' instead";
        const c = hitlCfgWith(async () => ({ decision: "deny_and_steer", steer }), tool);
        const res = await runAdmissibilityGate(call("mutate"), c, { mode: "default" }, actionOf(tool));
        expect(res).not.toBeNull();
        expect(res?.preview).toBe("deny_steer");
        // Deny content is the legacy phrasing PLUS the steer (atomic).
        expect(res?.block.content).toContain("User declined: mutate requires explicit confirmation (always-confirm tier).");
        expect(res?.block.content).toContain("Steer:");
        expect(res?.block.content).toContain(steer);
        // The headline assertion: the loop can read the steer off the result.
        expect(res?.steerInjection).toBe(steer);
        // tool_result block must still be flagged as an error (refusal).
        expect(res?.block.is_error).toBe(true);
    });
    test("deny_and_steer preserves unicode + multi-line steers", async () => {
        const tool = hitlAlwaysConfirm();
        const steer = "Bash 대신 다음을 시도하세요:\n  rg --files src/ | head -50";
        const c = hitlCfgWith(async () => ({ decision: "deny_and_steer", steer }), tool);
        const res = await runAdmissibilityGate(call("mutate"), c, { mode: "default" }, actionOf(tool));
        expect(res?.steerInjection).toBe(steer);
        expect(res?.preview).toBe("deny_steer");
    });
    test("malformed deny_and_steer (empty steer) ⇒ 'error' preview, no steer leaks", async () => {
        const tool = hitlAlwaysConfirm();
        const c = hitlCfgWith(async () => ({ decision: "deny_and_steer", steer: "" }), tool);
        const res = await runAdmissibilityGate(call("mutate"), c, { mode: "default" }, actionOf(tool));
        // normalizeConfirm throws ⇒ caught by the gate's try/catch ⇒ error preview.
        expect(res?.preview).toBe("error");
        expect(res?.steerInjection).toBeUndefined();
    });
    test("malformed ConfirmDecision (unknown literal) ⇒ 'error' preview", async () => {
        const tool = hitlAlwaysConfirm();
        const c = hitlCfgWith(async () => ({ decision: "approve" }), tool);
        const res = await runAdmissibilityGate(call("mutate"), c, { mode: "default" }, actionOf(tool));
        expect(res?.preview).toBe("error");
        expect(res?.steerInjection).toBeUndefined();
    });
    test("throwing onConfirm still maps to legacy 'error' preview (no steer)", async () => {
        const tool = hitlAlwaysConfirm();
        const c = hitlCfgWith(async () => {
            throw new Error("surface-blew-up");
        }, tool);
        const res = await runAdmissibilityGate(call("mutate"), c, { mode: "default" }, actionOf(tool));
        expect(res?.preview).toBe("error");
        expect(res?.block.content).toContain("surface-blew-up");
        expect(res?.steerInjection).toBeUndefined();
    });
});
// ─── 4. deny_and_steer — mode-policy ask branch ───────────────────────────
describe("Mode-policy ask-branch × ConfirmDecision (no HITL)", () => {
    // A non-readonly tool with NO HITL config + permission.mode=default ⇒ the
    // permission policy returns `ask` ⇒ onConfirm is consulted via
    // resolveAskBranch. This mirrors the existing onConfirm-throw test.
    const mkAskCfg = (onConfirm) => {
        const tool = makeTool("write_file", { readOnly: false });
        const c = cfg({
            registry: new ToolRegistry([tool]),
            onConfirm,
            permission: { mode: "default" },
        });
        return { c, tool };
    };
    test("boolean true ⇒ admit (byte-identical)", async () => {
        const { c, tool } = mkAskCfg(async () => true);
        const res = await runAdmissibilityGate(call("write_file"), c, c.permission, actionOf(tool));
        expect(res).toBeNull();
    });
    test("boolean false ⇒ deny preview 'declined', no steerInjection (byte-identical)", async () => {
        const { c, tool } = mkAskCfg(async () => false);
        const res = await runAdmissibilityGate(call("write_file"), c, c.permission, actionOf(tool));
        expect(res?.preview).toBe("declined");
        expect(res?.steerInjection).toBeUndefined();
    });
    test("{decision:'allow'} ⇒ admit (identical to boolean true)", async () => {
        const { c, tool } = mkAskCfg(async () => ({ decision: "allow" }));
        const res = await runAdmissibilityGate(call("write_file"), c, c.permission, actionOf(tool));
        expect(res).toBeNull();
    });
    test("{decision:'deny'} ⇒ deny (identical to boolean false)", async () => {
        const { c, tool } = mkAskCfg(async () => ({ decision: "deny" }));
        const res = await runAdmissibilityGate(call("write_file"), c, c.permission, actionOf(tool));
        expect(res?.preview).toBe("declined");
        expect(res?.steerInjection).toBeUndefined();
    });
    test("deny_and_steer ⇒ deny_steer preview + steer attached to DispatchResult", async () => {
        const steer = "edit the existing config file instead of creating a new one";
        const { c, tool } = mkAskCfg(async () => ({ decision: "deny_and_steer", steer }));
        const res = await runAdmissibilityGate(call("write_file"), c, c.permission, actionOf(tool));
        expect(res?.preview).toBe("deny_steer");
        expect(res?.steerInjection).toBe(steer);
        expect(res?.block.content).toContain("Steer:");
        expect(res?.block.content).toContain(steer);
    });
    test("malformed deny_and_steer (empty steer) ⇒ 'error' preview from ask-branch", async () => {
        const { c, tool } = mkAskCfg(async () => ({ decision: "deny_and_steer", steer: "" }));
        const res = await runAdmissibilityGate(call("write_file"), c, c.permission, actionOf(tool));
        expect(res?.preview).toBe("error");
        expect(res?.steerInjection).toBeUndefined();
    });
    test("missing onConfirm in ask-branch ⇒ legacy 'declined' (byte-identical)", async () => {
        const tool = makeTool("write_file", { readOnly: false });
        const c = cfg({
            registry: new ToolRegistry([tool]),
            permission: { mode: "default" },
        });
        const res = await runAdmissibilityGate(call("write_file"), c, c.permission, actionOf(tool));
        expect(res?.preview).toBe("declined");
        expect(res?.steerInjection).toBeUndefined();
    });
});
// ─── 5. Action argument carries through unchanged to onConfirm ────────────
describe("onConfirm argument identity — action shape is byte-identical", () => {
    test("the gate passes the AdmissibilityAction as `action` (tool/input/isReadOnly visible)", async () => {
        const tool = hitlAlwaysConfirm();
        let observed = null;
        const c = hitlCfgWith(async (a) => {
            observed = a;
            return true;
        }, tool);
        const input = { x: 1 };
        await runAdmissibilityGate(call("mutate", input), c, { mode: "default" }, actionOf(tool, input));
        const obs = observed;
        expect(obs).not.toBeNull();
        expect(obs?.tool).toBe("mutate");
        expect(obs?.input).toEqual(input);
        expect(obs?.isReadOnly).toBe(false);
    });
    test("the gate awaits onConfirm exactly once per call (no double-prompt)", async () => {
        const tool = hitlAlwaysConfirm();
        let calls = 0;
        const c = hitlCfgWith(async () => {
            calls += 1;
            return { decision: "deny_and_steer", steer: "do X instead" };
        }, tool);
        await runAdmissibilityGate(call("mutate"), c, { mode: "default" }, actionOf(tool));
        expect(calls).toBe(1);
    });
});
