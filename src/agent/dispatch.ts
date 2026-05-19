import type { ToolResultBlock, ToolUseBlock } from "@/llm"
import {
  type AutoModeClassifier,
  evaluate,
  evaluateAuto,
  type PermissionContext,
} from "@/permission"
import { QuantaError, toError } from "@/shared"
import type { ToolContext } from "@/tool"
import { isMutatingToolBlockedInPlan } from "./plan"
import type { AgentConfig } from "./types"

export interface DispatchResult {
  block: ToolResultBlock
  ok: boolean
  preview: string
  /** Wall time of the tool execution in ms (RFC-0002 §5.2 evidence). Set for
   *  every executed tool; absent only on pre-execute deny short-circuits. */
  durationMs?: number
  /** Bounded tail of the tool's stderr, when the ToolResult exposes one
   *  (shell-class tools). Omitted — never null — for tools without stderr. */
  stderrTail?: string
  /** Process exit code for shell-class tools, when the ToolResult exposes it. */
  exitCode?: number
  /** Path to a persisted full log, only when the tool actually wrote one. */
  fullLogPath?: string
}

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

const resultBlock = (id: string, content: string, isError: boolean): ToolResultBlock => ({
  type: "tool_result",
  tool_use_id: id,
  content,
  ...(isError ? { is_error: true } : {}),
})

const deny = (id: string, content: string, preview: string): DispatchResult => ({
  block: resultBlock(id, content, true),
  ok: false,
  preview,
})

/**
 * Pre-execution gates that can short-circuit a call into a deny tool_result
 * (the model recovers — same contract as the permission-deny path). Returns a
 * {@link DispatchResult} to short-circuit, or `null` to proceed to execute.
 *
 * Order: plan-mode block → permission → confirm → hook deny. Plan mode is
 * checked first so a blocked mutating tool never even hits permission/execute
 * (RFC §13 Q3). All gates are skipped when unconfigured, so the default path
 * is byte-for-byte unchanged.
 */
const runGates = async (
  call: ToolUseBlock,
  config: AgentConfig,
  permission: PermissionContext,
  action: { tool: string; input: unknown; isReadOnly: boolean },
  autoClassifier?: AutoModeClassifier,
): Promise<DispatchResult | null> => {
  if (config.planMode && isMutatingToolBlockedInPlan(action)) {
    return deny(call.id, `blocked in plan mode: ${call.name}`, "plan-blocked")
  }

  // SOTA++ Tier 1 (ADR-0011): "auto" mode routes to the session-scoped
  // LLM classifier (denial-limit + AFK circuit-break state accumulates in
  // `autoClassifier`). All other modes use the synchronous policy verbatim.
  const decision =
    permission.mode === "auto" && autoClassifier
      ? await evaluateAuto(action, permission, autoClassifier)
      : evaluate(action, permission)
  if (decision.kind === "deny") {
    return deny(call.id, `Permission denied: ${decision.reason}`, "denied")
  }
  if (decision.kind === "ask") {
    const approved = config.onConfirm ? await config.onConfirm(action) : false
    if (!approved) return deny(call.id, `User declined: ${decision.reason}`, "declined")
  }

  if (config.hooks) {
    const hookDeny = await config.hooks.emit({
      type: "pre_tool_use",
      name: call.name,
      input: call.input,
    })
    if (hookDeny) return deny(call.id, `Hook denied: ${hookDeny.deny}`, "hook-denied")
  }
  return null
}

/** Run one tool call end to end: gates → execute → normalize errors.
 *  Tool/permission/plan/hook failures become error tool_results (the model
 *  recovers); only the loop's own fatal conditions propagate. */
export const dispatchTool = async (
  call: ToolUseBlock,
  config: AgentConfig,
  permission: PermissionContext,
  onProgress?: (message: string) => void,
  autoClassifier?: AutoModeClassifier,
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

  const gated = await runGates(call, config, permission, action, autoClassifier)
  if (gated) return gated

  // SOTA++ subagent absorption (ADR-0011): propagate this agent's recursion
  // depth so the `Agent` tool can enforce `maxDepth`. Absent ⇒ omitted (the
  // tool duck-reads it as 0), so the default path is byte-identical.
  const ctx: ToolContext = {
    cwd: config.cwd,
    signal: config.signal,
    ...(config.depth !== undefined ? { depth: config.depth } : {}),
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
