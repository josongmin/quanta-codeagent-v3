/**
 * Hellgate — RFC jun-17 UX: the nav tool emits a "initializing language server"
 * progress event BEFORE `provider.open()` so a cold-workspace stall (or a join
 * onto an in-flight background warm) is never a SILENT block. Round-trip:
 *
 *   UX-01  a progress event is emitted before the `analyzing …` event, and
 *          before the (slow) open resolves.
 *   UX-02  even when the server is unavailable, the pre-open progress still
 *          fires (the user sees activity, then the clean unavailable result).
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LspNavProvider, LspNavSession, ToolContext, ToolEvent } from "@/tool"
import { lspNavTools, nullLspNavProvider } from "@/tool/lsp_nav"

const fakeSession = (): LspNavSession =>
  ({
    definition: async () => [],
    references: async () => [],
    hover: async () => null,
    typeDefinition: async () => [],
    implementation: async () => [],
    documentSymbol: async () => [],
    workspaceSymbol: async () => [],
    prepareRename: async () => null,
    incomingCalls: async () => [],
    outgoingCalls: async () => [],
    stop: async () => {},
  }) as LspNavSession

const drive = async (provider: LspNavProvider, cwd: string): Promise<ToolEvent[]> => {
  const def = lspNavTools(provider).find((t) => t.name === "lsp_definition")
  if (!def) throw new Error("lsp_definition tool missing")
  const ctx = { signal: new AbortController().signal, cwd } as unknown as ToolContext
  const events: ToolEvent[] = []
  for await (const e of def.execute({ path: "a.py", line: 1, character: 1 } as never, ctx)) {
    events.push(e as ToolEvent)
  }
  return events
}

const msgs = (events: ToolEvent[]): string[] =>
  events.filter((e) => e.type === "progress").map((e) => (e as { message: string }).message)

describe("RFC jun-17 — nav-tool pre-open warm-status UX", () => {
  test("UX-01: 'initializing language server' progress precedes 'analyzing' (no silent block)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ux-"))
    let opened = false
    const provider: LspNavProvider = {
      unavailableReason: () => "n/a",
      open: async () => {
        // Simulate a cold/slow open: the progress must already have been emitted
        // by the time we get here.
        await new Promise((r) => setTimeout(r, 10))
        opened = true
        return fakeSession()
      },
    }
    const events = await drive(provider, dir)
    const progress = msgs(events)
    expect(opened).toBe(true)
    const initIdx = progress.findIndex((m) => m.includes("initializing language server"))
    const analyzingIdx = progress.findIndex((m) => m.startsWith("analyzing"))
    expect(initIdx).toBeGreaterThanOrEqual(0)
    expect(analyzingIdx).toBeGreaterThan(initIdx) // ordering: init BEFORE analyzing
  })

  test("UX-02: the pre-open progress still fires when the server is unavailable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ux-"))
    const events = await drive(nullLspNavProvider, dir)
    expect(msgs(events).some((m) => m.includes("initializing language server"))).toBe(true)
    // …and the terminal result is the clean unavailable message, not a crash.
    const last = events.at(-1) as { type: string; result?: { ok: boolean } }
    expect(last.type).toBe("result")
    expect(last.result?.ok).toBe(false)
  })
})
