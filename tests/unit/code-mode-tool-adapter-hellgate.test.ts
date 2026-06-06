/**
 * code-mode TOOL ADAPTER (src/tool/codemode-tool.ts) — adapter-logic hellgate.
 *
 * The `code_cell` tool's OWN logic, exercised WITHOUT depending on the real VM
 * for the pre-flight paths:
 *   (a) pre-flight failures — no dispatch port wired ⇒ `not_wired`; an
 *       already-aborted signal ⇒ `aborted`; invalid input (schema) ⇒
 *       `invalid_input` — each a typed `ok:false` ToolResult, never a throw.
 *   (b) `resolveLimits` security clamp — a per-call `timeoutMs` far ABOVE the
 *       host ceiling must be clamped DOWN to the ceiling (`Math.min`). Observed
 *       behaviorally: a `while(true){}` cell with a huge requested timeout but a
 *       tiny configured ceiling times out near the CEILING, not the request.
 *   (c) `toToolResult` mapping — `status==="ok"` ⇒ `ok:true`; every abnormal
 *       status ⇒ `ok:false` with `failure.modelVisibleError === code_cell_<status>`.
 *
 * NOTE on resolveLimits: it is NOT exported from codemode-tool.ts, so the
 * Math.min clamp + the four knob→default fallbacks cannot be asserted by reading
 * the function directly. We assert the SECURITY-relevant clamp behaviorally
 * (timeout ceiling) and pin the knob→default fallbacks via the runtime-config +
 * CODE_MODE_DEFAULTS contract (the source of the fallbacks). See REPORT.
 */

import { describe, expect, test } from "bun:test"
import { CODE_MODE_DEFAULTS } from "@/codemode"
import { __resetRuntimeConfig, runtimeConfig } from "@/shared"
import { codeCellTool } from "@/tool/codemode-tool"
import type { CodeCellDispatchSeam, ToolContext, ToolResult } from "@/tool/types"

/** Drive the tool's async-generator `execute` and return the single terminal
 *  ToolResult (the tool yields exactly one `{type:"result"}`). */
const runTool = async (
  input: { code: string; timeoutMs?: number },
  ctx: Partial<ToolContext>,
): Promise<ToolResult> => {
  const tool = codeCellTool()
  const fullCtx = {
    cwd: "/tmp",
    signal: new AbortController().signal,
    ...ctx,
  } as unknown as ToolContext
  let out: ToolResult | undefined
  for await (const ev of tool.execute(input as never, fullCtx)) {
    if (ev.type === "result") out = ev.result
  }
  if (out === undefined) throw new Error("tool yielded no result event")
  return out
}

/** A dispatch seam that resolves every in-cell call with a scripted ok content. */
const okSeam: CodeCellDispatchSeam = async () => ({ ok: true, content: "C" })

describe("code_cell adapter — pre-flight failures (a)", () => {
  test("NO dispatch port wired ⇒ ok:false / not_wired (typed, no throw)", async () => {
    // ctx.codeCellDispatch undefined — the belt-and-braces path.
    const r = await runTool({ code: "return 1;" }, {})
    expect(r.ok).toBe(false)
    expect((r as { failure: { modelVisibleError: string } }).failure.modelVisibleError).toBe(
      "not_wired",
    )
  })

  test("an already-aborted signal ⇒ ok:false / aborted (before any VM spin)", async () => {
    const ac = new AbortController()
    ac.abort()
    const r = await runTool(
      { code: "return 1;" },
      { codeCellDispatch: okSeam, signal: ac.signal },
    )
    expect(r.ok).toBe(false)
    expect((r as { failure: { modelVisibleError: string } }).failure.modelVisibleError).toBe(
      "aborted",
    )
  })

  test("invalid input (empty code) ⇒ ok:false / invalid_input (schema reject)", async () => {
    const r = await runTool({ code: "" }, { codeCellDispatch: okSeam })
    expect(r.ok).toBe(false)
    expect((r as { failure: { modelVisibleError: string } }).failure.modelVisibleError).toBe(
      "invalid_input",
    )
  })

  test("invalid input (non-positive timeoutMs) ⇒ ok:false / invalid_input", async () => {
    const r = await runTool(
      { code: "return 1;", timeoutMs: 0 },
      { codeCellDispatch: okSeam },
    )
    expect(r.ok).toBe(false)
    expect((r as { failure: { modelVisibleError: string } }).failure.modelVisibleError).toBe(
      "invalid_input",
    )
  })
})

