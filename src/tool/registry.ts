import { join } from "node:path"
import { runtimeConfig, ToolExecutionError, ToolInputError } from "@/shared"
import { enforceOutputSchema } from "./factory"
import { capToolOutput, DEFAULT_SPILL_KEEP, DEFAULT_TOOL_OUTPUT_MAX } from "./output-spill"
import { zodToJsonSchema } from "./schema"
import type { Tool, ToolContext, ToolResult, ToolSpec } from "./types"

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>()

  constructor(tools: Tool[]) {
    for (const t of tools) this.tools.set(t.name, t as Tool)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  isReadOnly(name: string): boolean {
    return this.tools.get(name)?.isReadOnly() ?? false
  }

  /** Schemas advertised to the model. */
  specs(): ToolSpec[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: zodToJsonSchema(t.inputSchema),
    }))
  }

  /** S16: extract a shell command from a tool call when the tool implements
   *  `extractShellCommand`. Returns `null` for tools that don't accept a
   *  shell command, OR when input validation fails. Permission policy uses
   *  this to apply HARD_DENY uniformly across every shell-equivalent tool
   *  (bash, future `shell`/`exec`/MCP `run`), instead of hardcoding `bash`. */
  extractShellCommand(name: string, rawInput: unknown): string | null {
    const tool = this.tools.get(name)
    if (!tool || tool.extractShellCommand === undefined) return null
    const parsed = tool.inputSchema.safeParse(rawInput)
    if (!parsed.success) return null
    return tool.extractShellCommand(parsed.data)
  }

  /** Validate then ask the tool whether this call may run concurrently with
   *  other concurrency-safe calls. Unknown tool or invalid input ⇒ false
   *  (the safe default: serialize it). */
  isConcurrencySafe(name: string, rawInput: unknown): boolean {
    const tool = this.tools.get(name)
    if (!tool) return false
    const parsed = tool.inputSchema.safeParse(rawInput)
    if (!parsed.success) return false
    return tool.isConcurrencySafe(parsed.data)
  }

  /** Validate raw model input, then drive the tool's event stream. Progress
   *  events are forwarded to `onProgress`; the terminal result is returned.
   *  Throws {@link ToolInputError} on a schema mismatch (caller feeds it back
   *  as a tool error) and {@link ToolExecutionError} if the tool ends without
   *  emitting a result. */
  async run(
    name: string,
    rawInput: unknown,
    ctx: ToolContext,
    onProgress?: (message: string) => void,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (!tool) {
      // Surface the registered surface so the model (and human triage) can spot
      // a typo without round-tripping through a separate `list_tools` call. The
      // names are stable identifiers — listing them is cheap and not a leak.
      const known = [...this.tools.keys()].sort().join(", ")
      throw new ToolInputError(
        `Unknown tool: ${name}. Registered tools: ${known || "(none)"}`,
      )
    }

    const parsed = tool.inputSchema.safeParse(rawInput)
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")
      throw new ToolInputError(`Invalid input for ${name}: ${issues}`)
    }

    let result: ToolResult | undefined
    for await (const ev of tool.execute(parsed.data, ctx)) {
      if (ev.type === "progress") {
        onProgress?.(ev.message)
      } else {
        result = ev.result
      }
    }
    if (result === undefined) {
      throw new ToolExecutionError(`Tool ${name} produced no result`)
    }
    // L3 wire (absorb #1, ADR-0060): enforce outputSchema then render model-
    // facing output via toModelOutput. Both factory helpers fast-path when the
    // tool declines to opt in, so a tool with neither field is byte-identical
    // to the pre-wire path. enforce runs FIRST so a structured-validation
    // failure (`ok:false` with a retry-instruction message) short-circuits
    // toModelOutput; on ok results, toModelOutput supplies the compact model-
    // facing string. Capping below applies to the rewritten output so the
    // wire honours the existing token cap.
    result = enforceOutputSchema(tool, result)
    if (result.ok && tool.toModelOutput !== undefined) {
      result = { ...result, output: tool.toModelOutput(result) }
    }
    // S5: read tunables from the frozen runtimeConfig — no per-call env reads.
    const cfg = runtimeConfig()
    const capped = capToolOutput(result.output, {
      maxChars: cfg.toolOutputMaxChars ?? DEFAULT_TOOL_OUTPUT_MAX,
      spillDir: join(ctx.cwd, ".quanta", "tool-output"),
      spillKeep: cfg.toolOutputSpillKeep ?? DEFAULT_SPILL_KEEP,
    })
    if (capped.output === result.output) return result
    // Route the spill path (if any) into the typed `evidence.fullLogPath` so
    // the dispatch seam (`evidenceOf`) can flatten it onto `DispatchResult.
    // fullLogPath` → trajectory `tool_end.fullLogPath`. exactOptionalPropertyTypes-
    // safe: the `evidence` field is only set when we have something to add, and
    // existing evidence subfields (stderr/exitCode) are merged through, not
    // clobbered.
    const next: ToolResult = {
      ...result,
      output: capped.output,
      ...(capped.spillPath !== undefined
        ? { evidence: { ...result.evidence, fullLogPath: capped.spillPath } }
        : {}),
    }
    return next
  }
}
