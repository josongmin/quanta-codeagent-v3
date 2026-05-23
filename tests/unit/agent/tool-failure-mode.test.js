/**
 * Typed per-failure-mode tool results (P0-1, absorb #2 — Cursor
 * `EditResult`/`ShellResult` discriminated failure model).
 *
 * Contract under test:
 *   - ADDITIVE + DEFAULT-OFF: a `ToolResult` with no `failure` produces a
 *     `DispatchResult` with no `failure` (byte-identical to the pre-absorb
 *     normalization). `ok`/`block`/`preview` derivation is unchanged.
 *   - Each `ToolFailure` mode round-trips through the dispatch normalization
 *     unchanged (surfaced verbatim onto `DispatchResult.failure`).
 *   - `permission_denied.isReadonly` distinguishes a read-only-mode refusal
 *     from a genuine permission denial (Cursor's `is_readonly`).
 *   - The `ToolFailure["mode"]` union is exhaustive: a switch with a `never`
 *     default compiles.
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { dispatchTool } from "@/agent/dispatch";
import { ToolRegistry } from "@/tool";
/** Minimal scripted tool emitting a single terminal `result`. */
const resultTool = (name, result, readOnly = false) => ({
    name,
    description: `${name} test tool`,
    inputSchema: z.object({}),
    isReadOnly: () => readOnly,
    isConcurrencySafe: () => readOnly,
    execute: async function* () {
        yield { type: "result", result };
    },
});
const perm = { mode: "acceptEdits" };
const config = (tools) => ({
    registry: new ToolRegistry(tools),
    cwd: "/repo",
    signal: new AbortController().signal,
    planMode: false,
    permission: perm,
});
const call = (name, id = "c1") => ({
    type: "tool_use",
    id,
    name,
    input: {},
});
describe("(a) default-OFF — no failure field is byte-identical", () => {
    test("ok:false ToolResult without `failure` ⇒ DispatchResult has no `failure`", async () => {
        const tool = resultTool("plain_fail", { ok: false, output: "nope" });
        const res = await dispatchTool(call("plain_fail"), config([tool]), perm);
        expect(res.ok).toBe(false);
        expect(res.preview).toBe("nope");
        expect(res.block.is_error).toBe(true);
        // The additive field must be ABSENT, not `undefined`-valued.
        expect("failure" in res).toBe(false);
        expect(res.failure).toBeUndefined();
    });
    test("ok:true ToolResult ⇒ DispatchResult has no `failure`", async () => {
        const tool = resultTool("plain_ok", { ok: true, output: "fine" }, true);
        const res = await dispatchTool(call("plain_ok"), config([tool]), perm);
        expect(res.ok).toBe(true);
        expect("failure" in res).toBe(false);
    });
});
describe("(b) each ToolFailure mode round-trips through dispatch normalization", () => {
    const cases = [
        { name: "not_found", failure: { mode: "not_found", path: "/repo/missing.ts" } },
        {
            name: "permission_denied",
            failure: { mode: "permission_denied", path: "/etc/passwd" },
        },
        { name: "rejected", failure: { mode: "rejected", reason: "user-declined" } },
        { name: "timeout", failure: { mode: "timeout", timeoutMs: 30_000 } },
        {
            name: "spawn_error",
            failure: { mode: "spawn_error", error: "bash: nope: command not found" },
        },
        {
            name: "error",
            failure: {
                mode: "error",
                modelVisibleError: "build failed",
                clientVisibleError: "build failed: ENOSPC writing /tmp/x",
            },
        },
    ];
    for (const { name, failure } of cases) {
        test(`${name} surfaces verbatim onto DispatchResult.failure`, async () => {
            const tool = resultTool(name, { ok: false, output: `${name} happened`, failure });
            const res = await dispatchTool(call(name), config([tool]), perm);
            expect(res.ok).toBe(false);
            // `output` is preserved IN ADDITION TO the typed failure.
            expect(res.preview).toBe(`${name} happened`);
            expect(res.failure).toEqual(failure);
        });
    }
});
describe("(c) is_readonly distinguishes readonly-mode refusal from real denial", () => {
    test("readonly-mode refusal carries isReadonly:true", async () => {
        const failure = {
            mode: "permission_denied",
            path: "/repo/src/x.ts",
            isReadonly: true,
        };
        const tool = resultTool("ro", { ok: false, output: "session is read-only", failure });
        const res = await dispatchTool(call("ro"), config([tool]), perm);
        expect(res.failure).toEqual(failure);
        if (res.failure?.mode === "permission_denied") {
            expect(res.failure.isReadonly).toBe(true);
        }
        else {
            throw new Error("expected permission_denied");
        }
    });
    test("real permission denial omits isReadonly (would-not-succeed-if-writable)", async () => {
        const failure = { mode: "permission_denied", path: "/etc/shadow" };
        const tool = resultTool("denied", { ok: false, output: "denied by jail", failure });
        const res = await dispatchTool(call("denied"), config([tool]), perm);
        expect(res.failure).toEqual(failure);
        if (res.failure?.mode === "permission_denied") {
            expect(res.failure.isReadonly).toBeUndefined();
        }
        else {
            throw new Error("expected permission_denied");
        }
    });
});
describe("(d) exhaustiveness — switch over ToolFailure['mode'] with never default compiles", () => {
    // A model-side branch helper. If a new variant is added to ToolFailure
    // without a case here, the `never` assignment is a COMPILE error — this is
    // the load-bearing assertion (it is enforced by `tsc`, not the runtime).
    const describeFailure = (f) => {
        switch (f.mode) {
            case "not_found":
                return `not_found:${f.path ?? "?"}`;
            case "permission_denied":
                return `permission_denied:${f.isReadonly === true ? "readonly" : "denied"}`;
            case "rejected":
                return `rejected:${f.reason}`;
            case "timeout":
                return `timeout:${f.timeoutMs ?? "?"}`;
            case "spawn_error":
                return `spawn_error:${f.error}`;
            case "error":
                return `error:${f.modelVisibleError ?? "?"}`;
            default: {
                const _exhaustive = f;
                return _exhaustive;
            }
        }
    };
    test("each mode maps to a stable tag", () => {
        expect(describeFailure({ mode: "not_found", path: "/a" })).toBe("not_found:/a");
        expect(describeFailure({ mode: "permission_denied", isReadonly: true })).toBe("permission_denied:readonly");
        expect(describeFailure({ mode: "permission_denied" })).toBe("permission_denied:denied");
        expect(describeFailure({ mode: "rejected", reason: "r" })).toBe("rejected:r");
        expect(describeFailure({ mode: "timeout", timeoutMs: 5 })).toBe("timeout:5");
        expect(describeFailure({ mode: "spawn_error", error: "not found" })).toBe("spawn_error:not found");
        expect(describeFailure({ mode: "error", modelVisibleError: "boom" })).toBe("error:boom");
    });
});
