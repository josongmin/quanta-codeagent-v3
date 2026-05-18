import type { ToolResultBlock, ToolUseBlock } from "@/llm"
import { evaluate, type PermissionContext } from "@/permission"
import { QuantaError, toError } from "@/shared"
import type { ToolContext } from "@/tool"
import { isMutatingToolBlockedInPlan } from "./plan"
import type { AgentConfig } from "./types"

export interface DispatchResult {
  block: ToolResultBlock
  ok: boolean
  preview: string
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
): Promise<DispatchResult | null> => {
  if (config.planMode && isMutatingToolBlockedInPlan(action)) {
    return deny(call.id, `blocked in plan mode: ${call.name}`, "plan-blocked")
  }

  const decision = evaluate(action, permission)
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

  const gated = await runGates(call, config, permission, action)
  if (gated) return gated

  const ctx: ToolContext = { cwd: config.cwd, signal: config.signal }
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
  try {
    const result = await config.registry.run(call.name, call.input, ctx, onProgress)
    return {
      block: resultBlock(call.id, result.output, !result.ok),
      ok: result.ok,
      preview: result.output,
    }
  } catch (e) {
    const message = e instanceof QuantaError ? e.message : toError(e).message
    return { block: resultBlock(call.id, message, true), ok: false, preview: message }
  }
}
