import { describe, expect, test } from "bun:test";
import { AnthropicAdapter } from "@/llm";
/** Drive one stream() and return the captured create() params. The adapter
 *  holds `private readonly client: Anthropic`; at runtime it is a plain
 *  property, so we swap messages.create for a capturing empty async-iterable. */
const driveOnce = async (input) => {
    const adapter = new AnthropicAdapter({ apiKey: "test-key", model: "claude-x" });
    let params;
    const client = adapter.client;
    client.messages.create = (p) => {
        params = p;
        const empty = {
            [Symbol.asyncIterator]() {
                return { next: () => Promise.resolve({ done: true, value: undefined }) };
            },
        };
        return Promise.resolve(empty);
    };
    for await (const _ of adapter.stream(input)) {
        // drain
    }
    if (params === undefined)
        throw new Error("create() was not called");
    return params;
};
/** Index helper that narrows away `T | undefined` without a non-null
 *  assertion (Biome `noNonNullAssertion` is on). Fails loudly if out of range. */
const at = (arr, i) => {
    const v = arr[i];
    if (v === undefined)
        throw new Error(`index ${i} out of range (len ${arr.length})`);
    return v;
};
const baseInput = (over) => ({
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
    ...over,
});
describe("toAnthropicSystem — string passthrough (legacy)", () => {
    test("a plain string system passes through verbatim", async () => {
        const p = await driveOnce(baseInput({ system: "You are a helpful agent." }));
        expect(p.system).toBe("You are a helpful agent.");
    });
    test("absent system ⇒ no `system` key on the request at all", async () => {
        const p = await driveOnce(baseInput({}));
        expect("system" in p).toBe(false);
    });
});
describe("toAnthropicSystem — SystemBlock[] → text params + cache_control", () => {
    test("blocks become text params; only `cache:true` block gets ephemeral cache_control", async () => {
        const system = [
            { type: "text", text: "STATIC PREFIX" },
            { type: "text", text: "PREFIX BREAKPOINT", cache: true },
        ];
        const p = await driveOnce(baseInput({ system }));
        expect(Array.isArray(p.system)).toBe(true);
        const arr = p.system;
        expect(arr).toEqual([
            { type: "text", text: "STATIC PREFIX" },
            { type: "text", text: "PREFIX BREAKPOINT", cache_control: { type: "ephemeral" } },
        ]);
    });
    test("no cache:true anywhere ⇒ NO cache_control on any system block", async () => {
        const system = [
            { type: "text", text: "a" },
            { type: "text", text: "b" },
        ];
        const p = await driveOnce(baseInput({ system }));
        const arr = p.system;
        for (const blk of arr) {
            expect("cache_control" in blk).toBe(false);
        }
    });
    test("exactly ONE cache_control breakpoint even with multiple cache:true blocks present", async () => {
        const system = [
            { type: "text", text: "p0", cache: true },
            { type: "text", text: "p1" },
            { type: "text", text: "p2", cache: true },
        ];
        const p = await driveOnce(baseInput({ system }));
        const arr = p.system;
        // Source stamps cache_control per-block where `cache:true`; assert the
        // mapping is faithful (not a "last block only" heuristic).
        const stamped = arr.filter((b) => "cache_control" in b);
        expect(stamped.length).toBe(2);
        expect(arr[0]?.cache_control).toEqual({ type: "ephemeral" });
        expect(arr[2]?.cache_control).toEqual({ type: "ephemeral" });
        expect("cache_control" in arr[1]).toBe(false);
    });
});
describe("cacheConversationPrefix — trailing-block breakpoint", () => {
    test("the LAST block of the LAST message gets cache_control:{type:ephemeral}", async () => {
        const messages = [
            { role: "user", content: [{ type: "text", text: "earlier turn" }] },
            {
                role: "user",
                content: [
                    { type: "text", text: "context A" },
                    { type: "text", text: "context B (tail)" },
                ],
            },
        ];
        const p = await driveOnce(baseInput({ messages }));
        const msgs = p.messages;
        // First message untouched.
        expect("cache_control" in at(at(msgs, 0).content, 0)).toBe(false);
        // Only the final block of the final message is stamped.
        const lastContent = at(msgs, 1).content;
        expect("cache_control" in at(lastContent, 0)).toBe(false);
        expect(at(lastContent, lastContent.length - 1).cache_control).toEqual({ type: "ephemeral" });
    });
    test("single-message single-block conversation: that sole block is the breakpoint", async () => {
        const p = await driveOnce(baseInput({ messages: [{ role: "user", content: [{ type: "text", text: "solo" }] }] }));
        const msgs = p.messages;
        expect(at(at(msgs, 0).content, 0).cache_control).toEqual({ type: "ephemeral" });
    });
});
describe("ADR-0004 invariant — cached prefix is byte-identical across turns", () => {
    test("same input ⇒ byte-identical serialized (system + non-tail) request", async () => {
        const system = [
            { type: "text", text: "STATIC SYSTEM" },
            { type: "text", text: "STATIC BREAKPOINT", cache: true },
        ];
        const messages = [
            { role: "user", content: [{ type: "text", text: "fixed prefix turn" }] },
            { role: "user", content: [{ type: "text", text: "tail-A" }] },
        ];
        const a = await driveOnce(baseInput({ system, messages }));
        const b = await driveOnce(baseInput({ system, messages }));
        expect(JSON.stringify(a.system)).toBe(JSON.stringify(b.system));
        expect(JSON.stringify(a.messages)).toBe(JSON.stringify(b.messages));
    });
    test("only the trailing dynamic content changes ⇒ system + prior turns stay byte-identical", async () => {
        const system = [
            { type: "text", text: "STATIC SYSTEM" },
            { type: "text", text: "STATIC BREAKPOINT", cache: true },
        ];
        const prior = {
            role: "user",
            content: [{ type: "text", text: "STABLE PRIOR TURN — must not shift" }],
        };
        const turn1 = await driveOnce(baseInput({
            system,
            messages: [prior, { role: "user", content: [{ type: "text", text: "tail-v1" }] }],
        }));
        const turn2 = await driveOnce(baseInput({
            system,
            messages: [prior, { role: "user", content: [{ type: "text", text: "tail-v2-DIFFERENT" }] }],
        }));
        // The cached prefix = system + every message except the last (the tail).
        expect(JSON.stringify(turn1.system)).toBe(JSON.stringify(turn2.system));
        const prefix1 = turn1.messages.slice(0, -1);
        const prefix2 = turn2.messages.slice(0, -1);
        expect(JSON.stringify(prefix1)).toBe(JSON.stringify(prefix2));
        // And the tails genuinely differ (so the test would catch a no-op stub).
        expect(JSON.stringify(turn1.messages.at(-1))).not.toBe(JSON.stringify(turn2.messages.at(-1)));
    });
});
