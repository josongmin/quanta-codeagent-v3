import type { ContentBlock, LLMPort, Message, SystemPromptInput } from "@/llm"
import { assembleFromEvents } from "@/llm"
import { errMessage, logger, type Result } from "@/shared"
import {
  BackgroundSummarizationController,
  type BgCompactionConfig,
  bgCompactionEnabled,
  type CancelToken,
  type SpeculativeSummarizeFn,
  type SummarizeError,
} from "./compaction/index"
import {
  charsOf,
  estimateTokens,
  markBaselineStaleIfShrunk,
  resolveCompactionLimitTokens,
  resolveThreshold,
  type TokenBaseline,
  TokenBaselineBox,
  type TokenBaselineBoxState,
  triggerTokenCount,
} from "./compaction/token-baseline"
import type { RecoveryProvenance, RecoveryReason } from "./recovery-reason"
import { isPromptTooLong } from "./retry"

// Token accounting + threshold derivation moved to ./compaction/token-baseline
// (god-module split). Re-export the public surface verbatim so the ~30 importers
// of `@/agent/compaction` are byte-unaffected.
export {
  charsOf,
  estimateTokens,
  markBaselineStaleIfShrunk,
  resolveCompactionLimitTokens,
  type TokenBaseline,
  TokenBaselineBox,
  type TokenBaselineBoxState,
  triggerTokenCount,
}

/**
 * Single-tier conversation compaction (RFC §8 Phase 2 / §1.2: one tier, no
 * over-engineering). When the running transcript exceeds a token budget we
 * summarize everything older than the last `keepRecentTurns` turns into ONE
 * synthetic user message and keep the recent suffix verbatim.
 *
 * Token estimate: chars/4 heuristic, implemented locally (the memory slice has
 * the same idea but importing @/memory just for arithmetic is not worth the
 * coupling — RFC §3.1).
 *
 * Turn / boundary algorithm (see {@link findBoundary}): we keep the message
 * suffix that covers the last `keepRecentTurns` assistant messages plus their
 * trailing tool_result user messages and any leading user text. The retained
 * suffix MUST be self-consistent: a tool_result block in the suffix whose
 * matching tool_use was summarized away would be orphaned (Anthropic rejects
 * unpaired tool_result). We therefore expand the boundary *backwards* until no
 * retained tool_result references a tool_use that lives in the summarized
 * prefix.
 */

const DEFAULT_KEEP_TURNS = 6

/** tool_use ids referenced by tool_result blocks in `m` (if any). */
const toolResultRefs = (m: Message): string[] =>
  m.content.filter((b) => b.type === "tool_result").map((b) => b.tool_use_id)

/** tool_use ids produced by `m` (if any). */
const toolUseIds = (m: Message): string[] =>
  m.content.filter((b) => b.type === "tool_use").map((b) => b.id)

/**
 * Choose the index where the retained suffix begins. Start from the cut that
 * keeps `keepTurns` assistant messages, then walk the boundary earlier while
 * the suffix's first message is a tool_result whose tool_use is NOT in the
 * suffix (would orphan). Never returns < 0; clamps to keep ≥ recent suffix.
 */
export const findBoundary = (messages: Message[], keepTurns: number): number => {
  let assistantSeen = 0
  let idx = messages.length
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Message
    if (m.role === "assistant") {
      assistantSeen++
      if (assistantSeen > keepTurns) break
    }
    idx = i
  }
  // Expand backwards until no retained tool_result is orphaned. The head guard
  // (`idx < messages.length`) matters when the initial scan leaves an EMPTY
  // suffix (`idx === messages.length`, e.g. keepTurns=0 with an assistant tail):
  // there is no retained message to orphan, so `messages[idx]` must NOT be
  // dereferenced (it is `undefined` → TypeError). An empty suffix is already
  // self-consistent, so the walk is a no-op there.
  // Seed the suffix's tool_use ids ONCE for the initial suffix [idx, end), then
  // accumulate incrementally as the boundary walks earlier — each message's
  // ids are added at most once, making the whole walk O(n) instead of the
  // O(n²) of rebuilding the set on every backward step.
  const suffixIds = new Set<string>()
  for (let i = idx; i < messages.length; i++) {
    for (const id of toolUseIds(messages[i] as Message)) suffixIds.add(id)
  }
  while (idx > 0 && idx < messages.length) {
    const head = messages[idx] as Message
    const orphaned = toolResultRefs(head).some((ref) => !suffixIds.has(ref))
    if (!orphaned) break
    idx--
    // The message now at `idx` just joined the suffix — fold in its tool_use ids.
    for (const id of toolUseIds(messages[idx] as Message)) suffixIds.add(id)
  }
  return idx
}

