import { assembleFromEvents, type LLMPort, type Message, type StreamEvent } from "@/llm"
import { errMessage } from "@/shared"
import {
  buildCandidateReviewLlmEvidencePacket,
  candidatePatchHash,
  type LlmEvidencePacket,
  type OwnerEvidenceFact,
  renderLlmEvidencePacket,
} from "./llm-evidence-packet"

const LLM_RISK_GATE_SYSTEM = [
  "You are a strict semantic expansion gate for candidate 0 in SWE-bench verify-select.",
  "Your job is NOT to judge correctness and NOT to pick a winner.",
  "Decide only whether the outer selector should spend another candidate.",
  "Expand under uncertainty.",
  "Reply with ONE JSON object only. No prose, no markdown fences.",
  'Shape: {"expand": boolean, "reasons": ["issue-condition-not-evidenced" | "behavioral-intent-not-evidenced" | "symptom-site-only" | "public-example-overfit-risk" | "uncertain"], "why": "<optional short note>"}',
].join("\n")

const LLM_RISK_REASONS = [
  "issue-condition-not-evidenced",
  "behavioral-intent-not-evidenced",
  "symptom-site-only",
  "public-example-overfit-risk",
  "uncertain",
] as const

type LlmRiskReason = (typeof LLM_RISK_REASONS)[number]

const LLM_RISK_REASON_SET = new Set<string>(LLM_RISK_REASONS)

export interface LlmPatchRiskInput {
  readonly llm: LLMPort
  readonly problemStatement: string
  readonly patch: string
  readonly candidateFiles: readonly string[]
  readonly ownerEvidence?: readonly OwnerEvidenceFact[]
  readonly ownerFiles?: readonly string[]
  readonly signal?: AbortSignal
}

export interface LlmPatchRiskDecision {
  readonly expand: boolean
  readonly reasons: readonly string[]
  readonly packet: LlmEvidencePacket
}

interface RawLlmPatchRisk {
  expand?: unknown
  reasons?: unknown
}

const extractJsonObject = (s: string): string | null => {
  const start = s.indexOf("{")
  if (start < 0) return null
  let depth = 0
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) return s.slice(start, i + 1)
    }
  }
  return null
}

const knownReasons = (value: unknown): LlmRiskReason[] => {
  if (!Array.isArray(value)) return []
  const out: LlmRiskReason[] = []
  const seen = new Set<LlmRiskReason>()
  for (const entry of value) {
    if (
      typeof entry !== "string" ||
      !LLM_RISK_REASON_SET.has(entry) ||
      seen.has(entry as LlmRiskReason)
    )
      continue
    const reason = entry as LlmRiskReason
    seen.add(reason)
    out.push(reason)
  }
  return out
}

const invalidDecision = (reason: string, packet: LlmEvidencePacket): LlmPatchRiskDecision => ({
  expand: true,
  reasons: [reason],
  packet,
})

const parseDecision = (raw: string, packet: LlmEvidencePacket): LlmPatchRiskDecision => {
  if (raw.trim() === "") return invalidDecision("empty-output", packet)
  const block = extractJsonObject(raw)
  if (block === null) return invalidDecision("invalid-output", packet)
  let obj: RawLlmPatchRisk
  try {
    obj = JSON.parse(block) as RawLlmPatchRisk
  } catch (e) {
    return invalidDecision(`invalid-output:${errMessage(e)}`, packet)
  }
  if (typeof obj.expand !== "boolean") return invalidDecision("invalid-output", packet)
  const reasons = knownReasons(obj.reasons)
  if (obj.expand && reasons.length === 0) return invalidDecision("invalid-output", packet)
  return {
    expand: obj.expand,
    reasons: obj.expand ? reasons : [],
    packet,
  }
}

const collectText = (events: readonly StreamEvent[]): string =>
  assembleFromEvents([...events])
    .message.content.filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim()

export const evaluateLlmPatchRisk = async (
  input: LlmPatchRiskInput,
): Promise<LlmPatchRiskDecision> => {
  const ownerEvidence: readonly OwnerEvidenceFact[] =
    input.ownerEvidence ??
    (input.ownerFiles ?? []).map((file) => ({
      file,
      symbols: [],
      provenance: "selection-owner",
    }))
  const packet = buildCandidateReviewLlmEvidencePacket({
    problemStatement: input.problemStatement,
    candidatePatchHash: candidatePatchHash(input.patch),
    candidateFiles: input.candidateFiles,
    ownerEvidence,
  })
  if (input.signal?.aborted === true) return invalidDecision("cancelled", packet)
  const events = []
  const messages: Message[] = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: [
            renderLlmEvidencePacket(packet),
            "",
            "Candidate patch (unified diff):",
            "```diff",
            input.patch === "" ? "(empty patch)" : input.patch,
            "```",
          ].join("\n"),
        },
      ],
    },
  ]
  try {
    for await (const event of input.llm.stream({
      system: [{ type: "text", text: LLM_RISK_GATE_SYSTEM }],
      messages,
      tools: [],
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    })) {
      events.push(event)
    }
  } catch (_e) {
    return invalidDecision((input.signal?.aborted ?? false) ? "cancelled" : "stream-error", packet)
  }
  return parseDecision(collectText(events), packet)
}
