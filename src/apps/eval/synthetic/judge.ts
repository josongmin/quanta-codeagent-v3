/**
 * LLM-as-judge for synthetic scenarios. Takes the scenario rubric + the
 * captured run output, asks a judge model for per-rubric pass/fail, and
 * computes a weighted score.
 *
 * Error surface contract (critical — no silent conflation):
 *
 *   - `error: undefined` ⇒ judge ran; `score`/`rubric` reflect the model's
 *     verdict (every rubric `pass:false` is a legitimate judgement).
 *   - `error: defined`   ⇒ INFRA failure (stream errored, no parseable JSON,
 *     malformed shape). Callers MUST surface this as a distinct `error`
 *     verdict — never lump it into `fail` (would falsely tank the score).
 *
 * Calibration knob: pass a `judgePrompt` override to bias toward stricter or
 * laxer scoring (default is neutral).
 */
import type { LLMPort, Message } from "@/llm"
import { assembleFromEvents } from "@/llm"
import { errMessage } from "@/shared"
import type { RubricItem, Scenario } from "./scenario"

export interface JudgeInput {
  scenario: Scenario
  assistantText: string
  toolsUsed: readonly string[]
  /** Surface to the judge so it can reason about tool selection. */
  turns: number
  stopReason: string
}

export interface JudgeVerdict {
  /** Per-rubric pass/fail in scenario order. */
  rubric: readonly { name: string; pass: boolean }[]
  /** Weighted score ∈ [0,1]. */
  score: number
  raw: string
  /** Set ONLY on infra failure (stream errored, no JSON, malformed shape).
   *  Callers MUST distinguish this from a legitimate all-fail rubric. */
  error?: string
}

export interface JudgeOpts {
  /** LLM adapter — its `model` is taken from the port (constructed elsewhere). */
  llm: LLMPort
  /** Override the judge system prompt (for calibration). */
  judgePrompt?: string
}

const DEFAULT_SYSTEM = [
  "You are a strict but fair code-review judge.",
  "Score each rubric item PASS or FAIL based ONLY on the agent transcript and tool usage shown.",
  "Reply with a SINGLE JSON object only — no prose, no markdown fences.",
  'Shape: { "rubric": [ { "id": "<rubric-id>", "pass": true|false, "why": "<≤120 chars>" } ] }',
  "Order MUST match the input rubric. Include every item.",
].join("\n")

const buildUser = (i: JudgeInput): string => {
  const rubricLines = i.scenario.rubric
    .map((r, idx) => `${idx + 1}. id=${r.id} — ${r.description}`)
    .join("\n")
  return [
    `Use case: ${i.scenario.usecase}`,
    `Scenario: ${i.scenario.title}`,
    "",
    "User prompt to the agent:",
    "---",
    i.scenario.prompt,
    "---",
    "",
    "Rubric:",
    rubricLines,
    "",
    `Agent finished in ${i.turns} turn(s), stop=${i.stopReason}.`,
    `Tools used (in order): ${i.toolsUsed.length === 0 ? "(none)" : i.toolsUsed.join(", ")}`,
    "",
    "Agent assistant text (full):",
    "---",
    i.assistantText.length > 0 ? i.assistantText : "(no assistant text)",
    "---",
  ].join("\n")
}

const extractJson = (s: string): string | null => {
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

const weightedScore = (
  rubric: readonly RubricItem[],
  verdicts: readonly { id: string; pass: boolean }[],
): number => {
  let acc = 0
  let total = 0
  const verdictById = new Map(verdicts.map((v) => [v.id, v.pass]))
  for (const item of rubric) {
    const w = item.weight ?? 1
    total += w
    if (verdictById.get(item.id) === true) acc += w
  }
  return total === 0 ? 0 : acc / total
}

const errVerdict = (rubric: readonly RubricItem[], raw: string, error: string): JudgeVerdict => ({
  rubric: rubric.map((r) => ({ name: r.id, pass: false })),
  score: 0,
  raw,
  error,
})

export const judge = async (input: JudgeInput, opts: JudgeOpts): Promise<JudgeVerdict> => {
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: buildUser(input) }] },
  ]
  const events = []
  try {
    for await (const e of opts.llm.stream({
      system: [{ type: "text", text: opts.judgePrompt ?? DEFAULT_SYSTEM }],
      messages,
      tools: [],
    })) {
      events.push(e)
    }
  } catch (e) {
    return errVerdict(input.scenario.rubric, "", `llm stream: ${errMessage(e)}`)
  }
  const { message } = assembleFromEvents(events)
  const raw = message.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("")
  return parseVerdict(raw, input.scenario.rubric)
}

const parseVerdict = (raw: string, rubric: readonly RubricItem[]): JudgeVerdict => {
  const block = extractJson(raw)
  if (block === null) return errVerdict(rubric, raw, "no JSON object in response")
  let obj: unknown
  try {
    obj = JSON.parse(block)
  } catch (e) {
    return errVerdict(rubric, raw, `JSON parse: ${errMessage(e)}`)
  }
  if (typeof obj !== "object" || obj === null) {
    return errVerdict(rubric, raw, "response is not an object")
  }
  const items = (obj as { rubric?: unknown }).rubric
  if (!Array.isArray(items)) return errVerdict(rubric, raw, "response.rubric is not an array")
  const parsed: { id: string; pass: boolean }[] = []
  for (const it of items) {
    if (typeof it !== "object" || it === null) continue
    const id = (it as { id?: unknown }).id
    const pass = (it as { pass?: unknown }).pass
    if (typeof id === "string" && typeof pass === "boolean") parsed.push({ id, pass })
  }
  // Every rubric item MUST have a verdict in the response. A model that
  // returned a partial set is malformed — surface that as an error rather
  // than letting unscored items default-fail and tank the score.
  if (parsed.length < rubric.length) {
    return errVerdict(
      rubric,
      raw,
      `partial verdict: ${parsed.length}/${rubric.length} rubric items scored`,
    )
  }
  const verdictById = new Map(parsed.map((p) => [p.id, p.pass]))
  return {
    rubric: rubric.map((r) => ({ name: r.id, pass: verdictById.get(r.id) ?? false })),
    score: weightedScore(rubric, parsed),
    raw,
  }
}