const SUMMARY_SYSTEM =
  "You are a transcript compactor. Summarize the conversation so far into a " +
  "terse, information-dense brief: the task, key decisions, files touched, " +
  "tool outcomes (note what was confirmed by running/reading vs. assumed), " +
  "and any open threads. Note any security-relevant instructions or " +
  "constraints the user stated (e.g. files not to touch, commands not to " +
  "run, scopes off-limits) — these MUST be preserved verbatim so they keep " +
  "applying after compaction. Plain prose, no preamble. Be concise."

const renderBlock = (b: ContentBlock): string => {
  switch (b.type) {
    case "text":
      return b.text
    case "thinking":
      return `(thinking) ${b.thinking}`
    case "tool_use":
      return `(tool_use ${b.name}) ${JSON.stringify(b.input ?? {})}`
    case "tool_result":
      return `(tool_result) ${b.content}`
    case "image":
      return `(image ${b.mediaType})`
    case "document":
      return `(document ${b.mediaType})`
  }
}

const renderForSummary = (messages: Message[]): string =>
  messages.map((m) => `[${m.role}] ${m.content.map(renderBlock).join("\n")}`).join("\n\n")

export interface CompactInput {
  messages: Message[]
  llm: LLMPort
  /** Original system prompt — passed to the summarizer, never dropped.
   *  Accepts the widened {@link SystemPromptInput} (string or cache blocks). */
  system: SystemPromptInput
  thresholdTokens?: number
  /** §11.5 — ON-DEMAND force (the `/summarize-now` mid-turn verb). When true,
   *  the `under_threshold` early-return is SKIPPED so a summarize happens even
   *  below the auto-window trigger. The `no_boundary` guard still applies (a
   *  single indivisible turn cannot be summarized). Absent/false ⇒ the
   *  threshold-gated auto path, byte-identical. */
  force?: boolean
  /**
   * D4 (jun-7 naive-impl hardening) — the model id the loop is talking to. When
   * present AND no explicit/env threshold override is set, the threshold is
   * DERIVED from the model's context window (`window − maxOutput − margin`)
   * instead of the model-blind 120k constant. Absent / unknown model ⇒ 120k
   * legacy, byte-identical (signal-presence gates — no global knob).
   */
  model?: string
  /**
   * D5 (jun-7 naive-impl hardening) — authoritative token baseline from the
   * provider's last successful response. When present, the trigger token count
   * is `measuredInputTokens + estimateTokens(messages.slice(measuredAtMessage
   * Count))` (authoritative baseline + chars/4 of ONLY the messages appended
   * since the measurement) instead of the chars/4 estimate over the WHOLE
   * transcript. This closes the chars/4 under-count (20-40% on code/JSON-dense
   * transcripts) that let a real 150k estimate ~115k and sail past the gate
   * into a hard `context_window_exceeded`. Absent (turn-1 / provider doesn't
   * report / not `exact`) ⇒ `estimateTokens(messages)` legacy, byte-identical.
   */
  tokenBaseline?: TokenBaseline
  keepRecentTurns?: number
  /** ADR-0133 — caller-computed flag (`archive.summaries.length === 0` in
   *  the loop wire). Forwarded verbatim to {@link preCompactHook}. Absent ⇒
   *  defaults to `false` (the hook sees a non-first compaction; safer
   *  default for a host that doesn't yet maintain an archive). */
  isFirstCompaction?: boolean
  /**
   * Cursor-style pre-compact HITL hook (ADR-0075). When provided, the
   * summarizer is consulted ONLY AFTER `preflight` resolves. The seam stays
   * inside `compactIfNeeded` (vs. the loop) so unit tests can exercise the
   * full preflight→summarize→archive chain without a runAgent harness, and
   * the `proposedSummaryTokens` heuristic stays co-located with the prefix-
   * size computation. Absent ⇒ auto-approve, byte-identical (no callback
   * allocated, no extra await).
   *
   * Return values:
   *   - `"approve"` / `"force_now"` ⇒ proceed (the loop treats both as approve);
   *   - `"defer_one_turn"` ⇒ skip THIS compaction; `compactIfNeeded` returns
   *      `{compacted:false}` and the loop's breaker observes the no-op.
   *
   * A thrown error is propagated to the caller (the loop wraps in try/catch
   * and degrades gracefully via the existing proactive-compaction error path).
   */
  preflight?: (q: {
    currentTokens: number
    threshold: number
    proposedKeep: number
    proposedSummaryTokens: number
  }) => Promise<"approve" | "defer_one_turn" | "force_now">
  /**
   * ADR-0133 — typed `pre_compact` hook bridge. When wired, the threshold-and-
   * boundary-passing case fires this BEFORE the preflight (so a hook-side
   * abort short-circuits cheaper than waking the HITL UI). `isFirstCompaction`
   * is `true` iff this is the first archive-eligible compaction of the
   * session (caller computes from its `ConversationSummaryArchive.summaries.
   * length === 0`). A truthy `abortReason` skips THIS compaction (returns
   * `{compacted:false}` — same shape the breaker observes as no progress).
   * Absent ⇒ no extra await, byte-identical legacy fast-path.
   */
  preCompactHook?: (q: {
    messagesToCompact: number
    isFirstCompaction: boolean
  }) => Promise<{ abortReason: string | null }>
  /** ADR-0409 — `post_compact` emission bridge. Absent ⇒ existing path
   *  byte-identical. NO-THROW: emitter errors are swallowed. */
  postCompactEmit?: (provenance: RecoveryProvenance) => void | Promise<void>
  /** ADR-0409 — threadId for provenance + Objective wire. */
  threadId?: string
  /** ADR-0409 — minimal Objective wire (callback, not the full port — keeps
   *  the slice fence intact). NO-THROW: errors swallowed. */
  objectiveSetNextActions?: (threadId: string, actions: readonly string[]) => void
  /** ADR-0409 — explicit reason override (default `"token_budget_exceeded"`). */
  recoveryReason?: RecoveryReason
}

