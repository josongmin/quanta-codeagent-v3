/**
 * `code_cell` tool (RFC jun-6-code-mode, Phase 1) — GATED, default-OFF.
 *
 * Input = a model-authored JS program string. The tool runs it in the
 * `@/codemode` QuickJS-WASM sandbox, where each in-cell `await tools.X(args)`
 * re-enters the REAL `dispatchTool` via the injected
 * {@link ToolContext.codeCellDispatch} port — so EVERY in-cell tool call passes
 * the full admissibility gate / HARD_DENY / plan-mode / permission / redaction
 * pipeline EXACTLY like an ordinary tool call (the structural no-bypass
 * invariant, RFC §6.1). A cell is, to the permission system, N ordinary gated
 * calls.
 *
 * Surface (RFC §4.2 / Phase 2 — full tool surface, jun-07): the cell binds
 * `tools.<name>` for the agent's FULL registered tool set, surfaced from the
 * dispatch seam on {@link ToolContext.codeCellSurface} (= `registry.toolNames()`).
 * A host that wired the port but NOT the surface falls back to the Phase-1 3-tool
 * surface (`read`/`grep`/`write`). Every bound tool — read-only or mutating — is
 * STILL re-gated through `codeCellDispatch` → the real `dispatchTool` per call, so
 * widening the NAMES never widens the SECURITY (a HARD_DENY-able / plan-mode
 * mutating in-cell call is blocked exactly as a direct one). Phase 3
 * (`code_mode_only`) is a prompt-steering directive (default-OFF).
 *
 * No-throw (Tool contract §2): every failure (no port, abort, timeout, memory,
 * cap, syntax error, uncaught throw) yields a typed `ok:false`/`ok:true`
 * {@link ToolResult} — never an iterator rejection. The QuickJS-WASM module is
 * imported LAZILY inside `@/codemode` so the OFF binary never instantiates it.
 *
 * Slice posture (RFC §5.1): imports `zod`, `@/shared` (runtime-config), and
 * `@/codemode` (the sandbox). NO `@/agent`/`@/permission` — the dispatch port
 * arrives via `ToolContext`, built host-side by `@/agent/codemode-wire.ts`.
 */

import { z } from "zod"
import {
  CODE_MODE_DEFAULTS,
  type CodeCellLimits,
  type CodeCellResult,
  runCodeCell,
} from "@/codemode"
import { runtimeConfig } from "@/shared"
import { defineTool } from "./factory"
import type { Tool, ToolContext, ToolEvent, ToolResult } from "./types"

/** Max program-string length accepted (defensive — a 256 KiB cell is already
 *  pathological; the model authors a SMALL program). */
const CODE_MAX = 256 * 1024

export const codeCellInputSchema = z.object({
  code: z
    .string()
    .min(1)
    .max(CODE_MAX)
    .describe(
      "A JavaScript program (the 'code cell'). It may call ANY tool you have as an async " +
        "function — e.g. `await tools.read({path})`, `await tools.grep({pattern, path})`, " +
        "`await tools.write({path, content})`, `await tools.bash({command})` — use " +
        "loops/conditionals/Promise.all over the results, and `return` a JSON-serializable " +
        "value. EACH tools.* call is gated EXACTLY like a normal tool call (permission / " +
        "HARD_DENY / plan-mode all apply per call). No require/fetch/process/filesystem/" +
        "network — only tools.*.",
    ),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Optional wall-clock deadline for this cell in ms (capped by the host default)."),
})
export type CodeCellInput = z.infer<typeof codeCellInputSchema>

/** Resolve the hard caps from runtime-config knobs (falling back to the shared
 *  defaults). The per-call `timeoutMs` (when provided) takes the MIN with the
 *  configured ceiling so a cell cannot raise its own deadline above the host
 *  cap. */
const resolveLimits = (input: CodeCellInput): CodeCellLimits => {
  const cfg = runtimeConfig()
  const timeoutCeiling = cfg.codeModeTimeoutMs ?? CODE_MODE_DEFAULTS.timeoutMs
  const timeoutMs =
    input.timeoutMs !== undefined ? Math.min(input.timeoutMs, timeoutCeiling) : timeoutCeiling
  return {
    memoryBytes: cfg.codeModeMemBytes ?? CODE_MODE_DEFAULTS.memoryBytes,
    timeoutMs,
    maxCalls: cfg.codeModeMaxCalls ?? CODE_MODE_DEFAULTS.maxCalls,
    outputCap: cfg.codeModeOutputCap ?? CODE_MODE_DEFAULTS.outputCap,
  }
}

