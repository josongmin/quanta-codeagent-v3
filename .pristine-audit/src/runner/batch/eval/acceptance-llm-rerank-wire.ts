/**
 * Driver-side wire for the LLM acceptance soft-reranker (competitor strategies
 * #2 chooser / #1 reviewer). Couples the pure bridge ({@link buildAcceptanceLlmRerank})
 * to the live {@link LLMPort} by turning a one-shot stream into the injected `ask`.
 *
 * Knob: `QUANTA_BENCH_LLM_SELECT` = `chooser` | `reviewer` (anything else / unset ⇒
 * OFF ⇒ no reranker ⇒ byte-identical). This is a measure-first absorbed lever (same
 * class as `QUANTA_BENCH_SIMPLICITY` / `QUANTA_BENCH_SIBLING` — A/B before promoting
 * to a posture/schema knob), so it is read directly at the driver readSite rather
 * than threaded through the knob-schema SSOT.
 *
 * Kept out of driver.ts (already a god-module) as a small leaf so the env parser is
 * unit-testable and the @/llm coupling stays off the pure selector path.
 */

import { assembleFromEvents, type LLMPort, type Message, type StreamEvent } from "@/llm"
import { buildAcceptanceLlmRerank, type LlmRerankMode } from "./acceptance-llm-rerank"
import type { AcceptanceLlmRerank } from "./acceptance-select"

/** Parse `QUANTA_BENCH_LLM_SELECT`. Only the two exact modes turn it on. */
export const resolveLlmSelectMode = (
  env: Record<string, string | undefined>,
): LlmRerankMode | undefined => {
  const raw = env.QUANTA_BENCH_LLM_SELECT?.trim().toLowerCase()
  if (raw === "chooser") return "chooser"
  if (raw === "reviewer") return "reviewer"
  return undefined
}

const collectText = (events: readonly StreamEvent[]): string =>
  assembleFromEvents([...events])
    .message.content.filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim()

const LLM_SELECT_SYSTEM =
  "You are a meticulous software-engineering reviewer judging candidate patches " +
  "for whether they resolve a reported issue at its root cause. Reply with ONLY the " +
  "single requested line."

/**
 * Build the acceptance soft-reranker from a live LLM port. The `ask` runs one
 * tool-less streamed turn and returns the assembled text; a stream error throws,
 * which the pure cores catch and FAIL-OPEN to the deterministic winner.
 */
export const buildLlmRerankFromPort = (args: {
  readonly llm: LLMPort
  readonly problemStatement: string
  readonly mode: LlmRerankMode
  readonly signal?: AbortSignal
}): AcceptanceLlmRerank => {
  const ask = async (prompt: string): Promise<string> => {
    const events: StreamEvent[] = []
    const messages: Message[] = [{ role: "user", content: [{ type: "text", text: prompt }] }]
    for await (const event of args.llm.stream({
      system: [{ type: "text", text: LLM_SELECT_SYSTEM }],
      messages,
      tools: [],
      ...(args.signal !== undefined ? { signal: args.signal } : {}),
    })) {
      events.push(event)
    }
    return collectText(events)
  }
  return buildAcceptanceLlmRerank(args.mode, args.problemStatement, ask)
}
