/**
 * Integration: `runAdmissibilityGate` consults the FULL permission stack
 * (ADR-0046) when `config.permissionStack.enabled` is on.
 *
 * Coverage matrix:
 *   1. Stack disabled (default) ⇒ legacy mode policy is authoritative.
 *   2. Stack enabled + per-thread read-only ⇒ DENY a mutating call even when
 *      global mode is `bypass`.
 *   3. Stack enabled + per-host read-only (no per-thread) ⇒ DENY even when
 *      mode is `bypass`.
 *   4. Stack enabled + per-thread overrides per-host (precedence inversion).
 *   5. Stack enabled + post-denial complete sequence ⇒ ALLOW even when
 *      per-thread says read-only.
 *   6. Stack enabled + HARD_DENY ⇒ DENY (security boundary beats overrides).
 *   7. Stack enabled + sessionId missing ⇒ silently falls through to legacy
 *      policy (defensive — no fabricated threadId).
 *
 * Each test uses an isolated `PermissionStore` injected via the gate's
 * `permissionStore` opt so parallel tests + the singleton stay decoupled.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { runAdmissibilityGate } from "@/agent/admissibility-gate";
import { createPermissionStore, recordDenial, recordRiskSeen, recordUserOverride, setHostMode, setThreadPermission, } from "@/permission";
import { ToolRegistry } from "@/tool";
// --- Fixtures --------------------------------------------------------------
const bashSchema = z.object({ command: z.string() });
const mkTool = (name, opts = {}) => ({
    name,
    description: `${name} tool`,
    inputSchema: (opts.schema ?? z.object({})),
    isReadOnly: () => opts.readOnly ?? false,
    isConcurrencySafe: () => opts.readOnly ?? false,
    execute: () => (async function* () {
        yield { type: "result", result: { ok: true, output: "ran" } };
    })(),
});
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
    sessionId: "thread-1",
    ...over,
});
const actionOf = (tool, input = {}) => ({
    tool: tool.name,
    input,
    isReadOnly: tool.isReadOnly(),
});
let tmp;
let store;
beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "quanta-gate-perm-"));
    store = createPermissionStore({ filePath: join(tmp, "state.json"), debounceMs: 0 });
    await store.load();
});
afterEach(async () => {
    await store.flush();
    await rm(tmp, { recursive: true, force: true });
});
describe("admissibility-gate × permission-stack (ADR-0046)", () => {
    test("stack disabled (default) ⇒ legacy mode policy is authoritative", async () => {
        const edit = mkTool("edit", { readOnly: false });
        setThreadPermission("thread-1", {
            approvalPolicy: "never",
            approvalsReviewer: "agent",
            sandboxPolicy: { type: "read-only" },
        }, store);
        const c = cfg({
            registry: new ToolRegistry([edit]),
            permission: { mode: "bypass" },
            // permissionStack omitted ⇒ disabled
        });
        const res = await runAdmissibilityGate(call("edit"), c, { mode: "bypass" }, actionOf(edit), undefined, { permissionStore: store });
        // Legacy bypass ⇒ allow (per-thread read-only IGNORED because stack disabled).
        expect(res).toBeNull();
    });
    test("stack enabled + per-thread read-only DENIES even in bypass mode", async () => {
        const edit = mkTool("edit", { readOnly: false });
        setThreadPermission("thread-1", {
            approvalPolicy: "never",
            approvalsReviewer: "agent",
            sandboxPolicy: { type: "read-only" },
        }, store);
        const c = cfg({
            registry: new ToolRegistry([edit]),
            permission: { mode: "bypass" },
            permissionStack: { enabled: true, hostId: "h-test" },
        });
        const res = await runAdmissibilityGate(call("edit"), c, { mode: "bypass" }, actionOf(edit), undefined, { permissionStore: store });
        expect(res).not.toBeNull();
        expect(res?.preview).toBe("denied");
        expect(res?.block.content).toContain("Permission denied");
        expect(res?.block.content).toContain("Per-thread");
    });
    test("stack enabled + per-host read-only (no thread) DENIES in bypass", async () => {
        const edit = mkTool("edit", { readOnly: false });
        setHostMode("h-prod", "read-only", store);
        const c = cfg({
            registry: new ToolRegistry([edit]),
            permission: { mode: "bypass" },
            permissionStack: { enabled: true, hostId: "h-prod" },
        });
        const res = await runAdmissibilityGate(call("edit"), c, { mode: "bypass" }, actionOf(edit), undefined, { permissionStore: store });
        expect(res).not.toBeNull();
        expect(res?.preview).toBe("denied");
        expect(res?.block.content).toContain("Per-host");
    });
    test("per-thread BEATS per-host (precedence inversion)", async () => {
        const edit = mkTool("edit", { readOnly: false });
        setHostMode("h-prod", "read-only", store);
        setThreadPermission("thread-1", {
            approvalPolicy: "never",
            approvalsReviewer: "agent",
            sandboxPolicy: { type: "danger-full-access" },
        }, store);
        const c = cfg({
            registry: new ToolRegistry([edit]),
            permission: { mode: "default" },
            permissionStack: { enabled: true, hostId: "h-prod" },
        });
        const res = await runAdmissibilityGate(call("edit"), c, { mode: "default" }, actionOf(edit), undefined, { permissionStore: store });
        // Per-thread says allow ⇒ no deny block; gate returns null (fall through
        // to dispatch).
        expect(res).toBeNull();
    });
    test("post-denial OVERRIDE beats per-thread read-only", async () => {
        const edit = mkTool("edit", { readOnly: false, schema: z.object({ path: z.string() }) });
        setThreadPermission("thread-1", {
            approvalPolicy: "never",
            approvalsReviewer: "agent",
            sandboxPolicy: { type: "read-only" },
        }, store);
        const input = { path: "secret.env" };
        const actionKey = { threadId: "thread-1", tool: "edit", workdir: "/repo", args: input };
        recordDenial(actionKey, "test", { store, clock: { now: () => 100 } });
        recordRiskSeen(actionKey, { store, clock: { now: () => 200 } });
        recordUserOverride(actionKey, { store, clock: { now: () => 300 } });
        const c = cfg({
            registry: new ToolRegistry([edit]),
            permission: { mode: "default" },
            permissionStack: { enabled: true, hostId: "localhost" },
        });
        const res = await runAdmissibilityGate(call("edit", input), c, { mode: "default" }, actionOf(edit, input), undefined, { permissionStore: store });
        // Stack's allow ⇒ gate returns null (the legacy mode-policy is skipped).
        expect(res).toBeNull();
    });
    test("HARD_DENY BEATS post-denial override (security boundary)", async () => {
        const bash = mkTool("bash", { readOnly: false, schema: bashSchema });
        const input = { command: "rm -rf /" };
        const actionKey = { threadId: "thread-1", tool: "bash", workdir: "/repo", args: input };
        recordDenial(actionKey, "test", { store, clock: { now: () => 100 } });
        recordRiskSeen(actionKey, { store, clock: { now: () => 200 } });
        recordUserOverride(actionKey, { store, clock: { now: () => 300 } });
        const c = cfg({
            registry: new ToolRegistry([bash]),
            permission: { mode: "bypass" },
            permissionStack: { enabled: true, hostId: "localhost" },
        });
        const res = await runAdmissibilityGate(call("bash", input), c, { mode: "bypass" }, { tool: "bash", input, isReadOnly: false }, undefined, { permissionStore: store });
        expect(res).not.toBeNull();
        expect(res?.preview).toBe("denied");
        expect(res?.block.content).toContain("Permission denied");
    });
    test("stack enabled but sessionId missing ⇒ falls through to legacy policy", async () => {
        const edit = mkTool("edit", { readOnly: false });
        setHostMode("h-prod", "read-only", store);
        // Construct config without sessionId at all (exactOptionalPropertyTypes —
        // explicit `undefined` is not assignable).
        const baseConfig = cfg({
            registry: new ToolRegistry([edit]),
            permission: { mode: "bypass" },
            permissionStack: { enabled: true, hostId: "h-prod" },
        });
        delete baseConfig.sessionId;
        const res = await runAdmissibilityGate(call("edit"), baseConfig, { mode: "bypass" }, actionOf(edit), undefined, { permissionStore: store });
        // No sessionId ⇒ stack skipped; bypass mode allows.
        expect(res).toBeNull();
    });
    test("read-only action bypasses stack regardless of thread record", async () => {
        const ro = mkTool("read", { readOnly: true });
        setThreadPermission("thread-1", {
            approvalPolicy: "never",
            approvalsReviewer: "agent",
            sandboxPolicy: { type: "read-only" },
        }, store);
        const c = cfg({
            registry: new ToolRegistry([ro]),
            permission: { mode: "default" },
            permissionStack: { enabled: true, hostId: "localhost" },
        });
        const res = await runAdmissibilityGate(call("read"), c, { mode: "default" }, actionOf(ro), undefined, { permissionStore: store });
        expect(res).toBeNull();
    });
});
