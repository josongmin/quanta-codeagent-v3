import { errMessage } from "@/shared"
import { classifyGroundingParserError, type GroundingErrorKind } from "./diagnostics"
import {
  GROUNDING_CONFIDENCE,
  GROUNDING_INTENTS,
  GROUNDING_SCOPES,
  type GroundingDecision,
  type GroundingOutputProtocol,
} from "./schema"
export interface GroundingParseResult {
  rawText: string
  structuredOutputProtocol: GroundingOutputProtocol
  structuredOutputValid: boolean
  decision?: GroundingDecision
  error?: string
  errorKind?: GroundingErrorKind
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isOneOf = <T extends readonly string[]>(value: unknown, items: T): value is T[number] =>
  typeof value === "string" && (items as readonly string[]).includes(value)

export const extractJsonObject = (text: string): string | null => {
  const start = text.indexOf("{")
  if (start < 0) return null
  let depth = 0
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (ch === "{") depth += 1
    if (ch === "}") {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

export const parseGroundingDecisionObject = (raw: unknown): GroundingDecision => {
  if (!isRecord(raw)) throw new Error("decision is not an object")
  const activeThreadId = raw["activeThreadId"]
  const referentId = raw["referentId"]
  const intent = raw["intent"]
  const scope = raw["scope"]
  const shouldClarify = raw["shouldClarify"]
  const confidence = raw["confidence"]
  if (activeThreadId !== null && typeof activeThreadId !== "string") {
    throw new Error("activeThreadId must be string|null")
  }
  if (referentId !== null && typeof referentId !== "string") {
    throw new Error("referentId must be string|null")
  }
  if (!isOneOf(intent, GROUNDING_INTENTS)) {
    throw new Error(`intent must be one of ${GROUNDING_INTENTS.join(", ")}`)
  }
  if (!isOneOf(scope, GROUNDING_SCOPES)) {
    throw new Error(`scope must be one of ${GROUNDING_SCOPES.join(", ")}`)
  }
  if (typeof shouldClarify !== "boolean") {
    throw new Error("shouldClarify must be boolean")
  }
  if (!isOneOf(confidence, GROUNDING_CONFIDENCE)) {
    throw new Error(`confidence must be one of ${GROUNDING_CONFIDENCE.join(", ")}`)
  }
  return { activeThreadId, referentId, intent, scope, shouldClarify, confidence }
}

const parseJsonRoot = (rawText: string): unknown => {
  const trimmed = rawText.trim()
  if (trimmed === "") throw new Error("response is empty")
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (error) {
    throw new Error(`JSON parse failed: ${errMessage(error)}`)
  }
  return parsed
}

const unwrapProviderStructuredDecision = (raw: unknown): GroundingDecision => {
  if (!isRecord(raw)) throw new Error("provider structured output root is not an object")
  if (
    "activeThreadId" in raw &&
    "referentId" in raw &&
    "intent" in raw &&
    "scope" in raw &&
    "shouldClarify" in raw &&
    "confidence" in raw
  ) {
    return parseGroundingDecisionObject(raw)
  }
  for (const key of ["decision", "groundingDecision", "grounding_decision", "output"] as const) {
    if (key in raw) return parseGroundingDecisionObject(raw[key])
  }
  throw new Error("provider structured output did not contain a decision object")
}

export const parseGroundingDecisionText = (
  rawText: string,
  protocol: GroundingOutputProtocol = "exact_json",
): GroundingParseResult => {
  try {
    const parsed = parseJsonRoot(rawText)
    const decision =
      protocol === "provider_structured_object"
        ? unwrapProviderStructuredDecision(parsed)
        : parseGroundingDecisionObject(parsed)
    return {
      rawText,
      structuredOutputProtocol: protocol,
      structuredOutputValid: true,
      decision,
    }
  } catch (error) {
    const message = errMessage(error)
    return {
      rawText,
      structuredOutputProtocol: protocol,
      structuredOutputValid: false,
      error: message,
      errorKind: classifyGroundingParserError(message),
    }
  }
}
