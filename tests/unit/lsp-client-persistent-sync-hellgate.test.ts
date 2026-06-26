import { describe, expect, test } from "bun:test"
import type { LspClientOptions, LspClientSpec } from "@/lsp"
import { LspClient } from "@/lsp"

const SPEC: LspClientSpec = {
  defaultCommand: ["unused"],
  languageIdFor: () => "python",
}

class SyncProbeClient extends LspClient {
  readonly notifications: Array<{ method: string; params: unknown }> = []
  private text = ""

  constructor(options: LspClientOptions = {}) {
    super(SPEC, options)
  }

  setFileText(text: string): void {
    this.text = text
  }

  override async start(): Promise<void> {
    return
  }

  protected override readFileText(): Promise<string> {
    return Promise.resolve(this.text)
  }

  protected override sendNotification(method: string, params: unknown): void {
    this.notifications.push({ method, params })
  }

  protected override sendRequest(method: string): Promise<unknown> {
    if (method === "textDocument/hover") return Promise.resolve({ contents: "ok" })
    return Promise.resolve(null)
  }
}

class DispatchProbeClient extends LspClient {
  private readonly writes: string[] = []

  constructor(options: LspClientOptions = {}) {
    super(SPEC, options)
  }

  override async start(): Promise<void> {
    return
  }

  installTransport(): void {
    const self = this as unknown as {
      proc: { stdin?: { write: (chunk: string | Uint8Array) => unknown } } | null
    }
    self.proc = {
      stdin: {
        write: (chunk: string | Uint8Array) => {
          this.writes.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk))
        },
      },
    }
  }

  dispatchMessage(msg: unknown): void {
    ;(
      LspClient.prototype as unknown as {
        dispatch: (this: LspClient, input: unknown) => void
      }
    ).dispatch.call(this, msg)
  }

  lastResponse(): unknown {
    const wire = this.writes[this.writes.length - 1] ?? ""
    const body = wire.slice(wire.indexOf("\r\n\r\n") + 4)
    return JSON.parse(body)
  }
}

/** Drives the per-session caches (`opened`, `diagnosticsByUri`) through the
 *  public surface + the dispatch seam so we can assert eviction + stop() clear
 *  without a live server. */
class CacheProbeClient extends LspClient {
  readonly notifications: Array<{ method: string; params: unknown }> = []
  private text = ""

  constructor(options: LspClientOptions = {}) {
    super(SPEC, options)
  }

  setFileText(text: string): void {
    this.text = text
  }

  override async start(): Promise<void> {
    return
  }

  protected override readFileText(): Promise<string> {
    return Promise.resolve(this.text)
  }

  protected override sendNotification(method: string, params: unknown): void {
    this.notifications.push({ method, params })
  }

  protected override sendRequest(method: string): Promise<unknown> {
    if (method === "textDocument/hover") return Promise.resolve({ contents: "ok" })
    return Promise.resolve(null)
  }

  publish(uri: string): void {
    ;(
      LspClient.prototype as unknown as {
        dispatch: (this: LspClient, input: unknown) => void
      }
    ).dispatch.call(this, {
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: { uri, diagnostics: [] },
    })
  }

  openedSize(): number {
    return (this as unknown as { opened: Map<string, unknown> }).opened.size
  }

  openedUris(): string[] {
    return [...(this as unknown as { opened: Map<string, unknown> }).opened.keys()]
  }

  diagnosticsSize(): number {
    return (this as unknown as { diagnosticsByUri: Map<string, unknown> }).diagnosticsByUri.size
  }

  diagnosticsWaitersSize(): number {
    return (this as unknown as { diagnosticsWaiters: Map<string, unknown> }).diagnosticsWaiters.size
  }
}

