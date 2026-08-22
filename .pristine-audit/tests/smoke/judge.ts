import type { LLMPort, StreamInput } from "@/llm"
import type { JudgeExpect } from "./types"

/**
 * LLM-as-judge runtime (Inspect AI / promptfoo `llm-rubric` parity). Scores an
 * agent's final text against a natural-language rubric on a 0..1 scale.
 *
 * Determinism story:
 *   - tier-0 uses the `cached` score on the {@link JudgeExpect} (gated SYNC in
 *     `expect.ts#checkJudgeCached`) — no LLM round-trip, fully reproducible.
 *   - tier-1 (live) calls {@link runJudge} against the real provider, then
 *     compares to the threshold. The judge model is a SEPARATE call from the
 *     agent conversation so the agent's own model cannot grade itself by
 *     accident in the same context.
 *
 * The judge is asked to emit STRICT JSON `{ "score": <0..1>, "rationale": ... }`.
 * We extract the first JSON object from the response (models often wrap it in
 * prose); a parse failure surfaces as score 0 with the raw text as rationale so
 * a malformed judge fails CLOSED rather than silently passing.
 */
export interface JudgeResult {
  score: number
  rationale: string
}

const JUDGE_SYSTEM =
  "You are a strict evaluator. Given a RUBRIC and an agent's RESPONSE, decide " +
  "how well the response satisfies the rubric. Reply with ONLY a JSON object: " +
  '{"score": <number between 0 and 1>, "rationale": "<one sentence>"}. ' +
  "score 1 = fully satisfies, 0 = does not satisfy."

const buildJudgeInput = (rubric: string, text: string): StreamInput => ({
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: `RUBRIC:\n${rubric}\n\nRESPONSE:\n${text}\n\nReturn the JSON now.` },
      ],
    },
  ],
  system: JUDGE_SYSTEM,
  tools: [],
})

/** Extract + parse the first `{...}` JSON object from a model reply. Returns a
 *  fail-closed `{score:0}` when nothing parses. */
export const parseJudgeReply = (raw: string): JudgeResult => {
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start === -1 || end === -1 || end < start) {
    return { score: 0, rationale: `unparseable judge reply: ${raw.slice(0, 120)}` }
  }
  try {
    const obj = JSON.parse(raw.slice(start, end + 1)) as { score?: unknown; rationale?: unknown }
    const score = typeof obj.score === "number" && Number.isFinite(obj.score) ? obj.score : 0
    const rationale = typeof obj.rationale === "string" ? obj.rationale : ""
    return { score: Math.max(0, Math.min(1, score)), rationale }
  } catch {
    return { score: 0, rationale: `invalid judge JSON: ${raw.slice(0, 120)}` }
  }
}

/** Live judge call. Accepts an optional {@link AbortSignal} so the runner's
 *  wallSeconds budget can actually cut a wedged provider — pre-fix, a stalled
 *  judge stream would hang `applyJudge` forever and the budget check was DEAD
 *  CODE (it sits AFTER applyJudge in the runner). When the signal aborts mid-
 *  stream the partial reply is parsed (fail-closed → score 0) instead of
 *  silently hanging. */
export const runJudge = async (args: {
  judge: JudgeExpect
  text: string
  llm: LLMPort
  signal?: AbortSignal
}): Promise<JudgeResult> => {
  let raw = ""
  try {
    for await (const ev of args.llm.stream(buildJudgeInput(args.judge.rubric, args.text))) {
      if (args.signal?.aborted) break
      if (ev.type === "text_delta") raw += ev.delta
    }
  } catch (e) {
    return {
      score: 0,
      rationale: `judge stream failed: ${(e as Error).message ?? String(e)}`,
    }
  }
  return parseJudgeReply(raw)
}
