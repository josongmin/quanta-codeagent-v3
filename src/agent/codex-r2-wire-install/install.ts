/**
 * ADR-0332 — `installCodexR2Wires` composition helper.
 *
 * Single-call mutator that populates the 6 ADR-0327-family wire slots
 * on an `AgentConfig`. Composition roots get one line (`installCodexR2Wires(
 * cfg, { sessionId, getSnapshot, store, mentionResolver, systemPromptCache,
 * imageSanitizationRetry })`) instead of hand-building 6 closures with
 * the right NO-THROW envelopes.
 *
 * # cfg ownership
 *
 * The helper MUTATES the supplied `cfg` in place. This mirrors the
 * canonical mutation pattern at `src/agent/loop.ts:~2140`
 * (`cfg.onPlanExitOutcome = ...`) where the loop owner clones the
 * caller's config (`{ ...baseCfg }` at line 2137) and then mutates the
 * clone. The composition root SHOULD do the same: assemble the bare
 * AgentConfig, then call this helper to layer the optional wires on.
 *
 * # NO-THROW
 *
 * A composition-root failure cannot break the agent loop. Every slot
 * fill is wrapped in a try/catch — on throw the slot is left UNTOUCHED
 * (legacy posture). The helper itself never throws to its caller.
 * Even passing a frozen `cfg` (a poison-pill from a test or hostile
 * host) degrades to "every slot stays as it was" rather than a throw.
 *
 * # Idempotent + caller-override precedence
 *
 * Each slot is filled IFF (a) the slot is currently `undefined` on
 * `cfg` AND (b) the matching deps are present. A caller-pre-populated
 * slot is NEVER overwritten — that lets the host supply a custom
 * store/injector/cache and still benefit from the rest of the install.
 * Calling the helper twice with the same deps is therefore a no-op on
 * the second call (every slot is already set).
 *
 * # ADR-0333 deferral
 *
 * The `imageSanitizationRetry` slot is set HERE; the actual `cfg.llm`
 * wrap (the ADR-0333 hookup) happens later in `createRunAgentContext`
 * once `wm` exists (a `HistorySanitizationPort` needs the wm). See
 * `loop.ts:~2146` for the hookup site and ADR-0333 §Hookup.
 */

import type { ContextEvent } from "@/agent/context-change"
import { detectContextChanges } from "@/agent/context-change"
import type { MentionResolveErrorSink, MentionResolverPort } from "@/agent/mention-injection"
import {
  buildInjectionFragments,
  buildMentionInjectionMessages,
  emitMentionEvents,
  parseMentions,
} from "@/agent/mention-injection"
import type { AgentConfig } from "@/agent/types"
import { asCacheKey } from "@/llm/system-prompt-cache"
import type { Message } from "@/llm/types"
import type { TypedHistoryEventStore } from "@/memory/typed-event"
import { errMessage, logger } from "@/shared"
import type { CodexR2WireDeps } from "./types"

/** Belt-and-suspenders setter: writes `obj[key] = value` inside a
 *  try/catch so a frozen / sealed cfg degrades to no-op rather than
 *  throwing to the caller. NO-THROW invariant. */
const safeSet = <K extends keyof AgentConfig>(
  cfg: AgentConfig,
  key: K,
  value: AgentConfig[K],
): boolean => {
  try {
    cfg[key] = value
    return true
  } catch {
    return false
  }
}

/** Push every event onto the side-channel store. Per-event try/catch so
 *  a single buggy `append` cannot interrupt the rest. */
const appendAllSafe = (store: TypedHistoryEventStore, events: readonly ContextEvent[]): void => {
  for (const ev of events) {
    try {
      store.append(ev)
    } catch (e) {
      // side-channel — log + swallow.
      logger.warn(`codex-r2-wire.appendAllSafe: ${errMessage(e)}`)
    }
  }
}

/** Build the inline context-events producer closure. The closure owns a
 *  ROLLING cursor of "last snapshot" so each call diffs against the
 *  previous snapshot — `detectContextChanges` short-circuits when the
 *  caller returns the same reference. Events are ALSO appended to
 *  `store` (when present) so a downstream consumer can replay typed
 *  history. NO-THROW envelope at the closure-entry boundary so a
 *  buggy `getSnapshot` cannot crash the turn. */
