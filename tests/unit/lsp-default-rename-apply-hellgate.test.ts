/**
 * Hellgate — `DefaultRenameApplyAdapter` (ADR-0380, S2).
 *
 * Wires the canonical `RenameApplyPort` to a real `LspClient` via:
 *   computeRename → `LspClient.computeRename` (textDocument/rename RPC)
 *   applyEdit     → `LspClient.applyWorkspaceEdit` (2-phase temp+rename atomic,
 *                   ADR-0152, reused verbatim)
 *
 * Strategy mirrors `lsp-real-adapters-hellgate.test.ts`: a FakeLspClient
 * subclass of the real `LspClient` overrides the IO seams so the adapter's
 * compute→apply path is exercised end-to-end with NO server / NO disk.
 *
 * Seal:
 *   A. computeRename forwards file/pos/newName + normalizes WorkspaceEdit
 *   B. applyEdit drives the real 2-phase atomic write (multi-file commit)
 *   C. atomicity — Phase 1 write failure ⇒ NO original committed
 *   D. null edit (no rename capability) surfaces as null from computeRename
 */

import { describe, expect, test } from "bun:test"
import { pathToFileURL } from "node:url"
import type { LspClientOptions, LspClientSpec, RenameWorkspaceEdit } from "@/lsp"
import { DefaultRenameApplyAdapter, LspClient } from "@/lsp"
import { LspRequestError } from "@/lsp/adapters/base"
import type { JsonRpcError } from "@/lsp/adapters/jsonrpc"

type SentRequest = { kind: "request"; method: string; params: unknown }
type SentNotification = { kind: "notify"; method: string; params: unknown }
type Sent = SentRequest | SentNotification
type Reply = { result: unknown } | { error: JsonRpcError }
type Replier = (req: SentRequest) => Reply | Promise<Reply>

class FakeLspClient extends LspClient {
  readonly sent: Sent[] = []
  readonly writes: { path: string; text: string }[] = []
  readonly renames: { from: string; to: string }[] = []
  readonly unlinks: string[] = []
  private replier: Replier = () => ({ result: null })
  private files = new Map<string, string>()
  private writeShouldThrow: ((path: string) => Error | null) | null = null

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
  setFile(path: string, text: string): void {
    this.files.set(path, text)
  }
  setWriteThrow(fn: (path: string) => Error | null): void {
    this.writeShouldThrow = fn
  }
  get committed(): Map<string, string> {
    const out = new Map<string, string>()
    for (const r of this.renames) {
      const w = this.writes.find((x) => x.path === r.from)
      if (w) out.set(r.to, w.text)
    }
    return out
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
  protected override readFileText(filePath: string): Promise<string> {
    return Promise.resolve(this.files.get(filePath) ?? "")
  }
  protected override writeFileText(filePath: string, text: string): Promise<unknown> {
    if (this.writeShouldThrow) {
      const err = this.writeShouldThrow(filePath)
      if (err) return Promise.reject(err)
    }
    this.writes.push({ path: filePath, text })
    return Promise.resolve(text.length)
  }
  protected override renameFile(from: string, to: string): Promise<void> {
    this.renames.push({ from, to })
    return Promise.resolve()
  }
  protected override unlinkTmp(filePath: string): Promise<void> {
    this.unlinks.push(filePath)
    return Promise.resolve()
  }
  protected override listDir(): Promise<string[]> {
    return Promise.resolve([])
  }
}

const FILE = "/work/a.ts"
const URI = pathToFileURL(FILE).href
const r = (sl: number, sc: number, el: number, ec: number) => ({
  start: { line: sl, character: sc },
  end: { line: el, character: ec },
})

describe("DefaultRenameApplyAdapter — computeRename", () => {
  test("HELL-A1: forwards 0-based pos + newName; normalizes WorkspaceEdit", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({
      result: { changes: { [URI]: [{ range: r(0, 6, 0, 9), newText: "Bar" }] } },
    }))
    const adapter = new DefaultRenameApplyAdapter(c)
    const edit = await adapter.computeRename(FILE, 0, 6, "Bar")
    const req = c.sent.find(
      (s): s is SentRequest => s.kind === "request" && s.method === "textDocument/rename",
    )
    expect(req?.params).toEqual({
      textDocument: { uri: URI },
      position: { line: 0, character: 6 },
      newName: "Bar",
    })
    expect(edit?.changes).toEqual([{ uri: URI, edits: [{ range: r(0, 6, 0, 9), newText: "Bar" }] }])
  })

  test("HELL-D2: server null result ⇒ computeRename returns null", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({ result: null }))
    const adapter = new DefaultRenameApplyAdapter(c)
    expect(await adapter.computeRename(FILE, 0, 6, "Bar")).toBeNull()
  })
})

describe("DefaultRenameApplyAdapter — applyEdit", () => {
  test("HELL-B3: drives the 2-phase atomic write across multiple files", async () => {
    const c = new FakeLspClient()
    c.setFile("/work/a.ts", "let foo = 1\n")
    c.setFile("/work/b.ts", "use(foo)\n")
    const adapter = new DefaultRenameApplyAdapter(c)
    const edit: RenameWorkspaceEdit = {
      changes: [
        {
          uri: pathToFileURL("/work/a.ts").href,
          edits: [{ range: r(0, 4, 0, 7), newText: "bar" }],
        },
        {
          uri: pathToFileURL("/work/b.ts").href,
          edits: [{ range: r(0, 4, 0, 7), newText: "bar" }],
        },
      ],
    }
    await adapter.applyEdit(edit)
    // 2 tmp writes, 2 atomic renames — originals never written directly.
    expect(c.writes).toHaveLength(2)
    expect(c.renames).toHaveLength(2)
    const committed = c.committed
    expect(committed.get("/work/a.ts")).toBe("let bar = 1\n")
    expect(committed.get("/work/b.ts")).toBe("use(bar)\n")
  })

  test("HELL-C4: Phase 1 write failure ⇒ NO original committed (atomicity)", async () => {
    const c = new FakeLspClient()
    c.setFile("/work/a.ts", "let foo = 1\n")
    c.setFile("/work/b.ts", "use(foo)\n")
    c.setWriteThrow((p) => (p.startsWith("/work/b.ts") ? new Error("disk full") : null))
    const adapter = new DefaultRenameApplyAdapter(c)
    const edit: RenameWorkspaceEdit = {
      changes: [
        {
          uri: pathToFileURL("/work/a.ts").href,
          edits: [{ range: r(0, 4, 0, 7), newText: "bar" }],
        },
        {
          uri: pathToFileURL("/work/b.ts").href,
          edits: [{ range: r(0, 4, 0, 7), newText: "bar" }],
        },
      ],
    }
    await expect(adapter.applyEdit(edit)).rejects.toThrow("disk full")
    // Phase-1 failure ⇒ no commit (no rename) ⇒ no original mutated.
    expect(c.renames).toHaveLength(0)
  })
})
