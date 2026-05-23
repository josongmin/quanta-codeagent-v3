import { pathToFileURL } from "node:url";
import { logger } from "@/shared";
import { encodeMessage, MessageReader, } from "./jsonrpc";
/** A JSON-RPC error raised by a server response. Preserves the wire `code`
 *  so call sites can distinguish "method not supported" (-32601) from other
 *  failures without re-parsing the message. */
export class LspRequestError extends Error {
    code;
    data;
    constructor(method, err) {
        super(`LSP error in "${method}": ${err.message}`);
        this.name = "LspRequestError";
        this.code = err.code;
        if (err.data !== undefined)
            this.data = err.data;
    }
}
/** LSP `SymbolKind` numeric → our string union. Anything off-spec → "unknown". */
const SYMBOL_KIND = {
    1: "file",
    2: "module",
    3: "namespace",
    4: "package",
    5: "class",
    6: "method",
    7: "property",
    8: "field",
    9: "constructor",
    10: "enum",
    11: "interface",
    12: "function",
    13: "variable",
    14: "constant",
    15: "string",
    16: "number",
    17: "boolean",
    18: "array",
    19: "object",
    20: "key",
    21: "null",
    22: "enum_member",
    23: "struct",
    24: "event",
    25: "operator",
    26: "type_parameter",
};
const toSymbolKind = (n) => SYMBOL_KIND[n] ?? "unknown";
/** Detect a "method not supported" JSON-RPC error so the nav RPCs can surface
 *  `null` (capability missing) instead of throwing — per the LspPort contract. */
const isUnsupportedError = (e) => {
    if (!(e instanceof LspRequestError))
        return false;
    if (e.code === -32601 || e.code === -32602)
        return true;
    const m = e.message.toLowerCase();
    return m.includes("not supported") || m.includes("unsupported");
};
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
const SEVERITY = {
    1: "error",
    2: "warning",
    3: "information",
    4: "hint",
};
const toPos = (p) => ({
    line: p.line,
    character: p.character,
});
const mapDiagnostic = (uri, d) => ({
    uri,
    severity: SEVERITY[d.severity ?? 1] ?? "error",
    message: d.message,
    range: { start: toPos(d.range.start), end: toPos(d.range.end) },
    ...(d.source !== undefined ? { source: d.source } : {}),
    ...(d.code !== undefined ? { code: String(d.code) } : {}),
});
const toRange = (r) => ({ start: toPos(r.start), end: toPos(r.end) });
const toLocation = (l) => ({ uri: l.uri, range: toRange(l.range) });
/** Map a single hit from `definition`/`typeDefinition`/`implementation`. The
 *  server may emit either a `Location` (uri+range) or a `LocationLink`
 *  (target* fields). `LocationLink.targetSelectionRange` — when present — is
 *  the tighter "navigate-to" range; we prefer it over `targetRange`. */
const toLocationOrLink = (l) => {
    if ("uri" in l)
        return toLocation(l);
    return { uri: l.targetUri, range: toRange(l.targetSelectionRange ?? l.targetRange) };
};
const isRawRange = (v) => "start" in v && "end" in v;
const flattenMarkedString = (m) => (typeof m === "string" ? m : m.value);
const isMarkupContent = (c) => !Array.isArray(c) && typeof c === "object" && "kind" in c && "value" in c;
/** Reduce the union `MarkupContent | MarkedString | MarkedString[]` to a
 *  single string. `MarkedString` arrays are newline-joined; legacy
 *  `{language, value}` entries surface their `value` only (we drop the
 *  language tag since downstream tools render the text untyped). */
const flattenHoverContents = (c) => {
    if (typeof c === "string")
        return c;
    if (Array.isArray(c))
        return c.map(flattenMarkedString).join("\n");
    if (isMarkupContent(c))
        return c.value;
    return flattenMarkedString(c);
};
const isSymbolInformationList = (list) => {
    const first = list[0];
    return first !== undefined && "location" in first;
};
/** Map an LSP `SymbolInformation`. The legacy form has no separate
 *  selectionRange, so we mirror `range` into both per the type contract. */
const mapSymbolInformation = (s) => {
    const range = toRange(s.location.range);
    return {
        name: s.name,
        kind: toSymbolKind(s.kind),
        range,
        selectionRange: range,
        uri: s.location.uri,
        ...(s.containerName !== undefined ? { containerName: s.containerName } : {}),
    };
};
/** Recursive walk of nested `DocumentSymbol` trees into a flat list.
 *  `containerName` is propagated to children as their parent's name; the
 *  owning file URI is stamped on every entry. */