describe("code_cell adapter — resolveLimits timeout clamp (b)", () => {
  test("a per-call timeoutMs far ABOVE the host ceiling is clamped DOWN to the ceiling", async () => {
    // Configure a TINY host ceiling. A cell requesting a HUGE timeout but running
    // an infinite loop must be interrupted near the CEILING — proving the
    // `Math.min(input.timeoutMs, ceiling)` clamp (else it would run ~minutes).
    const CEILING = 150
    process.env.QUANTA_CODE_MODE_TIMEOUT_MS = String(CEILING)
    __resetRuntimeConfig()
    try {
      // Sanity: the config reflects the ceiling we set.
      expect(runtimeConfig().codeModeTimeoutMs).toBe(CEILING)
      const started = performance.now()
      const r = await runTool(
        { code: "while (true) {}", timeoutMs: 600_000 }, // 10 minutes requested
        { codeCellDispatch: okSeam },
      )
      const elapsed = performance.now() - started
      // Clamp held: timed out, and finished FAR below the requested 600s (it was
      // bounded by the ~150ms ceiling, not the request). Generous upper bound to
      // stay non-flaky while still proving the clamp (request was 600000ms).
      expect(r.ok).toBe(false)
      expect((r as { failure: { modelVisibleError: string } }).failure.modelVisibleError).toBe(
        "code_cell_timeout",
      )
      expect(elapsed).toBeLessThan(10_000)
    } finally {
      delete process.env.QUANTA_CODE_MODE_TIMEOUT_MS
      __resetRuntimeConfig()
    }
  })

  test("knob→default fallbacks: absent knobs ⇒ CODE_MODE_DEFAULTS (resolveLimits source-of-fallback)", () => {
    // resolveLimits is NOT exported; this pins the CONTRACT it falls back to —
    // `cfg.codeModeX ?? CODE_MODE_DEFAULTS.X` for all four caps. With no knobs
    // set, runtimeConfig leaves them undefined ⇒ the defaults are the effective
    // limits. (See REPORT: a direct resolveLimits assertion needs an export.)
    delete process.env.QUANTA_CODE_MODE_MEM_BYTES
    delete process.env.QUANTA_CODE_MODE_TIMEOUT_MS
    delete process.env.QUANTA_CODE_MODE_MAX_CALLS
    delete process.env.QUANTA_CODE_MODE_OUTPUT_CAP
    __resetRuntimeConfig()
    try {
      const cfg = runtimeConfig()
      expect(cfg.codeModeMemBytes).toBeUndefined()
      expect(cfg.codeModeTimeoutMs).toBeUndefined()
      expect(cfg.codeModeMaxCalls).toBeUndefined()
      expect(cfg.codeModeOutputCap).toBeUndefined()
      // The four fallbacks resolveLimits applies when the knobs are absent.
      expect(CODE_MODE_DEFAULTS.memoryBytes).toBeGreaterThan(0)
      expect(CODE_MODE_DEFAULTS.timeoutMs).toBeGreaterThan(0)
      expect(CODE_MODE_DEFAULTS.maxCalls).toBeGreaterThan(0)
      expect(CODE_MODE_DEFAULTS.outputCap).toBeGreaterThan(0)
    } finally {
      __resetRuntimeConfig()
    }
  })
})

describe("code_cell adapter — toToolResult status→ok mapping (c)", () => {
  test("status ok ⇒ ok:true (a returning cell)", async () => {
    const r = await runTool({ code: "return 7;" }, { codeCellDispatch: okSeam })
    expect(r.ok).toBe(true)
    expect(r.output).toContain("code_cell ok")
    expect(r.output).toContain("7")
  })

  test("an abnormal status ⇒ ok:false with failure.modelVisibleError === code_cell_<status>", async () => {
    // Drive a real abnormal status (error) via an uncaught in-cell throw and pin
    // the `code_cell_<status>` mapping toToolResult produces.
    const r = await runTool(
      { code: `throw new Error("boom-from-cell");` },
      { codeCellDispatch: okSeam },
    )
    expect(r.ok).toBe(false)
    expect((r as { failure: { modelVisibleError: string } }).failure.modelVisibleError).toBe(
      "code_cell_error",
    )
    // The header carries the status; the ledger block is present when calls ran.
    expect(r.output).toContain("[code_cell error]")
  })

  test("timeout status ⇒ code_cell_timeout (the abnormal mapping is status-driven)", async () => {
    const r = await runTool(
      { code: "while (true) {}", timeoutMs: 120 },
      { codeCellDispatch: okSeam },
    )
    expect(r.ok).toBe(false)
    expect((r as { failure: { modelVisibleError: string } }).failure.modelVisibleError).toBe(
      "code_cell_timeout",
    )
  })
})
