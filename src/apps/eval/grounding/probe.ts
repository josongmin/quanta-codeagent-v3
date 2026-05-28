import type { ContextEvent } from "@/agent/context-change"
import { buildTurnContext, type RepoRules } from "@/agent"
import type { LLMPort, Message } from "@/llm"
import { costUsd } from "@/observability/pricing"
import type { TokenUsage } from "../storage/schema"
import { classifyGroundingInfraError, type GroundingErrorKind } from "./diagnostics"
import { parseGroundingDecisionText, type GroundingParseResult } from "./parser"
import type {
  GroundingCase,
  GroundingMode,
  GroundingOutputProtocol,
  GroundingProbeProfile,
} from "./schema"

export interface GroundingProbeOpts {
  llm: LLMPort
  probeProfile?: GroundingProbeProfile
  outputProtocol?: GroundingOutputProtocol
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

export const resolveGroundingProbeProfile = (
  mode: GroundingMode,
): { probeProfile: GroundingProbeProfile; outputProtocol: GroundingOutputProtocol } => {
  switch (mode) {
    case "raw":
      return { probeProfile: "minimal", outputProtocol: "exact_json" }
    case "engine":
      return { probeProfile: "runtime_parity", outputProtocol: "exact_json" }
    case "assisted":
      return { probeProfile: "assisted", outputProtocol: "exact_json" }
  }
}

const buildProbePrompt = (
  groundingCase: GroundingCase,
  probeProfile: GroundingProbeProfile,
  outputProtocol: GroundingOutputProtocol,
): string => {
  const stateContractBlock =
    groundingCase.stateContract === undefined
      ? []
      : [
          "Authoritative state snapshot:",
          JSON.stringify(groundingCase.stateContract),
          "",
        ]
  const protocolLine =
    outputProtocol === "provider_structured_object"
      ? 'Return exactly one JSON object. The root may either be the decision object itself or wrap it under "decision".'
      : "Return exactly one JSON object and no prose."
  const base = [
    "Resolve the user's underspecified utterance against the prior conversation context.",
    "History messages may include a <grounding-meta>{...}</grounding-meta> header; treat that JSON as authoritative context metadata.",
    ...stateContractBlock,
  ]
  const shape = [
    "Do NOT answer the utterance itself.",
    protocolLine,
    'Shape: {"activeThreadId": string|null, "referentId": string|null, "intent": "status_check"|"execute_change"|"explain"|"approval_request"|"clarify_request"|"fact_lookup", "scope": "current_workstream"|"entire_session"|"latest_tool_result"|"specific_file"|"specific_subthread", "shouldClarify": boolean, "confidence": "high"|"medium"|"low"}',
  ]
  const rules =
    probeProfile === "minimal"
      ? []
      : probeProfile === "runtime_parity"
        ? [
            "Decision rules:",
            "- intent is the user's underlying goal, not the assistant's response act.",
            "- If exactly one current active thread is identifiable and the utterance targets the current workstream, do not return activeThreadId=null.",
            "- Prefer current/active over paused, archived, historical, or background threads when those conflict.",
            "- Only set shouldClarify=true when multiple plausible threads or referents remain after applying active-vs-paused and latest-result cues.",
          ]
        : [
            "Decision rules:",
            "- intent is the user's underlying goal, not the assistant's response act.",
            "- If the user is asking you to do work but you need disambiguation, keep the latent intent such as execute_change and set shouldClarify=true.",
            "- Use intent=clarify_request only when the user's utterance itself is explicitly asking for clarification or explanation of ambiguity.",
            "- If exactly one current active thread is identifiable and the utterance targets the current workstream, do not return activeThreadId=null.",
            "- If scope=current_workstream, shouldClarify=false, and no narrower file/tool/subthread referent is implied, set referentId equal to activeThreadId.",
            "- If the utterance names a concrete file path, or authoritative metadata leaves exactly one file candidate, use scope=specific_file and set referentId to that file path.",
            "- If multiple file candidates remain and the utterance uses a generic file cue such as that file/index/entrypoint, keep intent on the user's goal but set shouldClarify=true.",
            "- If scope=latest_tool_result and the latest result is identifiable, set referentId to that result id.",
            "- Prefer current/active over paused, archived, historical, or background threads when those conflict.",
            "- Only set shouldClarify=true when multiple plausible threads or referents remain after applying active-vs-paused and latest-result cues.",
          ]
  return [...base, ...rules, ...shape, "", "Target utterance:", groundingCase.targetUtterance].join("\n")
}

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

const renderHistoryEntry = (entry: GroundingCase["history"][number]): string => {
  const meta: Record<string, unknown> = {}
  if (entry.kind !== undefined) meta["kind"] = entry.kind
  if (entry.threadId !== undefined) meta["threadId"] = entry.threadId
  if (entry.referentId !== undefined) meta["referentId"] = entry.referentId
  if (entry.mentionedFileIds !== undefined) meta["mentionedFileIds"] = entry.mentionedFileIds
  if (entry.mentionedReferentIds !== undefined) meta["mentionedReferentIds"] = entry.mentionedReferentIds
  if (entry.toolName !== undefined) meta["toolName"] = entry.toolName
  if (entry.mentionedThreadIds !== undefined) meta["mentionedThreadIds"] = entry.mentionedThreadIds
  if (entry.policyMarkers !== undefined) meta["policyMarkers"] = entry.policyMarkers
  if (Object.keys(meta).length === 0) return entry.text
  return [`<grounding-meta>${JSON.stringify(meta)}</grounding-meta>`, entry.text].join("\n")
}

const toHistoryMessages = (history: GroundingCase["history"]): Message[] =>
  history.map((entry) => ({
    role: entry.role,
    content: [{ type: "text", text: renderHistoryEntry(entry) }],
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

const isRetryableGroundingStreamError = (message: string, rawText: string): boolean =>
  rawText.trim() === "" && message.includes("LLM stream first-chunk timeout")

const runGroundingStream = async (
  llm: LLMPort,
  system: ReturnType<typeof buildTurnContext>["system"],
  messages: Message[],
  outputProtocol: GroundingOutputProtocol,
): Promise<GroundingProbeResult> => {
  const start = Date.now()
  const usage = { input: 0, output: 0, cacheRead: 0 }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let rawText = ""
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
      if (attempt === 0 && isRetryableGroundingStreamError(message, rawText)) continue
      return {
        rawText,
        error: message,
        errorKind: classifyGroundingInfraError(message),
        durationMs: Date.now() - start,
        ...rollupUsage(usage, llm.model),
      }
    }
    return {
      ...parseGroundingDecisionText(rawText, outputProtocol),
      durationMs: Date.now() - start,
      ...rollupUsage(usage, llm.model),
    }
  }
  return {
    rawText: "",
    structuredOutputProtocol: outputProtocol,
    structuredOutputValid: false,
    error: "llm stream failed: retry budget exhausted",
    errorKind: classifyGroundingInfraError("retry budget exhausted"),
    durationMs: Date.now() - start,
    ...rollupUsage(usage, llm.model),
  }
}

export const runGroundingProbe = async (
  groundingCase: GroundingCase,
  opts: GroundingProbeOpts,
): Promise<GroundingProbeResult> => {
  const probeProfile = opts.probeProfile ?? "assisted"
  const outputProtocol = opts.outputProtocol ?? "exact_json"
  const now = opts.now ?? Date.now
  const cwd = groundingCase.cwd ?? process.cwd()
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
      content: [{ type: "text", text: buildProbePrompt(groundingCase, probeProfile, outputProtocol) }],
    },
  ]
  return runGroundingStream(opts.llm, prompt.system, messages, outputProtocol)
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
      content: [
        {
          type: "text",
          text: [
            "Resolve the user's underspecified utterance against the prior conversation context.",
            "Do NOT answer the utterance itself.",
            "Return exactly one JSON object and no prose.",
            'Shape: {"activeThreadId": string|null, "referentId": string|null, "intent": "status_check"|"execute_change"|"explain"|"approval_request"|"clarify_request"|"fact_lookup", "scope": "current_workstream"|"entire_session"|"latest_tool_result"|"specific_file"|"specific_subthread", "shouldClarify": boolean, "confidence": "high"|"medium"|"low"}',
            "",
            "Target utterance:",
            "이제 다 됐냐?",
          ].join("\n"),
        },
      ],
    },
  ], opts.outputProtocol ?? "exact_json")
  return {
    ...result,
    ...(opts.llm.provider !== undefined ? { provider: opts.llm.provider } : {}),
    ...(opts.llm.model !== undefined ? { model: opts.llm.model } : {}),
    ...(opts.llm.surfaceId !== undefined ? { surfaceId: opts.llm.surfaceId } : {}),
    ...(opts.llm.transportId !== undefined ? { transportId: opts.llm.transportId } : {}),
    ...(opts.llm.authMode !== undefined ? { authMode: opts.llm.authMode } : {}),
  }
}
