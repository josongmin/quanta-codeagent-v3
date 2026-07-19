import { type AgentConfig, type AgentOutcome, runAgent } from "@/agent"
import type {
  SessionHostSideConversationInheritance,
  SessionHostSideConversationResult,
} from "@/kernel/session"
import type { Message } from "@/llm"
import { type Tool, ToolRegistry } from "@/tool"
import type { RuntimeBase } from "./types"

const SIDE_CONVERSATION_MAX_TURNS_CAP = 5

export const SIDE_CONVERSATION_DEFAULT_TOOLS: readonly string[] = Object.freeze([
  "read",
  "search_codebase",
  "grep",
  "glob",
  "file_tree_summary",
  "parse_test_failure",
  "localize",
  "diagnostics",
  "git_log",
  "git_diff",
  "git_blame",
  "git_blame_heatmap",
  "git_churn",
  "git_status",
  "lsp_definition",
  "lsp_references",
  "lsp_hover",
  "lsp_type_definition",
  "lsp_implementation",
  "lsp_document_symbol",
  "lsp_workspace_symbol",
])

const SIDE_CONVERSATION_FORBIDDEN = new Set<string>([
  "write",
  "edit",
  "apply_patch",
  "scripted_replace",
  "bash",
  "git_commit",
  "git_push",
  "git_reset",
  "git_revert",
  "git_checkout",
  "git_branch_delete",
  "spawn_agent",
  "wait_agent",
  "close_agent",
  "exec_command",
  "write_stdin",
  "send_input",
])

const buildSideConversationRegistry = (
  source: ToolRegistry,
  allowlist: readonly string[],
): ToolRegistry => {
  const allowed: Tool[] = []
  for (const name of allowlist) {
    if (SIDE_CONVERSATION_FORBIDDEN.has(name)) continue
    const tool = source.get(name)
    if (tool !== undefined) allowed.push(tool)
  }
  return new ToolRegistry(allowed)
}

const buildSideConversationHistory = (
  mainHistory: readonly Message[],
  mode: SessionHostSideConversationInheritance,
): Message[] => {
  if (mode === "none" || mode === "system") return []
  const out: Message[] = []
  let lastAssistantIdx = -1
  for (let i = mainHistory.length - 1; i >= 0; i--) {
    const message = mainHistory[i]
    if (message?.role === "assistant") {
      lastAssistantIdx = i
      break
    }
  }
  if (lastAssistantIdx < 1) return out
  for (let i = lastAssistantIdx - 1; i >= 0; i--) {
    const message = mainHistory[i]
    if (message?.role === "user") {
      out.push(message, mainHistory[lastAssistantIdx] as Message)
      break
    }
  }
  return out
}

const extractSideConversationAnswerText = (outcome: AgentOutcome): string => {
  for (let i = outcome.messages.length - 1; i >= 0; i--) {
    const message = outcome.messages[i]
    if (message?.role !== "assistant") continue
    return message.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("")
  }
  return ""
}

export interface UsageTally {
  inputTokens: number
  outputTokens: number
}

export const createUsageTallyStream = (
  source: AgentConfig["stream"],
  tally: UsageTally,
): AgentConfig["stream"] => ({
  emit(event) {
    if (event.type === "usage") {
      tally.inputTokens += event.inputTokens ?? 0
      tally.outputTokens += event.outputTokens ?? 0
    }
    source.emit(event)
  },
})

/** Build the side-chat config from an explicit allowlist. Do not spread the
 * parent base: it contains session hooks and mutable stores owned by the main
 * conversation (for example Radar and prompt-usage sinks). */
export const buildIsolatedSideConversationConfig = (args: {
  readonly base: RuntimeBase
  readonly registry: ToolRegistry
  readonly stream: AgentConfig["stream"]
  readonly signal: AbortSignal
  readonly maxTurns: number
  readonly messages: readonly Message[]
}): AgentConfig => ({
  llm: args.base.llm,
  registry: args.registry,
  stream: args.stream,
  permission: args.base.permission,
  messages: [...args.messages],
  system: args.base.system,
  cwd: args.base.cwd,
  maxTurns: args.maxTurns,
  signal: args.signal,
})

export const startSideConversation = async (args: {
  readonly base: RuntimeBase
  readonly question: string
  readonly messages: readonly Message[]
  readonly signal: AbortSignal
  readonly inherit?: SessionHostSideConversationInheritance
  readonly tools?: readonly string[]
  readonly maxTurns?: number
}): Promise<SessionHostSideConversationResult> => {
  const inheritance = args.inherit ?? "system"
  const allowlist = args.tools ?? SIDE_CONVERSATION_DEFAULT_TOOLS
  const requestedTurns = args.maxTurns ?? 3
  const maxTurns = Math.max(1, Math.min(requestedTurns, SIDE_CONVERSATION_MAX_TURNS_CAP))
  const filteredRegistry = buildSideConversationRegistry(args.base.registry, allowlist)
  const inherited = buildSideConversationHistory(args.messages, inheritance)
  const userTurn: Message = {
    role: "user",
    content: [{ type: "text", text: args.question }],
  }
  const messages: Message[] = [...inherited, userTurn]
  const tally: UsageTally = { inputTokens: 0, outputTokens: 0 }
  const stream = createUsageTallyStream(args.base.stream, tally)
  const outcome = await runAgent(
    buildIsolatedSideConversationConfig({
      base: args.base,
      registry: filteredRegistry,
      stream,
      messages,
      signal: args.signal,
      maxTurns,
    }),
  )
  return {
    outcome,
    answerText: extractSideConversationAnswerText(outcome),
    inputTokens: tally.inputTokens,
    outputTokens: tally.outputTokens,
    toolsAvailable: filteredRegistry.specs().length,
  }
}