const flattenDocumentSymbol = (s, uri, parentName, out) => {
    out.push({
        name: s.name,
        kind: toSymbolKind(s.kind),
        range: toRange(s.range),
        selectionRange: toRange(s.selectionRange),
        uri,
        ...(parentName !== undefined ? { containerName: parentName } : {}),
    });
    if (s.children) {
        for (const child of s.children)
            flattenDocumentSymbol(child, uri, s.name, out);
    }
};
/** Map either form of workspace symbol entry into our normalized shape.
 *  `WorkspaceSymbol` is the newer (>=3.17) form that may omit `range`; in
 *  that case we use a zero-width range at the document origin since we have
 *  no better signal without resolving the symbol. */
const mapWorkspaceSymbolEntry = (s) => {
    const rawRange = s.location.range;
    const range = rawRange
        ? toRange(rawRange)
        : { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
    return {
        name: s.name,
        kind: toSymbolKind(s.kind),
        range,
        selectionRange: range,
        uri: s.location.uri,
        ...(s.containerName !== undefined ? { containerName: s.containerName } : {}),
    };
};
const isResponse = (m) => "id" in m && !("method" in m);
const isNotification = (m) => "method" in m && !("id" in m);
/** A real LSP client over stdio, parameterised by an {@link LspClientSpec}.
 *
 *  Lifecycle: spawn → `initialize` → `initialized` → (per file)
 *  `textDocument/didOpen` then await `textDocument/publishDiagnostics` →
 *  `shutdown` → `exit` → kill. Requests are correlated by an incrementing id
 *  with per-request timeouts; all pending work is rejected if the process
 *  dies, so there are never unhandled rejections or leaked timers. */
export class LspClient {
    command;
    cwd;
    requestTimeoutMs;
    spec;
    proc = null;
    reader = new MessageReader();
    nextId = 1;
    pending = new Map();
    diagnosticsByUri = new Map();
    diagnosticsWaiters = new Map();
    /** URIs that have been opened via `textDocument/didOpen`. Used to dedup
     *  re-opens across multiple nav calls on the same file, and to drive the
     *  matching `didClose` on `stop()`. */
    opened = new Set();
    readPump = null;
    stopped = false;
    exited = false;
    serverInfo = null;
    constructor(spec, options = {}) {
        this.spec = spec;
        this.command = options.command ?? spec.defaultCommand;
        this.cwd = options.cwd ?? process.cwd();
        this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    }
    async start() {
        if (this.proc)
            return;
        this.proc = Bun.spawn(this.command, {
            cwd: this.cwd,
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
        });
        this.readPump = this.pumpStdout();
        this.watchExit();
        const init = (await this.sendRequest("initialize", {
            processId: process.pid,
            clientInfo: { name: "quanta-codeagent", version: "0.1.0" },
            rootUri: pathToFileURL(this.cwd).href,
            capabilities: {
                textDocument: {
                    publishDiagnostics: { relatedInformation: false },
                    synchronization: { didSave: false, dynamicRegistration: false },
                },
            },
        }));
        if (init.serverInfo) {
            this.serverInfo = {
                name: init.serverInfo.name,
                ...(init.serverInfo.version !== undefined ? { version: init.serverInfo.version } : {}),
            };
        }
        this.sendNotification("initialized", {});
    }
    async diagnostics(filePath) {
        if (!this.proc)
            throw new Error("LspClient.diagnostics called before start()");
        const uri = pathToFileURL(filePath).href;
        const text = await this.readFileText(filePath);
        this.diagnosticsByUri.delete(uri);
        const arrival = this.waitForDiagnostics(uri);
        this.sendNotification("textDocument/didOpen", {
            textDocument: { uri, languageId: this.spec.languageIdFor(filePath), version: 1, text },
        });
        const diags = await arrival;
        this.sendNotification("textDocument/didClose", { textDocument: { uri } });
        return diags;
    }
    // --- Nav RPC -----------------------------------------------------------
    // Each method:
    //   1. Lazily opens the document (idempotent via {@link opened})
    //   2. Issues the LSP request via {@link sendRequest}
    //   3. Normalizes the wire shape to our `@/lsp/types`
    //   4. Returns `null` for server `null` / "method not supported" results
    // Errors other than "unsupported" (timeout, transport) propagate to the
    // caller — the tool layer decides whether to degrade.
    async definition(filePath, pos) {
        return this.navLocations(filePath, "textDocument/definition", pos);
    }
    async references(filePath, pos, includeDeclaration) {
        const uri = await this.ensureOpen(filePath);
        const raw = await this.callOrNullOnUnsupported("textDocument/references", {
            textDocument: { uri },
            position: pos,
            context: { includeDeclaration },
        });
        if (raw === null || raw === undefined)
            return null;
        if (!Array.isArray(raw))
            return null;
        return raw.map(toLocation);
    }
    async hover(filePath, pos) {
        const uri = await this.ensureOpen(filePath);
        const raw = await this.callOrNullOnUnsupported("textDocument/hover", {
            textDocument: { uri },
            position: pos,
        });
        if (raw === null || raw === undefined)
            return null;
        const h = raw;
        const contents = flattenHoverContents(h.contents);
        return h.range !== undefined ? { contents, range: toRange(h.range) } : { contents };
    }
    async typeDefinition(filePath, pos) {
        return this.navLocations(filePath, "textDocument/typeDefinition", pos);
    }
    async implementation(filePath, pos) {
        return this.navLocations(filePath, "textDocument/implementation", pos);
    }
    async documentSymbol(filePath) {
        const uri = await this.ensureOpen(filePath);
        const raw = (await this.callOrNullOnUnsupported("textDocument/documentSymbol", {
            textDocument: { uri },
        }));
        if (raw === null || raw === undefined)
            return null;
        if (!Array.isArray(raw) || raw.length === 0)
            return [];
        if (isSymbolInformationList(raw))
            return raw.map((s) => mapSymbolInformation(s));
        const out = [];
        for (const s of raw)
            flattenDocumentSymbol(s, uri, undefined, out);
        return out;
    }
    async workspaceSymbol(query) {
        const raw = (await this.callOrNullOnUnsupported("workspace/symbol", {
            query,
        }));
        if (raw === null || raw === undefined)
            return null;
        if (!Array.isArray(raw))
            return null;
        if (raw.length === 0)
            return [];
        return raw.map(mapWorkspaceSymbolEntry);
    }
    async prepareRename(filePath, pos) {
        const uri = await this.ensureOpen(filePath);
        const raw = (await this.callOrNullOnUnsupported("textDocument/prepareRename", {
            textDocument: { uri },
            position: pos,
        }));
        if (raw === null || raw === undefined)
            return null;
        if (isRawRange(raw))
            return { range: toRange(raw), placeholder: "" };
        if (raw.defaultBehavior === true)
            return null;
        if (raw.range === undefined)
            return null;
        return { range: toRange(raw.range), placeholder: raw.placeholder ?? "" };
    }
    async stop() {
        if (this.stopped)
            return;
        this.stopped = true;
        const proc = this.proc;
        // Close every doc we lazily opened so the server's per-URI state is freed
        // even if the caller never explicitly closed. Done before shutdown so the
        // server is still alive to accept the notifications.
        for (const uri of this.opened) {
            this.sendNotification("textDocument/didClose", { textDocument: { uri } });
        }
        this.opened.clear();
        if (!proc)
            return;
        try {
            if (!this.exited) {
                await this.sendRequest("shutdown", null).catch(() => undefined);
                this.sendNotification("exit", undefined);
            }
        }
        finally {
            this.failAllPending(new Error("LSP server stopped"));
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
    }
    // --- internals -----------------------------------------------------------
    waitForDiagnostics(uri) {
        const existing = this.diagnosticsByUri.get(uri);
        if (existing)
            return Promise.resolve(existing);
        return new Promise((resolve) => {
            const waiters = this.diagnosticsWaiters.get(uri) ?? [];
            let settled = false;
            const settle = (d) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                resolve(d);
            };
            const timer = setTimeout(() => {
                // No publish within the bound: treat as "no diagnostics" rather than
                // hang. Servers emit an empty array for clean files, but a timeout is
                // the safety net if a notification is somehow missed.
                settle(this.diagnosticsByUri.get(uri) ?? []);
            }, this.requestTimeoutMs);
            waiters.push(settle);
            this.diagnosticsWaiters.set(uri, waiters);
        });
    }
    /** Send a JSON-RPC request and resolve with the server's `result`.
     *
     *  Protected to support an in-process test seam: a subclass can override
     *  this to inject canned responses without spawning a real server. Default
     *  implementation correlates by id, bounds the wait by `requestTimeoutMs`,
     *  and rejects with {@link LspRequestError} when the server returns an
     *  error (so callers can inspect the JSON-RPC code). */
    sendRequest(method, params) {
        const id = this.nextId++;
        const payload = params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params };
        return new Promise((resolve, reject) => {
            // Lifecycle guard: if the server has already exited or we've stopped,
            // reject immediately instead of registering a pending entry whose
            // `send()` would silently no-op (stdin gone) and only fail on timeout —
            // a needless `requestTimeoutMs` hang. Mirrors McpClient.request().
            // `shutdown` is exempt: stop() issues it after setting `stopped`.
            if ((this.exited || this.stopped) && method !== "shutdown") {
                reject(new Error(`LSP request "${method}" issued after server stopped/exited`));
                return;
            }
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`LSP request "${method}" timed out after ${this.requestTimeoutMs}ms`));
            }, this.requestTimeoutMs);
            this.pending.set(id, { resolve, reject, timer, method });
            this.send(payload);
        });
    }
    /** Send a JSON-RPC notification. Same test-seam rationale as
     *  {@link sendRequest}: subclasses may override to capture sent messages. */
    sendNotification(method, params) {
        const payload = params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params };
        this.send(payload);
    }
    /** Read the on-disk text for a document we're about to `didOpen`. Protected
     *  so tests can inject synthetic contents without touching the filesystem. */
    readFileText(filePath) {
        return Bun.file(filePath).text();
    }
    /** Idempotent `textDocument/didOpen`. The URI is added to {@link opened}
     *  on first call so subsequent nav RPCs on the same file skip the open. */
    async ensureOpen(filePath) {
        const uri = pathToFileURL(filePath).href;
        if (this.opened.has(uri))
            return uri;
        const text = await this.readFileText(filePath);
        this.sendNotification("textDocument/didOpen", {
            textDocument: { uri, languageId: this.spec.languageIdFor(filePath), version: 1, text },
        });
        this.opened.add(uri);
        return uri;
    }
    /** Issue a request and convert "method not supported" errors to a `null`
     *  result. Other errors (timeout, transport, malformed params caught by the
     *  server with a non-unsupported code) are re-thrown. */
    async callOrNullOnUnsupported(method, params) {
        try {
            return await this.sendRequest(method, params);
        }
        catch (e) {
            if (isUnsupportedError(e))
                return null;
            throw e;
        }
    }
    /** Shared body for `definition` / `typeDefinition` / `implementation`. All
     *  three return the same wire-level union (`Location | Location[] |
     *  LocationLink[] | null`), normalized here to `Location[] | null`. */
    async navLocations(filePath, method, pos) {
        const uri = await this.ensureOpen(filePath);
        const raw = (await this.callOrNullOnUnsupported(method, {
            textDocument: { uri },
            position: pos,
        }));
        if (raw === null || raw === undefined)
            return null;
        if (Array.isArray(raw)) {
            if (raw.length === 0)
                return [];
            return raw.map(toLocationOrLink);
        }
        return [toLocation(raw)];
    }
    send(payload) {
        const stdin = this.proc?.stdin;
        if (!stdin)
            return;
        try {
            stdin.write(encodeMessage(payload));
        }
        catch (e) {
            logger.warn("lsp: failed to write to server stdin", { error: String(e) });
        }
    }
    async pumpStdout() {
        const stdout = this.proc?.stdout;
        if (!stdout)
            return;
        try {
            for await (const chunk of stdout) {
                for (const msg of this.reader.push(chunk)) {
                    this.dispatch(msg);
                }
            }
        }
        catch (e) {
            logger.debug("lsp: stdout pump ended", { error: String(e) });
        }
    }
    dispatch(msg) {
        if (isResponse(msg)) {
            this.resolvePending(msg);
            return;
        }
        if (isNotification(msg) && msg.method === "textDocument/publishDiagnostics") {
            this.onPublishDiagnostics(msg.params);
        }
    }
    resolvePending(msg) {
        const id = typeof msg.id === "number" ? msg.id : Number(msg.id);
        const entry = this.pending.get(id);
        if (!entry)
            return;
        this.pending.delete(id);
        clearTimeout(entry.timer);
        if (msg.error) {
            entry.reject(new LspRequestError(entry.method, msg.error));
        }
        else {
            entry.resolve(msg.result);
        }
    }
    onPublishDiagnostics(params) {
        const p = params;
        if (!p || typeof p.uri !== "string" || !Array.isArray(p.diagnostics))
            return;
        const mapped = p.diagnostics.map((d) => mapDiagnostic(p.uri, d));
        this.diagnosticsByUri.set(p.uri, mapped);
        const waiters = this.diagnosticsWaiters.get(p.uri);
        if (waiters && waiters.length > 0) {
            this.diagnosticsWaiters.delete(p.uri);
            for (const w of waiters)
                w(mapped);
        }
    }
    watchExit() {
        const proc = this.proc;
        if (!proc)
            return;
        proc.exited
            .then(() => {
            this.exited = true;
            this.failAllPending(new Error("LSP server exited"));
        })
            .catch(() => {
            this.exited = true;
            this.failAllPending(new Error("LSP server exited"));
        });
    }
    failAllPending(reason) {
        for (const [, entry] of this.pending) {
            clearTimeout(entry.timer);
            entry.reject(reason);
        }
        this.pending.clear();
        // Unblock any diagnostics waiters with an empty result so callers that
        // raced a shutdown resolve instead of hanging forever.
        for (const [, waiters] of this.diagnosticsWaiters) {
            for (const w of waiters)
                w([]);
        }
        this.diagnosticsWaiters.clear();
    }
}
