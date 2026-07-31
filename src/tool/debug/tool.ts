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
import { isAbsolute, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { z } from "zod"
import { errMessage } from "@/shared"
import type { Tool, ToolContext, ToolEvent } from "../types"
import { CdpClient, type CdpTransport } from "./cdp-client"
import { inspectViaCdp } from "./cdp-inspect"
import { DapClient } from "./dap-client"
import { type DapVariable, type Inspection, inspectViaDap } from "./inspect-driver"
import {
  type DebugAdapterPort,
  defaultDebugAdapterPort,
  type NodeCdpSpawnSpec,
  spawnNodeCdpInspector,
} from "./port"

const schema = z.object({
  program: z
    .string()
    .min(1)
    .describe("Path to the program/script to debug (relative to cwd or absolute)."),
  breakpoints: z
    .array(
      z.object({
        file: z.string().min(1),
        line: z.number().int().positive(),
        condition: z
          .string()
          .optional()
          .describe(
            "Conditional breakpoint: only stop when this expression is truthy (e.g. 'i == 3').",
          ),
      }),
    )
    .min(1)
    .describe("Breakpoints to set before running, as {file, line, condition?} (1-based line)."),
  adapter: z
    .enum(["python", "lldb", "node"])
    .optional()
    .describe(
      "Built-in adapter preset. `python`=debugpy (pip install debugpy). `lldb`=lldb-dap for C/C++/Rust/Swift (program=compiled binary built with -g). `node`=Node via the built-in inspector (CDP over `node --inspect-brk`; no install — stops at the FIRST breakpoint, condition/evaluate not supported on this preset). Omit to use adapterCommand.",
    ),
  adapterCommand: z
    .array(z.string())
    .optional()
    .describe("Explicit debug-adapter argv (e.g. for non-preset languages). Overrides `adapter`."),
  args: z.array(z.string()).optional().describe("Arguments passed to the program."),
  cwd: z
    .string()
    .optional()
    .describe("Working directory for the program (defaults to the session cwd)."),
  evaluate: z.string().optional().describe("Expression to evaluate in the top frame once stopped."),
  stopOnEntry: z.boolean().optional().describe("Stop at the program's first line as well."),
  exceptionBreakpoints: z
    .boolean()
    .optional()
    .describe(
      "Break-on-throw: also stop at the throw site of an UNCAUGHT exception (not just line breakpoints) and report its type+message. Useful when the failure is an exception thrown somewhere you can't pin a line.",
    ),
})
type Input = z.infer<typeof schema>

const ADAPTER_PRESETS: Record<string, readonly string[]> = {
  python: ["python3", "-m", "debugpy.adapter"],
  // lldb-dap (LLVM/Xcode) speaks DAP over stdio; debugs C/C++/Rust/Swift. Must
  // be on PATH (Linux: llvm package; macOS: `$(xcrun -f lldb-dap)` via adapterCommand).
  lldb: ["lldb-dap"],
}

/** Per-adapter DAP exception-breakpoint filter ids (for `exceptionBreakpoints`).
 *  debugpy: stop on uncaught + about-to-escape-user-code; lldb-dap: C++ throws. */
const EXCEPTION_FILTERS: Record<string, readonly string[]> = {
  python: ["uncaught", "userUnhandled"],
  lldb: ["cpp_throw"],
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
  if (r.outcome === "exited") {
    const base = `Program ${program} ran to completion without hitting a breakpoint (exit ${r.exitCode ?? "?"}).`
    // If breakpoints were requested but NONE bound, that — not normal completion
    // — is the likely reason; tell the model how to fix it.
    if (r.breakpointsBound === false)
      return `${base}\nNOTE: no breakpoint could be bound — verify the program is built WITH debug info (e.g. \`-g\` / debug profile) and the breakpoint file path matches the source path in the binary's debug info (on macOS, /tmp resolves to /private/tmp).`
    return base
  }
  const lines: string[] = []
  const top = r.stack[0]
  lines.push(
    `⏸ Stopped (${r.reason})${top ? ` at ${top.name} (${top.source ?? "?"}:${top.line})` : ""}`,
  )
  // Break-on-throw: surface the exception type+message right under the header.
  if (r.exception)
    lines.push(
      `⚠ Exception: ${r.exception.id}${r.exception.description ? `: ${r.exception.description}` : ""}`,
    )
  if (r.stack.length > 0) {
    lines.push("Call stack:")
    for (const f of r.stack) lines.push(`  ${f.name} (${f.source ?? "?"}:${f.line})`)
  }
  // One variable line: `name = value (type)`, with nested children indented.
  const renderVar = (v: DapVariable, indent: string): void => {
    lines.push(`${indent}${v.name} = ${v.value}${v.type ? ` (${v.type})` : ""}`)
    for (const c of v.children ?? []) renderVar(c, `${indent}  `)
  }
  // Per-frame scopes (top K frames). The first frame is the stop site; deeper
  // frames are labelled so the model can attribute a local to its caller.
  r.frames.forEach((fr, i) => {
    const nonEmpty = fr.scopes.filter((s) => s.vars.length > 0)
    if (nonEmpty.length === 0) return
    if (i > 0) lines.push(`↑ frame: ${fr.frame} (${fr.source ?? "?"}:${fr.line})`)
    for (const scope of nonEmpty) {
      lines.push(`${scope.scope}:`)
      for (const v of scope.vars) renderVar(v, "  ")
    }
  })
  if (r.evaluated) lines.push(`Evaluated \`${r.evaluated.expression}\` ⇒ ${r.evaluated.result}`)
  return lines.join("\n")
}

/** Build `debug_inspect` against an injected adapter port (defaults to the real
 *  `Bun.spawn` port; tests pass a scripted in-memory adapter). The `nodeCdp`
 *  factory is the carrier for the `node` preset (CDP over a WebSocket) — also
 *  injectable so the node path is testable against a scripted fake. */
export const makeDebugInspectTool = (
  port: DebugAdapterPort = defaultDebugAdapterPort,
  nodeCdp: (spec: NodeCdpSpawnSpec) => Promise<CdpTransport> = spawnNodeCdpInspector,
): Tool<Input> => ({
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
    const cwd = input.cwd ?? ctx.cwd

    // NODE preset: not a DAP adapter — speak CDP to `node --inspect-brk`. Single
    // process (no `--test`), stop at the FIRST breakpoint, snapshot via CDP.
    if (input.adapter === "node") {
      const program = isAbsolute(input.program) ? input.program : resolve(cwd, input.program)
      const bp = input.breakpoints[0] // schema guarantees ≥1
      if (bp === undefined) {
        yield err("debug_inspect: node preset needs at least one breakpoint")
        return
      }
      const bpFile = isAbsolute(bp.file) ? bp.file : resolve(cwd, bp.file)
      let cdp: CdpClient | undefined
      try {
        const transport = await nodeCdp({
          command: (p) => ["node", `--inspect-brk=${p}`, program, ...(input.args ?? [])],
          cwd,
        })
        cdp = new CdpClient(transport)
        const result = await inspectViaCdp(
          cdp,
          // node wraps the entry module, so a top-level throw looks "caught" to
          // V8 ⇒ "uncaught" never fires; use "all" (stops at the first throw —
          // for a focused break-on-throw run that is the failing exception).
          {
            url: pathToFileURL(bpFile).href,
            line: bp.line,
            ...(input.exceptionBreakpoints === true ? { pauseOnExceptions: "all" as const } : {}),
          },
          { ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}) },
        )
        yield {
          type: "result",
          result: { ok: result.outcome !== "error", output: render(input.program, result) },
        }
      } catch (e) {
        yield err(`debug_inspect: ${errMessage(e)}`)
      } finally {
        cdp?.dispose()
      }
      return
    }

    const command =
      input.adapterCommand ?? (input.adapter ? ADAPTER_PRESETS[input.adapter] : undefined)
    if (command === undefined || command.length === 0) {
      yield err(
        "debug_inspect: provide `adapter` (preset) or `adapterCommand` (explicit adapter argv)",
      )
      return
    }
    let client: DapClient | undefined
    try {
      const transport = await port.spawn({ command: [...command], cwd })
      client = new DapClient(transport)
      const result = await inspectViaDap(
        client,
        {
          adapterID: input.adapter ?? "custom",
          launch: buildLaunchConfig(input, cwd),
          breakpoints: input.breakpoints.map((b) => ({
            file: b.file,
            line: b.line,
            ...(b.condition !== undefined ? { condition: b.condition } : {}),
          })),
          ...(input.evaluate !== undefined ? { evaluate: input.evaluate } : {}),
          // Break-on-throw filters by adapter (debugpy uses uncaught/userUnhandled;
          // lldb-dap uses cpp_throw). Only armed when the caller opts in.
          ...(input.exceptionBreakpoints === true
            ? { exceptionFilters: EXCEPTION_FILTERS[input.adapter ?? "custom"] ?? [] }
            : {}),
        },
        {
          // Turn-abort tears the session down instead of lingering to the timeout.
          ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        },
      )
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
