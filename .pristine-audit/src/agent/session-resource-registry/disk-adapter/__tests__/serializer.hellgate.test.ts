/**
 * ADR-0348 — Serializer hellgate.
 *
 * Coverage:
 *   A. event round-trip — context_update                        (1)
 *   B. event round-trip — skill_activation                      (1)
 *   C. event round-trip — repo_rules_change                     (1)
 *   D. event round-trip — mode_change                           (1)
 *   E. event round-trip — compaction_event                      (1)
 *   F. cache-line round-trip                                    (1)
 *   G. malformed JSON ⇒ null (NO-THROW)                         (1)
 *   H. empty line ⇒ null                                        (1)
 *   I. unknown event kind ⇒ null                                (1)
 *   J. large payload (10KB) round-trip                          (1)
 *   K. circular serialize ⇒ "" (NO-THROW)                       (1)
 *   L. parseEventsBody preserves order + filters bad lines      (1)
 *   M. parseCacheBody collapses duplicate keys (last wins)      (1)
 *   N. buildPersistedSnapshot wraps fields verbatim             (1)
 *
 *  Total = 14 cases.
 */

import { describe, expect, test } from "bun:test"
import { asCacheKey } from "@/llm/system-prompt-cache"
import type { TypedHistoryEvent } from "@/memory/typed-event"
import {
  buildPersistedSnapshot,
  deserializeCacheLine,
  deserializeEventLine,
  parseCacheBody,
  parseEventsBody,
  serializeCacheLine,
  serializeEventLine,
} from "../serializer"
import type { PersistedCacheEntry } from "../types"

describe("ADR-0348 §A — context_update round-trip", () => {
  test("preserves all fields", () => {
    const ev: TypedHistoryEvent = {
      kind: "context_update",
      field: "cwd",
      prev: "/a",
      next: "/b",
      at: 1234,
      turnId: "t1",
    }
    const line = serializeEventLine(ev)
    expect(line.length).toBeGreaterThan(0)
    const back = deserializeEventLine(line)
    expect(back).toEqual(ev)
  })
})

describe("ADR-0348 §B — skill_activation round-trip", () => {
  test("preserves trigger + skillId", () => {
    const ev: TypedHistoryEvent = {
      kind: "skill_activation",
      skillId: "git",
      trigger: "user",
      at: 5,
    }
    const back = deserializeEventLine(serializeEventLine(ev))
    expect(back).toEqual(ev)
  })
})

describe("ADR-0348 §C — repo_rules_change round-trip", () => {
  test("preserves both path arrays", () => {
    const ev: TypedHistoryEvent = {
      kind: "repo_rules_change",
      addedPaths: ["a/b", "c"],
      removedPaths: [],
      at: 10,
    }
    const back = deserializeEventLine(serializeEventLine(ev))
    expect(back).toEqual(ev)
  })
})

describe("ADR-0348 §D — mode_change round-trip", () => {
  test("preserves prev/next + optional reason", () => {
    const ev: TypedHistoryEvent = {
      kind: "mode_change",
      prev: "architect",
      next: "editor",
      reason: "/mode editor",
      at: 99,
    }
    const back = deserializeEventLine(serializeEventLine(ev))
    expect(back).toEqual(ev)
  })
})

describe("ADR-0348 §E — compaction_event round-trip", () => {
  test("preserves trigger + reason + counters", () => {
    const ev: TypedHistoryEvent = {
      kind: "compaction_event",
      trigger: "mid_turn",
      reason: "context_limit",
      tokensBefore: 10000,
      tokensAfter: 4000,
      messagesRemoved: 12,
      at: 500,
    }
    const back = deserializeEventLine(serializeEventLine(ev))
    expect(back).toEqual(ev)
  })
})

describe("ADR-0348 §F — cache-line round-trip", () => {
  test("preserves key/text/hash/builtAt", () => {
    const entry: PersistedCacheEntry = {
      key: asCacheKey("sess-1"),
      text: "system prompt body",
      contentHash: "abcd1234",
      builtAt: 1700000000000,
    }
    const back = deserializeCacheLine(serializeCacheLine(entry))
    expect(back).not.toBeNull()
    expect(back?.key).toBe("sess-1" as ReturnType<typeof asCacheKey>)
    expect(back?.text).toBe(entry.text)
    expect(back?.contentHash).toBe(entry.contentHash)
    expect(back?.builtAt).toBe(entry.builtAt)
  })
})

describe("ADR-0348 §G — malformed JSON ⇒ null (NO-THROW)", () => {
  test("non-JSON garbage", () => {
    expect(deserializeEventLine("{not json")).toBeNull()
    expect(deserializeCacheLine("(((")).toBeNull()
  })
})

