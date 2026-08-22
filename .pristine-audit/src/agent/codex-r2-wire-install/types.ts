/**
 * ADR-0332 — `CodexR2WireDeps` shape.
 *
 * Concrete sub-deps the install helper draws from to populate the
 * 6 ADR-0327-family wire slots on an `AgentConfig`. EVERY field is
 * optional — absent ⇒ that slot is left untouched (byte-identical to
 * the pre-install legacy posture).
 *
 * Types here intentionally reference only modules that exist TODAY
 * (ADR-0320 typed-event store, ADR-0321 context-change detector,
 * ADR-0323 history-sanitization, ADR-0325 mention-injection resolver
 * port, ADR-0326 system-prompt-cache, ADR-0328 image-sanitization-
 * retry config). Future absorbs of a higher-level
 * `createContextEventsProducer` factory may add convenience wrappers;
 * until then the install helper owns the closure assembly inline so a
 * composition root needs only the stateless primitive deps below.
 */

import type { TurnStateSnapshot } from "@/agent/context-change"
import type { MentionResolverPort } from "@/agent/mention-injection"
import type { SystemPromptCachePort } from "@/llm/system-prompt-cache"
import type { TypedHistoryEventStore } from "@/memory/typed-event"
import type { ImageSanitizationRetrySlotShape } from "./types-config"

/** Optional deps the install helper draws from to populate AgentConfig
 *  wire slots. All optional — absent ⇒ that slot is left untouched
 *  (byte-identical to legacy). */
export interface CodexR2WireDeps {
  /** Session id used as the system-prompt cache key + producer turnId
   *  prefix. When absent, BOTH `systemPromptCache` and `systemPromptCacheKey`
   *  slots stay unwired (the pair requires a session-stable key). */
  readonly sessionId?: string

  /** Snapshot capture for the context-events producer. When set together
   *  with `store`, the install helper fills `cfg.contextEventsForTurn`
   *  via an inline producer closure that calls `detectContextChanges`
   *  against the cursor `getSnapshot()` returns each turn. */
  readonly getSnapshot?: () => TurnStateSnapshot

  /** Shared typed-history store. When set with `getSnapshot`, fills
   *  `cfg.contextEventsForTurn` (events are pushed onto the store AND
   *  returned for the per-turn inject). When set ALONE, fills
   *  `cfg.compactionEventEmit` (proactive compaction events append here). */
  readonly store?: TypedHistoryEventStore

  /** Opt-in replay of stored compaction events into the normal per-turn
   * context-events slot. Other stored variants retain their direct owning
   * injection paths and are consumed without replay to avoid duplicates.
   * Absent or false is byte-identical to the prior append-only side channel. */
  readonly replayStoredEvents?: boolean

  /** Mention resolver port (ADR-0325). When set, fills `cfg.mentionInjector`
   *  via an inline closure that calls `parseMentions` → `buildInjectionFragments`
   *  → `buildMentionInjectionMessages`. If `store` is ALSO set the closure
   *  ALSO calls `emitMentionEvents` so skill mentions land on the same
   *  typed-history channel as ADR-0321 context-events. Absent ⇒ no
   *  injector wired. */
  readonly mentionResolver?: MentionResolverPort

  /** System-prompt cache port (ADR-0326). When set together with `sessionId`,
   *  fills BOTH `cfg.systemPromptCache` AND `cfg.systemPromptCacheKey`. The
   *  pair is wired atomically — absence of either keeps both slots untouched
   *  (the prompt seam disengages the cache when only one is present anyway,
   *  but the install helper enforces the pair to keep the host model simple). */
  readonly systemPromptCache?: SystemPromptCachePort

  /** Image-sanitization-retry config (ADR-0328). When set (and any value —
   *  the slot itself is the opt-in carrier; ADR-0333 wires `cfg.llm` at
   *  `createRunAgentContext` time if `enabled !== false`), fills
   *  `cfg.imageSanitizationRetry` verbatim. */
  readonly imageSanitizationRetry?: ImageSanitizationRetrySlotShape

  /** Optional clock for the context-events producer (`at` field on emitted
   *  events). Defaults to `Date.now`. Test-injection seam — production
   *  callers can omit. */
  readonly now?: () => number
}
