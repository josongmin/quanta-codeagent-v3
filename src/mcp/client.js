import { logger, QuantaError } from "@/shared";
import { encodeMessage, isResponse, LineReader } from "./jsonrpc";
const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "quanta", version: "0.1.0" };
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Max chars of joined tool-result text we hand back from `callTool`. A
 *  malicious/buggy MCP server returning a huge text blob would otherwise flow
 *  unbounded into memory and the model prompt (DOS). Mirrors the repo-wide
 *  tool-output cap (`@/tool` `output-spill.ts` `DEFAULT_TOOL_OUTPUT_MAX =
 *  200_000`); kept as a local constant because `@/mcp` may not import `@/tool`
 *  (slice isolation, RFC §3.1). Sub-cap results are returned byte-identical. */
const MAX_RESULT_CHARS = 200_000;
/** Typed MCP failure. Stable code lets callers branch without string matching. */
export class McpError extends QuantaError {
    constructor(message, options) {
        super("mcp", message, options);
    }
}
const mapTool = (t) => ({
    name: t.name,
    description: t.description ?? "",
    inputSchema: t.inputSchema ?? { type: "object" },
});
const joinTextBlocks = (content) => (content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text ?? "")
    .join("\n");
/** Bound the joined text to {@link MAX_RESULT_CHARS}. Sub-cap input is returned
 *  by reference (byte-identical, no allocation). Over-cap input is truncated to
 *  the head with a clear `[truncated: N bytes omitted]` marker so the model and
 *  any downstream caller can see the result was clipped. */
const capResultText = (text) => {
    if (text.length <= MAX_RESULT_CHARS)
        return text;
    const omitted = text.length - MAX_RESULT_CHARS;
    return `${text.slice(0, MAX_RESULT_CHARS)}\n[truncated: ${omitted} bytes omitted]`;
};
/** Build the spawn env. The full parent env is intentionally NOT inherited so
 *  host secrets never reach an arbitrary server; only PATH is kept so the
 *  command resolves, plus anything the config explicitly opted in. */
const buildEnv = (configEnv) => {
    const base = {};
    const path = process.env.PATH;
    if (path !== undefined)
        base.PATH = path;
    return configEnv === undefined ? base : { ...base, ...configEnv };
};
/** A real MCP client speaking newline-delimited JSON-RPC 2.0 over stdio.
 *
 *  Lifecycle: spawn → `initialize` → `notifications/initialized` → ready →
 *  `tools/list` / `tools/call` → `stop()`. Requests are correlated by an
 *  incrementing id with a per-request timeout; every pending request is
 *  rejected if the process exits, so there are never leaked timers or
 *  unhandled rejections. `stop()` is idempotent. */
export class McpClient {
    config;
    requestTimeoutMs;
    proc = null;
    reader = new LineReader();
    nextId = 1;
    pending = new Map();
    readPump = null;
    started = false;
    stopped = false;
    exited = false;
    constructor(config) {
        this.config = config;
        this.requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;
    }
    async start() {
        if (this.started)
            return;
        this.started = true;
        if (this.config.command.length === 0) {
            throw new McpError(`mcp server "${this.config.name}" has empty command`);
        }
        this.proc = Bun.spawn(this.config.command, {
            cwd: this.config.cwd ?? process.cwd(),
            env: buildEnv(this.config.env),
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
        });
        this.readPump = this.pumpStdout();
        this.watchExit();
        await this.request("initialize", {
            protocolVersion: PROTOCOL_VERSION,
            clientInfo: CLIENT_INFO,
            capabilities: {},
        });
        this.notify("notifications/initialized", {});
    }
    async listTools() {
        this.ensureReady();
        const tools = [];
        let cursor;
        do {
            const params = cursor === undefined ? {} : { cursor };
            const res = (await this.request("tools/list", params));
            for (const t of res.tools ?? [])
                tools.push(mapTool(t));
            cursor = res.nextCursor;
        } while (cursor !== undefined && cursor !== "");
        return tools;
    }
    async callTool(name, args) {
        this.ensureReady();
        const res = (await this.request("tools/call", {
            name,
            arguments: args ?? {},
        }));
        return {
            ok: res.isError !== true,
            content: capResultText(joinTextBlocks(res.content)),
        };
    }
    async stop() {
        if (this.stopped)
            return;
        this.stopped = true;
        const proc = this.proc;
        if (!proc)
            return;
        this.failAllPending(new McpError(`mcp server "${this.config.name}" stopped`));
        try {
            proc.stdin?.end();
        }
        catch {
            // stdin may already be closed
        }
        try {
            proc.kill();
        }
        catch {
            // process may have already exited
        }
        await proc.exited.catch(() => undefined);
        await this.readPump?.catch(() => undefined);
        this.proc = null;
    }
    // --- internals -----------------------------------------------------------
    ensureReady() {
        if (!this.started || this.stopped || !this.proc) {
            throw new McpError(`mcp server "${this.config.name}" is not running`);
        }
    }
    request(method, params) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            if (this.stopped || this.exited) {
                reject(new McpError(`mcp server "${this.config.name}" is not running`));
                return;
            }
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new McpError(`mcp request "${method}" timed out after ${this.requestTimeoutMs}ms`));
            }, this.requestTimeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.send({ jsonrpc: "2.0", id, method, params });
        });
    }
    notify(method, params) {
        this.send({ jsonrpc: "2.0", method, params });
    }
    send(payload) {
        const stdin = this.proc?.stdin;
        if (!stdin)
            return;
        try {
            stdin.write(encodeMessage(payload));
        }
        catch (e) {
            logger.warn("mcp: failed to write to server stdin", { error: String(e) });
        }
    }
    async pumpStdout() {
        const stdout = this.proc?.stdout;
        if (!stdout)
            return;
        try {
            for await (const chunk of stdout) {
                for (const msg of this.reader.push(chunk))
                    this.dispatch(msg);
            }
        }
        catch (e) {
            logger.debug("mcp: stdout pump ended", { error: String(e) });
        }
    }
    dispatch(msg) {
        if (!isResponse(msg))
            return;
        const id = typeof msg.id === "number" ? msg.id : Number(msg.id);
        const entry = this.pending.get(id);
        if (!entry)
            return;
        this.pending.delete(id);
        clearTimeout(entry.timer);
        if (msg.error) {
            entry.reject(new McpError(`mcp error ${msg.error.code}: ${msg.error.message}`));
        }
        else {
            entry.resolve(msg.result);
        }
    }
    watchExit() {
        const proc = this.proc;
        if (!proc)
            return;
        const onExit = () => {
            this.exited = true;
            this.failAllPending(new McpError(`mcp server "${this.config.name}" exited`));
        };
        proc.exited.then(onExit).catch(onExit);
    }
    failAllPending(reason) {
        for (const [, entry] of this.pending) {
            clearTimeout(entry.timer);
            entry.reject(reason);
        }
        this.pending.clear();
    }
}
