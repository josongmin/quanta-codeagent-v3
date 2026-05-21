import type { SystemBlock } from "@/llm"

/**
 * Sectioned system prompt assembly.
 *
 * Mirrors the Claude Desktop 1.7196.3 `systemPromptSectionCache` 4-section
 * pattern: the static prefix is split into named, byte-stable sections so the
 * provider's `cache_control` breakpoints (Anthropic caps at 4) can each anchor
 * an independent reuse boundary. Splitting a single 30-50 KiB string into
 * `base + project_md + session_ctx + user_append` lets the cache survive
 * project-policy or user-supplied changes without invalidating the whole
 * prefix — only the trailing affected section recomputes, the rest stays warm.
 *
 * Rules:
 *   - Section ORDER is the cache prefix; never reorder per turn.
 *   - Empty / whitespace-only inputs collapse — never emit an empty block.
 *   - At most {@link MAX_CACHE_BREAKPOINTS} cached sections (Anthropic limit).
 *   - The buildTurnContext caller stays byte-identical when neither projectMd
 *     nor userAppend is supplied: a single base SystemBlock is emitted.
 */

/** Anthropic `cache_control` breakpoint cap. Sectioned prompts MUST stay at
 *  or below this many cached sections or the API rejects the request. */
export const MAX_CACHE_BREAKPOINTS = 4

/** One labelled span of the system prompt. `name` is for diagnostics only;
 *  ordering is by array position. `cache` defaults to true (the whole point of
 *  the section split) but the renderer respects an explicit `false` so callers
 *  can drop the marker for unstable spans (rare). */
export interface PromptSection {
  name: string
  text: string
  cache: boolean
}

/** Render a list of sections to the `SystemBlock[]` shape the LLM port
 *  consumes. Filters nothing — the caller is responsible for collapsing empty
 *  sections (see {@link fourSectionPreset}). */
export const buildSectionedSystemBlocks = (sections: readonly PromptSection[]): SystemBlock[] =>
  sections.map((s) => ({
    type: "text" as const,
    text: s.text,
    cache: s.cache,
  }))

/** Legacy 1-section preset: the entire base prompt as a single cached block.
 *  Used by callers that do not supply per-project or per-user statics so the
 *  emitted `SystemBlock[]` is byte-identical to the pre-section world (one
 *  `{type:"text", text, cache:true}` element). */
export const defaultPromptSections = (basePrompt: string): PromptSection[] => [
  { name: "base", text: basePrompt, cache: true },
]

/** Inputs to {@link fourSectionPreset}. All optional fields collapse when
 *  empty or whitespace-only — the resulting array never carries an empty
 *  block, so the cache prefix stays clean for byte-stable reuse.
 *
 *  - `base`        — Quanta's static system prompt (always present).
 *  - `projectMd`   — repo-local rules body (CLAUDE.md / AGENTS.md), if any.
 *  - `sessionCtx`  — caller-supplied static session context (e.g. tool
 *                    inventory hash, surface flag, install id). Per-turn
 *                    dynamic data (date, cwd) does NOT belong here — that
 *                    rides as a trailing `<system-reminder>` user message.
 *  - `userAppend`  — user-supplied static prefix (e.g. global `~/CLAUDE.md`).
 */
export interface FourSectionInput {
  base: string
  projectMd?: string
  sessionCtx?: string
  userAppend?: string
}

const hasContent = (s: string | undefined): s is string => s !== undefined && s.trim().length > 0

/** Build the 4-section preset (Claude Desktop pattern): base + project_md +
 *  session_ctx + user_append, every present section flagged `cache:true`.
 *  Missing or whitespace-only optional inputs are dropped — the result is
 *  always 1..4 sections, with `base` first and the remaining sections in the
 *  declared order. */
export const fourSectionPreset = (input: FourSectionInput): PromptSection[] => {
  const out: PromptSection[] = [{ name: "base", text: input.base, cache: true }]
  if (hasContent(input.projectMd)) {
    out.push({ name: "project_md", text: input.projectMd, cache: true })
  }
  if (hasContent(input.sessionCtx)) {
    out.push({ name: "session_ctx", text: input.sessionCtx, cache: true })
  }
  if (hasContent(input.userAppend)) {
    out.push({ name: "user_append", text: input.userAppend, cache: true })
  }
  return out
}

/** Validation verdict for {@link validateSectionsCacheBudget}. */
export type CacheBudgetVerdict = { ok: true } | { ok: false; cachedCount: number; limit: number }

/** Validate that a section list does not exceed Anthropic's cache_control cap.
 *  Fail-soft by contract: callers SHOULD warn in dev mode and still send the
 *  request — the provider will surface the real error if it actually rejects.
 *  Counting honors explicit `cache:false` (uncached sections do not consume a
 *  breakpoint). */
export const validateSectionsCacheBudget = (
  sections: readonly PromptSection[],
): CacheBudgetVerdict => {
  const cachedCount = sections.reduce((n, s) => n + (s.cache ? 1 : 0), 0)
  if (cachedCount <= MAX_CACHE_BREAKPOINTS) return { ok: true }
  return { ok: false, cachedCount, limit: MAX_CACHE_BREAKPOINTS }
}
