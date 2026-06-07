/**
 * code-mode (RFC jun-6-code-mode) — POST-FAULT memory classification E2E through
 * the PRODUCTION `code_cell` tool entry (REAL quickjs-emscripten + the real
 * `codeCellTool().execute` → `runCodeCell` → `toToolResult` mapping).
 *
 * Unlike the unit hellgate (which drives `runCodeCell` directly), this exercises
 * the WHOLE production path the model sees:
 *   - the `code_cell` tool resolves its hard caps from runtime-config (here a
 *     REALISTIC injected `QUANTA_CODE_MODE_MEM_BYTES` of a few MB, not a 256 KiB
 *     toy), then
 *   - runs the cell in the sandbox, and
 *   - maps the finished {@link CodeCellResult} to the model-facing `ToolResult`.
 *
 * STRUCTURAL FIX (jun-07): a bulk over-allocation past the cap must terminate with
 * the dedicated `"memory"` status, surfaced to the model as `ok:false` with the
 * `code_cell_memory` tag + a "memory limit exceeded" message — NOT the generic
 * `code_cell_error`. The post-fault classifier keys on QuickJS's own
 * `InternalError: out of memory` (a structured error-TYPE signal), so the bulk
 * shape the old per-tick watchdog missed is now correctly labelled end-to-end.
 */

import { afterEach, beforeEach, expect, test } from "bun:test"
import type { DispatchOutcome } from "@/codemode"
import { __resetRuntimeConfig } from "@/shared"
import { codeCellTool, type ToolContext, type ToolResult } from "@/tool"

/** A realistic injected heap cap — a few MB, NOT the 256 KiB toy. */
const REALISTIC_MEM_BYTES = 4 * 1024 * 1024

/** Extract the model-visible error tag from a typed `mode:"error"` failure. */
const errorTag = (r: ToolResult): string | undefined =>
  r.failure?.mode === "error" ? r.failure.modelVisibleError : undefined

/** Drain the tool's single-result iterator into the typed ToolResult. */
const runTool = async (code: string, ctx: ToolContext): Promise<ToolResult> => {
  const tool = codeCellTool()
  let result: ToolResult | undefined
  for await (const ev of tool.execute({ code }, ctx)) {
    if (ev.type === "result") result = ev.result
  }
  if (result === undefined) throw new Error("code_cell yielded no result")
  return result
}

/** Minimal ToolContext with a no-op dispatch port (an OOM cell never reaches a
 *  tool call). The port is what makes the tool consider itself "wired". */
const ctxWithPort = (): ToolContext => {
  const dispatch = async (): Promise<DispatchOutcome> => ({ ok: true, content: "" })
  return {
    cwd: "/repo",
    signal: new AbortController().signal,
    codeCellDispatch: dispatch,
  } as unknown as ToolContext
}

const originalMem = process.env.QUANTA_CODE_MODE_MEM_BYTES
beforeEach(() => {
  process.env.QUANTA_CODE_MODE_MEM_BYTES = String(REALISTIC_MEM_BYTES)
  __resetRuntimeConfig()
})
afterEach(() => {
  if (originalMem === undefined) delete process.env.QUANTA_CODE_MODE_MEM_BYTES
  else process.env.QUANTA_CODE_MODE_MEM_BYTES = originalMem
  __resetRuntimeConfig()
})

test("e2e — a bulk over-allocation past a realistic cap terminates with the model-visible 'code_cell_memory' tag", async () => {
  // ~80 MB of array slots — far past the injected 4 MB cap, so it reliably OOMs.
  const r = await runTool(`const a = new Array(10000000).fill(0); return a.length;`, ctxWithPort())
  // The cell is NOT ok — and the model-facing failure is the DEDICATED memory tag,
  // not the generic code_cell_error (red-on-injection: without the post-fault
  // classifier this maps to code_cell_error).
  expect(r.ok).toBe(false)
  expect(errorTag(r)).toBe("code_cell_memory")
  // The model-visible output carries both the dedicated status header AND the
  // consistent "memory limit exceeded" message (no status/message divergence).
  expect(r.output).toContain("[code_cell memory]")
  expect(r.output).toContain("memory limit exceeded")
}, 20000)

test("e2e — an incremental over-allocation past a realistic cap is also tagged 'code_cell_memory'", async () => {
  const r = await runTool(
    `const a = []; for (let i = 0; i < 1e8; i++) { a.push({ x: i, pad: "padding-" + i }); } return a.length;`,
    ctxWithPort(),
  )
  expect(r.ok).toBe(false)
  expect(errorTag(r)).toBe("code_cell_memory")
  expect(r.output).toContain("memory limit exceeded")
}, 20000)

test("e2e — a normal compute cell stays ok end-to-end (no memory false-positive)", async () => {
  const r = await runTool(
    `let s = 0; for (let i = 0; i < 1000; i++) s += i; return s;`,
    ctxWithPort(),
  )
  expect(r.ok).toBe(true)
  expect(r.output).toContain("[code_cell ok]")
  expect(r.output).toContain("499500")
})

test("e2e — a plain throw stays the generic 'code_cell_error' tag (no memory mislabel)", async () => {
  const r = await runTool(`throw new Error("kaboom");`, ctxWithPort())
  expect(r.ok).toBe(false)
  expect(errorTag(r)).toBe("code_cell_error")
  expect(r.output).toContain("[code_cell error]")
  expect(r.output).not.toContain("memory limit exceeded")
})
