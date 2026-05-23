/**
 * HELLGATE — tool-output-schema-factory L3→L4 promotion (ADR-0060).
 *
 * Exercises the streaming-input seam wired into `streamingTurn`
 * (`onToolInput: buildToolInputSeam(registry)`), the outputSchema enforcement
 * inside `ToolRegistry.run`, and the deferred-result interaction. Each test
 * is a true negative path or race — not a happy path rehash.
 *
 * Failure modes covered:
 *  - bad / malformed JSON deltas (callbacks still fire — partial-JSON is the
 *    consumer's problem; the seam must surface the raw delta verbatim).
 *  - outputSchema reject WITH the retry directive (and structured field
 *    becomes absent on the rewritten ok:false result, not stale).
 *  - tool with no outputSchema but yielding a structured object — silent
 *    passthrough (default-OFF byte-identity).
 *  - race between final input_delta and tool_use_end (the seam must clear
 *    id→name mapping ONLY on `available`, never on `delta`).
 *  - tool with onInputStart wired but no onInputAvailable handler — graceful.
 *  - deferred result interaction with output validation (deferred carries no
 *    structured payload — enforce must NOT reject).
 *  - re-`start` of the same id (mid-stream LLM retry of the partial); the
 *    name binding must be refreshed, not duplicated.
 *  - cross-id interleaving (two parallel tool calls; deltas must route to
 *    the correct tool by id).
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { streamingTurn } from "@/agent/streaming-dispatch";
import { buildToolInputSeam } from "@/agent/tool-input-streaming";
import { defineTool } from "@/tool/factory";
import { ToolRegistry } from "@/tool/registry";
const ctx = () => ({ cwd: "/tmp", signal: new AbortController().signal });
const noProgress = () => undefined;
const Q = z.object({ q: z.string() });
// ---------------------------------------------------------------------------
// A. Malformed JSON deltas — the seam is byte-transparent.
// ---------------------------------------------------------------------------
describe("HELLGATE — malformed-JSON deltas on the input seam", () => {
    test("garbage deltas reach onInputDelta verbatim; final available carries the parsed input", () => {
        const log = [];
        const tool = defineTool({
            name: "tt",
            description: "d",
            inputSchema: Q,
            isReadOnly: () => true,
            isConcurrencySafe: () => true,
            onInputDelta: (d) => log.push(["delta", d]),
            onInputAvailable: (i) => log.push(["avail", i]),
            async *execute() {
                yield { type: "result", result: { ok: true, output: "ok" } };
            },
        });
        const reg = new ToolRegistry([tool]);
        const seam = buildToolInputSeam(reg);
        // garbage stream — never a closing brace; available finally carries an
        // empty object (the consumer's tolerant-JSON parser would have salvaged
        // nothing). The seam is byte-transparent: every delta is delivered raw.
        seam.start("u1", "tt");
        seam.delta("u1", "{");
        seam.delta("u1", '"q');
        seam.delta("u1", ": <not-json>");
        seam.delta("u1", ' "x"'); // never closed
        seam.available("u1", { q: "x" });
        expect(log).toEqual([
            ["delta", "{"],
            ["delta", '"q'],
            ["delta", ": <not-json>"],
            ["delta", ' "x"'],
            ["avail", { q: "x" }],
        ]);
    });
    test("zero-length deltas still fire (the seam doesn't filter)", () => {
        const log = [];
        const tool = defineTool({
            name: "tt",
            description: "d",
            inputSchema: Q,
            isReadOnly: () => true,
            isConcurrencySafe: () => true,
            onInputDelta: (d) => log.push(`[${d.length}]`),
            async *execute() {
                yield { type: "result", result: { ok: true, output: "ok" } };
            },
        });
        const reg = new ToolRegistry([tool]);
        const seam = buildToolInputSeam(reg);
        seam.start("u1", "tt");
        seam.delta("u1", "");
        seam.delta("u1", "");
        seam.delta("u1", "x");
        expect(log).toEqual(["[0]", "[0]", "[1]"]);
    });
});
// ---------------------------------------------------------------------------
// B. outputSchema reject — model gets the retry directive, structured cleared.
// ---------------------------------------------------------------------------
describe("HELLGATE — outputSchema reject path", () => {
    const Out = z.object({ count: z.number(), label: z.string() });
    const buildTool = (structured) => defineTool({
        name: "rej",
        description: "d",
        inputSchema: Q,
        outputSchema: Out,
        isReadOnly: () => true,
        isConcurrencySafe: () => true,
        async *execute() {
            yield {
                type: "result",
                result: { ok: true, output: "ui-out", structured },
            };
        },
    });
    test("invalid structured ⇒ ok:false WITH retry directive, structured field DROPPED", async () => {
        const reg = new ToolRegistry([buildTool({ count: "not-a-number", label: 42 })]);
        const r = await reg.run("rej", { q: "x" }, ctx(), noProgress);
        expect(r.ok).toBe(false);
        expect(r.output).toContain("failed validation");
        expect(r.output).toContain("Re-issue the call");
        // The rewritten ok:false placeholder MUST NOT carry the stale structured
        // payload (else the model sees both an "error" and the bad object).
        expect(r.structured).toBeUndefined();
    });
    test("rejection error message contains the path of the bad field", async () => {
        const reg = new ToolRegistry([buildTool({ count: "nope", label: "ok" })]);
        const r = await reg.run("rej", { q: "x" }, ctx(), noProgress);
        expect(r.ok).toBe(false);
        expect(r.output).toContain("count");
    });
    test("rejection includes EACH violation path when multiple fields fail", async () => {
        const reg = new ToolRegistry([buildTool({ count: "no", label: 99 })]);
        const r = await reg.run("rej", { q: "x" }, ctx(), noProgress);
        expect(r.ok).toBe(false);
        expect(r.output).toContain("count");
        expect(r.output).toContain("label");
    });
    test("nested-path zod error preserved", async () => {
        const Nested = z.object({ outer: z.object({ inner: z.number() }) });
        const tool = defineTool({
            name: "nested",
            description: "d",
            inputSchema: Q,
            outputSchema: Nested,
            isReadOnly: () => true,
            isConcurrencySafe: () => true,
            async *execute() {
                yield {
                    type: "result",
                    result: { ok: true, output: "u", structured: { outer: { inner: "bad" } } },
                };
            },
        });
        const reg = new ToolRegistry([tool]);
        const r = await reg.run("nested", { q: "x" }, ctx(), noProgress);
        expect(r.ok).toBe(false);
        expect(r.output).toContain("outer.inner");
    });
});
// ---------------------------------------------------------------------------
// C. Tool with NO outputSchema but yielding structured ⇒ silent passthrough.
// ---------------------------------------------------------------------------
describe("HELLGATE — silent mode (no outputSchema declared)", () => {
    test("structured payload passes through unchanged when outputSchema is absent", async () => {
        const tool = defineTool({
            name: "silent",
            description: "d",
            inputSchema: Q,
            isReadOnly: () => true,
            isConcurrencySafe: () => true,
            async *execute() {
                yield {
                    type: "result",
                    result: { ok: true, output: "ui-out", structured: { anything: "goes" } },
                };
            },
        });
        const reg = new ToolRegistry([tool]);
        const r = await reg.run("silent", { q: "x" }, ctx(), noProgress);
        expect(r.ok).toBe(true);
        expect(r.structured).toEqual({ anything: "goes" });
    });
    test("ok:false result preserved as-is (enforce skips non-ok results)", async () => {
        const Out = z.object({ ok: z.boolean() });
        const tool = defineTool({
            name: "preserved",
            description: "d",
            inputSchema: Q,
            outputSchema: Out,
            isReadOnly: () => true,
            isConcurrencySafe: () => true,
            async *execute() {
                yield { type: "result", result: { ok: false, output: "real failure" } };
            },
        });
        const reg = new ToolRegistry([tool]);
        const r = await reg.run("preserved", { q: "x" }, ctx(), noProgress);
        expect(r.ok).toBe(false);
        // outputSchema doesn't touch ok:false results (failures pass through).
        expect(r.output).toBe("real failure");
    });
});
// ---------------------------------------------------------------------------
// D. Race between delta and end / re-start / cross-id interleaving.
// ---------------------------------------------------------------------------
describe("HELLGATE — id→name mapping races", () => {
    test("delta arriving AFTER available is dropped (mapping cleared on available)", () => {
        const log = [];
        const tool = defineTool({
            name: "race",
            description: "d",
            inputSchema: Q,
            isReadOnly: () => true,
            isConcurrencySafe: () => true,
            onInputDelta: (d) => log.push(`d:${d}`),
            onInputAvailable: (i) => log.push(`a:${JSON.stringify(i)}`),
            async *execute() {
                yield { type: "result", result: { ok: true, output: "ok" } };
            },
        });
        const reg = new ToolRegistry([tool]);
        const seam = buildToolInputSeam(reg);
        seam.start("u1", "race");
        seam.delta("u1", "1");
        seam.available("u1", { q: "x" });
        seam.delta("u1", "late"); // dropped — id mapping cleared
        expect(log).toEqual(["d:1", 'a:{"q":"x"}']);
    });
    test("re-start of same id refreshes the name binding (no duplicate state)", () => {
        const log = [];
        const t1 = defineTool({
            name: "t1",
            description: "d",
            inputSchema: Q,
            isReadOnly: () => true,
            isConcurrencySafe: () => true,
            onInputDelta: (d) => log.push(`t1:${d}`),
            async *execute() {
                yield { type: "result", result: { ok: true, output: "ok" } };
            },
        });
        const t2 = defineTool({
            name: "t2",
            description: "d",
            inputSchema: Q,
            isReadOnly: () => true,
            isConcurrencySafe: () => true,
            onInputDelta: (d) => log.push(`t2:${d}`),
            async *execute() {
                yield { type: "result", result: { ok: true, output: "ok" } };
            },
        });
        const reg = new ToolRegistry([t1, t2]);
        const seam = buildToolInputSeam(reg);
        seam.start("u1", "t1");
        seam.delta("u1", "a"); // routed to t1
        seam.start("u1", "t2"); // refresh same id → t2
        seam.delta("u1", "b"); // now routed to t2
        expect(log).toEqual(["t1:a", "t2:b"]);
    });
    test("cross-id interleaving — two parallel tool calls route to the right tool", () => {
        const log = [];
        const ta = defineTool({
            name: "A",
            description: "d",
            inputSchema: Q,
            isReadOnly: () => true,
            isConcurrencySafe: () => true,
            onInputDelta: (d) => log.push(`A:${d}`),
            async *execute() {
                yield { type: "result", result: { ok: true, output: "ok" } };
            },
        });
        const tb = defineTool({
            name: "B",
            description: "d",
            inputSchema: Q,
            isReadOnly: () => true,
            isConcurrencySafe: () => true,
            onInputDelta: (d) => log.push(`B:${d}`),
            async *execute() {
                yield { type: "result", result: { ok: true, output: "ok" } };
            },
        });
        const reg = new ToolRegistry([ta, tb]);
        const seam = buildToolInputSeam(reg);
        seam.start("u-a", "A");
        seam.start("u-b", "B");
        seam.delta("u-a", "1");
        seam.delta("u-b", "x");
        seam.delta("u-a", "2");
        seam.delta("u-b", "y");
        seam.available("u-a", {});
        seam.available("u-b", {});
        expect(log).toEqual(["A:1", "B:x", "A:2", "B:y"]);
    });
});
// ---------------------------------------------------------------------------
// E. Partial-handler graceful — onInputStart only / available only.
// ---------------------------------------------------------------------------
describe("HELLGATE — partial handler set", () => {
    test("only onInputStart declared — delta + available silently no-op", () => {
        const startLog = [];
        const tool = defineTool({
            name: "partial-start",
            description: "d",
            inputSchema: Q,
            isReadOnly: () => true,
            isConcurrencySafe: () => true,
            onInputStart: () => startLog.push("S"),
            async *execute() {
                yield { type: "result", result: { ok: true, output: "ok" } };
            },
        });
        const reg = new ToolRegistry([tool]);
        const seam = buildToolInputSeam(reg);
        expect(() => {
            seam.start("u1", "partial-start");
            seam.delta("u1", "x");
            seam.available("u1", {});
        }).not.toThrow();
        expect(startLog).toEqual(["S"]);
    });
    test("only onInputAvailable declared — start + delta silently no-op", () => {
        const availLog = [];
        const tool = defineTool({
            name: "partial-avail",
            description: "d",
            inputSchema: Q,
            isReadOnly: () => true,
            isConcurrencySafe: () => true,
            onInputAvailable: (i) => availLog.push(i),
            async *execute() {
                yield { type: "result", result: { ok: true, output: "ok" } };
            },
        });
        const reg = new ToolRegistry([tool]);
        const seam = buildToolInputSeam(reg);
        seam.start("u1", "partial-avail");
        seam.delta("u1", "x");
        seam.available("u1", { q: "v" });
        expect(availLog).toEqual([{ q: "v" }]);
    });
});
// ---------------------------------------------------------------------------
// F. Deferred result interaction with outputSchema enforcement.
// ---------------------------------------------------------------------------
describe("HELLGATE — deferred result + outputSchema", () => {
    test("a deferred (in-flight) ok:false result is NOT re-rewritten by enforce", async () => {
        // A tool that advertises supportsDeferredResults can emit an ok:false
        // result carrying a deferred handle. `enforceOutputSchema` short-circuits
        // on non-ok results, so the deferred message must survive.
        const Out = z.object({ value: z.number() });
        const tool = defineTool({
            name: "deferred-tool",
            description: "d",
            inputSchema: Q,
            outputSchema: Out,
            supportsDeferredResults: true,
            isReadOnly: () => true,
            isConcurrencySafe: () => true,
            async *execute() {
                yield {
                    type: "result",
                    result: { ok: false, output: "deferred handle=deferred-7" },
                };
            },
        });
        const reg = new ToolRegistry([tool]);
        const r = await reg.run("deferred-tool", { q: "x" }, ctx(), noProgress);
        expect(r.ok).toBe(false);
        // The deferred message survived — NOT replaced by a validation-failure msg.
        expect(r.output).toContain("deferred handle=deferred-7");
        expect(r.output).not.toContain("failed validation");
    });
});
// ---------------------------------------------------------------------------
// G. E2E — full streaming flow exercises seam + validation + toModelOutput.
// ---------------------------------------------------------------------------
describe("E2E — streamingTurn drives seam through registry + outputSchema rendering", () => {
    const e2eRun = async (opts) => {
        const seamCalls = [];
        const Out = z.object({ count: z.number(), label: z.string() });
        const tool = defineTool({
            name: "e2e",
            description: "d",
            inputSchema: Q,
            outputSchema: Out,
            isReadOnly: () => true,
            isConcurrencySafe: () => true,
            onInputStart: () => seamCalls.push("start"),
            onInputDelta: (d) => seamCalls.push(`delta:${d}`),
            onInputAvailable: (i) => seamCalls.push(`avail:${JSON.stringify(i)}`),
            ...(opts.toModelOutput !== undefined ? { toModelOutput: opts.toModelOutput } : {}),
            async *execute() {
                yield {
                    type: "result",
                    result: { ok: true, output: "ui-out", structured: opts.structured },
                };
            },
        });
        const reg = new ToolRegistry([tool]);
        const events = [
            { type: "tool_use_start", id: "u1", name: "e2e" },
            { type: "tool_use_delta", id: "u1", delta: '{"q":' },
            { type: "tool_use_delta", id: "u1", delta: '"hello"}' },
            { type: "tool_use_end", id: "u1", input: { q: "hello" } },
            { type: "message_stop", stop_reason: "tool_use" },
        ];
        let captured = {
            ok: false,
            output: "",
        };
        const args = {
            events: (async function* gen() {
                for (const ev of events) {
                    yield ev;
                    await Promise.resolve();
                }
            })(),
            isConcurrencySafe: (n, i) => reg.isConcurrencySafe(n, i),
            onToolInput: buildToolInputSeam(reg),
            dispatch: async (call) => {
                const result = await reg.run(call.name, call.input, ctx(), noProgress);
                captured = result;
                return {
                    block: {
                        type: "tool_result",
                        tool_use_id: call.id,
                        content: result.output,
                        ...(result.ok ? {} : { is_error: true }),
                    },
                    ok: result.ok,
                    preview: result.output,
                };
            },
        };
        const outcome = await streamingTurn(args);
        if (outcome.kind !== "assembled")
            throw new Error("expected assembled");
        const blk = outcome.resultBlocks[0];
        if (!blk || blk.type !== "tool_result")
            throw new Error("expected tool_result block");
        return { seamCalls, result: captured, block: blk };
    };
    test("happy path: seam fires in order, structured passes, toModelOutput renders compact view", async () => {
        const out = await e2eRun({
            structured: { count: 5, label: "Z" },
            toModelOutput: (r) => `compact[${r.output}]`,
        });
        expect(out.seamCalls).toEqual(["start", 'delta:{"q":', 'delta:"hello"}', 'avail:{"q":"hello"}']);
        expect(out.result.ok).toBe(true);
        expect(out.result.output).toBe("compact[ui-out]");
        expect(out.block.content).toBe("compact[ui-out]");
        expect(out.block.is_error).toBeUndefined();
    });
    test("schema-reject path: seam still fires, block carries retry directive, is_error=true", async () => {
        const out = await e2eRun({ structured: { count: "bad", label: 42 } });
        expect(out.seamCalls).toEqual(["start", 'delta:{"q":', 'delta:"hello"}', 'avail:{"q":"hello"}']);
        expect(out.result.ok).toBe(false);
        expect(out.block.is_error).toBe(true);
        expect(out.block.content).toContain("failed validation");
        expect(out.block.content).toContain("Re-issue the call");
    });
    test("toModelOutput is NOT applied when validation rejects (compact view suppressed on error)", async () => {
        const out = await e2eRun({
            structured: { count: "no", label: "x" },
            toModelOutput: () => "must-not-appear",
        });
        expect(out.block.content).not.toContain("must-not-appear");
        expect(out.block.content).toContain("failed validation");
    });
});
