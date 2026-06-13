/**
 * T06 — LSP-as-MCP BRIDGE hellgate (jun-13 Codex-IDE reabsorption).
 *
 * Codex IDE spins up an in-process `vscode-codex-lsp-mcp-server` so a standalone
 * CLI agent gets the editor's language intelligence (diagnostics / references /
 * workspace symbols) as MCP tools WITHOUT an IDE. quanta already owns the LSP
 * client AND read-only LSP tools (`lsp_diagnostics` / `lsp_references` /
 * `lsp_workspace_symbol` / …) — but the reverse-MCP server (`quanta mcp-server`)
 * assembles via the headless `assembleAgentConfig` path, which wires neither the
 * `lsp` knob nor the CLI's `QUANTA_LSP_TOOLS` surface. So those tools never reach
 * the MCP registry: the BRIDGE is absent even though the TOOLS exist.
 *
 * This ticket is the bridge — NOT 3 new duplicate tools. A new `QUANTA_LSP_MCP`
 * gate, when set, merges the EXISTING read-only LSP tools into the reverse-MCP
 * server's registry so they project into `tools/list` and dispatch through the
 * real fold. Default-OFF: gate unset ⇒ byte-identical to today (no LSP tools
 * exposed). Mutating LSP tools (`lsp_rename_apply`) are NOT exposed.
 *
 * Real effect (UC1/UC2): the bridge accepts an injected LSP-tool builder seam
 * (production builds the real `lspNavToolList()`/`lspDiagnosticsTool()` lazily);
 * here we feed tools backed by a FAKE provider returning scripted locations /
 * diagnostics and observe them flow back through the FULL JSON-RPC pipeline
 * (fresh-readback: the exact scripted `path:line` appears in the MCP reply).
 *
 * Strong-test discipline ([[test-quality-culture-portable]]): every gate-on
 * assertion is paired with the gate-OFF control on the SAME server; real
 * effect is observed (not mocked at the assertion boundary); the no-binary
 * graceful path (UC6) is proven on the REAL tools.
 */

import { describe, expect, test } from "bun:test"
import { z } from "zod"
import type { McpServerCmdDeps } from "@/apps/cli/mcp-server-setup"
import { runMcpServerCmd } from "@/apps/cli/mcp-server-setup"
import type { Tool } from "@/tool"
import {
  type DiagnosticsProvider,
  diagnosticsTool,
  type LspNavProvider,
  type LspNavSession,
  lspNavTools,
  type NavLocation,
  type NavSymbolInfo,
} from "@/tool"

// ── JSON-RPC driver over the real `runMcpServerCmd` ────────────────────────

interface JsonRpcResponse {
  readonly id?: number
  readonly result?: {
    tools?: { name: string }[]
    nextCursor?: string
    content?: { text?: string }[]
  }
  readonly error?: { code: number; message: string }
}

/** Drive the reverse-MCP command end-to-end: set the env it reads, feed a
 *  batch of newline-framed JSON-RPC requests on stdin, capture stdout/stderr,
 *  and parse the responses. `tools/list` is paged (pageSize 50): we preemptively
 *  request cursors 0/50/100 and union the pages (a stale cursor returns a
 *  -32602 error we ignore). Env is restored in `finally`. */