export type CompactResult =
  | {
      compacted: false
      messages: Message[]
      /**
       * Why no compaction happened — lets the loop's breaker distinguish a
       * benign "we were under budget" no-op (`under_threshold`, no strike) from
       * an "over budget but the transcript is one indivisible giant turn we
       * cannot summarize" no-op (`no_boundary`). The latter is genuine
       * no-progress under pressure: if the breaker did not strike on it the
       * proactive `maxNoProgressProactive` cap could never trip on a giant-turn
       * transcript and `compactIfNeeded` would be re-invoked every turn with no
       * headroom gained. `deferred` covers the HITL/hook skip (the host
       * explicitly chose to wait one turn — not a failure to make progress).
       */
      reason: "under_threshold" | "no_boundary" | "deferred" | "empty_summary"
    }
  | { compacted: true; messages: Message[]; summaryTokens: number }

/** Stream one summary turn with an explicit system prompt and return its
 *  joined text. Shared by proactive ({@link summarize}) and reactive paths. */
const summarizeWith = async (llm: LLMPort, system: string, prefix: Message[]): Promise<string> => {
  const events = []
  for await (const ev of llm.stream({
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: renderForSummary(prefix) }],
      },
    ],
    system,
    tools: [],
  })) {
    events.push(ev)
  }
  const { message } = assembleFromEvents(events)
  return message.content
    .filter((b) => b.type === "text")
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim()
}

const summarize = (llm: LLMPort, prefix: Message[]): Promise<string> =>
  summarizeWith(llm, SUMMARY_SYSTEM, prefix)

/**
 * Reactive compaction: a *harder* squeeze than {@link compactIfNeeded}, run
 * only when the loop has already hit a "prompt is too long" API error. The
 * proactive path keeps `DEFAULT_KEEP_TURNS` (6) recent turns; here we keep a
 * much smaller tail (default 2) and use a continuation-summary prompt so the
 * model can *resume the task* from a fresh context rather than just recall
 * history. Reuses {@link findBoundary} (orphan-aware: never splits a
 * tool_use / tool_result pair).
 */

const REACTIVE_KEEP_TURNS = 2

/**
 * Minimum estimated input tokens before the post-build "did it actually
 * shrink?" guard engages. Below this the prompt is already tiny and a PTL
 * here is spurious; the synthetic continuation header can legitimately be
 * *larger* than a trivial summarized prefix, so applying the drop check would
 * mis-fire. (CC only ever reaches reactive compaction at real context
 * pressure — this floor encodes that precondition explicitly.)
 */
const REACTIVE_MIN_INPUT_TOKENS = 4_000

/**
 * Required shrink ratio for a reactive compaction to be worth keeping. If the
 * built `[synthetic, ...suffix]` is not at least this fraction smaller than
 * the input, the limiting payload is in the retained suffix (an
 * un-summarizable giant tool_result/file) — fail fast instead of handing the
 * loop a prompt that is still over the window. Mirrors the breaker's
 * `minProgressRatio` (see {@link CompactionBreaker}).
 */
const REACTIVE_MIN_DROP_RATIO = 0.15

const CONTINUATION_SYSTEM =
  "You have been working on a coding task but have not completed it. Write a " +
  "structured, concise, actionable continuation summary so you can resume in " +
  "a fresh context: (1) the task/goal, (2) what you've done and learned " +
  "(mark which claims you verified vs. assumed), (3) key files/paths and " +
  "their state, (4) the exact next command/edit to run, not a vague " +
  "direction, (5) any security-relevant instructions or constraints the user " +
  "stated (files not to touch, commands not to run, scopes off-limits) — " +
  "preserve these verbatim so they keep applying after the context resets. " +
  "Wrap it in <summary></summary>."

export interface ReactiveCompactInput {
  messages: Message[]
  llm: LLMPort
  /** Original system prompt (kept for parity with {@link CompactInput};
   *  the continuation summary uses its own system prompt). */
  system: SystemPromptInput
  /** Recent turns to keep verbatim. Defaults to {@link REACTIVE_KEEP_TURNS}. */
  keepRecentTurns?: number
}

