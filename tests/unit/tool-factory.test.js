import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { DeferredResultRegistry, UnknownDeferredHandleError } from "@/tool/deferred";
import { defineTool, driveStreamingInput, enforceOutputSchema, renderModelOutput, validateToolOutput, } from "@/tool/factory";
const ctx = () => ({ cwd: "/tmp", signal: new AbortController().signal });
const inputSchema = z.object({ q: z.string() });
const outputSchema = z.object({ count: z.number(), label: z.string() });
const drain = async (it) => {
    const out = [];
    for await (const e of it)
        out.push(e);
    return out;
};
describe("validateToolOutput", () => {
    test("returns ok with parsed value on a match", () => {
        const r = validateToolOutput(outputSchema, { count: 2, label: "x" });
        expect(r.ok).toBe(true);
        if (r.ok)
            expect(r.value).toEqual({ count: 2, label: "x" });
    });
    test("returns a flattened error message on a mismatch", () => {
        const r = validateToolOutput(outputSchema, { count: "nope" });
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.error).toContain("count");
            expect(r.error).toContain("label");
        }
    });
    test("never throws on a wildly wrong value", () => {
        expect(() => validateToolOutput(outputSchema, null)).not.toThrow();
        const r = validateToolOutput(outputSchema, null);
        expect(r.ok).toBe(false);
    });
});
describe("enforceOutputSchema", () => {
    const tool = defineTool({
        name: "structured",
        description: "d",
        inputSchema,
        outputSchema,
        isReadOnly: () => true,
        isConcurrencySafe: () => true,
        async *execute() { },
    });
    test("passes a valid structured result through unchanged", () => {
        const result = { ok: true, output: "human", structured: { count: 1, label: "a" } };
        expect(enforceOutputSchema(tool, result)).toBe(result);
    });
    test("turns an invalid structured result into an ok:false retry instruction", () => {
        const result = { ok: true, output: "human", structured: { count: "bad" } };
        const enforced = enforceOutputSchema(tool, result);
        expect(enforced.ok).toBe(false);
        expect(enforced.output).toContain("failed validation");
        expect(enforced.output).toContain("structured");
        expect(enforced.output).toContain("Re-issue");
    });
    test("leaves an already-failed result alone", () => {
        const result = { ok: false, output: "boom" };
        expect(enforceOutputSchema(tool, result)).toBe(result);
    });
    test("is a no-op when the tool has no outputSchema", () => {
        const plain = defineTool({
            name: "plain",
            description: "d",
            inputSchema,
            isReadOnly: () => true,
            isConcurrencySafe: () => true,
            async *execute() { },
        });
        const result = { ok: true, output: "x", structured: { whatever: true } };
        expect(enforceOutputSchema(plain, result)).toBe(result);
    });
});
describe("toModelOutput / renderModelOutput", () => {
    test("uses the compact transform when present", () => {
        const tool = defineTool({
            name: "compact",
            description: "d",
            inputSchema,
            isReadOnly: () => true,
            isConcurrencySafe: () => true,
            toModelOutput: (r) => `[${r.output.length}]`,
            async *execute() { },
        });
        expect(renderModelOutput(tool, { ok: true, output: "a long human string" })).toBe("[19]");
    });
    test("falls back to result.output when absent", () => {
        const tool = defineTool({
            name: "default",
            description: "d",
            inputSchema,
            isReadOnly: () => true,
            isConcurrencySafe: () => true,
            async *execute() { },
        });
        expect(renderModelOutput(tool, { ok: true, output: "verbatim" })).toBe("verbatim");
    });
});
describe("deferred-result contract", () => {
    test("register → poll(pending) → resolve → poll(resolved)", () => {
        const reg = new DeferredResultRegistry();
        const handle = reg.register("computing…");
        expect(handle.id).toMatch(/^deferred-/);
        expect(handle.hint).toBe("computing…");
        const pending = reg.poll(handle);
        expect(pending.state).toBe("pending");
        const final = { ok: true, output: "done" };
        reg.resolve(handle, final);
        const resolved = reg.poll(handle);
        expect(resolved.state).toBe("resolved");
        if (resolved.state === "resolved")
            expect(resolved.result).toBe(final);
    });
    test("register without a hint omits the field", () => {
        const reg = new DeferredResultRegistry();
        const handle = reg.register();
        expect(handle.hint).toBeUndefined();
    });
    test("polling/resolving an unknown handle throws UnknownDeferredHandleError", () => {
        const reg = new DeferredResultRegistry();
        expect(() => reg.poll({ id: "ghost" })).toThrow(UnknownDeferredHandleError);
        expect(() => reg.resolve({ id: "ghost" }, { ok: true, output: "" })).toThrow(UnknownDeferredHandleError);
    });
    test("evict drops a resolved handle", () => {
        const reg = new DeferredResultRegistry();
        const handle = reg.register();
        reg.resolve(handle, { ok: true, output: "x" });
        reg.evict(handle);
        expect(() => reg.poll(handle)).toThrow(UnknownDeferredHandleError);
    });
    test("a tool can yield a terminal result carrying a deferred handle", async () => {
        const handle = { id: "deferred-1" };
        const tool = defineTool({
            name: "long",
            description: "d",
            inputSchema,
            supportsDeferredResults: true,
            isReadOnly: () => true,
            isConcurrencySafe: () => true,
            async *execute() {
                yield {
                    type: "result",
                    result: { ok: true, output: "started; result pending", deferred: handle },
                };
            },
        });
        const events = await drain(tool.execute({ q: "x" }, ctx()));
        expect(events).toHaveLength(1);
        const ev = events[0];
        expect(ev?.type).toBe("result");
        if (ev?.type === "result") {
            expect(ev.result.deferred).toBe(handle);
        }
        expect(tool.supportsDeferredResults).toBe(true);
    });
});
describe("driveStreamingInput", () => {
    test("invokes start/delta/available callbacks in order and buffers deltas", () => {
        const events = [];
        let received;
        const tool = defineTool({
            name: "stream",
            description: "d",
            inputSchema,
            isReadOnly: () => true,
            isConcurrencySafe: () => true,
            onInputStart: () => events.push("start"),
            onInputDelta: (d) => events.push(`delta:${d}`),
            onInputAvailable: (input) => {
                received = input;
                events.push("available");
            },
            async *execute() { },
        });
        const steps = [
            { type: "start" },
            { type: "delta", delta: '{"q":' },
            { type: "delta", delta: '"hi"}' },
            { type: "available", input: { q: "hi" } },
        ];
        const buffer = driveStreamingInput(tool, steps);
        expect(buffer).toBe('{"q":"hi"}');
        expect(events).toEqual(["start", 'delta:{"q":', 'delta:"hi"}', "available"]);
        expect(received).toEqual({ q: "hi" });
    });
    test("is a safe no-op for a tool with no streaming callbacks", () => {
        const tool = defineTool({
            name: "nostream",
            description: "d",
            inputSchema,
            isReadOnly: () => true,
            isConcurrencySafe: () => true,
            async *execute() { },
        });
        const steps = [
            { type: "start" },
            { type: "delta", delta: "ab" },
            { type: "available", input: { q: "ab" } },
        ];
        expect(() => driveStreamingInput(tool, steps)).not.toThrow();
        expect(driveStreamingInput(tool, steps)).toBe("ab");
    });
});
describe("plain tool is unaffected (byte-identical surface)", () => {
    test("defineTool with no optional members produces a tool with none set", () => {
        const tool = defineTool({
            name: "bare",
            description: "d",
            inputSchema,
            isReadOnly: () => true,
            isConcurrencySafe: () => true,
            async *execute() { },
        });
        expect(tool.outputSchema).toBeUndefined();
        expect(tool.toModelOutput).toBeUndefined();
        expect(tool.supportsDeferredResults).toBeUndefined();
        expect(tool.onInputStart).toBeUndefined();
        expect(tool.onInputDelta).toBeUndefined();
        expect(tool.onInputAvailable).toBeUndefined();
        expect(tool.hitlTier).toBeUndefined();
        expect(tool.extractShellCommand).toBeUndefined();
        expect(Object.keys(tool).sort()).toEqual(["description", "execute", "inputSchema", "isConcurrencySafe", "isReadOnly", "name"].sort());
    });
    test("a hand-written Tool literal still satisfies the widened interface", () => {
        const tool = {
            name: "literal",
            description: "d",
            inputSchema,
            isReadOnly: () => true,
            isConcurrencySafe: () => true,
            async *execute(_input, _c) {
                yield { type: "result", result: { ok: true, output: "ok" } };
            },
        };
        expect(tool.name).toBe("literal");
    });
});
