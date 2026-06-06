import type { ContentBlock, LLMPort, Message, SystemPromptInput } from "@/llm"
import { assembleFromEvents, resolveModelWindow } from "@/llm"
import { errMessage, logger, type Result, runtimeConfig } from "@/shared"
import {
  BackgroundSummarizationController,
  type BgCompactionConfig,
  bgCompactionEnabled,
  type CancelToken,
  type SpeculativeSummarizeFn,
  type SummarizeError,
} from "./compaction/index"
import type { RecoveryProvenance, RecoveryReason } from "./recovery-reason"
import { isPromptTooLong } from "./retry"

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

const DEFAULT_THRESHOLD = 120_000
const DEFAULT_KEEP_TURNS = 6

/** Pre-ceil character total of a message list — the SUM that `estimateTokens`
 *  divides + ceils ONCE at the end. Extracted so the delta token counter
 *  (`token-delta/counter.ts`) can track the same pre-ceil sum and apply
 *  `Math.ceil` exactly once, making an incremental total byte-identical to a
 *  full `estimateTokens` re-scan (ceil-of-sum ≠ sum-of-ceils — RFC §4.1). */
export const charsOf = (messages: readonly Message[]): number => {
  let chars = 0
  for (const m of messages) {
    for (const b of m.content) {
      chars += blockChars(b)
    }
  }
  return chars
}

/** chars/4 token heuristic over a message list. Byte-identical to the prior
 *  inline loop: the SUM is identical (`charsOf`) and the single end-`Math.ceil`
 *  is preserved (applied once over the total, NOT per message). */
export const estimateTokens = (messages: Message[]): number => Math.ceil(charsOf(messages) / 4)

/**
 * D5 (jun-7 naive-impl hardening) — an authoritative input-token measurement
 * from the provider's last successful response, paired with the message count
 * at the moment it was measured.
 */
export interface TokenBaseline {
  /** The provider's authoritative `usage.inputTokens` from the last successful
   *  response. Only trusted when it was the `exact` count (authoritative ≥
   *  estimate), which the loop checks before constructing this. */
  readonly measuredInputTokens: number
  /** `messages.length` at the moment the measurement was taken. The trigger
   *  count adds the chars/4 estimate of ONLY the messages appended AFTER this
   *  index (the authoritative count already covers the prefix). */
  readonly measuredAtMessageCount: number
}

/**
 * D5 — the token count the compaction trigger should gate on. With a
 * `tokenBaseline`, anchor on the provider's authoritative input count and only
 * ESTIMATE the suffix appended since the measurement; without one, fall back to
 * the chars/4 estimate over the whole transcript (legacy, byte-identical).
 *
 * Fail-SAFE on a stale/invalid baseline: if `measuredAtMessageCount` is out of
 * range for the current transcript (e.g. messages were compacted/replaced under
 * it, so the recorded index no longer maps to the same suffix) we DROP the
 * baseline and use the legacy estimate rather than risk an under-count (the
 * RFC's "prefer fail-SAFE over over-trigger" — but here a bad mapping could
 * also UNDER-count, so the only safe move is the full estimate). A non-finite /
 * negative measurement is likewise ignored.
 */
/**
 * D5 — invalidate a token baseline whose measured prefix was replaced by a
 * compaction that SHRANK the transcript.
 *
 * After a proactive/microcompact summarize replaces the first messages, the
 * baseline's recorded `measuredAtMessageCount` index no longer maps to the same
 * content. The `triggerTokenCount` out-of-range fail-safe catches it only while
 * the transcript is shorter than the index; once it REGROWS past that index the
 * fail-safe stops firing and a stale baseline would force a premature compaction
 * on a tiny transcript (the inverse of the bug D5 fixes). Clearing `current`
 * falls the trigger back to the chars/4 estimate until a fresh exact usage
 * re-establishes the baseline against the new prefix. No-op when the transcript
 * grew or stayed the same (a non-shrinking turn never replaced the prefix).
 */
export const markBaselineStaleIfShrunk = (
  box: { current?: TokenBaseline | undefined; sendCount?: number } | undefined,
  lenBefore: number,
  lenAfter: number,
): void => {
  if (box !== undefined && lenAfter < lenBefore) box.current = undefined
}

export const triggerTokenCount = (messages: Message[], baseline?: TokenBaseline): number => {
  if (
    baseline === undefined ||
    !Number.isFinite(baseline.measuredInputTokens) ||
    baseline.measuredInputTokens < 0 ||
    !Number.isInteger(baseline.measuredAtMessageCount) ||
    baseline.measuredAtMessageCount < 0 ||
    // Out of range ⇒ the recorded index no longer maps onto this transcript
    // (history was replaced/compacted under the baseline). Fail-safe to legacy.
    baseline.measuredAtMessageCount > messages.length
  ) {
    return estimateTokens(messages)
  }
  const appended = messages.slice(baseline.measuredAtMessageCount)
  return baseline.measuredInputTokens + estimateTokens(appended)
}

/** Rough context-token footprint of an image, in chars (ADR-0083). The base64
 *  length is NOT a faithful proxy (a 1 MB image is ~1.3 M base64 chars but only
 *  ~1.5 k tokens to the model), so we use a fixed estimate ≈ 1.5 k tokens
 *  (`estimateTokens` divides by 4) — enough to nudge the compaction threshold
 *  without letting a large attachment explode it. */
const IMAGE_CHAR_ESTIMATE = 6000

