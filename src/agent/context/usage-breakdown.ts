/**
 * Segmented context-window usage breakdown (Cursor Canvas UsageBar shape).
 *
 * GAP closed: the CLI previously had only a single total + one-color bar
 * (`formatContextUsage`). Cursor's Canvas UsageBar instead shows the window as
 * proportional, colored per-CATEGORY segments. This module produces a
 * {@link ContextUsageBreakdown} carrying those segments so a renderer can paint
 * them.
 *
 * Tokenizer reuse (project rule — NO new heuristic): tokens are counted with
 * the SAME estimator the agent loop already uses for compaction —
 * `estimateTokens` in `src/agent/compaction.ts` (a `Math.ceil(chars / 4)`
 * heuristic over a `Message[]`). It is INJECTED here as {@link TokenEstimator}
 * (default-bound to the real one in the wiring layer) and never re-implemented.
 * Each category's text is wrapped as a single synthetic user `Message` and run
 * through that estimator, so per-category counts use the identical arithmetic
 * the loop applies elsewhere.
 *
 * Per-category counts are therefore independently MEASURED by the loop's own
 * estimator (not apportioned from a provider total). The breakdown's `total` is
 * the sum of those measured segment tokens.
 *
 * Default-OFF: nothing calls this on the hot path; the segmented view is only
 * surfaced behind the `/context` slash command. The single-bar status line is
 * left byte-identical.
 *
 * Pure functions only — no I/O, no clock. The estimator is a closed port.
 */

import { estimateTokens } from "@/agent/compaction"
import { type PromptSection, SECTION_CONTEXT_CATEGORY } from "@/agent/prompt-sections"
import type { Message } from "@/llm"

/**
 * Cursor-style context categories. The full closed enum is kept even though
 * this loop's prompt only populates a subset (System / Rules / Conversation) —
 * the other sources (Tools / Skills / MCP / Subagents) can be fed in via
 * {@link ExtraContextSource} without changing the shape, and empty categories
 * are omitted from the rendered breakdown.
 */
export type ContextCategory =
  | "System"
  | "Tools"
  | "Rules"
  | "Skills"
  | "MCP"
  | "Subagents"
  | "Conversation"

/** Canonical display order. */
export const CATEGORY_ORDER: readonly ContextCategory[] = [
  "System",
  "Tools",
  "Rules",
  "Skills",
  "MCP",
  "Subagents",
  "Conversation",
]

/** Deterministic per-category color (named token; the renderer maps to ANSI). */
const CATEGORY_COLOR: Record<ContextCategory, string> = {
  System: "cyan",
  Tools: "blue",
  Rules: "magenta",
  Skills: "green",
  MCP: "yellow",
  Subagents: "red",
  Conversation: "white",
}

/**
 * The loop's existing token estimator, injected. Matches the signature of
 * `estimateTokens(messages: Message[]): number` from `@/agent/compaction` so
 * the wiring layer passes that function verbatim — we never mint a second
 * heuristic.
 */
export type TokenEstimator = (messages: Message[]) => number

/**
 * An extra context source not represented as a PromptSection (e.g. serialized
 * tool schemas, skill bodies, MCP tool defs, subagent context). Supplying the
 * raw `text` keeps a single source of truth for token counting.
 */
export interface ExtraContextSource {
  readonly category: ContextCategory
  readonly text: string
}

export interface UsageSegment {
  /** Category id (stable string for tests/telemetry). */
  readonly id: ContextCategory
  /** Token count for this category — MEASURED by the injected estimator. */
  readonly tokens: number
  /** Exact character count contributed by this category. */
  readonly chars: number
  /** Named color for the segment. */
  readonly color: string
}

export interface ContextUsageBreakdown {
  /** Per-category segments, in {@link CATEGORY_ORDER}; empty categories omitted. */
  readonly segments: readonly UsageSegment[]
  /** Total tokens = sum of segment tokens (measured by the injected estimator). */
  readonly total: number
  /** Maximum context window for the active model (0 ⇒ unknown). */
  readonly max: number
  /** Model id, if known. */
  readonly model?: string
}

export interface BuildBreakdownInput {
  readonly sections: readonly PromptSection[]
  /** Extra sources mapped to categories (tools/skills/mcp/subagents). */
  readonly extras?: readonly ExtraContextSource[]
  /** Maximum context window for the active model. */
  readonly max: number
  readonly model?: string
}

/** Wrap a category's concatenated text as one synthetic `Message` (a single
 *  text content block) so the loop's `Message[]`-shaped estimator can count it
 *  unchanged — `estimateTokens` walks `m.content[].text`. */
const asMessage = (text: string): Message => ({
  role: "user",
  content: [{ type: "text", text }],
})

/**
 * Build a {@link ContextUsageBreakdown}. Per-category tokens are MEASURED by
 * the injected estimator (the loop's own `estimateTokens`). Empty categories
 * are omitted; segments follow {@link CATEGORY_ORDER}.
 */
export function buildUsageBreakdown(
  input: BuildBreakdownInput,
  estimate: TokenEstimator,
): ContextUsageBreakdown {
  // Collect concatenated text per category (single source of truth).
  const textByCat = new Map<ContextCategory, string[]>()
  const push = (cat: ContextCategory, text: string): void => {
    const arr = textByCat.get(cat)
    if (arr === undefined) textByCat.set(cat, [text])
    else arr.push(text)
  }
  for (const section of input.sections) {
    const cat = (SECTION_CONTEXT_CATEGORY[section.name] ?? "System") as ContextCategory
    push(cat, section.text)
  }
  for (const extra of input.extras ?? []) push(extra.category, extra.text)

  const segments: UsageSegment[] = []
  let total = 0
  for (const cat of CATEGORY_ORDER) {
    const parts = textByCat.get(cat)
    if (parts === undefined || parts.length === 0) continue
    const joined = parts.join("\n\n")
    if (joined.length === 0) continue
    const tokens = Math.max(0, estimate([asMessage(joined)]))
    total += tokens
    segments.push({ id: cat, tokens, chars: joined.length, color: CATEGORY_COLOR[cat] })
  }

  return {
    segments,
    total,
    max: input.max > 0 ? input.max : 0,
    ...(input.model !== undefined ? { model: input.model } : {}),
  }
}

/** Percentage (0–100, rounded) of the context window consumed. Never NaN. */
export function breakdownPercent(b: ContextUsageBreakdown): number {
  if (!(b.max > 0)) return 0
  return Math.min(100, Math.round((b.total / b.max) * 100))
}

/**
 * Convenience binding that uses the loop's REAL token estimator
 * (`estimateTokens` from `@/agent/compaction`, the `Math.ceil(chars/4)`
 * heuristic). This is the function a host wires into the `/context` slash seam
 * so no second estimator is ever introduced.
 */
export function buildUsageBreakdownDefault(input: BuildBreakdownInput): ContextUsageBreakdown {
  return buildUsageBreakdown(input, estimateTokens)
}