/** Map a finished {@link CodeCellResult} to a model-facing {@link ToolResult}.
 *  A per-cell ledger (categorical: tool name + outcome enum only — no input,
 *  no result bytes, RFC §6.3) is appended so the model sees the whole cell's
 *  activity in ONE result block. `status` drives `ok`: only `"ok"` is a
 *  success; every abnormal/error status is `ok:false` with the typed reason. */
const toToolResult = (result: CodeCellResult): ToolResult => {
  const ledger = result.toolCalls.map((c) => `  #${c.seq} ${c.tool} → ${c.outcome}`).join("\n")
  const header =
    `[code_cell ${result.status}] ${result.callCount} tool call(s)` +
    (result.truncated ? " (output truncated)" : "")
  const body = result.output.length > 0 ? `\n${result.output}` : ""
  const ledgerBlock = ledger.length > 0 ? `\n--- tool calls ---\n${ledger}` : ""
  const output = `${header}${body}${ledgerBlock}`
  if (result.status === "ok") return { ok: true, output }
  return {
    ok: false,
    output,
    failure: { mode: "error", modelVisibleError: `code_cell_${result.status}` },
  }
}

/** Build an ok:false ToolResult for the pre-flight failures (no port / schema /
 *  pre-abort). */
const errResult = (output: string, modelVisibleError: string): ToolResult => ({
  ok: false,
  output,
  failure: { mode: "error", modelVisibleError },
})

/** Run the whole cell as ONE typed ToolResult. */
const runCell = async (input: CodeCellInput, ctx: ToolContext): Promise<ToolResult> => {
  const parsed = codeCellInputSchema.safeParse(input)
  if (!parsed.success) return errResult(`invalid input: ${parsed.error.message}`, "invalid_input")
  // The tool is only REGISTERED when the host wired the dispatch port (gated on
  // QUANTA_CODE_MODE); this is belt-and-braces so a hand-registered tool without
  // the port yields a typed failure rather than a crash.
  const dispatch = ctx.codeCellDispatch
  if (dispatch === undefined) {
    return errResult("code_cell dispatch port not wired (QUANTA_CODE_MODE off)", "not_wired")
  }
  if (ctx.signal.aborted) return errResult("aborted before start", "aborted")

  const result = await runCodeCell({
    code: parsed.data.code,
    dispatch,
    // Phase 2 — the FULL cell surface. The dispatch seam surfaces the agent's
    // ACTUAL registered tool names here (alongside the port) when QUANTA_CODE_MODE
    // is on; the cell then binds `tools.<name>` for every one (each STILL re-gated
    // through `dispatch`). ABSENT ⇒ `@/codemode` falls back to the Phase-1 3-tool
    // surface (read/grep/write) — byte-identical for a host that wired only the
    // port. A tool the agent lacks is simply not in the list ⇒ unbound.
    ...(ctx.codeCellSurface !== undefined ? { surfaceTools: ctx.codeCellSurface } : {}),
    limits: resolveLimits(parsed.data),
    signal: ctx.signal,
    // Injected clock — the runtime takes its deadline from this (no Date.now in
    // @/codemode). `performance.now()` is monotonic; available under Bun/Node.
    now: () => performance.now(),
  })
  return toToolResult(result)
}

/** Build the gated `code_cell` tool. No port to inject at construction — the
 *  dispatch port arrives per-call via `ToolContext.codeCellDispatch`. */
export const codeCellTool = (): Tool<CodeCellInput> =>
  defineTool<CodeCellInput>({
    name: "code_cell",
    description:
      "Run a small JavaScript program that calls tools as async functions " +
      "(`await tools.<name>(...)` — ANY tool you have), with loops/conditionals/Promise.all " +
      "over their results, in ONE turn. Each tools.* call is gated EXACTLY like a normal tool " +
      "call (permission, HARD_DENY, and plan-mode all apply per call). Use this to collapse a " +
      "multi-step read→branch→write sequence into one turn. The cell is sandboxed: NO require/" +
      "fetch/process/filesystem/network — only tools.*. Return a JSON-serializable value.",
    inputSchema: codeCellInputSchema,
    // The cell can invoke MUTATING tools (write) — it is at least as powerful as
    // the union of the tools it can call. NOT read-only ⇒ plan-mode blocks it at
    // the dispatch seam (the MUTATING_TOOL_TABLE entry classifies it).
    isReadOnly: () => false,
    // Instantiates a WASM runtime + drives gated dispatches; never run two cells
    // concurrently (each spins its own isolate + its own dispatch stream).
    isConcurrencySafe: () => false,
    // Exec-class: it runs model-authored code, even though each in-cell tool call
    // is re-gated. Must be explicit — the mutating fallback tier is always-confirm.
    hitlTier: (): "always-confirm" => "always-confirm",

    async *execute(input: CodeCellInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
      yield { type: "result", result: await runCell(input, ctx) }
    },
  })