const driveMcp = async (
  env: Record<string, string | undefined>,
  requests: object[],
  deps?: McpServerCmdDeps,
): Promise<{ exit: number; responses: JsonRpcResponse[]; stderr: string }> => {
  const out: string[] = []
  const err: string[] = []
  async function* stdin(): AsyncGenerator<Uint8Array> {
    const enc = new TextEncoder()
    for (const r of requests) yield enc.encode(`${JSON.stringify(r)}\n`)
  }
  const io = {
    out: (s: string) => {
      out.push(s)
    },
    err: (s: string) => {
      err.push(s)
    },
    stdin: stdin(),
  }

  const KEYS = [
    "QUANTA_MCP_SERVER",
    "QUANTA_LSP_MCP",
    "QUANTA_MCP_SERVER_EXPOSE",
    "OPENAI_API_KEY",
    "QUANTA_PROVIDER",
  ]
  const saved = new Map<string, string | undefined>()
  for (const k of KEYS) saved.set(k, process.env[k])
  try {
    for (const k of KEYS) delete process.env[k]
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    const exit = await runMcpServerCmd([], io, deps)
    const responses = out
      .join("")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as JsonRpcResponse)
    return { exit, responses, stderr: err.join("") }
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

/** A minimal, valid env that lets `assembleAgentConfig` succeed headlessly
 *  (a dummy key — no LLM call is made for tools/list or LSP dispatch). */
const baseEnv = (
  extra: Record<string, string | undefined>,
): Record<string, string | undefined> => ({
  QUANTA_MCP_SERVER: "1",
  OPENAI_API_KEY: "sk-test-not-real",
  QUANTA_PROVIDER: "openai",
  ...extra,
})

const LIST_REQUESTS = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
  { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  { jsonrpc: "2.0", id: 3, method: "tools/list", params: { cursor: "quanta-mcp:50" } },
  { jsonrpc: "2.0", id: 4, method: "tools/list", params: { cursor: "quanta-mcp:100" } },
]

/** Union every tool name across all (paged) tools/list responses. Also asserts
 *  the paging was EXHAUSTIVE: the last page we requested (cursor 100) must not
 *  hand back a further `nextCursor` — otherwise the registry grew past our
 *  fixed cursors and the union would silently miss tools (a vacuous-pass trap). */
const collectToolNames = (responses: JsonRpcResponse[]): Set<string> => {
  const names = new Set<string>()
  for (const r of responses) for (const t of r.result?.tools ?? []) names.add(t.name)
  const lastPage = responses.find((r) => r.id === 4)
  // id=4 used cursor:100; if it returned a page WITH a nextCursor, >150 tools
  // are exposed and our 0/50/100 sweep is no longer exhaustive.
  expect(lastPage?.result?.nextCursor).toBeUndefined()
  return names
}

// ── Fake LSP providers (scripted real effect) ─────────────────────────────

const REF_URI = "file:///fake/alpha-usage.ts"
const REF_LINE0 = 41 // 0-based ⇒ surfaces as :42
const SYM_URI = "file:///fake/widget.ts"
const SYM_LINE0 = 9 // ⇒ :10
const DIAG_LINE0 = 6 // ⇒ :7

/** Session whose list methods return scripted payloads; the rest are clean
 *  no-answers (`null`). */
const fakeSession = (): LspNavSession => ({
  definition: async () => null,
  references: async (): Promise<NavLocation[]> => [
    {
      uri: REF_URI,
      range: { start: { line: REF_LINE0, character: 2 }, end: { line: REF_LINE0, character: 8 } },
    },
  ],
  hover: async () => null,
  typeDefinition: async () => null,
  implementation: async () => null,
  documentSymbol: async () => null,
  workspaceSymbol: async (): Promise<NavSymbolInfo[]> => [
    {
      name: "WidgetFactory",
      kind: "class",
      range: { start: { line: SYM_LINE0, character: 0 }, end: { line: SYM_LINE0, character: 20 } },
      selectionRange: {
        start: { line: SYM_LINE0, character: 6 },
        end: { line: SYM_LINE0, character: 19 },
      },
      uri: SYM_URI,
    },
  ],
  prepareRename: async () => null,
  incomingCalls: async () => null,
  outgoingCalls: async () => null,
  stop: async () => undefined,
})

const fakeNavProvider: LspNavProvider = {
  unavailableReason: () => "fake: no server",
  open: async () => fakeSession(),
}

const fakeDiagProvider: DiagnosticsProvider = {
  unavailableReason: () => "fake: no server",
  open: async () => ({
    diagnostics: async () => [
      {
        severity: "error" as const,
        message: "Type 'string' is not assignable to type 'number'.",
        range: { start: { line: DIAG_LINE0, character: 4 } },
        source: "ts",
        code: "2322",
      },
    ],
    stop: async () => undefined,
  }),
}

/** A FAKE MUTATING lsp tool — stands in for the real `lsp_rename_apply` that
 *  `lspNavToolList()` bundles. The bridge MUST drop it (read-only filter) so it
 *  never enters the registry — otherwise `QUANTA_MCP_SERVER_EXPOSE` could
 *  force-opt-in a mutating tool an external client then dispatches. */
const fakeMutatingRenameTool: Tool = {
  name: "lsp_rename_apply",
  description: "fake mutating rename",
  inputSchema: z.object({ path: z.string() }),
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async *execute() {
    yield { type: "result" as const, result: { ok: true, output: "RENAMED (should never run)" } }
  },
}

/** The injected bridge tool builder: the read-only LSP tools backed by the
 *  fake providers PLUS a mutating tool the filter must drop. (`lspNavTools`
 *  yields 10 read-only nav tools; we append the diagnostics tool — read-only —
 *  and the mutating rename stand-in.) */
const fakeBridgeTools = (): Tool[] => [
  ...lspNavTools(fakeNavProvider),
  diagnosticsTool(fakeDiagProvider) as Tool,
  fakeMutatingRenameTool,
]

const fakeDeps: McpServerCmdDeps = { lspToolsForBridge: fakeBridgeTools }

// ───────────────────────────────────────────────────────────────────────────

describe("T06 LSP-as-MCP bridge", () => {
  // UC4 — default-OFF: gate unset ⇒ NO lsp_* nav tools projected (byte-identical).
  // (`diagnostics` is a BASE tool always exposed read-only — see the upgrade
  // paired-control test below for what the gate changes about it.)
  test("default-OFF: QUANTA_LSP_MCP unset ⇒ lsp nav tools absent from tools/list", async () => {
    const { exit, responses } = await driveMcp(baseEnv({}), LIST_REQUESTS, fakeDeps)
    expect(exit).toBe(0)
    const names = collectToolNames(responses)
    // Unconditional sanity: the server DID expose its normal read-only surface.
    expect(names.size).toBeGreaterThan(0)
    // The narrowing assertion: no LSP nav tool leaked without the gate.
    expect(names.has("lsp_references")).toBe(false)
    expect(names.has("lsp_workspace_symbol")).toBe(false)
    expect(names.has("lsp_document_symbol")).toBe(false)
  })

  // UC1/UC3 — gate ON exposes the read-only LSP family; mutating excluded.
  test("gate ON: read-only LSP tools projected into tools/list; mutating excluded", async () => {
    const { exit, responses } = await driveMcp(
      baseEnv({ QUANTA_LSP_MCP: "1" }),
      LIST_REQUESTS,
      fakeDeps,
    )
    expect(exit).toBe(0)
    const names = collectToolNames(responses)
    expect(names.has("lsp_references")).toBe(true)
    expect(names.has("lsp_workspace_symbol")).toBe(true)
    expect(names.has("lsp_document_symbol")).toBe(true)
    expect(names.has("diagnostics")).toBe(true)
    // Mutating LSP tool is NOT bridged (read-only whitelist + explicit filter).
    expect(names.has("lsp_rename_apply")).toBe(false)
  })

  // SECURITY teeth for the read-only filter: the mutating tool must be kept OUT
  // of the registry entirely, so even an explicit `QUANTA_MCP_SERVER_EXPOSE`
  // cannot force-opt-it-in. Without the filter, the tool would be in the
  // registry, opted-in by EXPOSE, whitelisted, and DISPATCHED — RCE. With it,
  // EXPOSE sees an unknown name and `tools/call` is refused (-32602).
  test("mutating LSP tool cannot be force-opted-in via QUANTA_MCP_SERVER_EXPOSE", async () => {
    const reqs = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "lsp_rename_apply", arguments: { path: "src/x.ts" } },
      },
    ]
    const { responses } = await driveMcp(
      baseEnv({ QUANTA_LSP_MCP: "1", QUANTA_MCP_SERVER_EXPOSE: "lsp_rename_apply" }),
      reqs,
      fakeDeps,
    )
    const call = responses.find((r) => r.id === 2)
    expect(call?.error?.code).toBe(-32602) // not exposed — never dispatched
    const text = call?.result?.content?.map((c) => c.text ?? "").join("\n") ?? ""
    expect(text).not.toContain("RENAMED") // the mutating execute never ran
  })

  // UC1 — references real effect: scripted location flows back through the full
  // JSON-RPC pipeline (fresh-readback on the exact path:line).
  test("tools/call lsp_references returns the scripted reference path:line", async () => {
    const reqs = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "lsp_references", arguments: { path: "src/x.ts", line: 1, character: 1 } },
      },
    ]
    const { responses } = await driveMcp(baseEnv({ QUANTA_LSP_MCP: "1" }), reqs, fakeDeps)
    const call = responses.find((r) => r.id === 2)
    expect(call).toBeDefined()
    expect(call?.error).toBeUndefined()
    const text = call?.result?.content?.map((c) => c.text ?? "").join("\n") ?? ""
    expect(text).toContain("alpha-usage.ts:42")
  })

  // UC2 — diagnostics real effect + UPGRADE proof. The base `diagnostics` tool
  // ships a null provider ("no diagnostics" no matter what); the bridge must
  // OVERRIDE it with the real provider. Paired control: same call, gate OFF,
  // gets the null-provider answer — so the scripted error is attributable to
  // the bridge's override, not to the tool merely existing.
  const diagReqs = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "diagnostics", arguments: { path: "src/x.ts" } },
    },
  ]
  test("tools/call diagnostics (gate ON) returns the scripted type error via the bridged provider", async () => {
    const { responses } = await driveMcp(baseEnv({ QUANTA_LSP_MCP: "1" }), diagReqs, fakeDeps)
    const call = responses.find((r) => r.id === 2)
    expect(call?.error).toBeUndefined()
    const text = call?.result?.content?.map((c) => c.text ?? "").join("\n") ?? ""
    expect(text).toContain(":7:5")
    expect(text).toContain("not assignable")
  })
  test("paired control: diagnostics (gate OFF) still uses the null provider (no scripted error)", async () => {
    const { responses } = await driveMcp(baseEnv({}), diagReqs, fakeDeps)
    const call = responses.find((r) => r.id === 2)
    expect(call?.error).toBeUndefined() // base tool is exposed read-only
    const text = call?.result?.content?.map((c) => c.text ?? "").join("\n") ?? ""
    expect(text).not.toContain("not assignable")
  })

  // UC3 — workspace symbols real effect.
  test("tools/call lsp_workspace_symbol returns the scripted symbol", async () => {
    const reqs = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "lsp_workspace_symbol", arguments: { path: "src/x.ts", query: "Widget" } },
      },
    ]
    const { responses } = await driveMcp(baseEnv({ QUANTA_LSP_MCP: "1" }), reqs, fakeDeps)
    const call = responses.find((r) => r.id === 2)
    expect(call?.error).toBeUndefined()
    const text = call?.result?.content?.map((c) => c.text ?? "").join("\n") ?? ""
    expect(text).toContain("WidgetFactory")
    expect(text).toContain("widget.ts:10")
  })

  // UC6 — LSP not-ready / no binary: the REAL bridge tools degrade gracefully
  // (no JSON-RPC error, no crash, clean exit) instead of failing the pump.
  test("real bridge with no language server: graceful unavailable, no crash", async () => {
    const reqs = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "lsp_references", arguments: { path: "src/x.ts", line: 1, character: 1 } },
      },
    ]
    // No fakeDeps ⇒ the production builder wires the real provider; with no
    // typescript-language-server on PATH the provider yields null ⇒ unavailable.
    const { exit, responses } = await driveMcp(baseEnv({ QUANTA_LSP_MCP: "1" }), reqs)
    expect(exit).toBe(0)
    const call = responses.find((r) => r.id === 2)
    expect(call).toBeDefined()
    expect(call?.error).toBeUndefined() // graceful tool_result, NOT a protocol error
    const text = call?.result?.content?.map((c) => c.text ?? "").join("\n") ?? ""
    expect(text.toLowerCase()).toContain("unavailable")
  })
})
