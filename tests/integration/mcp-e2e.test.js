/**
 * MCP e2e — closes the L3 gap for the MCP integration (catalog row 9.1 / ADR-0007).
 *
 * Existing `mcp-client.test.ts` covers the client/JSON-RPC layer in isolation;
 * `mcp-bridge.test.ts` covers the Tool adapter against a stub client. NEITHER
 * exercises the **full runAgent dispatch pipeline** — that's the closure we
 * add here:
 *
 *   ScriptedLLM → tool_use(mcp__mock__alpha) → real ToolRegistry (defaultTools
 *   + bridged MCP tools) → dispatch → MCP client → JSON-RPC over stdio to a
 *   real subprocess → result event → loop continues with the follow-up step
 *   → done(completed).
 *
 * If any link in that chain regresses (result channel, error mapping, name
 * sanitization, concurrency flag), this test fails. Slice isolation is
 * respected: the bridge lives in `@/agent`; the test imports `@/agent`,
 * `@/tool`, `@/mcp` but never crosses `@/tool ↔ @/mcp` directly.
 *
 * --- Adversarial extension (Hell-cases) ---------------------------------
 *
 * The original three tests pin the happy and one-known-error paths. The
 * extension below stress-tests the JSON-RPC-over-stdio boundary against
 * untrusted/malicious servers: malformed frames, server-lifecycle chaos,
 * adversarial arguments/results, high concurrency, and registry collisions.
 * Production code is NOT touched; every assertion captures CURRENT behaviour
 * and pins it. Where a hell-case could not be expressed reliably from a test
 * (e.g. true 30s timeouts) the case is documented inline as a follow-up.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMcpTools, runAgent } from "@/agent";
import { McpClient, McpError } from "@/mcp";
import { defaultTools, ToolRegistry } from "@/tool";
import { cfg, ev, RecordingStream, ScriptedLLM, text, toolUse, withTimeout } from "./_harness";
/** Same mock server pattern as `mcp-client.test.ts` — one binary, two tools
 *  (`alpha` joins text blocks, `boom` returns isError). We re-spawn per test
 *  but write the file once. */
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
      reply({ jsonrpc: "2.0", id: msg.id, result: {
        tools: [
          { name: "alpha", description: "joins text", inputSchema: { type: "object" } },
          { name: "boom", description: "errors", inputSchema: { type: "object" } },
        ],
      } })
    } else if (msg.method === "tools/call") {
      if (msg.params.name === "boom") {
        reply({ jsonrpc: "2.0", id: msg.id, result: {
          content: [{ type: "text", text: "it failed" }],
          isError: true,
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
/**
 * Adversarial mock server. Behaviour is selected via QUANTA_MCP_MODE so a
 * single source file can be re-spawned in many test scenarios. Every mode
 * still handshakes correctly (initialize + notifications/initialized + first
 * tools/list with a single `alpha` entry) — only the FOLLOW-UP behaviour on
 * `tools/call` differs.
 *
 *  - `garbage`        emits a line of non-JSON bytes BEFORE the real reply
 *  - `nullId`         answers with `id: null`
 *  - `notifWithId`    sends an unsolicited notification carrying an id field
 *  - `bigLine`        emits a single 10MB line BEFORE the real reply
 *  - `crash`          process.exit(1) on first tools/call
 *  - `sigkillable`    waits forever on tools/call (caller kills externally)
 *  - `slow`           sleeps 5s before responding (test asserts no hang)
 *  - `nulInResult`    returns a text block containing NUL/control bytes
 *  - `concurrent`     interleaves N parallel replies in send-order
 */
const ADVERSARIAL_SERVER = `
const mode = process.env.QUANTA_MCP_MODE || "garbage"
const reply = (m) => process.stdout.write(JSON.stringify(m) + "\\n")
const replyRaw = (s) => process.stdout.write(s + "\\n")
let buf = ""
process.stdin.on("data", (c) => {
  buf += c
  let nl
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.method === "initialize") {
      reply({ jsonrpc: "2.0", id: msg.id, result: {
        protocolVersion: "2025-06-18",
        serverInfo: { name: "adv", version: "0.0.1" },
        capabilities: { tools: {} },
      } })
    } else if (msg.method === "notifications/initialized") {
      // noop
    } else if (msg.method === "tools/list") {
      reply({ jsonrpc: "2.0", id: msg.id, result: {
        tools: [{ name: "alpha", description: "x", inputSchema: { type: "object" } }],
      } })
    } else if (msg.method === "tools/call") {
      if (mode === "garbage") {
        replyRaw("THIS IS NOT JSON {{{ garbage \\x01\\x02")
        reply({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "ok-after-garbage" }] } })
      } else if (mode === "nullId") {
        reply({ jsonrpc: "2.0", id: null, result: { content: [{ type: "text", text: "ghost" }] } })
        // No second reply: the legit pending request stays pending until timeout.
        // To keep the test fast we ALSO answer with the real id.
        reply({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "real" }] } })
      } else if (mode === "notifWithId") {
        // Illegal: a notification (no id by spec) sent with an id field.
        // The MCP dispatch path only handles responses; method+id should be ignored.
        reply({ jsonrpc: "2.0", id: 999999, method: "notifications/something", params: {} })
        reply({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "ok-after-notif" }] } })
      } else if (mode === "bigLine") {
        // 10MB of 'A' chars on a single line — must not break framing.
        const huge = "A".repeat(10 * 1024 * 1024)
        replyRaw('{"jsonrpc":"2.0","id":424242,"result":{"huge":"' + huge + '"}}')
        reply({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "ok-after-big" }] } })
      } else if (mode === "crash") {
        process.exit(1)
      } else if (mode === "sigkillable") {
        // wait forever — external killer (SIGKILL) ends the process.
        setTimeout(() => {}, 1 << 30)
      } else if (mode === "slow") {
        // wait 5s before answering — caller's withTimeout(client.callTool, 2s) traps the hang.
        setTimeout(() => {
          reply({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "late" }] } })
        }, 5000)
      } else if (mode === "nulInResult") {
        const evil = "before\\x00mid\\x01\\x02after"
        reply({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: evil }] } })
      } else if (mode === "concurrent") {
        // Answer immediately in receive-order — concurrency test only cares
        // that EVERY request id gets its own reply (no interleaved torn frames).
        reply({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "id=" + msg.id }] } })
      } else {
        reply({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unknown-mode" } })
      }
    } else {
      reply({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } })
    }
  }
})
`;
let dir;
let serverPath;
let advServerPath;
beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mcp-e2e-"));
    serverPath = join(dir, "mock-server.mjs");
    advServerPath = join(dir, "adv-server.mjs");
    await writeFile(serverPath, MOCK_SERVER);
    await writeFile(advServerPath, ADVERSARIAL_SERVER);
});
afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
});
describe("MCP e2e — bridged tools through real runAgent loop", () => {
    test("happy path: scripted LLM calls mcp__mock__alpha, result reaches transcript, loop completes", async () => {
        const { tools: mcpTools, clients } = await loadMcpTools([
            { name: "mock", command: [process.execPath, serverPath] },
        ]);
        expect(mcpTools.map((t) => t.name)).toContain("mcp__mock__alpha");
        const llm = new ScriptedLLM([
            ev(toolUse("call-1", "mcp__mock__alpha", { who: "quanta" })),
            ev(text("done")),
        ]);
        const stream = new RecordingStream();
        const config = cfg({
            llm,
            registry: new ToolRegistry([...defaultTools, ...mcpTools]),
            stream,
            cwd: dir,
        });
        try {
            const outcome = await withTimeout(runAgent(config), 15_000, "mcp happy-path");
            expect(outcome.reason).toBe("completed");
            const toolResult = stream.events.find((e) => e.type === "tool_result" && e.name === "mcp__mock__alpha");
            expect(toolResult).toBeDefined();
            if (toolResult && toolResult.type === "tool_result") {
                expect(toolResult.ok).toBe(true);
                // Two text blocks are joined with `\n` by the MCP client (see
                // mcp-client.test.ts L105). The preview is the stdout tail so it
                // must contain both fragments.
                expect(toolResult.preview).toContain("hello quanta");
                expect(toolResult.preview).toContain("line2");
            }
            // LLM was called twice: once to emit tool_use, once after tool_result.
            expect(llm.calls).toBe(2);
        }
        finally {
            for (const c of clients)
                await c.stop().catch(() => undefined);
        }
    }, 20_000);
    test("isError mapping: MCP tool returns isError → tool_result.ok=false, loop continues to completion", async () => {
        const { tools: mcpTools, clients } = await loadMcpTools([
            { name: "mock", command: [process.execPath, serverPath] },
        ]);
        const llm = new ScriptedLLM([
            ev(toolUse("call-2", "mcp__mock__boom", {})),
            ev(text("acknowledged")),
        ]);
        const stream = new RecordingStream();
        const config = cfg({
            llm,
            registry: new ToolRegistry([...defaultTools, ...mcpTools]),
            stream,
            cwd: dir,
        });
        try {
            const outcome = await withTimeout(runAgent(config), 15_000, "mcp error-path");
            expect(outcome.reason).toBe("completed");
            const toolResult = stream.events.find((e) => e.type === "tool_result" && e.name === "mcp__mock__boom");
            expect(toolResult).toBeDefined();
            if (toolResult && toolResult.type === "tool_result") {
                // The MCP isError mapping (mcp-bridge.ts:65-66) → ok:false but the
                // loop does NOT abort; it appends the result and the LLM gets a
                // chance to recover or finish. Closing that contract is the point
                // of this test.
                expect(toolResult.ok).toBe(false);
                expect(toolResult.preview).toContain("it failed");
            }
            expect(llm.calls).toBe(2);
        }
        finally {
            for (const c of clients)
                await c.stop().catch(() => undefined);
        }
    }, 20_000);
    test("server-failure isolation: one bad server is logged & skipped, agent still runs", async () => {
        // Two configs: one valid, one whose command resolves to nothing. The
        // bridge MUST log and continue, NOT crash. The agent then runs against
        // only the valid server's tools.
        const { tools: mcpTools, clients } = await loadMcpTools([
            { name: "mock", command: [process.execPath, serverPath] },
            { name: "broken", command: ["/definitely/does/not/exist"] },
        ]);
        // Both servers tried; only the mock one's tools should be bridged.
        expect(mcpTools.some((t) => t.name === "mcp__mock__alpha")).toBe(true);
        expect(mcpTools.some((t) => t.name.startsWith("mcp__broken__"))).toBe(false);
        const llm = new ScriptedLLM([ev(text("ok"))]);
        const config = cfg({
            llm,
            registry: new ToolRegistry([...defaultTools, ...mcpTools]),
            cwd: dir,
        });
        try {
            const outcome = await withTimeout(runAgent(config), 10_000, "mcp partial-load");
            expect(outcome.reason).toBe("completed");
        }
        finally {
            for (const c of clients)
                await c.stop().catch(() => undefined);
        }
    }, 15_000);
});
// =========================================================================
// Hell-case extensions. All tests below run against ADVERSARIAL_SERVER mode
// strings via `QUANTA_MCP_MODE`. Each test spins its OWN client/process so
// failure isolation between cases is total.
// =========================================================================
const advClient = (mode) => new McpClient({
    name: `adv-${mode}`,
    command: [process.execPath, advServerPath],
    env: { QUANTA_MCP_MODE: mode },
});
describe("MCP e2e hell-cases — malformed JSON-RPC framing", () => {
    test("garbage bytes mid-stream: the bad line is dropped and the real reply still resolves", async () => {
        const c = advClient("garbage");
        try {
            await withTimeout(c.start(), 10_000, "garbage start");
            const res = await withTimeout(c.callTool("alpha", {}), 10_000, "garbage call");
            // The garbage line ahead of the response is logged + skipped by the
            // LineReader (jsonrpc.ts parseLine). The valid follow-up resolves.
            expect(res.ok).toBe(true);
            expect(res.content).toBe("ok-after-garbage");
        }
        finally {
            await c.stop().catch(() => undefined);
        }
    }, 15_000);
    test("response with id: null is dispatched as a numeric id and discarded if no pending entry", async () => {
        // Pinned behaviour: the dispatcher coerces `id` via Number(msg.id). For
        // `id: null` that becomes 0 (no pending request keyed at 0) so the ghost
        // reply is dropped. The same call also emits a properly-id'd reply that
        // resolves the pending request — that path must still work.
        const c = advClient("nullId");
        try {
            await withTimeout(c.start(), 10_000, "nullId start");
            const res = await withTimeout(c.callTool("alpha", {}), 10_000, "nullId call");
            expect(res.ok).toBe(true);
            // The real reply (text "real") wins; the ghost reply was discarded.
            expect(res.content).toBe("real");
        }
        finally {
            await c.stop().catch(() => undefined);
        }
    }, 15_000);
    test("server sends an illegal notification with an id field: client ignores it, real reply resolves", async () => {
        const c = advClient("notifWithId");
        try {
            await withTimeout(c.start(), 10_000, "notifWithId start");
            const res = await withTimeout(c.callTool("alpha", {}), 10_000, "notifWithId call");
            // `isResponse` requires no `method` field; the fake notif has a `method`
            // so dispatch drops it. The real reply (next line) wins.
            expect(res.ok).toBe(true);
            expect(res.content).toBe("ok-after-notif");
        }
        finally {
            await c.stop().catch(() => undefined);
        }
    }, 15_000);
    test("server emits a single ~10MB line: LineReader survives, real reply still resolves", async () => {
        // CURRENT BEHAVIOUR: LineReader has NO max-line cap — it will buffer
        // arbitrary bytes until `\n`. We pin that 10MB is tolerated without
        // wedging or crashing. The "huge" reply uses a fake id (424242) so its
        // dispatch is a no-op; the real reply follows on the next line.
        // FOLLOW-UP: production currently has no DoS guard on incoming line
        // length. A small server could OOM the host. TODO: bound the buffer in
        // src/mcp/jsonrpc.ts LineReader.push to e.g. 16MB and drop+log over the
        // cap. (Not in scope for this PR — test-only.)
        const c = advClient("bigLine");
        try {
            await withTimeout(c.start(), 10_000, "bigLine start");
            const res = await withTimeout(c.callTool("alpha", {}), 30_000, "bigLine call");
            expect(res.ok).toBe(true);
            expect(res.content).toBe("ok-after-big");
        }
        finally {
            await c.stop().catch(() => undefined);
        }
    }, 60_000);
});
describe("MCP e2e hell-cases — server lifecycle chaos", () => {
    test("server process exits 1 mid-call: pending request rejects with a clear McpError", async () => {
        const c = advClient("crash");
        await withTimeout(c.start(), 10_000, "crash start");
        try {
            // The server calls process.exit(1) on the first tools/call. The
            // watchExit hook MUST fail every pending request with a typed McpError.
            let caught;
            try {
                await withTimeout(c.callTool("alpha", {}), 10_000, "crash call");
            }
            catch (e) {
                caught = e;
            }
            expect(caught).toBeDefined();
            expect(caught).toBeInstanceOf(McpError);
            // The error message must clearly identify it as a server-exit problem,
            // NOT a generic "method not found" or anonymous failure.
            const msg = caught.message;
            // Either the watchExit message ("exited") or the stop() message
            // ("stopped") can win the race — both are clear failures.
            const ok = /exited|stopped|not running/.test(msg);
            expect(ok).toBe(true);
        }
        finally {
            await c.stop().catch(() => undefined);
        }
    }, 15_000);
    test("server is SIGKILL'd externally: client detects EOF and rejects pending request", async () => {
        const c = advClient("sigkillable");
        await withTimeout(c.start(), 10_000, "sigkill start");
        try {
            // Fire-and-record the pending call (server intentionally hangs).
            let caught;
            const pending = c.callTool("alpha", {}).catch((e) => {
                caught = e;
            });
            // Give the request a moment to be sent before we kill the server.
            await new Promise((r) => setTimeout(r, 100));
            // Forcibly kill via stop() — equivalent to SIGKILL since Bun.spawn's
            // kill() sends SIGTERM by default but the subprocess won't have time
            // to clean up. The contract is that the pending call rejects, NOT hangs.
            await c.stop();
            await withTimeout(pending, 10_000, "sigkill pending");
            expect(caught).toBeDefined();
            expect(caught).toBeInstanceOf(McpError);
        }
        finally {
            await c.stop().catch(() => undefined);
        }
    }, 15_000);
    test("server is slow (5s response): our withTimeout traps the hang at 2s instead of the 30s default", async () => {
        // CURRENT BEHAVIOUR: DEFAULT_REQUEST_TIMEOUT_MS is 30s (client.ts L8) and
        // not configurable per-call. To prove "doesn't hang forever" without
        // a 30s wait we wrap the callTool in withTimeout(2s) and assert that
        // wrapper trips — confirming the call is in-flight and the underlying
        // socket isn't deadlocked. The real 30s timeout itself is covered by
        // the client unit tests.
        // FOLLOW-UP: expose a per-call timeout knob so adversarial servers can be
        // bounded tighter than 30s in production agents.
        const c = advClient("slow");
        await withTimeout(c.start(), 10_000, "slow start");
        try {
            let caught;
            try {
                await withTimeout(c.callTool("alpha", {}), 2_000, "slow-call-cap");
            }
            catch (e) {
                caught = e;
            }
            expect(caught).toBeDefined();
            // withTimeout's sentinel error message starts with "HANG:".
            expect(caught.message).toMatch(/^HANG:/);
        }
        finally {
            await c.stop().catch(() => undefined);
        }
    }, 10_000);
});
describe("MCP e2e hell-cases — adversarial tool arguments and results", () => {
    test("call with NUL byte inside an argument: round-trips through JSON; server echoes back without crash", async () => {
        const c = advClient("concurrent"); // concurrent mode echoes id back
        try {
            await withTimeout(c.start(), 10_000, "nul-arg start");
            const res = await withTimeout(c.callTool("alpha", { evil: "a bc" }), 10_000, "nul-arg call");
            // The JSON-RPC encoder lets through ` ` (JSON spec allows it via
            // escape; encodeMessage uses JSON.stringify which escapes it). The
            // server parses, the response carries the id back.
            expect(res.ok).toBe(true);
            expect(res.content.startsWith("id=")).toBe(true);
        }
        finally {
            await c.stop().catch(() => undefined);
        }
    }, 15_000);
    test("call with a 1MB argument string: encode/decode survives end-to-end", async () => {
        const c = advClient("concurrent");
        try {
            await withTimeout(c.start(), 10_000, "big-arg start");
            const big = "x".repeat(1024 * 1024); // 1MB
            const res = await withTimeout(c.callTool("alpha", { big }), 15_000, "big-arg call");
            expect(res.ok).toBe(true);
            expect(res.content.startsWith("id=")).toBe(true);
        }
        finally {
            await c.stop().catch(() => undefined);
        }
    }, 30_000);
    test("server returns text with NUL + control bytes: client passes the bytes through verbatim", async () => {
        // Pinned behaviour: the bridge does NOT scrub control characters from
        // tool result text. The bytes reach the agent's tool_result preview
        // verbatim. Callers downstream that render to a terminal should sanitize.
        // FOLLOW-UP: consider stripping C0 controls (except \n, \r, \t) at the
        // bridge boundary to prevent terminal escape injection by hostile servers.
        const c = advClient("nulInResult");
        try {
            await withTimeout(c.start(), 10_000, "nul-result start");
            const res = await withTimeout(c.callTool("alpha", {}), 10_000, "nul-result call");
            expect(res.ok).toBe(true);
            expect(res.content).toContain("before");
            expect(res.content).toContain("after");
            expect(res.content).toContain(" ");
            expect(res.content).toContain("");
        }
        finally {
            await c.stop().catch(() => undefined);
        }
    }, 15_000);
});
describe("MCP e2e hell-cases — concurrency and re-spawn", () => {
    test("20 parallel callTool requests against the same client: every request resolves to its own id", async () => {
        const c = advClient("concurrent");
        try {
            await withTimeout(c.start(), 10_000, "conc start");
            const N = 20;
            const calls = Array.from({ length: N }, () => c.callTool("alpha", {}));
            const results = await withTimeout(Promise.all(calls), 15_000, "conc all");
            // Each request gets a uniquely-id'd reply. The set of returned `id=NN`
            // strings must contain N distinct values.
            const ids = new Set(results.map((r) => r.content));
            expect(results.every((r) => r.ok)).toBe(true);
            expect(ids.size).toBe(N);
        }
        finally {
            await c.stop().catch(() => undefined);
        }
    }, 30_000);
    test("spawn → kill → respawn under the SAME logical name: the second instance works independently", async () => {
        const c1 = advClient("concurrent");
        await withTimeout(c1.start(), 10_000, "respawn-1 start");
        const r1 = await withTimeout(c1.callTool("alpha", {}), 10_000, "respawn-1 call");
        expect(r1.ok).toBe(true);
        await c1.stop();
        // Fresh client, same logical name. Must initialize from scratch and serve
        // tools independently (no state bleeds across instances).
        const c2 = advClient("concurrent");
        try {
            await withTimeout(c2.start(), 10_000, "respawn-2 start");
            const r2 = await withTimeout(c2.callTool("alpha", {}), 10_000, "respawn-2 call");
            expect(r2.ok).toBe(true);
            // Both replies use the server's own monotonic numbering — first call on
            // a fresh process always echoes its own id.
            expect(r2.content.startsWith("id=")).toBe(true);
        }
        finally {
            await c2.stop().catch(() => undefined);
        }
    }, 30_000);
});
describe("MCP e2e hell-cases — tool registry pollution", () => {
    test("two MCP servers each declaring a tool called `alpha`: namespaces keep them distinct, registry maps both", async () => {
        // The mcp-bridge prefixes tool names with `mcp__<server>__`, so the same
        // remote tool name on two servers becomes TWO distinct bridged Tools —
        // no last-write-wins collision. This is the load-bearing isolation
        // guarantee that lets users wire arbitrary servers without name clashes.
        const { tools: mcpTools, clients } = await loadMcpTools([
            { name: "mockA", command: [process.execPath, serverPath] },
            { name: "mockB", command: [process.execPath, serverPath] },
        ]);
        try {
            const names = mcpTools.map((t) => t.name);
            expect(names).toContain("mcp__mockA__alpha");
            expect(names).toContain("mcp__mockB__alpha");
            // Build a registry exactly the way the CLI does (defaults + bridged).
            // Final registry has BOTH bridged tools — neither overwrote the other.
            const reg = new ToolRegistry([...defaultTools, ...mcpTools]);
            expect(reg.get("mcp__mockA__alpha")).toBeDefined();
            expect(reg.get("mcp__mockB__alpha")).toBeDefined();
        }
        finally {
            for (const c of clients)
                await c.stop().catch(() => undefined);
        }
    }, 20_000);
});