const buildContextEventsProducer = (
  getSnapshot: () => import("@/agent/context-change").TurnStateSnapshot,
  store: TypedHistoryEventStore | undefined,
  sessionId: string | undefined,
  now: () => number,
): (() => readonly ContextEvent[]) => {
  let prev: import("@/agent/context-change").TurnStateSnapshot | undefined
  let turnSeq = 0
  const mintTurnId = (): string => {
    turnSeq++
    return sessionId !== undefined ? `${sessionId}#${turnSeq}` : `t${turnSeq}`
  }
  return (): readonly ContextEvent[] => {
    try {
      const current = getSnapshot()
      if (prev === undefined) {
        // First turn — seed cursor without emitting (no "diff against
        // nothing" event spray). Matches Codex behaviour where the
        // initial reference context is captured but not diffed.
        prev = current
        return []
      }
      const events = detectContextChanges(prev, current, now(), { turnId: mintTurnId() })
      prev = current
      if (store !== undefined && events.length > 0) appendAllSafe(store, events)
      return events
    } catch (e) {
      // Keep the process-log warn for local attribution, then RE-THROW so the
      // ONLY wired caller — `resolveContextEventsForTurn` (compaction-wire) —
      // surfaces the failure as a NON-FATAL `stream.emit({type:"error"})` on the
      // session stream (it already does; the inner swallow used to preempt it).
      // The outer wrapper still degrades clean (returns `[]`), so the turn is
      // byte-identical on the SUCCESS path and gains ONE error event on throw.
      logger.warn(`codex-r2-wire.contextEventsForTurn: ${errMessage(e)}`)
      throw e
    }
  }
}

/** Build the inline mention-injector closure. Parses the user-input text,
 *  resolves fragments through the resolver, builds inject-messages, and
 *  (when `store` is present) emits skill events to the typed-history
 *  store. NO-THROW envelope at the closure-entry boundary.
 *
 *  ADR-0418: `buildInjectionFragments` is async (file / symbol I/O), so this
 *  closure is async and `cfg.mentionInjector` is `Promise`-shaped. */
const buildMentionInjector = (
  resolver: MentionResolverPort,
  store: TypedHistoryEventStore | undefined,
  sessionId: string | undefined,
  now: () => number,
  // Observability: invoked once per FAILING mention (a throwing `@file`/`@symbol`
  // resolution) so the operator sees a failed reference instead of it silently
  // vanishing. `undefined` ⇒ no sink ⇒ byte-identical (safeCall still logs.warn).
  onError: MentionResolveErrorSink | undefined,
): ((userInputText: string) => Promise<readonly Message[]>) => {
  let turnSeq = 0
  return async (userInputText: string): Promise<readonly Message[]> => {
    try {
      const mentions = parseMentions(userInputText)
      if (mentions.length === 0) return []
      const fragments = await buildInjectionFragments(mentions, resolver, onError)
      if (fragments.length === 0) return []
      if (store !== undefined) {
        turnSeq++
        const turnId = sessionId !== undefined ? `${sessionId}#m${turnSeq}` : `m${turnSeq}`
        emitMentionEvents(fragments, store, now(), turnId)
      }
      return buildMentionInjectionMessages(fragments)
    } catch (e) {
      // Keep the process-log warn, then RE-THROW so the ONLY wired caller —
      // `resolveMentionInjectionMessages` (context-assembler) — surfaces the
      // failure as a NON-FATAL `stream.emit({type:"error"})` on the session
      // stream (it already does; the inner swallow used to preempt it). The
      // outer wrapper still degrades clean (returns `[]`), so a degraded `@file`
      // expansion becomes ONE visible error event instead of silently vanishing.
      // (Per-mention `@file` failures are unchanged — they flow through the
      // `onError` sink inside `buildInjectionFragments`; this catch is the
      // CLOSURE-ENTRY boundary, which had no stream reach.)
      logger.warn(`codex-r2-wire.mentionInjector: ${errMessage(e)}`)
      throw e
    }
  }
}

/** Build the compaction-event emit closure. Appends the event to the
 *  store. NO-THROW: a buggy store cannot crash the turn. */
const buildCompactionEventEmit = (
  store: TypedHistoryEventStore,
): ((event: import("@/memory/typed-event").CompactionEventVariant) => void) => {
  return (event) => {
    try {
      store.append(event)
    } catch (e) {
      // side-channel — log + swallow.
      logger.warn(`codex-r2-wire.compactionEventEmit: ${errMessage(e)}`)
    }
  }
}

/** Fill the system-prompt cache pair on `cfg`. Both slots fill atomically;
 *  if either is already set (caller-override) NEITHER is touched. */
