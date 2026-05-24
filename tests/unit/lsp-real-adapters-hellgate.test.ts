/**
 * Hellgate — ADR-0143 real-adapter wiring.
 *
 * Seals the 3 default adapters (`DefaultCodeActionAdapter`,
 * `DefaultFormatAdapter`, `DefaultSignatureHelpAdapter`) that now wrap a real
 * `LspClient` (instead of the ADR-0141 `not-implemented` stubs), AND the 4 new
 * wire methods on `LspClient` itself.
 *
 * Strategy: use a `FakeLspClient` subclass of the real `LspClient` that
 * overrides `sendRequest` / `readFileText` / `writeFileText` to a scripted
 * replier — same pattern as `tests/unit/lsp-nav-rpc.test.ts`. The default
 * adapters consume the structurally-typed duck interface, so the fake
 * (= real subclass) satisfies both surfaces.
 *
 * Sealed slices:
 *   A. requestCodeActions (4 cases)         — happy / empty / throw / kind filter
 *   B. requestFormatting (3 cases)          — full-file / range / empty edits
 *   C. requestSignatureHelp (3 cases)       — happy / no sig / forwards args
 *   D. applyWorkspaceEdit (2 cases)         — multi-file write / write failure
 *   E. adapter wiring (2 cases)             — exact-kind narrowing / range absent
 */

import { describe, expect, test } from "bun:test"
import { pathToFileURL } from "node:url"
import {
  DefaultCodeActionAdapter,
  DefaultFormatAdapter,
  DefaultSignatureHelpAdapter,
  LspClient,
  type LspClientOptions,
  type LspClientSpec,
} from "@/lsp"
import { LspRequestError } from "@/lsp/adapters/base"
import type { JsonRpcError } from "@/lsp/adapters/jsonrpc"

/* ------------------------------------------------------------------ */
/* harness — mirrors `lsp-nav-rpc.test.ts`                            */
/* ------------------------------------------------------------------ */

type SentRequest = { kind: "request"; method: string; params: unknown }
type SentNotification = { kind: "notify"; method: string; params: unknown }
type Sent = SentRequest | SentNotification

type Reply = { result: unknown } | { error: JsonRpcError }
type Replier = (req: SentRequest) => Reply | Promise<Reply>

class FakeLspClient extends LspClient {
  readonly sent: Sent[] = []
  readonly writes: { path: string; text: string }[] = []
  private replier: Replier = () => ({ result: null })
  /** Map of path → on-disk text the fake serves to `readFileText`. */
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

  override async start(): Promise<void> {
    return
  }

  protected override sendRequest(method: string, params: unknown): Promise<unknown> {
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
}

const FILE = "/tmp/fixture.ts"
const r = (sl: number, sc: number, el: number, ec: number) => ({
  start: { line: sl, character: sc },
  end: { line: el, character: ec },
})

/* ------------------------------------------------------------------ */
/* A. requestCodeActions                                              */
/* ------------------------------------------------------------------ */

describe("LspClient.requestCodeActions (ADR-0143)", () => {
  test("HELL-A1: happy — 2 actions returned and mapped", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({
      result: [
        {
          title: "Add missing import",
          kind: "quickfix",
          edit: { changes: { "file:///a.ts": [{ range: r(0, 0, 0, 0), newText: "X" }] } },
        },
        {
          title: "Extract function",
          kind: "refactor.extract",
        },
      ],
    }))
    const out = await c.requestCodeActions(FILE, 3, 5)
    expect(out).toHaveLength(2)
    expect(out?.[0]?.title).toBe("Add missing import")
    expect(out?.[0]?.kind).toBe("quickfix")
    expect(out?.[0]?.edit?.changes).toEqual([
      { uri: "file:///a.ts", edits: [{ range: r(0, 0, 0, 0), newText: "X" }] },
    ])
    expect(out?.[1]?.kind).toBe("refactor.extract")
    expect(out?.[1]?.edit).toBeUndefined()
  })