export type ReactiveCompactResult =
  | { ok: true; messages: Message[]; summaryTokens: number }
  | { ok: false; reason: string }

/**
 * Aggressively compact `messages` for PTL recovery. Returns the new array on
 * success. `{ ok:false, reason }` when nothing can be safely summarized away
 * (one indivisible giant turn): the caller must surface a clear failure rather
 * than spin retrying an un-shrinkable prompt.
 */
export const reactiveCompact = async (
  input: ReactiveCompactInput,
): Promise<ReactiveCompactResult> => {
  const keepTurns = input.keepRecentTurns ?? REACTIVE_KEEP_TURNS
  const boundary = findBoundary(input.messages, keepTurns)
  if (boundary <= 0) {
    return {
      ok: false,
      reason:
        "prompt still too long after max compaction: no summarizable prefix " +
        "(a single turn exceeds the context window)",
    }
  }
  const prefix = input.messages.slice(0, boundary)
  const suffix = input.messages.slice(boundary)
  const summary = await summarizeWith(input.llm, CONTINUATION_SYSTEM, prefix)
  if (summary.trim() === "") {
    return { ok: false, reason: "continuation summary came back empty" }
  }
  const synthetic: Message = {
    role: "user",
    content: [{ type: "text", text: `<continuation summary>\n${summary}` }],
  }
  const messages = [synthetic, ...suffix]
  // Fail-fast: even with a non-empty summary and a valid boundary the squeeze
  // can be a no-op when the retained suffix itself holds the limiting payload
  // (one giant tool_result/file the orphan-safe boundary cannot drop). Spinning
  // a retry on a prompt that did not shrink just re-hits PTL — surface a clear
  // failure instead. Guarded by REACTIVE_MIN_INPUT_TOKENS so a spurious PTL on
  // an already-tiny transcript (where the synthetic header can exceed a trivial
  // prefix) does not mis-fire. Mirrors CC's rapid_refill_breaker intent.
  const inputTokens = estimateTokens(input.messages)
  const outputTokens = estimateTokens(messages)
  // Below REACTIVE_MIN_INPUT_TOKENS the prompt is already tiny: a spurious PTL
  // there can leave the synthetic header a few tokens above a trivial summarized
  // prefix, so the shrink-ratio bar is deliberately NOT applied here — the
  // reactive breaker (maxConsecutiveReactive) is the backstop against a genuine
  // no-shrink spin (see the dedicated GAP-1 rapid_refill_breaker test). An audit
  // proposed fail-closing below the floor on a zero/negative drop, but that
  // reverses an intentional, separately-tested tolerance ("tiny input below the
  // floor is NOT failed even if it grows") and is redundant with the breaker, so
  // it is deliberately not adopted.
  if (
    inputTokens >= REACTIVE_MIN_INPUT_TOKENS &&
    (inputTokens - outputTokens) / inputTokens < REACTIVE_MIN_DROP_RATIO
  ) {
    return {
      ok: false,
      reason:
        "prompt still too long after max compaction: reactive compaction " +
        `freed no meaningful context (${inputTokens}→${outputTokens} est. ` +
        "tokens, < 15% drop) — the limiting payload (a giant file read or " +
        "tool output) is in the retained suffix, not the summarized prefix",
    }
  }
  return { ok: true, messages, summaryTokens: estimateTokens([synthetic]) }
}

/* ------------------------------------------------------------------ */
/*  §13.3 — DROP-OLDEST salvage (jun-08 long-tail)                     */
/* ------------------------------------------------------------------ */

/**
 * Maximum drop-oldest rounds. Bounds the retry so a pathological transcript
 * (every turn an indivisible giant payload) cannot spin: after this many drops
 * we give up and return the last reactiveCompact failure. Codex's
 * `thread_rollout_truncation` similarly bounds how far it walks the rollout.
 */
export const MAX_DROP_OLDEST_ROUNDS = 8

/**
 * Drop the OLDEST turn from `messages`, orphan-safely, returning the reduced
 * array — or `null` when nothing more can be dropped without violating the
 * floor (`keepFloor` messages must always remain). Pure.
 *
 * "Oldest turn" = the leading messages up to AND INCLUDING the first assistant
 * message, plus any immediately-following `tool_result` user message(s) that
 * reference ONLY tool_use ids in the dropped prefix (so the new head is never
 * an orphaned tool_result Anthropic would reject). When the head is a leading
 * user message with no assistant after it within the floor, we drop that single
 * user message.
 *
 * This is the inverse of {@link findBoundary} (which keeps a SUFFIX): here we
 * remove a PREFIX. It is the mechanism §13.3 layers on top of summarization —
 * when the summarized prefix + retained suffix STILL overflow because the
 * limiting payload sits in the kept suffix, dropping the oldest retained turn
 * frees real headroom that summarization cannot.
 */
