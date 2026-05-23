/**
 * MCP client error-path coverage — R-Phase3 P2-4.
 *
 * `mcp/client.ts` throws `McpError` at two specific sites that prior tests
 * only exercised indirectly through the JSON-RPC integration suite:
 *
 *   Line 93  — `start()` rejects empty command array (before any spawn)
 *   Line 163 — `ensureReady()` rejects calls after stop() or before start()
 *
 * Direct isolated coverage matters because (a) these are FAIL-CLOSED guards
 * (a refactor that loosened either would silently allow undefined behaviour
 * in production), and (b) they protect the spawn surface from junk input
 * that the JSON-RPC layer would otherwise discover via a less informative
 * error path.
 *
 * No subprocess is spawned by any test in this file — every assertion is a
 * pure API contract check on the McpClient class.
 */
import { describe, expect, test } from "bun:test";
import { McpClient, McpError } from "@/mcp";
describe("McpClient — empty command rejection (client.ts:93)", () => {
    test("empty command array → start() rejects with McpError, no spawn attempted", async () => {
        const client = new McpClient({ name: "empty-cmd", command: [] });
        await expect(client.start()).rejects.toBeInstanceOf(McpError);
    });
    test("empty command — the rejection carries the server name for triage", async () => {
        const client = new McpClient({ name: "named-empty", command: [] });
        try {
            await client.start();
            // Unreachable: start() must have thrown.
            expect("should-have-thrown").toBe("but-did-not");
        }
        catch (e) {
            expect(e).toBeInstanceOf(McpError);
            expect(e.message).toContain("named-empty");
            expect(e.message).toContain("empty command");
        }
    });
    test("empty command — start() flips the `started` flag before throwing (so re-start is a no-op)", async () => {
        // The implementation sets `this.started = true` BEFORE the empty-command
        // throw. This is intentional: a second `start()` call should NOT retry the
        // spawn (idempotent start). Pin that contract with a re-call: the second
        // call must resolve cleanly without re-throwing.
        const client = new McpClient({ name: "retry-start", command: [] });
        await expect(client.start()).rejects.toBeInstanceOf(McpError);
        // Second start must be a no-op (`started === true` already).
        await expect(client.start()).resolves.toBeUndefined();
    });
});
describe("McpClient — not-running rejection (client.ts:163)", () => {
    test("listTools() before start() → McpError 'not running'", async () => {
        const client = new McpClient({ name: "never-started", command: ["/bin/false"] });
        await expect(client.listTools()).rejects.toBeInstanceOf(McpError);
        try {
            await client.listTools();
        }
        catch (e) {
            expect(e.message).toContain("not running");
        }
    });
    test("callTool() before start() → McpError 'not running'", async () => {
        const client = new McpClient({ name: "no-start", command: ["/bin/false"] });
        await expect(client.callTool("alpha", {})).rejects.toBeInstanceOf(McpError);
    });
    test("callTool() after stop() → McpError 'not running'", async () => {
        // We can't actually start the client (would spawn a real subprocess), but
        // calling stop() on a never-started client is idempotent (also tested in
        // mcp-client.test.ts), and the post-stop callTool path is the same
        // ensureReady gate. So a stop()-then-call sequence reaches the same throw.
        const client = new McpClient({ name: "stopped", command: ["/bin/false"] });
        await client.stop(); // idempotent on never-started
        await expect(client.callTool("anything", {})).rejects.toBeInstanceOf(McpError);
        await expect(client.listTools()).rejects.toBeInstanceOf(McpError);
    });
    test("stop() on never-started client is a no-op (does not throw)", async () => {
        const client = new McpClient({ name: "noop-stop", command: ["/bin/false"] });
        await expect(client.stop()).resolves.toBeUndefined();
        // Idempotent: a second stop() is also a no-op.
        await expect(client.stop()).resolves.toBeUndefined();
    });
});
describe("McpClient — error class taxonomy", () => {
    test("McpError extends Error (so `instanceof Error` consumers continue to work)", () => {
        const e = new McpError("test");
        expect(e).toBeInstanceOf(Error);
        expect(e).toBeInstanceOf(McpError);
        expect(e.message).toBe("test");
    });
});