  test("HELL-A2: empty array → empty array (not null)", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({ result: [] }))
    expect(await c.requestCodeActions(FILE, 1, 1)).toEqual([])
  })

  test("HELL-A3: server error other than unsupported → propagates", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({ error: { code: -32603, message: "Internal boom" } }))
    await expect(c.requestCodeActions(FILE, 1, 1)).rejects.toThrow(/Internal boom/)
  })

  test("HELL-A4: kind filter forwarded as `context.only`", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({ result: [] }))
    await c.requestCodeActions(FILE, 1, 1, "refactor")
    const req = c.sent.find(
      (s) => s.kind === "request" && s.method === "textDocument/codeAction",
    ) as SentRequest | undefined
    expect((req?.params as { context: { only?: string[] } }).context.only).toEqual(["refactor"])
  })

  test("HELL-A5: kind 'all' omits the filter", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({ result: [] }))
    await c.requestCodeActions(FILE, 1, 1, "all")
    const req = c.sent.find(
      (s) => s.kind === "request" && s.method === "textDocument/codeAction",
    ) as SentRequest | undefined
    expect("only" in (req?.params as { context: object }).context).toBe(false)
  })

  test("HELL-A6: unsupported (-32601) → null (not throw)", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({ error: { code: -32601, message: "Method not found" } }))
    expect(await c.requestCodeActions(FILE, 1, 1)).toBeNull()
  })

  test("HELL-A7: unknown kind string mapped to 'other'", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({
      result: [{ title: "Magic", kind: "magic.unicorn" }],
    }))
    const out = await c.requestCodeActions(FILE, 1, 1)
    expect(out?.[0]?.kind).toBe("other")
  })

  test("HELL-A8: legacy Command shape (no `edit`) maps to quickfix without edit", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({
      result: [{ title: "Run linter", command: "editor.lint" }],
    }))
    const out = await c.requestCodeActions(FILE, 1, 1)
    expect(out?.[0]).toEqual({ title: "Run linter", kind: "quickfix" })
  })
})

/* ------------------------------------------------------------------ */
/* B. requestFormatting                                               */
/* ------------------------------------------------------------------ */

describe("LspClient.requestFormatting (ADR-0143)", () => {
  test("HELL-B1: no range → `textDocument/formatting`", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({ result: [{ range: r(0, 0, 0, 4), newText: "    " }] }))
    const out = await c.requestFormatting(FILE)
    expect(out).toEqual([{ range: r(0, 0, 0, 4), newText: "    " }])
    const methods = c.sent.filter((s) => s.kind === "request").map((s) => s.method)
    expect(methods).toContain("textDocument/formatting")
    expect(methods).not.toContain("textDocument/rangeFormatting")
  })

  test("HELL-B2: with range → `textDocument/rangeFormatting`", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({ result: [] }))
    await c.requestFormatting(FILE, r(1, 0, 3, 0))
    const methods = c.sent.filter((s) => s.kind === "request").map((s) => s.method)
    expect(methods).toContain("textDocument/rangeFormatting")
    const req = c.sent.find(
      (s) => s.kind === "request" && s.method === "textDocument/rangeFormatting",
    ) as SentRequest | undefined
    expect((req?.params as { range: object }).range).toEqual(r(1, 0, 3, 0))
  })

  test("HELL-B3: empty edits → empty array", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({ result: [] }))
    expect(await c.requestFormatting(FILE)).toEqual([])
  })

  test("HELL-B4: null payload → null", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({ result: null }))
    expect(await c.requestFormatting(FILE)).toBeNull()
  })

  test("HELL-B5: unsupported → null", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({ error: { code: -32601, message: "Method not found" } }))
    expect(await c.requestFormatting(FILE)).toBeNull()
  })
})

/* ------------------------------------------------------------------ */
/* C. requestSignatureHelp                                            */
/* ------------------------------------------------------------------ */

