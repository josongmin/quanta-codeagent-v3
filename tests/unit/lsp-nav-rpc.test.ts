import { describe, expect, test } from "bun:test"
import { pathToFileURL } from "node:url"
import type { LspClientOptions, LspClientSpec } from "@/lsp"
import { LspClient } from "@/lsp"
import { LspRequestError } from "@/lsp/adapters/base"
import type { JsonRpcError } from "@/lsp/adapters/jsonrpc"

/** Recorded outbound message — either a JSON-RPC request (has params, awaits
 *  a result) or a notification (fire-and-forget). The test asserts against
 *  this log to confirm wire methods, didOpen dedup, and didClose-on-stop. */
type SentRequest = { kind: "request"; method: string; params: unknown }
type SentNotification = { kind: "notify"; method: string; params: unknown }
type Sent = SentRequest | SentNotification

/** Canned response from the fake server. `result` is the wire `result` value
 *  the test wants the LSP method to consume; `error` reproduces a JSON-RPC
 *  error (with a `code` so the "unsupported" detection branch can be tested). */
type Reply = { result: unknown } | { error: JsonRpcError }

/** Replier looks at the outgoing request's params/method and returns the
 *  scripted reply. Used instead of a Map<method, Reply> so the same method
 *  (e.g. references) can answer twice with different payloads. */
type Replier = (req: SentRequest) => Reply | Promise<Reply>

/** In-process test seam for `LspClient`. Overrides every IO touchpoint
 *  (`start`, `sendRequest`, `sendNotification`, `readFileText`) so the unit
 *  test never spawns a server, never opens stdio, never touches the disk.
 *  Every overridden method records into {@link sent} for assertions. */
class FakeLspClient extends LspClient {
  readonly sent: Sent[] = []
  private replier: Replier = () => ({ result: null })
  private fileText = ""

  constructor(options: LspClientOptions = {}) {
    const spec: LspClientSpec = {
      defaultCommand: ["unused"],
      languageIdFor: () => "typescript",
    }
    super(spec, options)
  }

  setReplier(r: Replier): void {
    this.replier = r
  }

  setFileText(text: string): void {
    this.fileText = text
  }

  /** Replace the spawn-and-handshake lifecycle with a noop so the test can
   *  drive the nav methods without a child process. Doesn't even touch
   *  `proc` — the nav methods don't consult it. */
  override async start(): Promise<void> {
    return
  }

  protected override sendRequest(
    method: string,
    params: unknown,
    _signal?: AbortSignal,
  ): Promise<unknown> {
    const req: SentRequest = { kind: "request", method, params }
    this.sent.push(req)
    return Promise.resolve(this.replier(req)).then((reply) => {
      if ("error" in reply) {
        // Mirror the real path: dispatch the error through resolvePending so
        // it surfaces as an `LspRequestError`. The simplest way is to throw
        // directly — `callOrNullOnUnsupported` catches `LspRequestError` via
        // `instanceof`, so we replicate the same shape here.
        return Promise.reject(makeLspRequestError(method, reply.error))
      }
      return reply.result
    })
  }

  protected override sendNotification(method: string, params: unknown): void {
    this.sent.push({ kind: "notify", method, params })
  }

  protected override readFileText(_filePath: string): Promise<string> {
    return Promise.resolve(this.fileText)
  }
}

class AbortProbeClient extends LspClient {
  readonly notifications: Array<{ method: string; params: unknown }> = []

  constructor(options: LspClientOptions = {}) {
    const spec: LspClientSpec = {
      defaultCommand: ["unused"],
      languageIdFor: () => "typescript",
    }
    super(spec, options)
  }

  async issue(method: string, signal?: AbortSignal): Promise<unknown> {
    return this.sendRequest(method, { probe: true }, signal)
  }

  installTransport(stdin: { write: (chunk: string) => unknown }): void {
    const self = this as unknown as {
      proc: { stdin?: { write: (chunk: string) => unknown } } | null
    }
    self.proc = { stdin }
  }

  override async start(): Promise<void> {
    return
  }

  protected override sendNotification(method: string, params: unknown): void {
    this.notifications.push({ method, params })
  }
}