export const dropOldestTurn = (messages: Message[], keepFloor: number): Message[] | null => {
  if (messages.length <= keepFloor) return null
  // Find the index of the first assistant message — the end of the first
  // "turn" (leading user prompt + assistant reply). We drop through it.
  let cut = 0
  let sawAssistant = false
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as Message
    if (m.role === "assistant") {
      sawAssistant = true
      cut = i + 1
      break
    }
  }
  // No assistant at all (only leading user messages): drop the single oldest.
  if (!sawAssistant) cut = 1
  // Sweep forward past any tool_result-only user messages that would be orphaned
  // (their tool_use was just dropped) so the new head is self-consistent.
  const droppedIds = new Set<string>()
  for (let i = 0; i < cut; i++) {
    for (const id of toolUseIds(messages[i] as Message)) droppedIds.add(id)
  }
  while (cut < messages.length) {
    const head = messages[cut] as Message
    const refs = toolResultRefs(head)
    // Only sweep a head that is PURELY a tool_result for a dropped tool_use.
    if (refs.length === 0 || !refs.some((r) => droppedIds.has(r))) break
    cut++
  }
  // Respect the floor: never drop below `keepFloor` retained messages.
  if (messages.length - cut < keepFloor) return null
  if (cut <= 0) return null
  return messages.slice(cut)
}

export interface DropOldestSalvageInput {
  messages: Message[]
  llm: LLMPort
  system: SystemPromptInput
  /** Recent turns to keep verbatim through the reactive squeeze attempt.
   *  Defaults to {@link REACTIVE_KEEP_TURNS}. */
  keepRecentTurns?: number
  /** Minimum messages that must survive every drop (orphan-safety floor).
   *  Defaults to 1 (always keep at least the most-recent message — you can
   *  never drop the current request). */
  keepFloor?: number
  /** Max drop rounds. Defaults to {@link MAX_DROP_OLDEST_ROUNDS}. */
  maxRounds?: number
  /** Token budget the salvaged transcript must fit under, when the hard
   *  drop-oldest fallback engages. When omitted, the fallback drops to the
   *  floor (drop everything droppable). The recovery executor passes the same
   *  model-window-derived limit the loop used so the drop stops as soon as the
   *  transcript would re-fit. */
  targetTokens?: number
}

export type DropOldestSalvageResult =
  | {
      ok: true
      messages: Message[]
      summaryTokens: number
      droppedRounds: number
      /** `"reactive"` = the summarization squeeze succeeded (no hard drop
       *  needed); `"hard-drop"` = the squeeze could not shrink the transcript
       *  so we shed the oldest turns to fit the budget. */
      strategy: "reactive" | "hard-drop"
    }
  | { ok: false; reason: string; droppedRounds: number }

/**
 * §13.3 (jun-08) — DROP-OLDEST salvage. The FAIL-FAST-vs-SALVAGE choice: instead
 * of aborting the turn the moment a reactive squeeze can't help, shed the oldest
 * context (which a user resuming after PTL cares about least) so the turn can
 * continue. Two layered strategies, in order:
 *
 *   1. REACTIVE first — run {@link reactiveCompact} unchanged. If it shrinks the
 *      transcript (the common case: a summarizable prefix exists), return that.
 *   2. HARD-DROP fallback — when the squeeze fails (no summarizable prefix, or
 *      the limiting payload sits in the retained suffix so summarization frees
 *      < 15%), drop the OLDEST turn (orphan-safely via {@link dropOldestTurn})
 *      and re-check the raw token estimate against `targetTokens`. Repeat until
 *      the transcript fits, nothing more can be shed (floor reached), or the
 *      round cap is hit. This is the genuine recovery summarization cannot give:
 *      it removes real tokens regardless of where the payload sits. Mirrors
 *      Codex `thread_rollout_truncation` (truncate the oldest rollout to fit).
 *
 * Pure orchestration — the only I/O is the single summarizer call the reactive
 * path already makes; the hard-drop fallback is pure array slicing (NO extra
 * LLM calls). NEVER throws (delegates to the no-throw `reactiveCompact`).
 * DEFAULT-OFF at the call site: the recovery executor only invokes this when the
 * salvage knob is on; absent ⇒ the legacy `{ok:false}`→abort path is
 * byte-identical (this function is not even constructed).
 */
