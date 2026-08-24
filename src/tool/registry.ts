import { join } from "node:path"
import { runtimeConfig, ToolExecutionError, ToolInputError } from "@/shared"
import { enforceOutputSchema } from "./factory"
import type { ToolOrigin } from "./origin"
import { capToolOutput, DEFAULT_SPILL_KEEP, DEFAULT_TOOL_OUTPUT_MAX } from "./output-spill"
import { zodToJsonSchema } from "./schema"
import type { Tool, ToolContext, ToolResult, ToolSpec } from "./types"

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>()

  /** Per-tool ORIGIN tag (ADR-0471 Substrate-B): WHICH source array registered
   *  a tool. Absent (legacy ctor) ⇒ every tool reads as `builtin`, so the
   *  origin surface is byte-identical to a registry that never carried a map. A
   *  consumer (dispatch #2) maps origin → provenance via `deriveProvenance`,
   *  deriving trust ACCURATELY from the call site rather than guessing by name. */
  private readonly origin: ReadonlyMap<string, ToolOrigin> | undefined

  constructor(tools: Tool[], origin?: ReadonlyMap<string, ToolOrigin>) {
    for (const t of tools) this.tools.set(t.name, t as Tool)
    this.origin = origin
  }

  /** The ORIGIN tag for a tool. No map supplied, or a name absent from the
   *  map, ⇒ `builtin` (the conservative, byte-identical default). O(1) map
   *  lookup — never scans the tool list. */
  originOf(name: string): ToolOrigin {
    return this.origin?.get(name) ?? "builtin"
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

  /** jun-6 (RFC jun-6-tool-interrupt-behavior) — the tool's declared interrupt
   *  policy. A tool that does NOT implement `interruptBehavior` (the common
   *  case) reads as `"cancel"` (today's uniform behavior). The dispatch seam
   *  consults this (gated on `runtimeConfig().toolInterruptBlock`) to decide
   *  whether to thread a derived suppressible signal + `criticalSection` seam
   *  onto the `ToolContext`. Mirrors {@link isReadOnly}. */
  interruptBehavior(name: string): "cancel" | "block" {
    return this.tools.get(name)?.interruptBehavior?.() ?? "cancel"
  }

  /** ADR-0298 / T02 — streaming-dispatch early-start eligibility. A tool whose
   *  side effects are isolated from the PARENT dispatch seam (today: `agent`,
   *  whose effects run inside an isolated child loop with its own abort signal)
   *  opts into in-flight overlap via `isEarlyDispatchSafe()`. When the tool does
   *  NOT implement it we fall back to `isReadOnly()` — byte-identical to T02, so
   *  parent-mutating concurrency-safe tools (`session_config`,
   *  `automation_update`) stay deferred and a refused turn never commits them. */
  isEarlyDispatchSafe(name: string): boolean {
    const tool = this.tools.get(name)
    if (!tool) return false
    return (tool.isEarlyDispatchSafe ?? tool.isReadOnly).call(tool)
  }

  /** Schemas advertised to the model. Called ON EVERY MODEL REQUEST (the loop
   *  re-derives the visible spec list per turn), so a tool that implements the
   *  optional {@link ToolDynamicSpec.getSpec} arm gets its CURRENT spec re-read
   *  here every request:
   *    - RFC-06 F3 (`Skill`): a stale skill disabled after construction leaves
   *      the Skill tool's advertised description on the next call.
   *    - RFC-05 E5b (`request_user_input`): the tool's live question-posture
   *      availability drives whether it appears in the spec at all — a getSpec
   *      that returns `undefined` HIDES the tool from THIS request's spec list
   *      (see the {@link ToolDynamicSpec.getSpec} contract), so a session that
   *      started in a denying posture reappears the moment the live posture
   *      admits it, with no rebuilt registry.
   *
   *  Static-tool compatibility: a tool WITHOUT `getSpec` (every built-in) is
   *  advertised from its static `{name, description, inputSchema}` fields exactly
   *  as before — byte-identical output, so the gate-OFF (no dynamic tools) spec
   *  list is unchanged. A `getSpec` that returns `undefined` DROPS its tool (the
   *  posture-driven hide), distinct from the absent-arm static fallback above. */
  specs(): ToolSpec[] {
    const out: ToolSpec[] = []
    for (const t of this.tools.values()) {
      if (t.getSpec !== undefined) {
        const dynamic = t.getSpec()
        // PRESENT-but-`undefined` ⇒ the dynamic tool hides itself this request.
        if (dynamic !== undefined) out.push(dynamic)
        continue
      }
      out.push({
        name: t.name,
        description: t.description,
        input_schema: zodToJsonSchema(t.inputSchema),
      })
    }
    return out
  }

  /** Concrete tool instances in stable registry order. Callers that need to
   *  extend a live registry without losing already-wired tool behavior use
   *  this rather than the model-only `specs()` surface. */
  all(): Tool[] {
    return [...this.tools.values()]
  }

  /** code-mode (RFC jun-6-code-mode, Phase 2) — the registered tool NAMES in
   *  stable registry (insertion) order. The `@/agent/codemode-wire` factory
   *  reads this to build the cell's FULL `tools.*` surface from the agent's
   *  ACTUAL registered set (a tool the agent can't use is never bound; a
   *  newly-registered tool appears automatically). Same set `dispatchTool`
   *  knows — the cell can never widen past what the loop exposes. Pure read of
   *  the map keys; no leak (the names are stable identifiers, see `specs()`). */
  toolNames(): string[] {
    return [...this.tools.keys()]
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
      throw new ToolInputError(`Unknown tool: ${name}. Registered tools: ${known || "(none)"}`)
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
    const capped = await capToolOutput(result.output, {
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