/** The base `callOrNullOnUnsupported` uses `instanceof LspRequestError` to
 *  decide whether to translate a JSON-RPC error into a `null` result. The
 *  fake's `sendRequest` therefore rejects with the same class — anything
 *  else would never trigger the unsupported branch. */
const makeLspRequestError = (method: string, err: JsonRpcError): LspRequestError =>
  new LspRequestError(method, err)

// --- Fixtures ----------------------------------------------------------------

const FILE = "/tmp/fixture.ts"
const URI = pathToFileURL(FILE).href
const POS = { line: 3, character: 7 }

/** Compact `Range` builder so tests stay legible. */
const r = (sl: number, sc: number, el: number, ec: number) => ({
  start: { line: sl, character: sc },
  end: { line: el, character: ec },
})

// --- Tests -------------------------------------------------------------------

describe("LspClient nav RPC — definition / typeDefinition / implementation", () => {
  test("definition returns Location[] from a single Location result", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({ result: { uri: "file:///x.ts", range: r(1, 0, 1, 5) } }))
    const out = await c.definition(FILE, POS)
    expect(out).toEqual([{ uri: "file:///x.ts", range: r(1, 0, 1, 5) }])
  })

  test("definition returns Location[] from a LocationLink (targetSelectionRange preferred)", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({
      result: [
        {
          targetUri: "file:///lib.ts",
          targetRange: r(10, 0, 20, 1),
          targetSelectionRange: r(10, 2, 10, 9),
        },
      ],
    }))
    const out = await c.definition(FILE, POS)
    expect(out).toEqual([{ uri: "file:///lib.ts", range: r(10, 2, 10, 9) }])
  })

  test("definition falls back to LocationLink.targetRange when selection range absent", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({
      result: [{ targetUri: "file:///lib.ts", targetRange: r(2, 0, 2, 4) }],
    }))
    const out = await c.definition(FILE, POS)
    expect(out).toEqual([{ uri: "file:///lib.ts", range: r(2, 0, 2, 4) }])
  })

  test("definition returns null when the server returns null", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({ result: null }))
    expect(await c.definition(FILE, POS)).toBeNull()
  })

  test("typeDefinition mirrors the definition normalization path", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({ result: { uri: "file:///t.ts", range: r(0, 0, 0, 3) } }))
    const out = await c.typeDefinition(FILE, POS)
    expect(out).toEqual([{ uri: "file:///t.ts", range: r(0, 0, 0, 3) }])
    expect(c.sent.find((s) => s.kind === "request")?.method).toBe("textDocument/typeDefinition")
  })

  test("implementation mirrors the definition normalization path", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({
      result: [
        { uri: "file:///a.ts", range: r(0, 0, 0, 1) },
        { uri: "file:///b.ts", range: r(2, 0, 2, 1) },
      ],
    }))
    const out = await c.implementation(FILE, POS)
    expect(out).toEqual([
      { uri: "file:///a.ts", range: r(0, 0, 0, 1) },
      { uri: "file:///b.ts", range: r(2, 0, 2, 1) },
    ])
    const requests = c.sent.filter((s) => s.kind === "request")
    expect(requests[requests.length - 1]?.method).toBe("textDocument/implementation")
  })
})

describe("LspClient request cancellation plumbing", () => {
  test("aborting a pending request rejects and emits $/cancelRequest", async () => {
    const c = new AbortProbeClient()
    c.installTransport({ write: () => undefined })
    const ac = new AbortController()
    const pending = c.issue("textDocument/hover", ac.signal)
    ac.abort()
    await expect(pending).rejects.toThrow(/aborted/)
    expect(c.notifications).toContainEqual({
      method: "$/cancelRequest",
      params: { id: 1 },
    })
  })
})

