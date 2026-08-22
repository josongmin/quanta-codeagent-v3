/**
 * ★ HELLGATE — ADR-0361 serializer.
 *
 * Pins every TypedHistoryEvent variant's row-roundtrip + cache row
 * roundtrip + the byte estimator monotonicity + NO-THROW degrade on a
 * corrupt payload.
 *
 * Coverage (10 cases):
 *   1. context_update round-trip
 *   2. skill_activation round-trip
 *   3. repo_rules_change round-trip
 *   4. mode_change round-trip
 *   5. reasoning_echo round-trip
 *   6. compaction_event round-trip
 *   7. plugin_activation round-trip
 *   8. app_activation round-trip + cache row round-trip
 *   9. estimateEventBytes monotonicity (2× payload ⇒ ≥ 2× bytes, ish)
 *  10. rowToEvent NO-THROW on corrupt JSON + unknown kind
 */

import { describe, expect, test } from "bun:test"
import type { CachedPrompt, SystemPromptCacheKey } from "@/llm/system-prompt-cache"
import type { TypedHistoryEvent } from "@/memory/typed-event"
import {
  cacheToRow,
  estimateCacheBytes,
  estimateEventBytes,
  eventToRow,
  rowToCache,
  rowToEvent,
} from "../serializer"

const roundTrip = (ev: TypedHistoryEvent): TypedHistoryEvent | null => {
  const row = eventToRow("s1", 0, ev)
  return rowToEvent(row)
}

describe("ADR-0361 serializer — hellgate", () => {
  test("[1] context_update round-trip", () => {
    const ev: TypedHistoryEvent = {
      kind: "context_update",
      field: "cwd",
      prev: "/a",
      next: "/b",
      at: 1,
      turnId: "t1",
    }
    expect(roundTrip(ev)).toEqual(ev)
  })

  test("[2] skill_activation round-trip", () => {
    const ev: TypedHistoryEvent = {
      kind: "skill_activation",
      skillId: "sk-1",
      trigger: "auto",
      at: 2,
    }
    expect(roundTrip(ev)).toEqual(ev)
  })

  test("[3] repo_rules_change round-trip", () => {
    const ev: TypedHistoryEvent = {
      kind: "repo_rules_change",
      addedPaths: ["a", "b"],
      removedPaths: [],
      at: 3,
    }
    expect(roundTrip(ev)).toEqual(ev)
  })

  test("[4] mode_change round-trip", () => {
    const ev: TypedHistoryEvent = {
      kind: "mode_change",
      prev: "architect",
      next: "editor",
      reason: "user",
      at: 4,
    }
    expect(roundTrip(ev)).toEqual(ev)
  })

  test("[5] reasoning_echo round-trip", () => {
    const ev: TypedHistoryEvent = {
      kind: "reasoning_echo",
      signature: "sig-x",
      redacted: false,
      tokenCount: 42,
      at: 5,
    }
    expect(roundTrip(ev)).toEqual(ev)
  })

  test("[6] compaction_event round-trip", () => {
    const ev: TypedHistoryEvent = {
      kind: "compaction_event",
      trigger: "mid_turn",
      reason: "context_limit",
      tokensBefore: 100,
      tokensAfter: 40,
      messagesRemoved: 3,
      at: 6,
    }
    expect(roundTrip(ev)).toEqual(ev)
  })

  test("[7] plugin_activation round-trip", () => {
    const ev: TypedHistoryEvent = {
      kind: "plugin_activation",
      pluginId: "p1",
      trigger: "user",
      capabilities: ["Interactive", "Read"],
      at: 7,
    }
    expect(roundTrip(ev)).toEqual(ev)
  })

  test("[8] app_activation round-trip + cache row round-trip", () => {
    const ev: TypedHistoryEvent = {
      kind: "app_activation",
      appId: "quanta-cli",
      surface: "cli",
      trigger: "system",
      at: 8,
    }
    expect(roundTrip(ev)).toEqual(ev)

    const cached: CachedPrompt = {
      key: "sess-1" as SystemPromptCacheKey,
      text: "hello world",
      contentHash: "sha256:abc",
      builtAt: 1700,
    }
    const row = cacheToRow("s1", "sess-1", cached)
    const decoded = rowToCache(row)
    expect(String(decoded.key)).toBe("sess-1")
    expect(decoded.entry.text).toBe("hello world")
    expect(decoded.entry.contentHash).toBe("sha256:abc")
    expect(decoded.entry.builtAt).toBe(1700)
  })

  test("[9] estimateEventBytes + estimateCacheBytes monotonic", () => {
    const small: TypedHistoryEvent = {
      kind: "mode_change",
      prev: "a",
      next: "b",
      at: 1,
    }
    const big: TypedHistoryEvent = {
      kind: "mode_change",
      prev: "a".repeat(1000),
      next: "b".repeat(1000),
      at: 1,
    }
    expect(estimateEventBytes(big)).toBeGreaterThan(estimateEventBytes(small) * 5)
    expect(estimateCacheBytes("x".repeat(1000))).toBeGreaterThan(estimateCacheBytes("x") * 5)
    // Empty event is bounded (envelope only).
    expect(estimateEventBytes(small)).toBeGreaterThan(0)
  })

  test("[10] rowToEvent NO-THROW on corrupt + unknown-kind payload", () => {
    // Corrupt JSON.
    expect(
      rowToEvent({
        session_id: "s",
        seq: 0,
        kind: "mode_change",
        at: 1,
        estimated_bytes: 0,
        payload: "{not json",
      }),
    ).toBeNull()
    // Unknown kind.
    expect(
      rowToEvent({
        session_id: "s",
        seq: 0,
        kind: "bogus_kind",
        at: 1,
        estimated_bytes: 0,
        payload: JSON.stringify({ kind: "bogus_kind", at: 1 }),
      }),
    ).toBeNull()
    // Missing `at`.
    expect(
      rowToEvent({
        session_id: "s",
        seq: 0,
        kind: "mode_change",
        at: 1,
        estimated_bytes: 0,
        payload: JSON.stringify({ kind: "mode_change" }),
      }),
    ).toBeNull()
  })
})
