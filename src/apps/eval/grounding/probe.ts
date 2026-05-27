import type { ContextEvent } from "@/agent/context-change"
import { buildTurnContext, type RepoRules } from "@/agent"
import type { LLMPort, Message } from "@/llm"
import { costUsd } from "@/observability/pricing"
import type { TokenUsage } from "../storage/schema"
import { classifyGroundingInfraError, type GroundingErrorKind } from "./diagnostics"
import { parseGroundingDecisionText, type GroundingParseResult } from "./parser"
import type { GroundingCase } from "./schema"

export interface GroundingProbeOpts {
  llm: LLMPort
  now?: () => number
}

export interface GroundingProbeResult extends GroundingParseResult {
  durationMs: number
  tokens?: TokenUsage
  costUsd?: number | null
}

export interface GroundingPreflightResult extends GroundingParseResult {
  durationMs: number
  provider?: string
  model?: string
  surfaceId?: string
  transportId?: string
  authMode?: string
  tokens?: TokenUsage
  costUsd?: number | null
}

const buildProbePrompt = (targetUtterance: string): string =>
  [
    "Resolve the user's underspecified utterance against the prior conversation context.",
    "Do NOT answer the utterance itself.",
    "Return exactly one JSON object and no prose.",
    'Shape: {"activeThreadId": string|null, "referentId": string|null, "intent": "status_check"|"execute_change"|"explain"|"approval_request"|"clarify_request"|"fact_lookup", "scope": "current_workstream"|"entire_session"|"latest_tool_result"|"specific_file"|"specific_subthread", "shouldClarify": boolean, "confidence": "high"|"medium"|"low"}',
    "",
    "Target utterance:",
    targetUtterance,
  ].join("\n")

const joinPseudo = (cwd: string, file: string): string =>
  cwd.endsWith("/") ? `${cwd}${file}` : `${cwd}/${file}`

const toRepoRules = (text: string | undefined, cwd: string, now: () => number): RepoRules | undefined =>
  text === undefined
    ? undefined
    : {
        sourcePath: joinPseudo(cwd, "GROUNDING_CASE_RULES.md"),
        entrypoint: "GROUNDING_CASE_RULES.md",
        body: text,
        loadedAt: now(),
      }

const toHistoryMessages = (history: GroundingCase["history"]): Message[] =>
  history.map((entry) => ({
    role: entry.role,
    content: [{ type: "text", text: entry.text }],
  }))

const toContextEvents = (events: GroundingCase["contextChanges"]): readonly ContextEvent[] | undefined =>
  events?.map((event, index) => ({
    kind: "context_update",
    field: event.field,
    prev: event.prev,
    next: event.next,
    at: event.at ?? index + 1,
  }))

const rollupUsage = (
  usage: { input: number; output: number; cacheRead: number },
  model: string | undefined,
): { tokens?: TokenUsage; costUsd?: number | null } => {
  const hasUsage = usage.input > 0 || usage.output > 0 || usage.cacheRead > 0
  if (!hasUsage) return {}
  const tokens: TokenUsage = {
    prompt: usage.input,
    completion: usage.output,
    ...(usage.cacheRead > 0 ? { cacheRead: usage.cacheRead } : {}),
  }
  if (model === undefined) return { tokens }
  return { tokens, costUsd: costUsd(model, usage.input, usage.output, usage.cacheRead) }
}

const runGroundingStream = async (
  llm: LLMPort,
  system: ReturnType<typeof buildTurnContext>["system"],
  messages: Message[],
): Promise<GroundingProbeResult> => {
  const start = Date.now()
  let rawText = ""
  const usage = { input: 0, output: 0, cacheRead: 0 }
  try {
    for await (const event of llm.stream({
      system,
      messages,
      tools: [],
    })) {
      if (event.type === "text_delta") rawText += event.delta
      if (event.type === "usage") {
        usage.input += event.inputTokens
        usage.output += event.outputTokens
        usage.cacheRead += event.cacheReadTokens ?? 0
      }
    }
  } catch (error) {
    const message = `llm stream failed: ${error instanceof Error ? error.message : String(error)}`
    return {
      rawText,
      error: message,
      errorKind: classifyGroundingInfraError(message),
      durationMs: Date.now() - start,
      ...rollupUsage(usage, llm.model),
    }
  }
  return {
    ...parseGroundingDecisionText(rawText),
    durationMs: Date.now() - start,
    ...rollupUsage(usage, llm.model),
  }
}

export const runGroundingProbe = async (
  groundingCase: GroundingCase,
  opts: GroundingProbeOpts,
): Promise<GroundingProbeResult> => {
  const now = opts.now ?? Date.now
  const cwd = groundingCase.cwd ?? process.cwd()
  const start = Date.now()
  const repoRules = toRepoRules(groundingCase.repoRulesText, cwd, now)
  const contextChangeEvents = toContextEvents(groundingCase.contextChanges)
  const prompt = buildTurnContext({
    baseMessages: toHistoryMessages(groundingCase.history),
    cwd,
    ...(groundingCase.mode !== undefined ? { mode: groundingCase.mode } : {}),
    ...(groundingCase.memoryContext !== undefined
      ? { memoryContext: groundingCase.memoryContext }
      : {}),
    ...(groundingCase.workingState !== undefined ? { workingState: groundingCase.workingState } : {}),
    ...(repoRules !== undefined ? { repoRules } : {}),
    ...(contextChangeEvents !== undefined ? { contextChangeEvents } : {}),
    now,
  })

  const messages: Message[] = [
    ...prompt.messages,
    {
      role: "user",
      content: [{ type: "text", text: buildProbePrompt(groundingCase.targetUtterance) }],
    },
  ]
  return runGroundingStream(opts.llm, prompt.system, messages)
}

export const runGroundingPreflight = async (
  opts: GroundingProbeOpts,
): Promise<GroundingPreflightResult> => {
  const prompt = buildTurnContext({
    baseMessages: [{ role: "assistant", content: [{ type: "text", text: "Active thread preflight." }] }],
    cwd: process.cwd(),
    now: opts.now ?? Date.now,
  })
  const result = await runGroundingStream(opts.llm, prompt.system, [
    ...prompt.messages,
    {
      role: "user",
      content: [{ type: "text", text: buildProbePrompt("이제 다 됐냐?") }],
    },
  ])
  return {
    ...result,
    ...(opts.llm.provider !== undefined ? { provider: opts.llm.provider } : {}),
    ...(opts.llm.model !== undefined ? { model: opts.llm.model } : {}),
    ...(opts.llm.surfaceId !== undefined ? { surfaceId: opts.llm.surfaceId } : {}),
    ...(opts.llm.transportId !== undefined ? { transportId: opts.llm.transportId } : {}),
    ...(opts.llm.authMode !== undefined ? { authMode: opts.llm.authMode } : {}),
  }
}