describe("LspClient nav RPC — references", () => {
  test("includeDeclaration=true vs false threads through to the server params", async () => {
    const c = new FakeLspClient()
    const seen: Array<{ includeDeclaration: boolean }> = []
    c.setReplier((req) => {
      const p = req.params as { context: { includeDeclaration: boolean } }
      seen.push(p.context)
      const refs = p.context.includeDeclaration
        ? [
            { uri: "file:///decl.ts", range: r(0, 0, 0, 1) },
            { uri: "file:///use.ts", range: r(5, 2, 5, 4) },
          ]
        : [{ uri: "file:///use.ts", range: r(5, 2, 5, 4) }]
      return { result: refs }
    })
    const withDecl = await c.references(FILE, POS, true)
    const withoutDecl = await c.references(FILE, POS, false)
    expect(withDecl?.length).toBe(2)
    expect(withoutDecl?.length).toBe(1)
    expect(seen).toEqual([{ includeDeclaration: true }, { includeDeclaration: false }])
  })

  test("references returns null on server null", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({ result: null }))
    expect(await c.references(FILE, POS, true)).toBeNull()
  })
})

describe("LspClient nav RPC — hover", () => {
  test("flattens MarkupContent (markdown) into the rendered value", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({
      result: { contents: { kind: "markdown", value: "# Title\n\nbody" }, range: r(0, 0, 0, 3) },
    }))
    const out = await c.hover(FILE, POS)
    expect(out).toEqual({ contents: "# Title\n\nbody", range: r(0, 0, 0, 3) })
  })

  test("flattens MarkedString[] (array form) by joining with newlines", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({
      result: { contents: [{ language: "ts", value: "let x: number" }, "extra info"] },
    }))
    const out = await c.hover(FILE, POS)
    expect(out?.contents).toBe("let x: number\nextra info")
    expect(out?.range).toBeUndefined()
  })

  test("flattens a single MarkedString (plain string) result", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({ result: { contents: "plain" } }))
    const out = await c.hover(FILE, POS)
    expect(out).toEqual({ contents: "plain" })
  })

  test("returns null when the server returns null", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({ result: null }))
    expect(await c.hover(FILE, POS)).toBeNull()
  })
})

describe("LspClient nav RPC — documentSymbol", () => {
  test("DocumentSymbol tree flattens with containerName + uri populated", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({
      result: [
        {
          name: "MyClass",
          kind: 5,
          range: r(0, 0, 20, 0),
          selectionRange: r(0, 6, 0, 13),
          children: [
            {
              name: "method1",
              kind: 6,
              range: r(2, 2, 5, 3),
              selectionRange: r(2, 6, 2, 13),
            },
          ],
        },
      ],
    }))
    const out = await c.documentSymbol(FILE)
    expect(out).toEqual([
      {
        name: "MyClass",
        kind: "class",
        range: r(0, 0, 20, 0),
        selectionRange: r(0, 6, 0, 13),
        uri: URI,
      },
      {
        name: "method1",
        kind: "method",
        range: r(2, 2, 5, 3),
        selectionRange: r(2, 6, 2, 13),
        uri: URI,
        containerName: "MyClass",
      },
    ])
  })

  test("SymbolInformation list maps directly with selectionRange = range", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({
      result: [
        {
          name: "helper",
          kind: 12,
          location: { uri: URI, range: r(3, 0, 3, 6) },
          containerName: "module",
        },
      ],
    }))
    const out = await c.documentSymbol(FILE)
    expect(out).toEqual([
      {
        name: "helper",
        kind: "function",
        range: r(3, 0, 3, 6),
        selectionRange: r(3, 0, 3, 6),
        uri: URI,
        containerName: "module",
      },
    ])
  })

  test("empty array → empty array (not null)", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({ result: [] }))
    expect(await c.documentSymbol(FILE)).toEqual([])
  })

  test("null result → null", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({ result: null }))
    expect(await c.documentSymbol(FILE)).toBeNull()
  })
})

describe("LspClient nav RPC — workspaceSymbol", () => {
  test("maps SymbolInformation entries with containerName", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({
      result: [
        {
          name: "foo",
          kind: 12,
          location: { uri: "file:///mod.ts", range: r(1, 0, 1, 3) },
          containerName: "outer",
        },
      ],
    }))
    const out = await c.workspaceSymbol("foo")
    expect(out).toEqual([
      {
        name: "foo",
        kind: "function",
        range: r(1, 0, 1, 3),
        selectionRange: r(1, 0, 1, 3),
        uri: "file:///mod.ts",
        containerName: "outer",
      },
    ])
  })

  test("maps WorkspaceSymbol (range may be absent → zero-width)", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({
      result: [{ name: "bar", kind: 5, location: { uri: "file:///m.ts" } }],
    }))
    const out = await c.workspaceSymbol("bar")
    expect(out).toEqual([
      {
        name: "bar",
        kind: "class",
        range: r(0, 0, 0, 0),
        selectionRange: r(0, 0, 0, 0),
        uri: "file:///m.ts",
      },
    ])
  })
})