export const dropOldestSalvage = async (
  input: DropOldestSalvageInput,
): Promise<DropOldestSalvageResult> => {
  const keepRecentTurns = input.keepRecentTurns ?? REACTIVE_KEEP_TURNS
  const keepFloor = input.keepFloor ?? 1
  const maxRounds = input.maxRounds ?? MAX_DROP_OLDEST_ROUNDS

  // Strategy 1 — reactive squeeze (unchanged). Succeeds whenever a summarizable
  // prefix exists and the kept suffix isn't the limiting payload.
  const reactive = await reactiveCompact({
    messages: input.messages,
    llm: input.llm,
    system: input.system,
    keepRecentTurns,
  })
  if (reactive.ok) {
    return {
      ok: true,
      messages: reactive.messages,
      summaryTokens: reactive.summaryTokens,
      droppedRounds: 0,
      strategy: "reactive",
    }
  }

  // Strategy 2 — hard drop-oldest until the transcript fits. The summary could
  // not help (its reason is preserved if we ultimately exhaust). Each round
  // sheds the single oldest orphan-safe turn; we stop as soon as the raw
  // estimate is at/under the target (or there's no target ⇒ drop everything
  // droppable). NO extra summarizer call here — pure slicing.
  let current = input.messages
  for (let round = 1; round <= maxRounds; round++) {
    const reduced = dropOldestTurn(current, keepFloor)
    if (reduced === null || reduced.length >= current.length) {
      // Floor reached — the limiting payload is in the irreducible tail (e.g.
      // a single giant current request). Summarization couldn't help and we
      // cannot drop the most-recent turn, so this is a genuine dead end.
      return {
        ok: false,
        reason: `${reactive.reason} — drop-oldest salvage exhausted (only the irreducible recent tail remains)`,
        droppedRounds: round - 1,
      }
    }
    current = reduced
    if (input.targetTokens === undefined || estimateTokens(current) <= input.targetTokens) {
      return {
        ok: true,
        messages: current,
        summaryTokens: 0,
        droppedRounds: round,
        strategy: "hard-drop",
      }
    }
  }
  return {
    ok: false,
    reason: `${reactive.reason} — drop-oldest salvage hit the ${maxRounds}-round cap without fitting the budget`,
    droppedRounds: maxRounds,
  }
}

/**
 * Compact `messages` if over the token threshold. Behavior-preserving when
 * under: returns the same array with `compacted:false`.
 *
 * Cursor-style HITL hook (ADR-0075): when `input.preflight` is provided, the
 * loop checks the threshold + boundary first (cheap pure-arithmetic guards) and
 * ONLY THEN consults the host. A `"defer_one_turn"` reply short-circuits to
 * `{compacted:false}` (the loop's breaker observes the no-op via the same
 * before/after token comparison); `"approve"`/`"force_now"` proceed to the
 * summarizer. Absent preflight ⇒ auto-approve, NO extra await, NO callback
 * allocation — byte-identical to the pre-hook path.
 */
export const compactIfNeeded = async (input: CompactInput): Promise<CompactResult> => {
  // D4 — model-derived threshold (known model only; unknown ⇒ 120k legacy).
  const threshold = resolveThreshold(input.thresholdTokens, input.model)
  const keepTurns = input.keepRecentTurns ?? DEFAULT_KEEP_TURNS
  // D5 — gate on the authoritative-baseline-anchored count when a baseline is
  // present; otherwise the chars/4 estimate over the whole transcript (legacy,
  // byte-identical). `currentTokens` is reused below for the preflight query.
  const currentTokens = triggerTokenCount(input.messages, input.tokenBaseline)
  // §11.5 — `force` (on-demand `/summarize-now`) bypasses the threshold gate; the
  // `no_boundary` guard below still holds (nothing safely summarizable ⇒ no-op).
  if (input.force !== true && currentTokens <= threshold) {
    return { compacted: false, messages: input.messages, reason: "under_threshold" }
  }
  const boundary = findBoundary(input.messages, keepTurns)
  if (boundary <= 0) {
    // Over budget but nothing safely summarizable (one giant indivisible turn)
    // — leave untouched, but tag the no-op so the loop's breaker can record it
    // as a no-progress strike (re-firing every turn gains no headroom).
    return { compacted: false, messages: input.messages, reason: "no_boundary" }
  }
  const prefix = input.messages.slice(0, boundary)
  const suffix = input.messages.slice(boundary)
  // ADR-0133 — typed `pre_compact` hook FIRST (cheaper than preflight: no
  // UI wake, no human-in-the-loop wait). Ordered AFTER threshold + boundary
  // (a degenerate one-giant-turn never reaches the hook for the same reason
  // it never reaches preflight: the work would be moot). When the bridge
  // returns `{abortReason}` truthy, we skip THIS compaction — same
  // `{compacted:false}` shape preflight's `defer_one_turn` produces, so the
  // breaker observes it identically.
  if (input.preCompactHook !== undefined) {
    const { abortReason } = await input.preCompactHook({
      messagesToCompact: prefix.length,
      isFirstCompaction: input.isFirstCompaction === true,
    })
    if (abortReason !== null) {
      return { compacted: false, messages: input.messages, reason: "deferred" }
    }
  }
  // ADR-0075 — preflight HITL. Ordered AFTER the cheap threshold + boundary
  // guards so a degenerate "one giant turn" never wakes the host UI for a
  // decision that can't matter (compaction would no-op anyway). The proposed
  // summary-tokens estimate is the chars/4 heuristic over the prefix (the
  // actual produced summary is typically a fraction of this, but the upper
  // bound is what the UI cares about: "this will summarize up to ~Nk tokens").
  if (input.preflight !== undefined) {
    const decision = await input.preflight({
      currentTokens,
      threshold,
      proposedKeep: keepTurns,
      proposedSummaryTokens: estimateTokens(prefix),
    })
    if (decision === "defer_one_turn") {
      return { compacted: false, messages: input.messages, reason: "deferred" }
    }
    // `approve` and `force_now` both fall through to the summarizer — the
    // loop differentiates them only for emit/log purposes.
  }
  const summary = await summarize(input.llm, prefix)
  // jun-26 SE-audit: an EMPTY/refused summarizer response must NOT replace the
  // summarized prefix with an empty summary (it would silently DESTROY history).
  // Abort this compaction and keep the full message list — parity with the
  // reactive path's "continuation summary came back empty" guard. compacted:false
  // is an unproductive strike, so the breaker still trips if it keeps recurring.
  if (summary.trim() === "") {
    return { compacted: false, messages: input.messages, reason: "empty_summary" }
  }
  const synthetic: Message = {
    role: "user",
    content: [{ type: "text", text: `<conversation summary>\n${summary}` }],
  }
  const messages = [synthetic, ...suffix]
  const summaryTokens = estimateTokens([synthetic])
  // ADR-0409 — post_compact emission + Objective wire. Byte-identical when
  // neither callback is set. NO-THROW (observability never aborts the turn).
  await emitPostCompactIfWired(input, prefix.length, suffix.length, currentTokens, messages)
  return { compacted: true, messages, summaryTokens }
}

