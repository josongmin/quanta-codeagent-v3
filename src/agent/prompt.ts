import type { Message, SystemBlock } from "@/llm"

/**
 * System prompt + per-turn context assembly.
 *
 * The cache lever (ADR-0003): the system prompt is STATIC for a session —
 * cwd and the tool set do not change mid-run — so it is built once as
 * `SystemBlock[]` with the final block flagged `cache:true`. That makes the
 * prefix byte-identical every turn, which is what both OpenAI's automatic
 * prefix cache and Anthropic's explicit `cache_control` need to hit. Anything
 * that varies per turn (today's date, cwd/git note, plan-mode notice, memory
 * recall) is NOT folded into the system; it rides as a single trailing
 * `<system-reminder>` user message so the cached prefix never shifts.
 */

/** The static system prompt. No per-turn data — keep it byte-stable so the
 *  provider cache prefix holds across the whole session. The legacy `cwd`
 *  parameter is accepted but ignored: cwd is now per-turn dynamic context
 *  (see {@link buildTurnContext}), kept off the cached prefix on purpose.
 *  The param remains so existing callers (apps) compile unchanged until the
 *  loop is migrated to {@link buildTurnContext}. */
export const buildSystemPrompt = (_cwd?: string): string =>
  [
    "You are Quanta, an autonomous coding agent working directly in a developer's",
    "repository. You operate in a ReAct loop: reason, call a tool, observe the",
    "result, repeat — until the task is genuinely done.",
    "",
    "Operating principles:",
    "- Bias to action. You have the tools to investigate and act; do that instead",
    "  of asking the user what you could find out yourself. Stop only when blocked",
    "  by a real ambiguity, not by uncertainty you can resolve with a tool.",
    "- Always read a file before editing it. Never edit from memory or assumption.",
    "- Never guess file paths, symbols, or APIs. If you are not certain a path",
    "  exists, find it with search/glob first. Hallucinated paths waste turns.",
    "- Prefer the smallest correct change. Use `edit` for targeted edits; reserve",
    "  `write` for new files or a deliberate full rewrite. Do not reformat or",
    "  refactor code you were not asked to touch.",
    "- Match the surrounding code: its style, naming, libraries, and patterns.",
    "  Check imports/manifests before assuming a dependency is available.",
    "- After changing code, verify it. Run the project's tests, type checker, or",
    "  the most specific relevant command via `bash`. Do not claim success on",
    "  unverified changes.",
    "- When a tool fails, read the error and diagnose the actual cause before",
    "  retrying. Do not repeat the same failing call or thrash blindly.",
    "- Work the whole task. If it spans multiple files, carry the change through",
    "  every site; a partial edit that breaks the build is worse than none.",
    "- Keep reasoning tight and act on it. Explain only what the user needs.",
    "",
    "Completion bar: finish only when the task is actually complete AND verified —",
    "the change is in place, it builds/type-checks, and the relevant tests pass.",
    "Then stop calling tools and give a brief summary of what changed and how it",
    "was verified. If you genuinely cannot verify, say so explicitly and explain",
    "why rather than implying success.",
  ].join("\n")

export interface TurnContextInput {
  baseMessages: Message[]
  cwd: string
  planMode: boolean
  memoryContext?: string
}

export interface TurnContext {
  system: SystemBlock[]
  messages: Message[]
}

const PLAN_NOTICE = [
  "PLAN MODE is active. Do NOT modify anything. Use only read-only tools",
  "(read, grep, glob, localize) to investigate, then produce a concrete,",
  "step-by-step implementation plan as your final answer: which files, what",
  "changes, in what order. Stop calling tools once you can write the plan.",
].join("\n")

/** Build the per-turn dynamic context — date, cwd, plan notice, memory — as a
 *  single block of text, or `undefined` when there is nothing to say. */
const buildDynamicContext = (input: TurnContextInput): string | undefined => {
  const parts: string[] = [
    `Today's date is ${new Date().toISOString().slice(0, 10)}.`,
    `Working directory: ${input.cwd}`,
  ]
  if (input.planMode) parts.push("", PLAN_NOTICE)
  const memory = input.memoryContext?.trim()
  if (memory) parts.push("", memory)
  return parts.join("\n")
}

/**
 * Assemble one turn's request. `system` is the STATIC prompt as
 * `SystemBlock[]` with the last block marked `cache:true` (the cache
 * breakpoint) — byte-identical across every turn of a session. `messages` is
 * the caller's history with the dynamic context appended as ONE trailing
 * `<system-reminder>` user message, so the cached prefix is preserved and only
 * the tail varies.
 */
export const buildTurnContext = (input: TurnContextInput): TurnContext => {
  const system: SystemBlock[] = [{ type: "text", text: buildSystemPrompt(), cache: true }]
  const dynamic = buildDynamicContext(input)
  const messages: Message[] = [...input.baseMessages]
  if (dynamic !== undefined) {
    messages.push({
      role: "user",
      content: [{ type: "text", text: `<system-reminder>\n${dynamic}\n</system-reminder>` }],
    })
  }
  return { system, messages }
}
