/**
 * Hellgate — `LspClient.computeRename` RPC (ADR-0380, S2).
 *
 * The `textDocument/rename` wire method. Sibling of the existing nav RPCs
 * (`definition`/`references`/…) and `prepareRename` (which only PROBES). This
 * one issues the actual rename request and normalizes the server's
 * `WorkspaceEdit` into the `RenameWorkspaceEdit` port shape.
 *
 * Seal:
 *   A. wire method    — issues `textDocument/rename` with newName param
 *   B. normalization  — `changes` map AND `documentChanges` array both map;
 *                       documentChanges wins; missing both ⇒ empty changes
 *   C. unsupported    — server `null` ⇒ null; method-not-found (-32601) ⇒ null
 *   D. position       — 0-based pos threaded verbatim
 *   E. lazy open      — didOpen fired once before the request
 */

import { describe, expect, test } from "bun:test"
import { pathToFileURL } from "node:url"
import type { LspClientOptions, LspClientSpec } from "@/lsp"
import { LspClient } from "@/lsp"
import { LspRequestError } from "@/lsp/adapters/base"
import type { JsonRpcError } from "@/lsp/adapters/jsonrpc"

type SentRequest = { kind: "request"; method: string; params: unknown }
type SentNotification = { kind: "notify"; method: string; params: unknown }
type Sent = SentRequest | SentNotification
type Reply = { result: unknown } | { error: JsonRpcError }
type Replier = (req: SentRequest) => Reply | Promise<Reply>

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
      if ("error" in reply) return Promise.reject(new LspRequestError(method, reply.error))
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

const FILE = "/tmp/fixture.ts"
const URI = pathToFileURL(FILE).href
const POS = { line: 3, character: 7 }
const r = (sl: number, sc: number, el: number, ec: number) => ({
  start: { line: sl, character: sc },
  end: { line: el, character: ec },
})

describe("LspClient.computeRename — wire method", () => {
  test("HELL-A1: issues textDocument/rename with newName param + position", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({ result: { changes: {} } }))
    await c.computeRename(FILE, POS, "Renamed")
    const req = c.sent.find(
      (s): s is SentRequest => s.kind === "request" && s.method === "textDocument/rename",
    )
    expect(req).toBeDefined()
    expect(req?.params).toEqual({
      textDocument: { uri: URI },
      position: POS,
      newName: "Renamed",
    })
  })

  test("HELL-E2: didOpen fires once before the rename request", async () => {
    const c = new FakeLspClient()
    c.setFileText("const a = 1")
    c.setReplier(() => ({ result: { changes: {} } }))
    await c.computeRename(FILE, POS, "Renamed")
    const opens = c.sent.filter((s) => s.kind === "notify" && s.method === "textDocument/didOpen")
    expect(opens).toHaveLength(1)
  })
})

describe("LspClient.computeRename — normalization", () => {
  test("HELL-B3: legacy `changes` map → flat per-document changes", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({
      result: {
        changes: {
          "file:///a.ts": [{ range: r(0, 0, 0, 3), newText: "Bar" }],
          "file:///b.ts": [{ range: r(1, 0, 1, 3), newText: "Bar" }],
        },
      },
    }))
    const out = await c.computeRename(FILE, POS, "Bar")
    expect(out).not.toBeNull()
    expect(out?.changes).toHaveLength(2)
    expect(out?.changes[0]).toEqual({
      uri: "file:///a.ts",
      edits: [{ range: r(0, 0, 0, 3), newText: "Bar" }],
    })
  })

  test("HELL-B4: `documentChanges` array → per-document changes", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({
      result: {
        documentChanges: [
          {
            textDocument: { uri: "file:///x.ts", version: 1 },
            edits: [{ range: r(2, 0, 2, 5), newText: "Baz" }],
          },
        ],
      },
    }))
    const out = await c.computeRename(FILE, POS, "Baz")
    expect(out?.changes).toEqual([
      { uri: "file:///x.ts", edits: [{ range: r(2, 0, 2, 5), newText: "Baz" }] },
    ])
  })

  test("HELL-B5: documentChanges wins over changes when both present", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({
      result: {
        changes: { "file:///legacy.ts": [{ range: r(0, 0, 0, 1), newText: "L" }] },
        documentChanges: [
          {
            textDocument: { uri: "file:///new.ts" },
            edits: [{ range: r(0, 0, 0, 1), newText: "N" }],
          },
        ],
      },
    }))
    const out = await c.computeRename(FILE, POS, "N")
    expect(out?.changes).toHaveLength(1)
    expect(out?.changes[0]?.uri).toBe("file:///new.ts")
  })

  test("HELL-B6: empty edit (no changes/documentChanges) → empty changes array", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({ result: {} }))
    const out = await c.computeRename(FILE, POS, "Bar")
    expect(out).toEqual({ changes: [] })
  })
})

describe("LspClient.computeRename — unsupported / null", () => {
  test("HELL-C7: server null result → null (no rename capability)", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({ result: null }))
    expect(await c.computeRename(FILE, POS, "Bar")).toBeNull()
  })

  test("HELL-C8: method-not-found (-32601) → null, not a throw", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({
      error: { code: -32601, message: "Unhandled method textDocument/rename" },
    }))
    expect(await c.computeRename(FILE, POS, "Bar")).toBeNull()
  })

  test("HELL-C9: non-unsupported error (-32603) propagates", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({ error: { code: -32603, message: "internal error" } }))
    await expect(c.computeRename(FILE, POS, "Bar")).rejects.toThrow()
  })
})
