/**
 * Hellgate — LSP call-hierarchy ADAPTER two-hop wire (RFC jun-6).
 *
 * Drives `LspClient.incomingCalls` / `outgoingCalls` through an in-process
 * capture seam (canned JSON-RPC, NO subprocess, NO disk). Seals:
 *   - the two-hop protocol: `textDocument/prepareCallHierarchy` THEN
 *     `callHierarchy/incomingCalls|outgoingCalls` per resolved item.
 *   - `-32601` on prepare ⇒ `null` (server lacks `callHierarchyProvider`).
 *   - `prepareCallHierarchy → []` ⇒ `[]` (resolved, nothing to query) — NOT null.
 *   - incoming reads `from`; outgoing reads `to` (field selection).
 *   - `fromRanges` map 1:1, normalized 0-based, no loss.
 *   - prepare ambiguity (2 items / overloads) ⇒ both resolved + flattened.
 *   - the `callHierarchy` client capability is advertised in `initialize`.
 */

import { describe, expect, test } from "bun:test"
import type { LspClientOptions, LspClientSpec } from "@/lsp"
import { LspClient } from "@/lsp"
import { LspRequestError } from "@/lsp/adapters/base"
import type { JsonRpcError } from "@/lsp/adapters/jsonrpc"

type SentRequest = { kind: "request"; method: string; params: unknown }
type Reply = { result: unknown } | { error: JsonRpcError }
type Replier = (req: SentRequest) => Reply

const makeLspRequestError = (method: string, err: JsonRpcError): LspRequestError =>
  new LspRequestError(method, err)

class FakeLspClient extends LspClient {
  readonly sent: SentRequest[] = []
  private replier: Replier = () => ({ result: null })

  constructor(options: LspClientOptions = {}) {
    const spec: LspClientSpec = { defaultCommand: ["unused"], languageIdFor: () => "typescript" }
    super(spec, options)
  }

  setReplier(r: Replier): void {
    this.replier = r
  }

  override async start(): Promise<void> {
    return
  }

  protected override sendRequest(method: string, params: unknown): Promise<unknown> {
    const req: SentRequest = { kind: "request", method, params }
    this.sent.push(req)
    const reply = this.replier(req)
    if ("error" in reply) return Promise.reject(makeLspRequestError(method, reply.error))
    return Promise.resolve(reply.result)
  }

  protected override sendNotification(): void {
    // swallow didOpen etc.
  }

  protected override readFileText(): Promise<string> {
    return Promise.resolve("function foo(){}\n")
  }
}

const rng = (line: number, ch: number) => ({
  start: { line, character: ch },
  end: { line, character: ch + 3 },
})

const item = (name: string, kind: number, line: number) => ({
  name,
  kind,
  uri: "file:///repo/caller.ts",
  range: rng(line, 0),
  selectionRange: rng(line, 9),
})