describe("ADR-0348 §H — empty line ⇒ null", () => {
  test("empty + whitespace-only", () => {
    expect(deserializeEventLine("")).toBeNull()
    expect(deserializeEventLine("   ")).toBeNull()
    expect(deserializeCacheLine("")).toBeNull()
    expect(deserializeCacheLine("\t")).toBeNull()
  })
})

describe("ADR-0348 §I — unknown event kind ⇒ null", () => {
  test("foreign kind rejected", () => {
    const line = JSON.stringify({ kind: "not_a_real_kind", at: 1 })
    expect(deserializeEventLine(line)).toBeNull()
  })
  test("missing `at` rejected", () => {
    const line = JSON.stringify({ kind: "context_update", field: "cwd" })
    expect(deserializeEventLine(line)).toBeNull()
  })
  test("non-finite `at` rejected", () => {
    const line = JSON.stringify({ kind: "context_update", field: "cwd", at: "now" })
    expect(deserializeEventLine(line)).toBeNull()
  })
})

describe("ADR-0348 §J — large payload (10KB) round-trip", () => {
  test("10KB string survives", () => {
    const big = "x".repeat(10_000)
    const ev: TypedHistoryEvent = {
      kind: "reasoning_echo",
      signature: big,
      redacted: false,
      at: 1,
    }
    const back = deserializeEventLine(serializeEventLine(ev))
    expect(back).toEqual(ev)
  })
})

describe('ADR-0348 §K — circular serialize ⇒ "" (NO-THROW)', () => {
  test("self-referential payload returns empty string", () => {
    type Self = { kind: string; self?: unknown }
    const ev: Self = { kind: "context_update" }
    ev.self = ev
    // Cast through unknown — the producer types prevent this in
    // production but the serializer must still degrade safely.
    const line = serializeEventLine(ev as unknown as TypedHistoryEvent)
    expect(line).toBe("")
  })
  test('cache-line circular via toJSON ⇒ ""', () => {
    // The cache-line serializer projects only {key,text,contentHash,builtAt}
    // so extra fields are dropped. To force a JSON.stringify failure we
    // make `text` a toJSON-throwing proxy.
    const poisoned = {
      key: asCacheKey("k"),
      text: new Proxy(
        {},
        {
          get: () => {
            throw new Error("poisoned")
          },
        },
      ) as unknown as string,
      contentHash: "h",
      builtAt: 1,
    }
    const line = serializeCacheLine(poisoned as unknown as PersistedCacheEntry)
    expect(line).toBe("")
  })
})

describe("ADR-0348 §L — parseEventsBody preserves order + filters bad lines", () => {
  test("good + bad interleaved", () => {
    const good1: TypedHistoryEvent = {
      kind: "context_update",
      field: "cwd",
      prev: "/a",
      next: "/b",
      at: 1,
    }
    const good2: TypedHistoryEvent = {
      kind: "mode_change",
      prev: "x",
      next: "y",
      at: 2,
    }
    const body = [
      serializeEventLine(good1),
      "{not json",
      "",
      serializeEventLine(good2),
      JSON.stringify({ kind: "bogus", at: 99 }),
    ].join("\n")
    const out = parseEventsBody(body)
    expect(out.length).toBe(2)
    expect(out[0]).toEqual(good1)
    expect(out[1]).toEqual(good2)
  })
})

describe("ADR-0348 §M — parseCacheBody collapses duplicate keys", () => {
  test("last entry per key wins", () => {
    const first: PersistedCacheEntry = {
      key: asCacheKey("k"),
      text: "old",
      contentHash: "h1",
      builtAt: 1,
    }
    const second: PersistedCacheEntry = {
      key: asCacheKey("k"),
      text: "new",
      contentHash: "h2",
      builtAt: 2,
    }
    const body = [serializeCacheLine(first), serializeCacheLine(second)].join("\n")
    const out = parseCacheBody(body)
    expect(out.length).toBe(1)
    expect(out[0]?.text).toBe("new")
    expect(out[0]?.contentHash).toBe("h2")
  })
})

describe("ADR-0348 §N — buildPersistedSnapshot wraps fields verbatim", () => {
  test("frozen-shape pass-through", () => {
    const events: readonly TypedHistoryEvent[] = [
      { kind: "context_update", field: "cwd", prev: "/a", next: "/b", at: 1 },
    ]
    const cacheEntries: readonly PersistedCacheEntry[] = [
      { key: asCacheKey("k"), text: "t", contentHash: "h", builtAt: 100 },
    ]
    const snap = buildPersistedSnapshot("sess-1", events, cacheEntries, 42)
    expect(snap.sessionId).toBe("sess-1")
    expect(snap.events).toEqual(events)
    expect(snap.cacheEntries).toEqual(cacheEntries)
    expect(snap.lastTouched).toBe(42)
  })
})
