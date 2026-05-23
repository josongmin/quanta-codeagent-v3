import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { HookBus } from "@/agent";
import { dispatchTool } from "@/agent/dispatch";
import { ToolRegistry } from "@/tool";
/** Minimal tool whose behaviour is scripted by the constructor callback. */
const makeTool = (name, opts) => ({
    name,
    description: `${name} test tool`,
    inputSchema: (opts.schema ?? z.object({})),
    isReadOnly: () => opts.readOnly ?? false,
    isConcurrencySafe: () => opts.readOnly ?? false,
    execute: () => opts.run(),
});
const okTool = makeTool("ok", {
    readOnly: true,
    schema: z.object({ value: z.string() }),
    run: async function* () {
        yield { type: "progress", message: "working" };
        yield { type: "result", result: { ok: true, output: "all good" } };
    },
});
const failTool = makeTool("fail", {
    schema: z.object({}),
    run: async function* () {
        yield { type: "result", result: { ok: false, output: "tool said no" } };
    },
});
const throwTool = makeTool("boom", {
    schema: z.object({}),
    run: async function* () {
        yield { type: "progress", message: "before throw" };
        throw new Error("kaboom");
    },
});
const config = (over = {}) => ({
    registry: new ToolRegistry([okTool, failTool, throwTool]),
    cwd: "/repo",
    signal: new AbortController().signal,
    planMode: false,
    permission: { mode: "acceptEdits" },
    ...over,
});
const call = (name, input, id = "c1") => ({
    type: "tool_use",
    id,
    name,
    input,
});
const perm = { mode: "acceptEdits" };
describe("dispatchTool happy path", () => {
    test("found read-only tool executes and returns a well-formed result block", async () => {
        const seen = [];
        const res = await dispatchTool(call("ok", { value: "hi" }), config(), perm, (m) => seen.push(m));
        expect(res.ok).toBe(true);
        expect(res.preview).toBe("all good");
        expect(res.block).toEqual({
            type: "tool_result",
            tool_use_id: "c1",
            content: "all good",
        });
        expect(res.block.is_error).toBeUndefined();
        expect(seen).toEqual(["working"]);
    });
});
describe("dispatchTool error normalization", () => {
    test("unknown tool → deny result, not a throw", async () => {
        const res = await dispatchTool(call("ghost", {}), config(), perm);
        expect(res.ok).toBe(false);
        expect(res.preview).toBe("unknown tool");
        expect(res.block.is_error).toBe(true);
        expect(res.block.content).toContain("Unknown tool: ghost");
    });
    test("schema-invalid input → ToolInputError normalized to an error result", async () => {
        const res = await dispatchTool(call("ok", { value: 123 }), config(), perm);
        expect(res.ok).toBe(false);
        expect(res.block.is_error).toBe(true);
        expect(res.block.content).toContain("value");
    });
    test("tool yielding ok:false → error result preserving the tool's output", async () => {
        const res = await dispatchTool(call("fail", {}), config(), perm);
        expect(res.ok).toBe(false);
        expect(res.block.is_error).toBe(true);
        expect(res.block.content).toBe("tool said no");
        expect(res.preview).toBe("tool said no");
    });
    test("tool throwing mid-execution → message captured as error result", async () => {
        const res = await dispatchTool(call("boom", {}), config(), perm);
        expect(res.ok).toBe(false);
        expect(res.block.is_error).toBe(true);
        expect(res.block.content).toBe("kaboom");
    });
});
describe("dispatchTool gates", () => {
    test("plan mode blocks a mutating tool before execute (ADR-0036 L4 seam-guard)", async () => {
        // ADR-0036 L4: the dispatch-seam guard fires BEFORE the legacy
        // admissibility gate. Custom (non-built-in) tools are not in
        // `MUTATING_TOOL_TABLE`, so the seam guard denies them with
        // `UnknownToolError` in plan mode (fail-closed) — never silently
        // allowing a forgotten classification. To exercise the
        // PlanModeMutatingBlockedError arm we use a real built-in (`write`)
        // that IS classified in the table; for the unknown-tool arm see the
        // sibling test below.
        let executed = false;
        const guarded = makeTool("write", {
            readOnly: false,
            run: async function* () {
                executed = true;
                yield { type: "result", result: { ok: true, output: "ran" } };
            },
        });
        const res = await dispatchTool(call("write", {}), config({ registry: new ToolRegistry([guarded]), planMode: true }), perm);
        expect(res.ok).toBe(false);
        expect(res.preview).toBe("mode-blocked");
        expect(res.block.content).toContain("blocked in plan collaboration mode");
        expect(executed).toBe(false);
    });
    test("plan mode denies an unknown tool via UnknownToolError (fail-closed)", async () => {
        // ADR-0036: a tool absent from MUTATING_TOOL_TABLE in plan mode is a
        // fail-closed deny (a future tool added without classification cannot
        // bypass the gate by being forgotten).
        let executed = false;
        const guarded = makeTool("mutate-unknown", {
            readOnly: false,
            run: async function* () {
                executed = true;
                yield { type: "result", result: { ok: true, output: "ran" } };
            },
        });
        const res = await dispatchTool(call("mutate-unknown", {}), config({ registry: new ToolRegistry([guarded]), planMode: true }), perm);
        expect(res.ok).toBe(false);
        expect(res.preview).toBe("mode-blocked");
        expect(res.block.content).toContain("not classified in the plan-mode mutating table");
        expect(executed).toBe(false);
    });
    test("read-only tool is allowed in plan mode", async () => {
        const res = await dispatchTool(call("ok", { value: "x" }), config({ planMode: true }), perm);
        expect(res.ok).toBe(true);
    });
    test("hard-denied bash command → permission deny result", async () => {
        const bash = makeTool("bash", {
            readOnly: false,
            schema: z.object({ command: z.string() }),
            run: async function* () {
                yield { type: "result", result: { ok: true, output: "should not run" } };
            },
        });
        const res = await dispatchTool(call("bash", { command: "rm -rf /" }), config({ registry: new ToolRegistry([bash]) }), perm);
        expect(res.ok).toBe(false);
        expect(res.preview).toBe("denied");
        expect(res.block.content).toContain("Permission denied");
    });
    test("ask decision without onConfirm → declined", async () => {
        const mutate = makeTool("mutate", {
            readOnly: false,
            run: async function* () {
                yield { type: "result", result: { ok: true, output: "ran" } };
            },
        });
        const res = await dispatchTool(call("mutate", {}), config({ registry: new ToolRegistry([mutate]), permission: { mode: "default" } }), { mode: "default" });
        expect(res.ok).toBe(false);
        expect(res.preview).toBe("declined");
        expect(res.block.content).toContain("User declined");
    });
    test("ask decision with approving onConfirm → tool runs", async () => {
        const mutate = makeTool("mutate", {
            readOnly: false,
            run: async function* () {
                yield { type: "result", result: { ok: true, output: "ran" } };
            },
        });
        const res = await dispatchTool(call("mutate", {}), config({
            registry: new ToolRegistry([mutate]),
            permission: { mode: "default" },
            onConfirm: async () => true,
        }), { mode: "default" });
        expect(res.ok).toBe(true);
        expect(res.block.content).toBe("ran");
    });
    test("pre_tool_use hook deny short-circuits before execute", async () => {
        let executed = false;
        const t = makeTool("ok", {
            readOnly: true,
            schema: z.object({ value: z.string() }),
            run: async function* () {
                executed = true;
                yield { type: "result", result: { ok: true, output: "ran" } };
            },
        });
        const hooks = new HookBus();
        hooks.on("pre_tool_use", () => ({ deny: "policy says no" }));
        const res = await dispatchTool(call("ok", { value: "x" }), config({ registry: new ToolRegistry([t]), hooks }), perm);
        expect(res.ok).toBe(false);
        expect(res.preview).toBe("hook-denied");
        expect(res.block.content).toContain("policy says no");
        expect(executed).toBe(false);
    });
    test("post_tool_use hook receives the execution outcome", async () => {
        const events = [];
        const hooks = new HookBus();
        hooks.on("post_tool_use", (e) => {
            events.push({ ok: e.ok, output: e.output });
        });
        const res = await dispatchTool(call("ok", { value: "x" }), config({ hooks }), perm);
        expect(res.ok).toBe(true);
        expect(events).toEqual([{ ok: true, output: "all good" }]);
    });
});
describe("dispatchTool tool evidence (RFC-0002 §5.2 / C2)", () => {
    test("bash-class tool: durationMs set; stderrTail/exitCode surfaced when present", async () => {
        const bashish = makeTool("bash", {
            readOnly: false,
            schema: z.object({ command: z.string() }),
            run: async function* () {
                yield {
                    type: "result",
                    // Shell-class tools attach §5.2 evidence via the typed
                    // `evidence` field (CR3: no more duck-typed extras on ToolResult).
                    result: {
                        ok: false,
                        output: "[exit 1]\nboom",
                        evidence: { stderr: "boom on stderr", exitCode: 1 },
                    },
                };
            },
        });
        const res = await dispatchTool(call("bash", { command: "false" }), config({ registry: new ToolRegistry([bashish]), permission: { mode: "bypass" } }), { mode: "bypass" });
        expect(res.ok).toBe(false);
        expect(typeof res.durationMs).toBe("number");
        expect(res.durationMs).toBeGreaterThanOrEqual(0);
        expect(res.stderrTail).toBe("boom on stderr");
        expect(res.exitCode).toBe(1);
    });
    test("read-only tool: durationMs set; stderr/exitCode absent (not null)", async () => {
        const res = await dispatchTool(call("ok", { value: "hi" }), config(), perm);
        expect(res.ok).toBe(true);
        expect(typeof res.durationMs).toBe("number");
        expect(res.durationMs).toBeGreaterThanOrEqual(0);
        expect(res.stderrTail).toBeUndefined();
        expect(res.exitCode).toBeUndefined();
        expect(res.fullLogPath).toBeUndefined();
        expect("stderrTail" in res).toBe(false);
        expect("exitCode" in res).toBe(false);
    });
    test("tool throwing mid-execution still reports durationMs", async () => {
        const res = await dispatchTool(call("boom", {}), config(), perm);
        expect(res.ok).toBe(false);
        expect(typeof res.durationMs).toBe("number");
        expect(res.durationMs).toBeGreaterThanOrEqual(0);
    });
});
describe("dispatchTool execution context", () => {
    test("passes cwd and signal through to the tool", async () => {
        let captured;
        const probe = {
            name: "probe",
            description: "probe ctx",
            inputSchema: z.object({}),
            isReadOnly: () => true,
            isConcurrencySafe: () => true,
            execute: (_input, ctx) => {
                captured = ctx;
                return (async function* () {
                    yield { type: "result", result: { ok: true, output: "done" } };
                })();
            },
        };
        const ac = new AbortController();
        await dispatchTool(call("probe", {}), config({ registry: new ToolRegistry([probe]), cwd: "/work/here", signal: ac.signal }), perm);
        expect(captured?.cwd).toBe("/work/here");
        expect(captured?.signal).toBe(ac.signal);
    });
});
describe("dispatchTool NO-THROW contract (AUDIT-FIX)", () => {
    // The streaming engine (`streaming-dispatch.ts`) is built on the invariant
    // that `dispatchTool` NEVER throws — every failure is an `ok:false`
    // tool_result. `execute()` normalizes tool throws, but the PRE-execute path
    // had un-normalized throw surfaces. Pin them as normalized error results.
    test("tool-declared extractShellCommand throwing → error result, not a throw", async () => {
        // `extractShellCommand` is invoked in dispatchToolInner BEFORE the gate
        // (to populate `shellCommand` for HARD_DENY). A third-party tool throwing
        // there previously escaped dispatchTool entirely.
        const evil = {
            name: "evil_shell",
            description: "tool whose shell extractor throws",
            inputSchema: z.object({ command: z.string() }),
            isReadOnly: () => false,
            isConcurrencySafe: () => false,
            extractShellCommand: () => {
                throw new Error("extractShellCommand exploded");
            },
            execute: () => (async function* () {
                yield { type: "result", result: { ok: true, output: "unreached" } };
            })(),
        };
        const res = await dispatchTool(call("evil_shell", { command: "ls" }), config({ registry: new ToolRegistry([evil]), permission: { mode: "bypass" } }), { mode: "bypass" });
        // Must NOT throw — normalized to an error tool_result.
        expect(res.ok).toBe(false);
        expect(res.block.is_error).toBe(true);
        expect(res.preview).toBe("dispatch-error");
        expect(res.block.content).toContain("extractShellCommand exploded");
        expect(res.block.tool_use_id).toBe("c1");
    });
    test("the result is a structurally valid tool_result the loop can consume", async () => {
        const evil = {
            name: "evil2",
            description: "throws in extractShellCommand",
            inputSchema: z.object({ command: z.string() }),
            isReadOnly: () => false,
            isConcurrencySafe: () => false,
            extractShellCommand: () => {
                throw "string-throw"; // non-Error reject path
            },
            execute: () => (async function* () {
                yield { type: "result", result: { ok: true, output: "x" } };
            })(),
        };
        const res = await dispatchTool(call("evil2", { command: "x" }, "id-9"), config({ registry: new ToolRegistry([evil]), permission: { mode: "bypass" } }), { mode: "bypass" });
        expect(res.block.type).toBe("tool_result");
        expect(res.block.tool_use_id).toBe("id-9");
        expect(res.ok).toBe(false);
    });
});