/** Rough context-token footprint of a PDF document, in chars (ADR-0137).
 *  ~3k tokens baseline (4 chars per token convention used by `estimateTokens`).
 *  Conservative "small document" estimate — multi-page PDFs cost more on the
 *  provider side, but a finer-grained estimate would require parsing the PDF
 *  (which `pdf_read` intentionally does NOT do; Claude handles it natively). */
const DOCUMENT_CHAR_ESTIMATE = 12000

const blockChars = (b: ContentBlock): number => {
  switch (b.type) {
    case "text":
      return b.text.length
    case "thinking":
      return b.thinking.length
    case "tool_use":
      return b.name.length + JSON.stringify(b.input ?? {}).length
    case "tool_result":
      return b.content.length
    case "image":
      return IMAGE_CHAR_ESTIMATE
    case "document":
      // ADR-0137 — PDF document attachments. Tokens are provider-side OCR /
      // page-parse, NOT raw bytes. Anthropic charges ~1.5k-3k tokens per page;
      // base64 byte length is NOT a faithful proxy. Use a fixed estimate of
      // ~3k tokens (`estimateTokens` divides by 4) per document attachment —
      // enough to nudge compaction without exploding the threshold on a small
      // multi-page PDF. Page count is unknown without parsing, so this is the
      // conservative "small document" baseline.
      return DOCUMENT_CHAR_ESTIMATE
    default: {
      // ContentBlock is a closed union — `_exhaustive` pins it at build time so
      // a new variant fails tsc here instead of silently returning `undefined`
      // (which would corrupt the token estimate). At runtime (e.g. a block from
      // a forward-compat payload) fall back to its serialized length rather than
      // NaN-poisoning the running sum.
      const _exhaustive: never = b
      return JSON.stringify(_exhaustive ?? {}).length
    }
  }
}

/**
 * D4 (jun-7 naive-impl hardening) — safety margin (tokens) reserved BELOW the
 * derived threshold so that the chars/4 estimate's known under-count and a few
 * pending in-flight tokens cannot sail past the provider's hard window before
 * the proactive path folds history. Named after Claude Code's identical
 * `13000`-token reserve (claude-cli `CLAUDE_CODE_MAX_CONTEXT_TOKENS` derivation:
 * `window − outputReserve − 13000`). NOT a heuristic threshold — a fixed
 * safety budget cited from the reference implementation.
 */
const COMPACTION_SAFETY_MARGIN = 13_000

/**
 * D4 — derive the compaction threshold for a KNOWN model from its context
 * window: `window − maxOutput(reserve) − COMPACTION_SAFETY_MARGIN`. The reserve
 * is the model's table `maxOutput` (a spec value, NOT a guess) so a compaction
 * never leaves too little room for the model to finish its reply. Returns
 * `undefined` for an un-tabled model (caller falls back to the 120k legacy
 * constant — byte-identical pre-D4 path). Clamped to `> 0` defensively (every
 * tabled window satisfies `window > maxOutput + margin`, asserted in the
 * hellgate, but a degenerate future entry must never yield a non-positive or
 * negative threshold that would make compaction fire every turn).
 */
const deriveModelThreshold = (model: string): number | undefined => {
  const window = resolveModelWindow(model)
  if (window === undefined) return undefined
  const derived = window.contextWindow - window.maxOutput - COMPACTION_SAFETY_MARGIN
  return derived > 0 ? derived : undefined
}

/**
 * Resolve the proactive compaction threshold. Precedence (D4):
 *   1. explicit per-config override (`thresholdTokens`) — authoritative;
 *   2. env override (`QUANTA_COMPACT_TOKENS` via `runtimeConfig`) — authoritative;
 *   3. derived from the model's context window (KNOWN model only) — D4;
 *   4. `DEFAULT_THRESHOLD` (120_000) legacy — UNKNOWN model byte-identical.
 *
 * The explicit + env overrides stay AUTHORITATIVE and unchanged; the model-
 * derived layer sits strictly BELOW them. Signal-presence (a known model id)
 * gates the new behavior — no global knob, and an un-tabled model is identical
 * to the pre-D4 path.
 */
const resolveThreshold = (explicit?: number, model?: string): number => {
  if (explicit !== undefined) return explicit
  // S5: env is read in ONE place (runtimeConfig) — validated + frozen at
  // startup. A garbage value there is rejected with a stderr warn rather
  // than silently flipping the threshold here.
  const env = runtimeConfig().compactTokens
  if (env !== undefined) return env
  if (model !== undefined) {
    const derived = deriveModelThreshold(model)
    if (derived !== undefined) return derived
  }
  return DEFAULT_THRESHOLD
}

/**
 * ADR-0473 — the working token CEILING used as `UsageSnapshot.limitTokens` for
 * the background controller. The compaction threshold IS the meaningful ceiling
 * (it is the point at which the synchronous proactive path folds history), so
 * the speculative "approaching the limit" / "frees enough" math is anchored to
 * the SAME number the synchronous path uses. Resolves the explicit per-config
 * override first, then the env override, then the module default — identical
 * precedence to {@link resolveThreshold}, exported so the loop never re-derives
 * it (no literals at the call site).
 */
export const resolveCompactionLimitTokens = (explicit?: number, model?: string): number =>
  resolveThreshold(explicit, model)

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
      reason: "under_threshold" | "no_boundary" | "deferred"
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
  if (currentTokens <= threshold) {
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