describe("LspClient nav RPC — prepareRename", () => {
  test("bare Range result → placeholder is empty string", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({ result: r(4, 2, 4, 8) }))
    const out = await c.prepareRename(FILE, POS)
    expect(out).toEqual({ range: r(4, 2, 4, 8), placeholder: "" })
  })

  test("{ defaultBehavior: true } → null (we have no symbol text)", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({ result: { defaultBehavior: true } }))
    expect(await c.prepareRename(FILE, POS)).toBeNull()
  })

  test("{ range, placeholder } full object → both surface", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({ result: { range: r(0, 1, 0, 4), placeholder: "myVar" } }))
    const out = await c.prepareRename(FILE, POS)
    expect(out).toEqual({ range: r(0, 1, 0, 4), placeholder: "myVar" })
  })

  test("null result → null", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({ result: null }))
    expect(await c.prepareRename(FILE, POS)).toBeNull()
  })
})

describe("LspClient nav RPC — error handling", () => {
  test("method-not-found (-32601) → returns null instead of rejecting", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({ error: { code: -32601, message: "Method not found" } }))
    expect(await c.hover(FILE, POS)).toBeNull()
  })

  test("invalid-params (-32602) → also treated as unsupported → null", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({ error: { code: -32602, message: "Invalid params" } }))
    expect(await c.definition(FILE, POS)).toBeNull()
  })

  test('"not supported" message text → null even with a generic code', async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({ error: { code: -32000, message: "feature is not supported" } }))
    expect(await c.references(FILE, POS, false)).toBeNull()
  })

  test("any other JSON-RPC error propagates as a rejection", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({ error: { code: -32603, message: "Internal error" } }))
    await expect(c.hover(FILE, POS)).rejects.toThrow(/Internal error/)
  })
})

describe("LspClient nav RPC — document lifecycle", () => {
  test("didOpen is sent exactly once per URI across multiple nav calls", async () => {
    const c = new FakeLspClient()
    c.setFileText("const x = 1\n")
    c.setReplier(() => ({ result: null }))

    await c.definition(FILE, POS)
    await c.hover(FILE, POS)
    await c.references(FILE, POS, true)

    const opens = c.sent.filter((s) => s.kind === "notify" && s.method === "textDocument/didOpen")
    expect(opens.length).toBe(1)
  })

  test("didClose is sent for every opened URI when stop() runs", async () => {
    const c = new FakeLspClient()
    c.setFileText("// file a\n")
    c.setReplier(() => ({ result: null }))

    await c.definition("/tmp/a.ts", POS)
    await c.definition("/tmp/b.ts", POS)
    await c.stop()

    const closes = c.sent.filter((s) => s.kind === "notify" && s.method === "textDocument/didClose")
    const closedUris = closes.map((s) => {
      const p = s.params as { textDocument: { uri: string } }
      return p.textDocument.uri
    })
    expect(closedUris.sort()).toEqual(
      [pathToFileURL("/tmp/a.ts").href, pathToFileURL("/tmp/b.ts").href].sort(),
    )
  })

  test("workspaceSymbol does NOT trigger a didOpen (no document context)", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({ result: [] }))
    await c.workspaceSymbol("q")
    const opens = c.sent.filter((s) => s.kind === "notify" && s.method === "textDocument/didOpen")
    expect(opens.length).toBe(0)
  })
})