describe("LspClient.requestSignatureHelp (ADR-0143)", () => {
  test("HELL-C1: happy — 1 signature with parameters + activeParameter", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({
      result: {
        signatures: [
          {
            label: "foo(a: number, b: string)",
            parameters: [{ label: "a: number" }, { label: "b: string" }],
            activeParameter: 1,
          },
        ],
      },
    }))
    const out = await c.requestSignatureHelp(FILE, 1, 5)
    expect(out).toHaveLength(1)
    expect(out?.[0]?.label).toBe("foo(a: number, b: string)")
    expect(out?.[0]?.parameters).toEqual([{ label: "a: number" }, { label: "b: string" }])
    expect(out?.[0]?.activeParameter).toBe(1)
  })

  test("HELL-C2: no payload → null", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({ result: null }))
    expect(await c.requestSignatureHelp(FILE, 1, 5)).toBeNull()
  })

  test("HELL-C3: empty signatures → empty array", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({ result: { signatures: [] } }))
    expect(await c.requestSignatureHelp(FILE, 1, 5)).toEqual([])
  })

  test("HELL-C4: line/col forwarded as 0-based position", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({ result: { signatures: [] } }))
    await c.requestSignatureHelp(FILE, 7, 12)
    const req = c.sent.find(
      (s) => s.kind === "request" && s.method === "textDocument/signatureHelp",
    ) as SentRequest | undefined
    expect((req?.params as { position: { line: number; character: number } }).position).toEqual({
      line: 7,
      character: 12,
    })
  })

  test("HELL-C5: parameter label as [start, end] tuple slices the signature", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({
      result: {
        signatures: [
          {
            label: "foo(a: number, b: string)",
            parameters: [{ label: [4, 13] }, { label: [15, 24] }],
          },
        ],
      },
    }))
    const out = await c.requestSignatureHelp(FILE, 1, 5)
    expect(out?.[0]?.parameters[0]?.label).toBe("a: number")
    expect(out?.[0]?.parameters[1]?.label).toBe("b: string")
  })

  test("HELL-C6: documentation as MarkupContent flattened to .value", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({
      result: {
        signatures: [
          {
            label: "foo()",
            documentation: { kind: "markdown", value: "# Foo" },
            parameters: [],
          },
        ],
      },
    }))
    const out = await c.requestSignatureHelp(FILE, 1, 5)
    expect(out?.[0]?.documentation).toBe("# Foo")
  })
})

/* ------------------------------------------------------------------ */
/* D. applyWorkspaceEdit                                              */
/* ------------------------------------------------------------------ */

describe("LspClient.applyWorkspaceEdit (ADR-0143)", () => {
  test("HELL-D1: multi-file edit → all files written with patched text", async () => {
    const c = new FakeLspClient()
    const a = "/tmp/proj/a.ts"
    const b = "/tmp/proj/b.ts"
    c.setFile(a, "hello world\n")
    c.setFile(b, "foo bar\n")
    await c.applyWorkspaceEdit({
      changes: [
        {
          uri: pathToFileURL(a).href,
          edits: [{ range: r(0, 0, 0, 5), newText: "HELLO" }],
        },
        {
          uri: pathToFileURL(b).href,
          edits: [{ range: r(0, 4, 0, 7), newText: "BAZ" }],
        },
      ],
    })
    expect(c.writes).toHaveLength(2)
    expect(c.writes[0]).toEqual({ path: a, text: "HELLO world\n" })
    expect(c.writes[1]).toEqual({ path: b, text: "foo BAZ\n" })
  })

  test("HELL-D2: write failure on a later file throws; earlier files already written", async () => {
    const c = new FakeLspClient()
    const a = "/tmp/proj/a.ts"
    const b = "/tmp/proj/b.ts"
    c.setFile(a, "alpha\n")
    c.setFile(b, "beta\n")
    c.setWriteThrow((p) => (p === b ? new Error("disk full") : null))
    await expect(
      c.applyWorkspaceEdit({
        changes: [
          {
            uri: pathToFileURL(a).href,
            edits: [{ range: r(0, 0, 0, 5), newText: "ALPHA" }],
          },
          {
            uri: pathToFileURL(b).href,
            edits: [{ range: r(0, 0, 0, 4), newText: "BETA" }],
          },
        ],
      }),
    ).rejects.toThrow(/disk full/)
    // First file is on disk (per-file atomicity caveat — v2 follow-up for
    // 2-phase temp+rename across the whole edit).
    expect(c.writes).toHaveLength(1)
    expect(c.writes[0]?.path).toBe(a)
  })

  test("HELL-D3: multi-edit single file applies in reverse offset order (no clobber)", async () => {
    const c = new FakeLspClient()
    const a = "/tmp/proj/a.ts"
    c.setFile(a, "abcdefgh\n")
    await c.applyWorkspaceEdit({
      changes: [
        {
          uri: pathToFileURL(a).href,
          edits: [
            { range: r(0, 1, 0, 2), newText: "B" }, // b→B
            { range: r(0, 5, 0, 6), newText: "F" }, // f→F
          ],
        },
      ],
    })
    expect(c.writes[0]?.text).toBe("aBcdeFgh\n")
  })

  test("HELL-D4: documentChanges variant is normalized to changes", async () => {
    // Construct via requestCodeActions to exercise the documentChanges path.
    const c = new FakeLspClient()
    const a = "/tmp/proj/c.ts"
    c.setFile(a, "old\n")
    c.setReplier(() => ({
      result: [
        {
          title: "Patch",
          kind: "quickfix",
          edit: {
            documentChanges: [
              {
                textDocument: { uri: pathToFileURL(a).href, version: 1 },
                edits: [{ range: r(0, 0, 0, 3), newText: "new" }],
              },
            ],
          },
        },
      ],
    }))
    const actions = await c.requestCodeActions(FILE, 1, 1)
    const edit = actions?.[0]?.edit
    expect(edit).toBeDefined()
    if (!edit) return
    await c.applyWorkspaceEdit(edit)
    expect(c.writes[0]?.text).toBe("new\n")
  })
})

