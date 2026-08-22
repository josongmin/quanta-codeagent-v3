import type { Verdict } from "../types"
import type { GroundingCase, GroundingDecision } from "./schema"

export interface GroundingFieldMatches {
  activeThread: boolean
  referent: boolean
  intent: boolean
  scope: boolean
  shouldClarify: boolean
  exactTuple: boolean
  wrongThread: boolean
  mustClarifyMiss: boolean
  staleContextTrapMiss: boolean
}

export interface GroundingScore {
  verdict: Extract<Verdict, "pass" | "partial" | "fail">
  matches: GroundingFieldMatches
}

export const emptyGroundingMatches = (): GroundingFieldMatches => ({
  activeThread: false,
  referent: false,
  intent: false,
  scope: false,
  shouldClarify: false,
  exactTuple: false,
  wrongThread: false,
  mustClarifyMiss: false,
  staleContextTrapMiss: false,
})

export const scoreGroundingDecision = (
  groundingCase: GroundingCase,
  actual: GroundingDecision,
): GroundingScore => {
  const activeThread = actual.activeThreadId === groundingCase.gold.activeThreadId
  const referent = actual.referentId === groundingCase.gold.referentId
  const intent = actual.intent === groundingCase.gold.intent
  const scope = actual.scope === groundingCase.gold.scope
  const shouldClarify = actual.shouldClarify === groundingCase.gold.shouldClarify
  const exactTuple = activeThread && referent && intent && scope && shouldClarify
  const wrongThread = !activeThread
  const mustClarifyMiss = groundingCase.bucket === "must_clarify" && actual.shouldClarify !== true
  const staleContextTrapMiss =
    groundingCase.bucket === "stale_context_trap" && (!activeThread || !referent)
  const matches: GroundingFieldMatches = {
    activeThread,
    referent,
    intent,
    scope,
    shouldClarify,
    exactTuple,
    wrongThread,
    mustClarifyMiss,
    staleContextTrapMiss,
  }
  if (exactTuple) return { verdict: "pass", matches }
  if (wrongThread || mustClarifyMiss || staleContextTrapMiss) {
    return { verdict: "fail", matches }
  }
  if (activeThread && shouldClarify) {
    return { verdict: "partial", matches }
  }
  return { verdict: "fail", matches }
}
