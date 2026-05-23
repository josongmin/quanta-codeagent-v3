import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpClient } from "@/mcp";
/** A tiny MCP server speaking newline-delimited JSON-RPC 2.0 over stdio.
 *  Reads complete lines off stdin, answers initialize / tools/list (paginated
 *  across two pages via nextCursor) / tools/call (success + isError). Written
 *  to a temp file and spawned as the McpClient command. */
const MOCK_SERVER = `
const reply = (m) => process.stdout.write(JSON.stringify(m) + "\\n")
let buf = ""
process.stdin.on("data", (c) => {
  buf += c
  let nl
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    const msg = JSON.parse(line)
    if (msg.method === "initialize") {
      reply({ jsonrpc: "2.0", id: msg.id, result: {
        protocolVersion: "2025-06-18",
        serverInfo: { name: "mock", version: "0.0.1" },
        capabilities: { tools: {} },
      } })
    } else if (msg.method === "notifications/initialized") {
      // notification: no reply
    } else if (msg.method === "tools/list") {
      if (!msg.params || msg.params.cursor === undefined) {
        reply({ jsonrpc: "2.0", id: msg.id, result: {
          tools: [{ name: "alpha", description: "first", inputSchema: { type: "object" } }],
          nextCursor: "page2",
        } })
      } else {
        reply({ jsonrpc: "2.0", id: msg.id, result: {
          tools: [{ name: "beta" }],
        } })
      }
    } else if (msg.method === "tools/call") {
      if (msg.params.name === "boom") {
        reply({ jsonrpc: "2.0", id: msg.id, result: {
          content: [{ type: "text", text: "it failed" }],
          isError: true,
        } })
      } else if (msg.params.name === "huge") {
        // Emit a single text block far larger than the 200k client cap.
        reply({ jsonrpc: "2.0", id: msg.id, result: {
          content: [{ type: "text", text: "x".repeat(500000) }],
        } })
      } else {
        reply({ jsonrpc: "2.0", id: msg.id, result: {
          content: [
            { type: "text", text: "hello " + (msg.params.arguments.who || "world") },
            { type: "text", text: "line2" },
          ],
        } })
      }
    } else {
      reply({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } })
    }
  }
})
`;
let dir;
let serverPath;
beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mcp-it-"));
    serverPath = join(dir, "mock-server.mjs");
    await writeFile(serverPath, MOCK_SERVER);
});
afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
});
const makeClient = () => new McpClient({ name: "mock", command: [process.execPath, serverPath] });
describe("McpClient against a mock MCP server", () => {
    it("completes the start() handshake", async () => {
        const c = makeClient();
        await c.start();
        await c.start(); // idempotent
        await c.stop();
    });
    it("lists tools following nextCursor pagination", async () => {
        const c = makeClient();
        await c.start();
        const tools = await c.listTools();
        await c.stop();
        expect(tools.map((t) => t.name)).toEqual(["alpha", "beta"]);
        expect(tools[0]).toEqual({
            name: "alpha",
            description: "first",
            inputSchema: { type: "object" },
        });
        // defaults applied for the sparse second-page tool
        expect(tools[1]).toEqual({ name: "beta", description: "", inputSchema: { type: "object" } });
    });
    it("calls a tool successfully, joining text blocks", async () => {
        const c = makeClient();
        await c.start();
        const res = await c.callTool("alpha", { who: "quanta" });
        await c.stop();
        expect(res).toEqual({ ok: true, content: "hello quanta\nline2" });
    });
    it("caps an oversized tool result with a truncation marker (DOS guard)", async () => {
        const c = makeClient();
        await c.start();
        const res = await c.callTool("huge", {});
        await c.stop();
        expect(res.ok).toBe(true);
        // Capped to the 200k head + a single-line marker; never the full 500k.
        expect(res.content.length).toBeLessThan(500_000);
        expect(res.content.startsWith("x".repeat(200_000))).toBe(true);
        expect(res.content).toContain("[truncated: 300000 bytes omitted]");
    });
    it("maps isError results to ok:false", async () => {
        const c = makeClient();
        await c.start();
        const res = await c.callTool("boom", {});
        await c.stop();
        expect(res).toEqual({ ok: false, content: "it failed" });
    });
    it("stop() terminates cleanly and is idempotent", async () => {
        const c = makeClient();
        await c.start();
        await c.stop();
        await c.stop();
        await expect(c.callTool("alpha", {})).rejects.toThrow(/not running/);
    });
});