/* ------------------------------------------------------------------ */
/* E. Adapter wiring                                                  */
/* ------------------------------------------------------------------ */

describe("DefaultCodeActionAdapter (ADR-0143 wiring)", () => {
  test("HELL-E1: forwards request to LspClient + narrows by exact port-level kind", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({
      result: [
        { title: "Inline", kind: "refactor.inline" },
        { title: "Extract", kind: "refactor.extract" },
      ],
    }))
    const adapter = new DefaultCodeActionAdapter(c)
    // Wire-level filter coarsens to "refactor"; port-level "refactor.inline"
    // must filter the wire result down to exactly the inline action.
    const out = await adapter.resolveCodeActions("x.ts", 0, 0, "refactor.inline")
    expect(out).toHaveLength(1)
    expect(out?.[0]?.title).toBe("Inline")
  })

  test("HELL-E2: server error propagates through adapter", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({ error: { code: -32603, message: "boom" } }))
    const adapter = new DefaultCodeActionAdapter(c)
    await expect(adapter.resolveCodeActions("x.ts", 0, 0)).rejects.toThrow(/boom/)
  })

  test("HELL-E3: applyEdit delegates to LspClient.applyWorkspaceEdit", async () => {
    const c = new FakeLspClient()
    const a = "/tmp/y.ts"
    c.setFile(a, "12345\n")
    const adapter = new DefaultCodeActionAdapter(c)
    await adapter.applyEdit({
      changes: [
        {
          uri: pathToFileURL(a).href,
          edits: [{ range: r(0, 0, 0, 5), newText: "ABCDE" }],
        },
      ],
    })
    expect(c.writes[0]?.text).toBe("ABCDE\n")
  })
})

describe("DefaultFormatAdapter (ADR-0143 wiring)", () => {
  test("HELL-E4: range absent → adapter calls client without range", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({ result: [] }))
    const adapter = new DefaultFormatAdapter(c)
    await adapter.format("x.ts")
    const methods = c.sent.filter((s) => s.kind === "request").map((s) => s.method)
    expect(methods).toContain("textDocument/formatting")
    expect(methods).not.toContain("textDocument/rangeFormatting")
  })

  test("HELL-E5: range present → adapter calls client with range", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({ result: [] }))
    const adapter = new DefaultFormatAdapter(c)
    await adapter.format("x.ts", r(0, 0, 1, 0))
    const methods = c.sent.filter((s) => s.kind === "request").map((s) => s.method)
    expect(methods).toContain("textDocument/rangeFormatting")
  })
})

describe("DefaultSignatureHelpAdapter (ADR-0143 wiring)", () => {
  test("HELL-E6: forwards file/line/col to LspClient + returns mapped signatures", async () => {
    const c = new FakeLspClient()
    c.setReplier(() => ({
      result: { signatures: [{ label: "f()", parameters: [], activeParameter: null }] },
    }))
    const adapter = new DefaultSignatureHelpAdapter(c)
    const out = await adapter.signatureHelp("x.ts", 4, 9)
    expect(out).toHaveLength(1)
    expect(out?.[0]?.label).toBe("f()")
    expect(out?.[0]?.activeParameter).toBeNull()
    const req = c.sent.find(
      (s) => s.kind === "request" && s.method === "textDocument/signatureHelp",
    ) as SentRequest | undefined
    expect((req?.params as { position: { line: number; character: number } }).position).toEqual({
      line: 4,
      character: 9,
    })
  })
})