/** ADR-0409 — fire `postCompactEmit` and the Objective wire if either is set.
 *  Both seams are NO-THROW (any error is swallowed so an emitter glitch never
 *  aborts the compaction). Kept as a separate helper so `compactIfNeeded`'s
 *  cognitive complexity stays under the biome cap. */
const emitPostCompactIfWired = async (
  input: CompactInput,
  prefixLen: number,
  suffixLen: number,
  tokensBefore: number,
  messages: Message[],
): Promise<void> => {
  if (input.postCompactEmit === undefined && input.objectiveSetNextActions === undefined) return
  const provenance: RecoveryProvenance = {
    reason: input.recoveryReason ?? "token_budget_exceeded",
    tokensBefore,
    tokensAfter: estimateTokens(messages),
    turnsDropped: prefixLen,
    turnsKept: suffixLen,
    resumeStep: `resume after compaction — kept last ${suffixLen} turn(s), summarized ${prefixLen}`,
    compactedAt: Date.now(),
  }
  try {
    await input.postCompactEmit?.(provenance)
  } catch (e) {
    // side-channel — log + swallow.
    logger.warn(`compaction.postCompactEmit: ${errMessage(e)}`)
  }
  if (input.objectiveSetNextActions !== undefined && input.threadId !== undefined) {
    try {
      input.objectiveSetNextActions(input.threadId, [
        `agent compacted: reason ${provenance.reason} — ${provenance.resumeStep}`,
      ])
    } catch (e) {
      // side-channel — log + swallow.
      logger.warn(`compaction.objectiveSetNextActions: ${errMessage(e)}`)
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// ADR-0473 — background (speculative) compaction wiring.
//
// The pure controller lives in `./compaction/background.ts`. This factory is the
// COMPOSITION seam: it adapts the EXISTING in-module summarize primitives
// (`findBoundary` / `summarizeWith` / `CONTINUATION_SYSTEM` / `estimateTokens` /
// `REACTIVE_KEEP_TURNS`) into the injected {@link SpeculativeSummarizeFn} the
// controller drives, and derives the controller's {@link BgCompactionConfig}
// from NAMED constants (no literals at the call site). DEFAULT-OFF: returns
// `undefined` unless the gate (`QUANTA_BG_COMPACTION === "1"`) is on, so the
// loop's existing synchronous proactive/reactive paths stay byte-identical.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Fraction of the working ceiling at which a speculative summarize begins
 * (relative start floor). At 15% free headroom we start eagerly — the persist
 * gate (below) is the conservative side, so an early start only costs a
 * cancellable background pass, never a bad install.
 */
const BG_START_AT_UNUSED_PERCENT = 0.15
/**
 * Absolute start floor (tokens). Mirrors the reactive squeeze precondition
 * (`REACTIVE_MIN_INPUT_TOKENS`): below a few thousand tokens of free headroom
 * there is meaningful pressure regardless of the percent floor. Begin a
 * speculative pass once free headroom drops to/below this.
 */
const BG_START_AT_UNUSED_TOKENS = REACTIVE_MIN_INPUT_TOKENS
/**
 * Minimum fraction of the working ceiling a completed summary must FREE to be
 * worth installing (relative persist floor). Mirrors the reactive path's
 * `REACTIVE_MIN_DROP_RATIO` intent — a summary that frees less than this is not
 * worth swapping live history for.
 */
const BG_PERSIST_UNUSED_PERCENT = REACTIVE_MIN_DROP_RATIO
/**
 * Minimum absolute tokens a completed summary must free to be worth installing
 * (absolute persist floor). Same magnitude as the reactive squeeze precondition
 * — a sub-`REACTIVE_MIN_INPUT_TOKENS` saving is noise.
 */
const BG_PERSIST_UNUSED_TOKENS = REACTIVE_MIN_INPUT_TOKENS

/** Build the named {@link BgCompactionConfig} from the constants above. Kept as
 *  a pure helper so a test can assert the derivation and the loop never inlines
 *  literals. */
export const bgCompactionConfig = (): BgCompactionConfig => ({
  startAtUnusedTokens: BG_START_AT_UNUSED_TOKENS,
  startAtUnusedPercent: BG_START_AT_UNUSED_PERCENT,
  persistUnusedTokens: BG_PERSIST_UNUSED_TOKENS,
  persistUnusedPercent: BG_PERSIST_UNUSED_PERCENT,
})

/**
 * The installed-summary payload for the loop wire: the rebuilt transcript
 * (`[synthetic, ...suffix]`) the host installs via `wm.replace(...)`.
 */
export type BgSummaryPayload = Message[]

/**
 * Adapt the EXISTING summarize primitives into the injected speculative port.
 * Honors the {@link CancelToken} (checks before+after the summarize stream so a
 * turn that ends early stops spending) and returns a typed {@link
 * SummarizeError} (never throws — the controller additionally wraps this, but we
 * keep the no-throw contract local too). Uses the orphan-safe `findBoundary` and
 * the continuation summary prompt (same as `reactiveCompact`), so a speculative
 * install never splits a tool_use/tool_result pair.
 */
const speculativeSummarizeAdapter = (
  llm: LLMPort,
  getPrefix: () => readonly Message[],
): SpeculativeSummarizeFn<BgSummaryPayload> => {
  return async ({
    cancel,
  }): Promise<Result<{ summary: BgSummaryPayload; resultingTokens: number }, SummarizeError>> => {
    if (cancel.aborted) {
      return { ok: false, error: { kind: "other", detail: "cancelled before start" } }
    }
    const messages = [...getPrefix()]
    const boundary = findBoundary(messages, REACTIVE_KEEP_TURNS)
    if (boundary <= 0) {
      return {
        ok: false,
        error: { kind: "other", detail: "no summarizable boundary (one indivisible giant turn)" },
      }
    }
    const prefix = messages.slice(0, boundary)
    const suffix = messages.slice(boundary)
    let summaryText: string
    try {
      summaryText = await summarizeWith(llm, CONTINUATION_SYSTEM, prefix)
    } catch (e) {
      // Map a prompt-too-long while summarizing to the dedicated discard reason
      // (the controller turns `input-limit` into `input-limit-failure`); every
      // other failure is a generic summarizer error. NEVER throw.
      const kind = isPromptTooLong(e) ? "input-limit" : "other"
      return { ok: false, error: { kind, detail: errMessage(e) } }
    }
    if (cancel.aborted) {
      return { ok: false, error: { kind: "other", detail: "cancelled after summarize" } }
    }
    if (summaryText.trim() === "") {
      return { ok: false, error: { kind: "other", detail: "continuation summary came back empty" } }
    }
    const synthetic: Message = {
      role: "user",
      content: [{ type: "text", text: `<continuation summary>\n${summaryText}` }],
    }
    const summary: BgSummaryPayload = [synthetic, ...suffix]
    return { ok: true, value: { summary, resultingTokens: estimateTokens(summary) } }
  }
}

/**
 * ADR-0473 — construct the background-compaction controller IFF the gate is on.
 *
 * `env`     — the injected env record (gate read via `bgCompactionEnabled`).
 * `llm`     — the summarizer LLM (the loop passes the dedicated summarizer model
 *             when configured, else the main model — same choice the synchronous
 *             path makes).
 * `getPrefix` — a thunk returning the LIVE transcript snapshot at start time
 *             (the loop wires `() => wm.snapshot()`).
 * `clock`   — injected wall clock (the loop passes the real one; tests a fake).
 * `cfg`     — optional config override (defaults to {@link bgCompactionConfig}).
 *
 * Returns `undefined` when the gate is OFF — the loop then never references the
 * controller and the existing synchronous flow is byte-identical.
 */
export const makeBgCompactionController = (
  env: Readonly<Record<string, string | undefined>>,
  llm: LLMPort,
  getPrefix: () => readonly Message[],
  clock: () => number,
  cfg: BgCompactionConfig = bgCompactionConfig(),
): BackgroundSummarizationController<BgSummaryPayload> | undefined => {
  if (!bgCompactionEnabled(env)) return undefined
  return new BackgroundSummarizationController<BgSummaryPayload>(
    speculativeSummarizeAdapter(llm, getPrefix),
    clock,
    cfg,
  )
}

/** Re-export the cancel-token type for the loop's e2e test convenience. */
export type { CancelToken }
