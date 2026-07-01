/**
 * Driver-side wire for the observe-only post-fix repro-viability review (spec
 * step-5). Couples the pure bridge ({@link buildReproViabilityPrompt} /
 * {@link parseReproViabilityReply}) to the live {@link LLMPort} by turning one
 * tool-less stream into a typed verdict. MIRROR of `acceptance-llm-rerank-wire.ts`
 * (the real LLM-call seam): same `assembleFromEvents`/collectText idiom and the same
 * FAIL-OPEN contract (a stream error is caught and returned as the typed 3rd state,
 * never propagated), so the observation can NEVER divert control flow or kill an
 * instance.
 *
 * Knob: `QUANTA_BENCH_REPRO_VIABILITY` (default-OFF opt-in). Unset ⇒
 * {@link maybeReviewReproViability} returns `undefined` with ZERO `llm.stream` calls
 * ⇒ nothing attached ⇒ byte-identical. Read directly at the driver readSite via
 * `gateOn`, exactly like the sibling `QUANTA_BENCH_SUBMIT_REVIEW`.
 *
 * Kept out of driver.ts (already a god-module) as a small leaf so the env parser and
 * the fail-open path are unit-testable and the @/llm coupling stays off the pure core.
 */

import { assembleFromEvents, type LLMPort, type Message, type StreamEvent } from "@/llm"
import { gateOn } from "@/shared/env-flag"
import {
  buildReproViabilityPrompt,
  parseReproViabilityReply,
  type ReproViabilityReview,
} from "./repro-viability"

/** Parse `QUANTA_BENCH_REPRO_VIABILITY`. Only canonical truthy tokens turn it on. */
export const resolveReproViabilityMode = (env: Record<string, string | undefined>): boolean =>
  gateOn(env, "QUANTA_BENCH_REPRO_VIABILITY")

const collectText = (events: readonly StreamEvent[]): string =>
  assembleFromEvents([...events])
    .message.content.filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim()

const VIABILITY_SYSTEM =
  "You are a meticulous software-engineering reviewer judging whether a candidate " +
  "patch is structurally capable of making a reproducing test pass. Reply with ONLY " +
  "the single requested line."

/**
 * Build the viability review from a live LLM port. Runs ONE tool-less streamed turn
 * over the three real inputs and parses the reply. FAIL-OPEN: a stream error (or an
 * off-spec reply) yields the typed `unparseable` verdict — never a throw.
 */
export const buildReproViabilityFromPort = async (args: {
  readonly llm: LLMPort
  readonly problemStatement: string
  readonly reproSources: readonly string[]
  readonly capturedPatch: string
  readonly signal?: AbortSignal
}): Promise<ReproViabilityReview> => {
  const prompt = buildReproViabilityPrompt(args.problemStatement, args.reproSources, args.capturedPatch)
  const messages: Message[] = [{ role: "user", content: [{ type: "text", text: prompt }] }]
  try {
    const events: StreamEvent[] = []
    for await (const event of args.llm.stream({
      system: [{ type: "text", text: VIABILITY_SYSTEM }],
      messages,
      tools: [],
      ...(args.signal !== undefined ? { signal: args.signal } : {}),
    })) {
      events.push(event)
    }
    return parseReproViabilityReply(collectText(events))
  } catch {
    // Observe-invariant: the review can never divert control flow. A stream failure
    // is an inconclusive OBSERVATION, mirroring the acceptance reranker's catch→null
    // (deterministic-winner-stands) fail-open.
    return { verdict: "unparseable" }
  }
}

/**
 * Driver seam: gate off ⇒ `undefined` (0 llm calls ⇒ byte-identical). Gate on ⇒
 * a typed review. An empty `reproSources` (no reproducing test source captured) is
 * NOT an error — it is the typed `unparseable` observation with a reason, with ZERO
 * llm calls (nothing to judge against).
 */
export const maybeReviewReproViability = async (args: {
  readonly llm: LLMPort
  readonly problemStatement: string
  readonly reproSources: readonly string[]
  readonly capturedPatch: string
  readonly signal?: AbortSignal
  readonly env?: Record<string, string | undefined>
}): Promise<ReproViabilityReview | undefined> => {
  if (!resolveReproViabilityMode(args.env ?? process.env)) return undefined
  if (args.reproSources.length === 0) {
    return { verdict: "unparseable", reason: "no reproducing source" }
  }
  return buildReproViabilityFromPort(args)
}
