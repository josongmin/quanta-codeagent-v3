import type { ContentBlock, Message } from "@/llm"
import { resolveModelWindow } from "@/llm"
import { providerOf } from "@/observability"
import { runtimeConfig } from "@/shared"

/**
 * Token accounting + compaction-threshold derivation — extracted verbatim from
 * `../compaction` (god-module split; the parent re-exports this surface so every
 * importer of `@/agent/compaction` is unaffected). Pure arithmetic over message
 * lists plus the D5 token-baseline owner ({@link TokenBaselineBox}); no clock,
 * no I/O. The only env read is the validated, frozen `runtimeConfig()`.
 */

const DEFAULT_THRESHOLD = 120_000
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

/**
 * The mutable per-session storage the loop spreads into every turn's TurnState.
 * Declared structurally (NOT as the class) because the box is ALLOCATED in
 * `session-bootstrap` as `{}` and a couple of legacy invalidation sites still
 * assign `.current` directly. {@link TokenBaselineBox} is the OWNER of the
 * invariants over this shape — every NEW call site goes through the class, which
 * is why the four scattered correctness patches (provider cache-bucket
 * arithmetic, invalidate-on-shrink, invalidate-on-content-change, empty-model
 * double-count) now live in ONE place instead of guarding each call site.
 */
export interface TokenBaselineBoxState {
  current?: TokenBaseline | undefined
  sendCount?: number
}

/**
 * S2 (jun-7 FINAL) — the OWNER of the D5 token-baseline invariants.
 *
 * The bare `{ current?, sendCount? }` box accreted FOUR scattered correctness
 * patches across 8 audit rounds (each a guard bolted onto a different call
 * site): provider-aware cache-bucket arithmetic + the empty-model double-count
 * guard (capture), invalidate-on-shrink (the length-based stale clear),
 * invalidate-on-content-change (microcompact keeps the COUNT but replaces
 * tool_result CONTENT), and the in-range fail-safe (trigger). That is the
 * classic "bare object + a guard at every call site" smell.
 *
 * This class WRAPS the shared mutable {@link TokenBaselineBoxState} (it does NOT
 * own the allocation — the loop allocates `{}` once per session and spreads it
 * by reference into every turn, so the class is a thin per-call view over the
 * SAME object) and exposes the four invariants as named operations. The internal
 * `current`/`sendCount` are mutated ONLY here. Pure (no clock, no env): the
 * `clock`/`env` reads stay where they already were in the wire.
 */
export class TokenBaselineBox {
  constructor(private readonly box: TokenBaselineBoxState) {}

  /** Construct a view over the shared mutable box (allocated elsewhere). */
  static wrap(box: TokenBaselineBoxState): TokenBaselineBox {
    return new TokenBaselineBox(box)
  }

  /**
   * Fold the provider's usage into the authoritative input count — the PRIVATE
   * invariant that the rest of the loop never re-implements.
   *
   * The cache-bucket arithmetic is PROVIDER-DEPENDENT (the exact divergence
   * `costUsd`/`providerOf` encode in `@/observability/pricing`):
   *  - **anthropic**: `inputTokens` EXCLUDES cache reads (`cache_read` /
   *    `cache_creation` are disjoint buckets) → full prompt = `inputTokens +
   *    cacheRead + cacheCreation`. On a cache-HIT turn `inputTokens` alone is a
   *    few hundred tokens while the real prompt is ~100k.
   *  - **openai / empty-model**: `prompt_tokens` (our `inputTokens`) ALREADY
   *    INCLUDES `cached_tokens` → full = `inputTokens`; adding cacheRead
   *    double-counts. An EMPTY/unidentified model id (`usage.model ?? ""`) also
   *    takes this branch — `providerOf("")` defaults to "anthropic", so blindly
   *    summing would 2× double-count an OpenAI-shaped payload that didn't echo
   *    `model`, recording a baseline far above the real prompt → premature
   *    compaction discarding history.
   *
   * Trusts the result ONLY when it is `exact` (`>= sentEstimate`, our chars/4
   * estimate of the sent prompt) AND a send-time wm count was recorded by
   * {@link recordSendCount}. Otherwise no-op (legacy chars/4 stays in force).
   */
  capture(
    usage: {
      inputTokens: number
      cacheReadTokens?: number
      cacheCreationTokens?: number
      model: string
    },
    sentEstimate: number,
  ): void {
    if (this.box.sendCount === undefined) return
    const isAnthropic = usage.model !== "" && providerOf(usage.model) === "anthropic"
    const fullInput = isAnthropic
      ? usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheCreationTokens ?? 0)
      : usage.inputTokens
    if (!Number.isFinite(fullInput) || fullInput < sentEstimate) return
    this.box.current = {
      measuredInputTokens: fullInput,
      measuredAtMessageCount: this.box.sendCount,
    }
  }

  /** Record the wm length of the prompt about to be sent (after this turn's
   *  compaction settled). The {@link capture} pairs it with the provider's
   *  authoritative input count to form the baseline. */
  recordSendCount(len: number): void {
    this.box.sendCount = len
  }

  /**
   * Invalidate a baseline whose measured prefix was replaced by a compaction
   * that SHRANK the transcript (proactive/reactive summarize). See
   * {@link markBaselineStaleIfShrunk} for the full rationale — the length-based
   * `> messages.length` fail-safe stops firing once the transcript regrows past
   * the recorded index, so the stale baseline would force a premature
   * compaction. No-op when the transcript grew or held steady.
   */
  invalidateOnShrink(lenBefore: number, lenAfter: number): void {
    if (lenAfter < lenBefore) this.box.current = undefined
  }

  /**
   * Invalidate a baseline after a CONTENT-only change the length check cannot
   * see — a tier-1 microcompact replaces tool_result CONTENT while keeping the
   * message COUNT stable, so the prefix-measured baseline is now stale but
   * `invalidateOnShrink` (length-based) structurally misses it. Clearing falls
   * the trigger back to chars/4 until a fresh exact usage re-anchors.
   */
  invalidateOnContentChange(): void {
    this.box.current = undefined
  }

  /** The current authoritative baseline value (for the compaction wire to pass
   *  through to `compactIfNeeded`), or `undefined` when none is established. */
  currentBaseline(): TokenBaseline | undefined {
    return this.box.current
  }

  /** The token count the compaction trigger gates on: the in-range fail-safe +
   *  suffix-estimate anchored on the authoritative baseline (delegates to the
   *  pure {@link triggerTokenCount}). */
  trigger(messages: Message[]): number {
    return triggerTokenCount(messages, this.box.current)
  }
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
export const resolveThreshold = (explicit?: number, model?: string): number => {
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
