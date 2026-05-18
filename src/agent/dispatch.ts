import type { ToolResultBlock, ToolUseBlock } from "@/llm"
import { evaluate, type PermissionContext } from "@/permission"
import { QuantaError, toError } from "@/shared"
import type { ToolContext } from "@/tool"
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

/** Run one tool call end to end: permission → execute → normalize errors.
 *  Tool/permission failures become error tool_results (the model recovers);
 *  only the loop's own fatal conditions propagate. */
export const dispatchTool = async (
  call: ToolUseBlock,
  config: AgentConfig,
  permission: PermissionContext,
): Promise<DispatchResult> => {
  const { registry } = config

  if (!registry.has(call.name)) {
    return {
      block: resultBlock(call.id, `Unknown tool: ${call.name}`, true),
      ok: false,
      preview: "unknown tool",
    }
  }

  const action = {
    tool: call.name,
    input: call.input,
    isReadOnly: registry.isReadOnly(call.name),
  }

  const decision = evaluate(action, permission)
  if (decision.kind === "deny") {
    return {
      block: resultBlock(call.id, `Permission denied: ${decision.reason}`, true),
      ok: false,
      preview: "denied",
    }
  }
  if (decision.kind === "ask") {
    const approved = config.onConfirm ? await config.onConfirm(action) : false
    if (!approved) {
      return {
        block: resultBlock(call.id, `User declined: ${decision.reason}`, true),
        ok: false,
        preview: "declined",
      }
    }
  }

  const ctx: ToolContext = { cwd: config.cwd, signal: config.signal }
  try {
    const result = await registry.run(call.name, call.input, ctx)
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