describe("LspClient nav RPC — wire mapping edges", () => {
  test("unknown numeric SymbolKind → 'unknown'", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({
      result: [
        {
          name: "weird",
          kind: 999,
          range: r(0, 0, 0, 1),
          selectionRange: r(0, 0, 0, 1),
        },
      ],
    }))
    const out = await c.documentSymbol(FILE)
    expect(out?.[0]?.kind).toBe("unknown")
  })

  test("definition empty array → empty array (NOT null)", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({ result: [] }))
    expect(await c.definition(FILE, POS)).toEqual([])
  })

  test("references empty array → empty array (NOT null)", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({ result: [] }))
    expect(await c.references(FILE, POS, true)).toEqual([])
  })

  test("nav methods send the right wire method names", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({ result: null }))
    await c.definition(FILE, POS)
    await c.references(FILE, POS, true)
    await c.hover(FILE, POS)
    await c.typeDefinition(FILE, POS)
    await c.implementation(FILE, POS)
    await c.documentSymbol(FILE)
    await c.workspaceSymbol("q")
    await c.prepareRename(FILE, POS)
    const methods = c.sent.filter((s) => s.kind === "request").map((s) => s.method)
    expect(methods).toEqual([
      "textDocument/definition",
      "textDocument/references",
      "textDocument/hover",
      "textDocument/typeDefinition",
      "textDocument/implementation",
      "textDocument/documentSymbol",
      "workspace/symbol",
      "textDocument/prepareRename",
    ])
  })
})

/** Exposes the REAL (non-overridden) `sendRequest` so the lifecycle guard can
 *  be exercised. Unlike {@link FakeLspClient} this does NOT replace
 *  `sendRequest` — it only surfaces it publicly and uses a short timeout so a
 *  guard regression (request hangs instead of rejecting) fails the test fast
 *  rather than waiting the full default timeout. */
class RealSendLspClient extends LspClient {
  constructor() {
    super(
      { defaultCommand: ["unused"], languageIdFor: () => "typescript" },
      { requestTimeoutMs: 250 },
    )
  }
  callSendRequest(method: string, params: unknown): Promise<unknown> {
    return this.sendRequest(method, params)
  }
  installTransport(stdin: { write: (chunk: string) => unknown } | undefined): void {
    const self = this as unknown as {
      started: boolean
      proc: { stdin?: { write: (chunk: string) => unknown } } | null
    }
    self.started = true
    self.proc = stdin ? { stdin } : {}
  }
  pendingCount(): number {
    return (this as unknown as { pending: Map<number, unknown> }).pending.size
  }
}

describe("LspClient lifecycle — sendRequest after stop/exit (base.ts guard)", () => {
  test("a request after stop() rejects promptly instead of hanging until timeout", async () => {
    const c = new RealSendLspClient()
    await c.stop() // never started: flips `stopped`, leaves proc null
    const started = Date.now()
    await expect(c.callSendRequest("textDocument/definition", {})).rejects.toThrow(
      /after server stopped\/exited/,
    )
    // Must reject synchronously-ish, not after the 250ms timeout.
    expect(Date.now() - started).toBeLessThan(200)
  })

  test("the `shutdown` method is exempt from the guard (stop() issues it post-stop)", async () => {
    // shutdown after stop must NOT be rejected by the guard — it would instead
    // reach the transport layer. Missing transport is now rejected eagerly, so
    // we assert it bypasses the stop/exit guard and fails as a transport error.
    const c = new RealSendLspClient()
    await c.stop()
    await expect(c.callSendRequest("shutdown", null)).rejects.toThrow(/stdin closed/)
  })

  test("missing stdin rejects immediately and clears the pending slot", async () => {
    const c = new RealSendLspClient()
    c.installTransport(undefined)
    const started = Date.now()
    await expect(c.callSendRequest("textDocument/definition", {})).rejects.toThrow(/stdin closed/)
    expect(Date.now() - started).toBeLessThan(200)
    expect(c.pendingCount()).toBe(0)
  })

  test("stdin.write throw rejects immediately and clears the pending slot", async () => {
    const c = new RealSendLspClient()
    c.installTransport({
      write: () => {
        throw new Error("kaboom")
      },
    })
    const started = Date.now()
    await expect(c.callSendRequest("textDocument/definition", {})).rejects.toThrow(/kaboom/)
    expect(Date.now() - started).toBeLessThan(200)
    expect(c.pendingCount()).toBe(0)
  })
})
