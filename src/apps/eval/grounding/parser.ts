import {
  GROUNDING_CONFIDENCE,
  GROUNDING_INTENTS,
  GROUNDING_SCOPES,
  type GroundingDecision,
} from "./schema"
import { classifyGroundingParserError, type GroundingErrorKind } from "./diagnostics"

export interface GroundingParseResult {
  rawText: string
  decision?: GroundingDecision
  error?: string
  errorKind?: GroundingErrorKind
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

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

const parseDecisionObject = (raw: unknown): GroundingDecision => {
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

export const parseGroundingDecisionText = (rawText: string): GroundingParseResult => {
  const block = extractJsonObject(rawText)
  if (block === null) {
    const error = "no JSON object in response"
    return { rawText, error, errorKind: classifyGroundingParserError(error) }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(block)
  } catch (error) {
    const message = `JSON parse failed: ${error instanceof Error ? error.message : String(error)}`
    return {
      rawText,
      error: message,
      errorKind: classifyGroundingParserError(message),
    }
  }
  try {
    return {
      rawText,
      decision: parseDecisionObject(parsed),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      rawText,
      error: message,
      errorKind: classifyGroundingParserError(message),
    }
  }
}
