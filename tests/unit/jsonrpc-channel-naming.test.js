import { describe, expect, test } from "bun:test";
import { channelTriple, parseChannelBase, parseChannelKind } from "@/shared/jsonrpc";
describe("channelTriple", () => {
    test("produces three suffixed names", () => {
        const t = channelTriple("agent.run");
        expect(t.request).toBe("agent.run-request");
        expect(t.response).toBe("agent.run-response");
        expect(t.timeout).toBe("agent.run-timeout");
    });
    test("accepts dot-namespaced base", () => {
        const t = channelTriple("tools.list");
        expect(t.request).toBe("tools.list-request");
    });
    test("accepts slash-namespaced base", () => {
        const t = channelTriple("tools/call");
        expect(t.request).toBe("tools/call-request");
    });
    test("frozen triple cannot be mutated", () => {
        const t = channelTriple("x");
        expect(() => {
            ;
            t.request = "y";
        }).toThrow();
    });
    test("rejects empty name", () => {
        expect(() => channelTriple("")).toThrow();
    });
    test("rejects illegal characters", () => {
        expect(() => channelTriple("bad name")).toThrow();
        expect(() => channelTriple("with\nnewline")).toThrow();
    });
    test("rejects already-suffixed names (no double-wrap)", () => {
        expect(() => channelTriple("foo-request")).toThrow();
        expect(() => channelTriple("foo-response")).toThrow();
        expect(() => channelTriple("foo-timeout")).toThrow();
    });
});
describe("parseChannelKind", () => {
    test("classifies known suffixes", () => {
        expect(parseChannelKind("agent.run-request")).toBe("request");
        expect(parseChannelKind("agent.run-response")).toBe("response");
        expect(parseChannelKind("agent.run-timeout")).toBe("timeout");
    });
    test("returns null for unknown suffix", () => {
        expect(parseChannelKind("agent.run-ack")).toBeNull();
        expect(parseChannelKind("just-a-name")).toBeNull();
    });
});
describe("parseChannelBase", () => {
    test("round-trips with channelTriple", () => {
        const bases = ["agent.run", "tools/call", "sandbox.exec", "patch.apply"];
        for (const base of bases) {
            const t = channelTriple(base);
            expect(parseChannelBase(t.request)).toBe(base);
            expect(parseChannelBase(t.response)).toBe(base);
            expect(parseChannelBase(t.timeout)).toBe(base);
        }
    });
    test("returns null for unknown suffix", () => {
        expect(parseChannelBase("plain")).toBeNull();
    });
});