const fillSystemPromptCachePair = (
  cfg: AgentConfig,
  port: import("@/llm/system-prompt-cache").SystemPromptCachePort,
  sessionId: string,
): void => {
  if (cfg.systemPromptCache !== undefined) return
  if (cfg.systemPromptCacheKey !== undefined) return
  const ok1 = safeSet(cfg, "systemPromptCache", port)
  if (!ok1) return
  const ok2 = safeSet(cfg, "systemPromptCacheKey", asCacheKey(sessionId))
  if (!ok2) {
    // Roll back the first set so we never end up with a half-wired pair.
    // The cast goes through `unknown` to thread the optional slot's
    // `undefined` value past the non-null-assertion lint without using `!`.
    // `safeSet` itself swallows any throw from the rollback write.
    safeSet(cfg, "systemPromptCache", undefined as unknown as AgentConfig["systemPromptCache"])
    // frozen-cfg edge: when the rollback ALSO fails the pair stays
    // half-wired, but the prompt seam disengages the cache when only
    // one of the pair is set anyway, so the result is still safe
    // (legacy build path).
  }
}

/**
 * Populate the 6 ADR-0327-family wire slots on `cfg` from the supplied
 * `deps`. See module docstring for the cfg ownership / NO-THROW /
 * idempotent / caller-override-precedence contracts.
 *
 * @param cfg   The AgentConfig to mutate. Composition roots SHOULD pass
 *              the already-cloned config (mirror of `loop.ts:~2137`).
 * @param deps  Optional dep bag. Each field is independently optional;
 *              absent fields leave the matching slot untouched.
 */
/** Slot 3 — context-events producer. NO-THROW factory step. */
const fillContextEvents = (cfg: AgentConfig, deps: CodexR2WireDeps, now: () => number): void => {
  if (cfg.contextEventsForTurn !== undefined) return
  if (deps.getSnapshot === undefined || deps.store === undefined) return
  try {
    const producer = buildContextEventsProducer(deps.getSnapshot, deps.store, deps.sessionId, now)
    safeSet(cfg, "contextEventsForTurn", producer)
  } catch {
    // Producer factory throw ⇒ slot stays unwired.
  }
}

/** Slot 4 — mention-injector. NO-THROW factory step. */
const fillMentionInjector = (cfg: AgentConfig, deps: CodexR2WireDeps, now: () => number): void => {
  if (cfg.mentionInjector !== undefined) return
  if (deps.mentionResolver === undefined) return
  try {
    // Surface a failed `@`-mention resolution as a non-fatal stream error so it is
    // not silently swallowed inside `safeCall` (mirror of `resolveMemoryContext`).
    const onError: MentionResolveErrorSink = (err) =>
      cfg.stream.emit({
        type: "error",
        message: `mention @${err.target} (${err.kind}) resolve failed: ${err.message}`,
      })
    const injector = buildMentionInjector(
      deps.mentionResolver,
      deps.store,
      deps.sessionId,
      now,
      onError,
    )
    safeSet(cfg, "mentionInjector", injector)
  } catch {
    // Injector factory throw ⇒ slot stays unwired.
  }
}

/** Slot 5 — compaction-event emit. NO-THROW factory step. */
const fillCompactionEmit = (cfg: AgentConfig, deps: CodexR2WireDeps): void => {
  if (cfg.compactionEventEmit !== undefined) return
  if (deps.store === undefined) return
  try {
    safeSet(cfg, "compactionEventEmit", buildCompactionEventEmit(deps.store))
  } catch {
    // Emitter factory throw ⇒ slot stays unwired.
  }
}

/** Slot 6 — image-sanitization-retry knob carrier. ADR-0333 hookup
 *  happens in `createRunAgentContext` once wm exists. */
const fillImageRetrySlot = (cfg: AgentConfig, deps: CodexR2WireDeps): void => {
  if (cfg.imageSanitizationRetry !== undefined) return
  if (deps.imageSanitizationRetry === undefined) return
  safeSet(cfg, "imageSanitizationRetry", deps.imageSanitizationRetry)
}

export const installCodexR2Wires = (cfg: AgentConfig, deps: CodexR2WireDeps): void => {
  const now = deps.now ?? Date.now
  // Slot 1+2: system-prompt cache pair (atomic).
  if (deps.systemPromptCache !== undefined && deps.sessionId !== undefined) {
    fillSystemPromptCachePair(cfg, deps.systemPromptCache, deps.sessionId)
  }
  fillContextEvents(cfg, deps, now)
  fillMentionInjector(cfg, deps, now)
  fillCompactionEmit(cfg, deps)
  fillImageRetrySlot(cfg, deps)
}