describe("LspClient per-session cache eviction + teardown", () => {
  test("stop() clears retained open-doc text AND diagnostics maps", async () => {
    const client = new CacheProbeClient()
    client.setFileText("x = 1\n")
    await client.hover("/repo/a.py", { line: 0, character: 0 })
    client.publish("file:///repo/a.py")

    expect(client.openedSize()).toBe(1)
    expect(client.diagnosticsSize()).toBe(1)

    await client.stop()

    expect(client.openedSize()).toBe(0)
    expect(client.diagnosticsSize()).toBe(0)
    expect(client.diagnosticsWaitersSize()).toBe(0)
  })

  test("open-doc cache is bounded: touching > cap files evicts the LRU and forgets its diagnostics", async () => {
    const cap = 256
    const client = new CacheProbeClient()

    for (let i = 0; i < cap; i++) {
      client.setFileText(`x = ${i}\n`)
      await client.hover(`/repo/f${i}.py`, { line: 0, character: 0 })
      client.publish(`file:///repo/f${i}.py`)
    }
    expect(client.openedSize()).toBe(cap)
    expect(client.diagnosticsSize()).toBe(cap)

    // One more file pushes past the cap → the least-recently-touched (f0) is
    // didClose'd and its text + diagnostics are dropped.
    client.setFileText("y = 1\n")
    await client.hover("/repo/over.py", { line: 0, character: 0 })

    expect(client.openedSize()).toBe(cap)
    expect(client.openedUris()).not.toContain("file:///repo/f0.py")
    expect(client.openedUris()).toContain("file:///repo/over.py")
    expect(client.diagnosticsSize()).toBe(cap - 1) // f0's diagnostics forgotten
    const closes = client.notifications.filter((n) => n.method === "textDocument/didClose")
    expect(
      closes.map((n) => (n.params as { textDocument: { uri: string } }).textDocument.uri),
    ).toEqual(["file:///repo/f0.py"])
  })

  test("re-touching a doc refreshes its recency so a colder doc is evicted instead", async () => {
    const cap = 256
    const client = new CacheProbeClient()

    for (let i = 0; i < cap; i++) {
      client.setFileText(`x = ${i}\n`)
      await client.hover(`/repo/f${i}.py`, { line: 0, character: 0 })
    }
    // Touch f0 again (stable text → no didChange, but recency must refresh).
    client.setFileText("x = 0\n")
    await client.hover("/repo/f0.py", { line: 0, character: 0 })

    // Overflow: f1 is now the LRU victim, f0 survives.
    client.setFileText("y = 1\n")
    await client.hover("/repo/over.py", { line: 0, character: 0 })

    expect(client.openedUris()).toContain("file:///repo/f0.py")
    expect(client.openedUris()).not.toContain("file:///repo/f1.py")
  })
})

describe("LspClient persistent-session document sync", () => {
  test("reuses didOpen for stable text and emits didChange after an on-disk edit", async () => {
    const client = new SyncProbeClient()
    client.setFileText("from lib import foo\nfoo()\n")
    await client.hover("/repo/app.py", { line: 0, character: 16 })

    client.setFileText("from lib import bar\nbar()\n")
    await client.hover("/repo/app.py", { line: 0, character: 16 })

    const opens = client.notifications.filter((n) => n.method === "textDocument/didOpen")
    const changes = client.notifications.filter((n) => n.method === "textDocument/didChange")
    expect(opens).toHaveLength(1)
    expect(changes).toHaveLength(1)
    expect(changes[0]?.params).toEqual({
      textDocument: { uri: "file:///repo/app.py", version: 2 },
      contentChanges: [{ text: "from lib import bar\nbar()\n" }],
    })
  })
})

describe("LspClient server-request handshake responses", () => {
  test("workspace/configuration resolves dot-section requests from the injected config bag", async () => {
    const client = new DispatchProbeClient({
      workspaceConfiguration: {
        python: {
          analysis: {
            diagnosticMode: "openFilesOnly",
            indexing: false,
          },
        },
      },
    })
    client.installTransport()
    client.dispatchMessage({
      jsonrpc: "2.0",
      id: 7,
      method: "workspace/configuration",
      params: { items: [{ section: "python" }, { section: "python.analysis" }] },
    })
    expect(client.lastResponse()).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: [
        { analysis: { diagnosticMode: "openFilesOnly", indexing: false } },
        { diagnosticMode: "openFilesOnly", indexing: false },
      ],
    })
  })

  test("workspace/workspaceFolders returns the advertised roots", async () => {
    const client = new DispatchProbeClient({ workspaceFolders: ["/repo", "/repo/pkg"] })
    client.installTransport()
    client.dispatchMessage({ jsonrpc: "2.0", id: 9, method: "workspace/workspaceFolders" })
    expect(client.lastResponse()).toEqual({
      jsonrpc: "2.0",
      id: 9,
      result: [
        { uri: "file:///repo", name: "repo" },
        { uri: "file:///repo/pkg", name: "pkg" },
      ],
    })
  })
})
