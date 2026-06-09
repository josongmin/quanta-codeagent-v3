/**
 * W5 `debug_inspect` — run a program under a Debug Adapter Protocol adapter,
 * stop at the first breakpoint, and report the call stack + local variables
 * (and an optional evaluated expression). One self-contained call: launch →
 * stop → inspect → terminate. Continue/step across calls is a future extension.
 *
 * HIGH RISK: launching a debug adapter EXECUTES the user's program (arbitrary
 * code), so the tool is `always-confirm` (every call needs approval, like
 * `bash`) AND default-OFF (registered only when QUANTA_DEBUG_TOOLS is on).
 * NEVER throws — a spawn / protocol / timeout fault collapses to ok:false.
 */
import { z } from "zod"
import { errMessage } from "@/shared"
import { DapClient } from "./dap-client"
import { type Inspection, inspectViaDap } from "./inspect-driver"
import { defaultDebugAdapterPort, type DebugAdapterPort } from "./port"
import type { Tool, ToolContext, ToolEvent } from "../types"

const schema = z.object({
  program: z.string().min(1).describe("Path to the program/script to debug (relative to cwd or absolute)."),
  breakpoints: z
    .array(z.object({ file: z.string().min(1), line: z.number().int().positive() }))
    .min(1)
    .describe("Breakpoints to set before running, as {file, line} (1-based line)."),
  adapter: z
    .enum(["python"])
    .optional()
    .describe("Built-in adapter preset. `python` uses debugpy (must be installed). Omit to use adapterCommand."),
  adapterCommand: z
    .array(z.string())
    .optional()
    .describe("Explicit debug-adapter argv (e.g. for non-preset languages). Overrides `adapter`."),
  args: z.array(z.string()).optional().describe("Arguments passed to the program."),
  cwd: z.string().optional().describe("Working directory for the program (defaults to the session cwd)."),
  evaluate: z.string().optional().describe("Expression to evaluate in the top frame once stopped."),
  stopOnEntry: z.boolean().optional().describe("Stop at the program's first line as well."),
})
type Input = z.infer<typeof schema>

const ADAPTER_PRESETS: Record<string, readonly string[]> = {
  python: ["python3", "-m", "debugpy.adapter"],
}

/** Build the adapter-specific DAP `launch` request arguments. debugpy needs the
 *  `request`/`type` discriminators + the debuggee interpreter (`python`). */
const buildLaunchConfig = (input: Input, cwd: string): Record<string, unknown> => {
  const common = {
    program: input.program,
    args: input.args ?? [],
    cwd,
    stopOnEntry: input.stopOnEntry ?? false,
    console: "internalConsole",
  }
  if (input.adapter === "python") {
    return { request: "launch", type: "python", python: ["python3"], ...common }
  }
  return common
}

const err = (output: string): ToolEvent => ({
  type: "result",
  result: { ok: false, output, failure: { mode: "error", modelVisibleError: output } },
})

/** Render an {@link Inspection} as a compact, model-readable report. */
const render = (program: string, r: Inspection): string => {
  if (r.outcome === "error") return `debug_inspect error: ${r.message}`
  if (r.outcome === "exited")
    return `Program ${program} ran to completion without hitting a breakpoint (exit ${r.exitCode ?? "?"}).`
  const lines: string[] = []
  const top = r.stack[0]
  lines.push(`⏸ Stopped (${r.reason})${top ? ` at ${top.name} (${top.source ?? "?"}:${top.line})` : ""}`)
  if (r.stack.length > 0) {
    lines.push("Call stack:")
    for (const f of r.stack) lines.push(`  ${f.name} (${f.source ?? "?"}:${f.line})`)
  }
  for (const scope of r.variables) {
    if (scope.vars.length === 0) continue
    lines.push(`${scope.scope}:`)
    for (const v of scope.vars) lines.push(`  ${v.name} = ${v.value}`)
  }
  if (r.evaluated) lines.push(`Evaluated \`${r.evaluated.expression}\` ⇒ ${r.evaluated.result}`)
  return lines.join("\n")
}

/** Build `debug_inspect` against an injected adapter port (defaults to the real
 *  `Bun.spawn` port; tests pass a scripted in-memory adapter). */
export const makeDebugInspectTool = (port: DebugAdapterPort = defaultDebugAdapterPort): Tool<Input> => ({
  name: "debug_inspect",
  description:
    "Run a program under a debugger, stop at the FIRST breakpoint, and report the call stack + local " +
    "variables (and an optional evaluated expression). Use to inspect runtime state instead of adding " +
    "print statements. One-shot: launch → stop → inspect → terminate. Requires a debug adapter " +
    "(e.g. debugpy for `adapter:'python'`) to be installed.",
  inputSchema: schema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  // Launching a debug adapter executes the program (arbitrary code) ⇒ confirm.
  hitlTier: (): "always-confirm" => "always-confirm",

  async *execute(input: Input, ctx: ToolContext): AsyncIterable<ToolEvent> {
    if (ctx.signal?.aborted === true) {
      yield err("aborted before start")
      return
    }
    const command = input.adapterCommand ?? (input.adapter ? ADAPTER_PRESETS[input.adapter] : undefined)
    if (command === undefined || command.length === 0) {
      yield err("debug_inspect: provide `adapter` (preset) or `adapterCommand` (explicit adapter argv)")
      return
    }
    const cwd = input.cwd ?? ctx.cwd
    let client: DapClient | undefined
    try {
      const transport = await port.spawn({ command: [...command], cwd })
      client = new DapClient(transport)
      const result = await inspectViaDap(client, {
        adapterID: input.adapter ?? "custom",
        launch: buildLaunchConfig(input, cwd),
        breakpoints: input.breakpoints,
        ...(input.evaluate !== undefined ? { evaluate: input.evaluate } : {}),
      }, {
        // Turn-abort tears the session down instead of lingering to the timeout.
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      })
      yield {
        type: "result",
        result: { ok: result.outcome !== "error", output: render(input.program, result) },
      }
    } catch (e) {
      yield err(`debug_inspect: ${errMessage(e)}`)
    } finally {
      client?.dispose()
    }
  },
})

/** Default-bound tool (real spawn port) for the registry. */
export const debugInspectTool: Tool<Input> = makeDebugInspectTool()
