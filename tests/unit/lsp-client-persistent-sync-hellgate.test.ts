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

  dispatch(msg: unknown): void {
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
    client.dispatch({
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
    client.dispatch({ jsonrpc: "2.0", id: 9, method: "workspace/workspaceFolders" })
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
