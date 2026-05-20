/**
 * LSP `diagnostics` tool e2e — closes the L3 gap for diagnostics
 * (catalog row 9.2 / ADR-0009). The `lsp_*` nav tools (ADR-0024) are already
 * L4; this brings the original `diagnostics` surface to parity.
 *
 *   ScriptedLLM → tool_use(diagnostics, {path}) → real ToolRegistry with the
 *   tool built around an injected DiagnosticsProvider → dispatch → tool_result
 *   on the agent stream → loop continues with the follow-up step.
 *
 * Three closure scenarios:
 *   1. Fake provider returning real diagnostics → tool_result.ok=true with the
 *      formatted summary in `preview`.
 *   2. Null provider (`nullDiagnosticsProvider`) → tool_result.ok=false with
 *      a clean "no language server" message. Loop continues (graceful degrade
 *      is the whole reason ADR-0009 chose this shape).
 *   3. Provider whose session.diagnostics() throws → tool_result.ok=false,
 *      session.stop() is still called (exception-safe lifecycle).
 *
 * Slice isolation respected: `diagnosticsTool` lives in `@/tool`; the real
 * LSP-backed provider is in `@/agent/lsp-bridge.ts`. This test injects fake
 * providers, so no language server binary is needed (we already have a
 * separate `tests/contract/lsp-*.test.ts` for real-server contract checks).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runAgent } from "@/agent"
import {
  type DiagnosticsProvider,
  type DiagnosticsSession,
  defaultTools,
  diagnosticsTool,
  nullDiagnosticsProvider,
  type Tool,
  ToolRegistry,
} from "@/tool"
import { cfg, ev, RecordingStream, ScriptedLLM, text, toolUse, withTimeout } from "./_harness"

const swapDiagnosticsTool = (replacement: Tool): Tool[] =>
  defaultTools.map((t) => (t.name === "diagnostics" ? replacement : t))

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "lsp-e2e-"))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("LSP diagnostics e2e — diagnostics tool through real runAgent loop", () => {
  test("fake provider reporting errors → tool_result.ok=false (errors found), formatted summary in preview", async () => {
    const stopped: string[] = []
    const fakeProvider: DiagnosticsProvider = {
      unavailableReason: () => "unused",
      open: async (filePath): Promise<DiagnosticsSession> => ({
        diagnostics: async () => [
          {
            severity: "error",
            message: "Type 'string' is not assignable to type 'number'.",
            range: { start: { line: 2, character: 6 } },
            source: "ts",
            code: "2322",
          },
          {
            severity: "warning",
            message: "unused variable",
            range: { start: { line: 5, character: 0 } },
            source: "ts",
          },
        ],
        stop: async () => {
          stopped.push(filePath)
        },
      }),
    }
    const tool = diagnosticsTool(fakeProvider)

    const llm = new ScriptedLLM([
      ev(toolUse("d-1", "diagnostics", { path: "src/bad.ts" })),
      ev(text("acknowledged")),
    ])
    const stream = new RecordingStream()
    const config = cfg({
      llm,
      registry: new ToolRegistry(swapDiagnosticsTool(tool as Tool)),
      stream,
      cwd: dir,
    })

    const outcome = await withTimeout(runAgent(config), 10_000, "diagnostics happy-path")
    expect(outcome.reason).toBe("completed")

    const result = stream.events.find((e) => e.type === "tool_result" && e.name === "diagnostics")
    expect(result).toBeDefined()
    if (result && result.type === "tool_result") {
      // Contract: `ok = !hasError` (src/tool/diagnostics/index.ts:141). The
      // fake reported one error + one warning ⇒ ok is false. The formatted
      // summary still rides on `preview` regardless of ok.
      expect(result.ok).toBe(false)
      // formatter emits 1-based human coords (`+1` in formatOne)
      expect(result.preview).toContain("1 error(s), 1 warning(s)")
      expect(result.preview).toContain("src/bad.ts:3:7 error")
      expect(result.preview).toContain("src/bad.ts:6:1 warning")
    }
    // Lifecycle: tool MUST close the session after use.
    expect(stopped.length).toBe(1)
  }, 15_000)

  test("fake provider reporting NO diagnostics → tool_result.ok=true (clean file)", async () => {
    // Control: a clean file produces `ok:true` (no errors) and the formatter's
    // "no diagnostics" message in the preview. Pins the `!hasError` contract
    // from the other direction.
    const cleanProvider: DiagnosticsProvider = {
      unavailableReason: () => "unused",
      open: async (): Promise<DiagnosticsSession> => ({
        diagnostics: async () => [],
        stop: async () => {},
      }),
    }
    const tool = diagnosticsTool(cleanProvider)
    const llm = new ScriptedLLM([
      ev(toolUse("d-clean", "diagnostics", { path: "src/clean.ts" })),
      ev(text("nothing to fix")),
    ])
    const stream = new RecordingStream()
    const config = cfg({
      llm,
      registry: new ToolRegistry(swapDiagnosticsTool(tool as Tool)),
      stream,
      cwd: dir,
    })
    const outcome = await withTimeout(runAgent(config), 10_000, "diagnostics clean-file")
    expect(outcome.reason).toBe("completed")
    const result = stream.events.find((e) => e.type === "tool_result" && e.name === "diagnostics")
    expect(result).toBeDefined()
    if (result && result.type === "tool_result") {
      expect(result.ok).toBe(true)
      expect(result.preview).toContain("no diagnostics")
    }
  }, 15_000)

  test("null provider (no LSP) → graceful ok:false, loop still completes", async () => {
    const tool = diagnosticsTool(nullDiagnosticsProvider)
    const llm = new ScriptedLLM([
      ev(toolUse("d-2", "diagnostics", { path: "any.py" })),
      ev(text("nothing to check")),
    ])
    const stream = new RecordingStream()
    const config = cfg({
      llm,
      registry: new ToolRegistry(swapDiagnosticsTool(tool as Tool)),
      stream,
      cwd: dir,
    })

    const outcome = await withTimeout(runAgent(config), 10_000, "diagnostics null-degrade")
    expect(outcome.reason).toBe("completed")

    const result = stream.events.find((e) => e.type === "tool_result" && e.name === "diagnostics")
    expect(result).toBeDefined()
    if (result && result.type === "tool_result") {
      expect(result.ok).toBe(false)
      expect(result.preview).toContain("no language server")
    }
  }, 15_000)

  test("session.diagnostics() throws → ok:false, stop() still called (lifecycle safety)", async () => {
    const stopped: string[] = []
    const throwingProvider: DiagnosticsProvider = {
      unavailableReason: () => "unused",
      open: async (filePath): Promise<DiagnosticsSession> => ({
        diagnostics: async () => {
          throw new Error("server-internal-error")
        },
        stop: async () => {
          stopped.push(filePath)
        },
      }),
    }
    const tool = diagnosticsTool(throwingProvider)
    const llm = new ScriptedLLM([
      ev(toolUse("d-3", "diagnostics", { path: "broken.ts" })),
      ev(text("noted")),
    ])
    const stream = new RecordingStream()
    const config = cfg({
      llm,
      registry: new ToolRegistry(swapDiagnosticsTool(tool as Tool)),
      stream,
      cwd: dir,
    })

    const outcome = await withTimeout(runAgent(config), 10_000, "diagnostics throw-path")
    expect(outcome.reason).toBe("completed")

    const result = stream.events.find((e) => e.type === "tool_result" && e.name === "diagnostics")
    expect(result).toBeDefined()
    if (result && result.type === "tool_result") {
      expect(result.ok).toBe(false)
      expect(result.preview.toLowerCase()).toContain("server-internal-error")
    }
    // Whatever the failure, the session MUST be closed — otherwise we'd
    // leak language-server processes on every transient error.
    expect(stopped.length).toBe(1)
  }, 15_000)
})
