import { describe, expect, test } from "bun:test";
import { JSONRPC_ERROR_CODES, JSONRPC_VERSION, JsonRpcErrorResponseSchema, JsonRpcFrameSchema, JsonRpcNotificationSchema, JsonRpcRequestSchema, JsonRpcResponseSchema, JsonRpcSuccessResponseSchema, JsonRpcTimeoutResponseSchema, } from "@/shared/jsonrpc";
describe("JsonRpcRequestSchema", () => {
    test("accepts a minimal request with no params", () => {
        const r = JsonRpcRequestSchema.safeParse({
            jsonrpc: JSONRPC_VERSION,
            id: 1,
            method: "ping",
        });
        expect(r.success).toBe(true);
    });
    test("accepts string id (spec §4)", () => {
        const r = JsonRpcRequestSchema.safeParse({
            jsonrpc: JSONRPC_VERSION,
            id: "tx-1",
            method: "ping",
        });
        expect(r.success).toBe(true);
    });
    test("accepts null id (spec §4 — allowed but discouraged)", () => {
        const r = JsonRpcRequestSchema.safeParse({
            jsonrpc: JSONRPC_VERSION,
            id: null,
            method: "ping",
        });
        expect(r.success).toBe(true);
    });
    test("rejects object id (spec §4 forbids structured ids on requests)", () => {
        const r = JsonRpcRequestSchema.safeParse({
            jsonrpc: JSONRPC_VERSION,
            id: { foo: 1 },
            method: "ping",
        });
        expect(r.success).toBe(false);
    });
    test("rejects array id", () => {
        const r = JsonRpcRequestSchema.safeParse({
            jsonrpc: JSONRPC_VERSION,
            id: [1, 2],
            method: "ping",
        });
        expect(r.success).toBe(false);
    });
    test("rejects wrong jsonrpc version string", () => {
        const r = JsonRpcRequestSchema.safeParse({ jsonrpc: "1.0", id: 1, method: "ping" });
        expect(r.success).toBe(false);
    });
    test("rejects missing method", () => {
        const r = JsonRpcRequestSchema.safeParse({ jsonrpc: JSONRPC_VERSION, id: 1 });
        expect(r.success).toBe(false);
    });
    test("rejects empty-string method", () => {
        const r = JsonRpcRequestSchema.safeParse({ jsonrpc: JSONRPC_VERSION, id: 1, method: "" });
        expect(r.success).toBe(false);
    });
    test("rejects extra keys (strict)", () => {
        const r = JsonRpcRequestSchema.safeParse({
            jsonrpc: JSONRPC_VERSION,
            id: 1,
            method: "ping",
            stray: "field",
        });
        expect(r.success).toBe(false);
    });
    test("preserves large integer ids (Number.MAX_SAFE_INTEGER)", () => {
        const big = Number.MAX_SAFE_INTEGER;
        const wire = JSON.stringify({ jsonrpc: JSONRPC_VERSION, id: big, method: "p" });
        const decoded = JsonRpcRequestSchema.parse(JSON.parse(wire));
        expect(decoded.id).toBe(big);
    });
    test("accepts array params", () => {
        const r = JsonRpcRequestSchema.safeParse({
            jsonrpc: JSONRPC_VERSION,
            id: 1,
            method: "sum",
            params: [1, 2, 3],
        });
        expect(r.success).toBe(true);
    });
    test("accepts object params", () => {
        const r = JsonRpcRequestSchema.safeParse({
            jsonrpc: JSONRPC_VERSION,
            id: 1,
            method: "sum",
            params: { a: 1 },
        });
        expect(r.success).toBe(true);
    });
    test("rejects scalar params (spec §4.2 — structured value only)", () => {
        const r = JsonRpcRequestSchema.safeParse({
            jsonrpc: JSONRPC_VERSION,
            id: 1,
            method: "sum",
            params: 42,
        });
        expect(r.success).toBe(false);
    });
});
describe("JsonRpcNotificationSchema", () => {
    test("accepts notification with no id", () => {
        const r = JsonRpcNotificationSchema.safeParse({
            jsonrpc: JSONRPC_VERSION,
            method: "tick",
        });
        expect(r.success).toBe(true);
    });
    test("rejects notification with id present (spec §4.1)", () => {
        const r = JsonRpcNotificationSchema.safeParse({
            jsonrpc: JSONRPC_VERSION,
            id: 1,
            method: "tick",
        });
        expect(r.success).toBe(false);
    });
});
describe("JsonRpcResponseSchema", () => {
    test("accepts success response", () => {
        const r = JsonRpcResponseSchema.safeParse({
            jsonrpc: JSONRPC_VERSION,
            id: 1,
            result: { ok: true },
        });
        expect(r.success).toBe(true);
    });
    test("accepts error response", () => {
        const r = JsonRpcResponseSchema.safeParse({
            jsonrpc: JSONRPC_VERSION,
            id: 1,
            error: { code: -32600, message: "Invalid Request" },
        });
        expect(r.success).toBe(true);
    });
    test("rejects response with BOTH result and error (spec §5)", () => {
        const r = JsonRpcResponseSchema.safeParse({
            jsonrpc: JSONRPC_VERSION,
            id: 1,
            result: 1,
            error: { code: -1, message: "x" },
        });
        expect(r.success).toBe(false);
    });
    test("rejects response with NEITHER result nor error", () => {
        const r = JsonRpcResponseSchema.safeParse({
            jsonrpc: JSONRPC_VERSION,
            id: 1,
        });
        expect(r.success).toBe(false);
    });
    test("success-only schema rejects an error response", () => {
        const r = JsonRpcSuccessResponseSchema.safeParse({
            jsonrpc: JSONRPC_VERSION,
            id: 1,
            error: { code: -1, message: "x" },
        });
        expect(r.success).toBe(false);
    });
    test("error-only schema requires error field", () => {
        const r = JsonRpcErrorResponseSchema.safeParse({
            jsonrpc: JSONRPC_VERSION,
            id: 1,
            result: 1,
        });
        expect(r.success).toBe(false);
    });
});
describe("JsonRpcTimeoutResponseSchema", () => {
    test("accepts a properly-formed timeout (code -32000 + data.kind=timeout)", () => {
        const r = JsonRpcTimeoutResponseSchema.safeParse({
            jsonrpc: JSONRPC_VERSION,
            id: 1,
            error: {
                code: JSONRPC_ERROR_CODES.TIMEOUT,
                message: "timed out",
                data: { kind: "timeout", elapsedMs: 5000 },
            },
        });
        expect(r.success).toBe(true);
    });
    test("rejects a generic -32000 error without data.kind=timeout", () => {
        const r = JsonRpcTimeoutResponseSchema.safeParse({
            jsonrpc: JSONRPC_VERSION,
            id: 1,
            error: { code: JSONRPC_ERROR_CODES.TIMEOUT, message: "something else" },
        });
        expect(r.success).toBe(false);
    });
    test("rejects wrong error code even when data.kind=timeout", () => {
        const r = JsonRpcTimeoutResponseSchema.safeParse({
            jsonrpc: JSONRPC_VERSION,
            id: 1,
            error: { code: -32603, message: "x", data: { kind: "timeout" } },
        });
        expect(r.success).toBe(false);
    });
});
describe("JsonRpcFrameSchema (union demux)", () => {
    test("accepts a request frame", () => {
        expect(JsonRpcFrameSchema.safeParse({ jsonrpc: JSONRPC_VERSION, id: 1, method: "x" }).success).toBe(true);
    });
    test("accepts a notification frame", () => {
        expect(JsonRpcFrameSchema.safeParse({ jsonrpc: JSONRPC_VERSION, method: "x" }).success).toBe(true);
    });
    test("accepts a success response frame", () => {
        expect(JsonRpcFrameSchema.safeParse({ jsonrpc: JSONRPC_VERSION, id: 1, result: 0 }).success).toBe(true);
    });
    test("accepts an error response frame", () => {
        expect(JsonRpcFrameSchema.safeParse({
            jsonrpc: JSONRPC_VERSION,
            id: 1,
            error: { code: -32600, message: "x" },
        }).success).toBe(true);
    });
    test("rejects junk", () => {
        expect(JsonRpcFrameSchema.safeParse({ hello: "world" }).success).toBe(false);
    });
});
