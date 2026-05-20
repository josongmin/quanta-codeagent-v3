import type { ToolUseBlock } from "@/llm"
import type { AutoModeClassifier, PermissionContext } from "@/permission"
import { QuantaError, toError } from "@/shared"
import type { ToolContext, WorkingStateHandle } from "@/tool"
import { runAdmissibilityGate } from "./admissibility-gate"
import { deny, resultBlock } from "./dispatch-helpers"
import type { DispatchResult } from "./dispatch-types"
import type { AgentConfig } from "./types"

export type { DispatchResult } from "./dispatch-types"

/** Max chars of stderr retained on the dispatch result (RFC-0002 §5.2). */
const STDERR_TAIL_CAP = 2000

/** Duck-read RFC-0002 §5.2 tool evidence a tool may attach to its ToolResult.
 *  `ToolResult` only declares `ok`/`output`; shell-class tools may carry
 *  `stderr`/`exitCode`/`fullLogPath` as extra props. Read defensively and
 *  conditional-set so `exactOptionalPropertyTypes` never sees `undefined`. */
const evidenceOf = (
  result: unknown,
): Pick<DispatchResult, "stderrTail" | "exitCode" | "fullLogPath"> => {
  const r = result as Record<string, unknown>
  const out: Pick<DispatchResult, "stderrTail" | "exitCode" | "fullLogPath"> = {}
  if (typeof r.stderr === "string" && r.stderr.length > 0) {
    out.stderrTail = r.stderr.slice(-STDERR_TAIL_CAP)
  }
  if (typeof r.exitCode === "number") out.exitCode = r.exitCode
  if (typeof r.fullLogPath === "string" && r.fullLogPath.length > 0) {
    out.fullLogPath = r.fullLogPath
  }
  return out
}

// `resultBlock` / `deny` now live in `./dispatch-helpers` so both `dispatch.ts`
// and `./admissibility-gate.ts` can construct deny / tool_result values without
// either file importing the other's full implementation surface.

/** Run one tool call end to end: gates → execute → normalize errors.
 *  Tool/permission/plan/hook failures become error tool_results (the model
 *  recovers); only the loop's own fatal conditions propagate.
 *
 *  `workingState` is the optional session-scoped Codex memory L3 handle
 *  (ADR-0021). When the agent loop has built one (`AgentConfig.workingState?.
 *  enabled === true`) it is passed here so `ctx.workingState` is populated on
 *  the {@link ToolContext} forwarded to every tool. Absent ⇒ the field is
 *  OMITTED on `ctx` (exactOptionalPropertyTypes: never `undefined`), so
 *  callers without the opt-in are byte-identical. The closure pattern
 *  `createUpdateWorkingStateTool(handle)` continues to work — `ctx.workingState`
 *  is the second seam so future tools (or callers that don't capture via
 *  closure) can read the same handle. */
export const dispatchTool = async (
  call: ToolUseBlock,
  config: AgentConfig,
  permission: PermissionContext,
  onProgress?: (message: string) => void,
  autoClassifier?: AutoModeClassifier,
  workingState?: WorkingStateHandle,
): Promise<DispatchResult> => {
  const { registry } = config

  if (!registry.has(call.name)) {
    return deny(call.id, `Unknown tool: ${call.name}`, "unknown tool")
  }

  const action = {
    tool: call.name,
    input: call.input,
    isReadOnly: registry.isReadOnly(call.name),
  }

  // SSOT pre-execute gate (see admissibility-gate.ts for the canonical order).
  const gated = await runAdmissibilityGate(call, config, permission, action, autoClassifier)
  if (gated) return gated

  // SOTA++ subagent absorption (ADR-0011): propagate this agent's recursion
  // depth so the `Agent` tool can enforce `maxDepth`. Absent ⇒ omitted (the
  // tool duck-reads it as 0), so the default path is byte-identical.
  // Phase 6 (ADR-0021): propagate the session-scoped WorkingState handle so
  // tools that want to read/mutate L3 via the context seam (rather than a
  // closure-captured handle) have a real path. Absent ⇒ omitted.
  const ctx: ToolContext = {
    cwd: config.cwd,
    signal: config.signal,
    ...(config.depth !== undefined ? { depth: config.depth } : {}),
    ...(workingState !== undefined ? { workingState } : {}),
  }
  const out = await execute(call, config, ctx, onProgress)
  if (config.hooks) {
    await config.hooks.emit({
      type: "post_tool_use",
      name: call.name,
      ok: out.ok,
      output: out.preview,
    })
  }
  return out
}

/** Drive the registry, normalizing thrown errors into an error tool_result. */
const execute = async (
  call: ToolUseBlock,
  config: AgentConfig,
  ctx: ToolContext,
  onProgress?: (message: string) => void,
): Promise<DispatchResult> => {
  const startedAt = performance.now()
  try {
    const result = await config.registry.run(call.name, call.input, ctx, onProgress)
    const durationMs = Math.max(0, Math.round(performance.now() - startedAt))
    return {
      block: resultBlock(call.id, result.output, !result.ok),
      ok: result.ok,
      preview: result.output,
      durationMs,
      ...evidenceOf(result),
    }
  } catch (e) {
    const durationMs = Math.max(0, Math.round(performance.now() - startedAt))
    const message = e instanceof QuantaError ? e.message : toError(e).message
    return { block: resultBlock(call.id, message, true), ok: false, preview: message, durationMs }
  }
}