describe("LspClient.incomingCalls — two-hop wire", () => {
  test("prepare → incomingCalls; maps `from` + fromRanges 1:1", async () => {
    const c = new FakeLspClient()
    await c.start()
    c.setReplier((req) => {
      if (req.method === "textDocument/prepareCallHierarchy") {
        return { result: [item("foo", 12, 0)] }
      }
      if (req.method === "callHierarchy/incomingCalls") {
        return {
          result: [
            { from: item("bar", 12, 10), fromRanges: [rng(12, 4), rng(14, 8)] },
            { from: item("baz", 12, 20), fromRanges: [rng(22, 2)] },
          ],
        }
      }
      return { result: null }
    })
    const out = await c.incomingCalls("/repo/foo.ts", { line: 0, character: 0 })
    expect(out).not.toBeNull()
    expect(out).toHaveLength(2)
    expect(out?.[0]?.name).toBe("bar")
    expect(out?.[0]?.kind).toBe("function")
    expect(out?.[0]?.uri).toBe("file:///repo/caller.ts")
    expect(out?.[0]?.fromRanges).toHaveLength(2)
    expect(out?.[0]?.fromRanges[0]).toEqual({
      start: { line: 12, character: 4 },
      end: { line: 12, character: 7 },
    })
    expect(out?.[1]?.name).toBe("baz")
    // The two-hop order: prepare THEN incomingCalls.
    const methods = c.sent.map((s) => s.method)
    expect(methods).toEqual(["textDocument/prepareCallHierarchy", "callHierarchy/incomingCalls"])
  })

  test("-32601 on prepare ⇒ null (no callHierarchyProvider)", async () => {
    const c = new FakeLspClient()
    await c.start()
    c.setReplier(() => ({ error: { code: -32601, message: "method not supported" } }))
    const out = await c.incomingCalls("/repo/foo.ts", { line: 0, character: 0 })
    expect(out).toBeNull()
    // Never issued the second hop.
    expect(c.sent.map((s) => s.method)).toEqual(["textDocument/prepareCallHierarchy"])
  })

  test("prepare ⇒ [] ⇒ [] (resolved, nothing to query — NOT null)", async () => {
    const c = new FakeLspClient()
    await c.start()
    c.setReplier((req) =>
      req.method === "textDocument/prepareCallHierarchy" ? { result: [] } : { result: null },
    )
    const out = await c.incomingCalls("/repo/foo.ts", { line: 0, character: 0 })
    expect(out).toEqual([])
    expect(c.sent.map((s) => s.method)).toEqual(["textDocument/prepareCallHierarchy"])
  })

  test("prepare ambiguity (2 overloads) ⇒ both resolved + flattened, no item dropped", async () => {
    const c = new FakeLspClient()
    await c.start()
    let calls = 0
    c.setReplier((req) => {
      if (req.method === "textDocument/prepareCallHierarchy") {
        return { result: [item("foo", 12, 0), item("foo", 12, 30)] }
      }
      calls += 1
      return { result: [{ from: item(`caller${calls}`, 12, 10), fromRanges: [rng(1, 0)] }] }
    })
    const out = await c.incomingCalls("/repo/foo.ts", { line: 0, character: 0 })
    expect(out).toHaveLength(2)
    expect(out?.map((e) => e.name)).toEqual(["caller1", "caller2"])
    // prepare + 2 resolves.
    expect(c.sent.filter((s) => s.method === "callHierarchy/incomingCalls")).toHaveLength(2)
  })

  test("missing fromRanges on an edge collapses to [] (no crash)", async () => {
    const c = new FakeLspClient()
    await c.start()
    c.setReplier((req) =>
      req.method === "textDocument/prepareCallHierarchy"
        ? { result: [item("foo", 12, 0)] }
        : { result: [{ from: item("bar", 12, 10) }] },
    )
    const out = await c.incomingCalls("/repo/foo.ts", { line: 0, character: 0 })
    expect(out?.[0]?.fromRanges).toEqual([])
  })
})

describe("LspClient.outgoingCalls — reads `to` not `from`", () => {
  test("outgoing maps the `to` field (field selection)", async () => {
    const c = new FakeLspClient()
    await c.start()
    c.setReplier((req) => {
      if (req.method === "textDocument/prepareCallHierarchy")
        return { result: [item("bar", 12, 0)] }
      if (req.method === "callHierarchy/outgoingCalls") {
        return { result: [{ to: item("foo", 12, 9), fromRanges: [rng(3, 4)] }] }
      }
      return { result: null }
    })
    const out = await c.outgoingCalls("/repo/bar.ts", { line: 0, character: 0 })
    expect(out).toHaveLength(1)
    expect(out?.[0]?.name).toBe("foo")
    expect(out?.[0]?.fromRanges[0]).toEqual({
      start: { line: 3, character: 4 },
      end: { line: 3, character: 7 },
    })
    expect(c.sent.map((s) => s.method)).toEqual([
      "textDocument/prepareCallHierarchy",
      "callHierarchy/outgoingCalls",
    ])
  })
})

describe("initialize advertises the callHierarchy capability", () => {
  test("the `callHierarchy` client capability is sent under textDocument", async () => {
    // Spawn a harmless real command (`true` exits 0 immediately, no stdout) so
    // the real `start()` runs through `initialize`; override `sendRequest` to
    // capture the params instead of waiting on the (dead) process.
    const sent: SentRequest[] = []
    class CaptureInit extends LspClient {
      constructor() {
        super({ defaultCommand: ["true"], languageIdFor: () => "typescript" })
      }
      protected override sendRequest(method: string, params: unknown): Promise<unknown> {
        sent.push({ kind: "request", method, params })
        return Promise.resolve({ serverInfo: { name: "fake" } })
      }
      protected override sendNotification(): void {}
    }
    const c = new CaptureInit()
    await c.start()
    await c.stop().catch(() => undefined)
    const init = sent.find((s) => s.method === "initialize")
    expect(init).toBeDefined()
    const caps = (init?.params as { capabilities: { textDocument: Record<string, unknown> } })
      .capabilities.textDocument
    expect(caps.callHierarchy).toEqual({ dynamicRegistration: false })
  })
})
