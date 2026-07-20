/**
 * SP-31 — typed-history store reader → context injection contract.
 *
 * This is intentionally separate from detector/inject unit tests: it proves
 * the store-backed consumer is ordered, bounded, exactly-once, and can resume
 * after the store's documented `clear()` session boundary.
 */

import { describe, expect, test } from "bun:test"
import { createInMemoryTypedHistoryEventStore } from "@/memory/typed-event"
import { buildPersistentInjectionMessages } from "../inject"
import { createContextEventStoreReader } from "../store-reader"
import type { ContextEvent } from "../types"

const event = (next: string, at: number): ContextEvent => ({
  kind: "context_update",
  field: "cwd",
  prev: `/before-${next}`,
  next,
  at,
})

describe("SP-31 context-event store reader", () => {
  test("consumes append-only history in bounded, ordered, exactly-once windows", () => {
    const store = createInMemoryTypedHistoryEventStore()
    const first = event("/one", 1)
    const second = event("/two", 2)
    const third = event("/three", 3)
    store.append(first)
    store.append(second)
    store.append(third)

    const reader = createContextEventStoreReader(store, { maxEvents: 2 })
    const window1 = reader.read()
    expect(window1).toEqual([first, second])
    expect(Object.isFrozen(window1)).toBe(true)

    // This is the real consumer hand-off: the bounded reader's output renders
    // directly through the prompt injection builder, in the same order.
    const rendered = buildPersistentInjectionMessages(window1)
    expect(rendered).toHaveLength(2)
    expect((rendered[0]?.content[0] as { text: string }).text).toContain("next: /one")
    expect((rendered[1]?.content[0] as { text: string }).text).toContain("next: /two")

    expect(reader.read()).toEqual([third])
    expect(reader.read()).toEqual([])

    const fourth = event("/four", 4)
    store.append(fourth)
    expect(reader.read()).toEqual([fourth])
  })

  test("clear resets the cursor without replaying pre-clear history", () => {
    const store = createInMemoryTypedHistoryEventStore()
    store.append(event("/old", 1))
    const reader = createContextEventStoreReader(store, { maxEvents: 1 })
    expect(reader.read()).toHaveLength(1)

    store.clear()
    expect(reader.read()).toEqual([])
    const fresh = event("/fresh", 2)
    store.append(fresh)
    expect(reader.read()).toEqual([fresh])
  })

  test("invalid runtime cap and a throwing snapshot fail closed", () => {
    const store = createInMemoryTypedHistoryEventStore()
    for (let i = 0; i < 17; i++) store.append(event(`/event-${i}`, i))
    const fallbackReader = createContextEventStoreReader(store, { maxEvents: 0 })
    expect(fallbackReader.read()).toHaveLength(16)

    const brokenReader = createContextEventStoreReader({
      append: () => {},
      snapshot: () => {
        throw new Error("storage unavailable")
      },
      since: () => [],
      clear: () => {},
    })
    expect(brokenReader.read()).toEqual([])
  })

  test("selection happens before the bounded prompt budget", () => {
    const store = createInMemoryTypedHistoryEventStore()
    for (let i = 0; i < 16; i++) store.append(event(`/before-${i}`, i))
    const compaction = {
      kind: "compaction_event" as const,
      trigger: "pre_sampling" as const,
      reason: "context_limit" as const,
      tokensBefore: 100,
      tokensAfter: 50,
      messagesRemoved: 3,
      at: 17,
    }
    store.append(compaction)

    const reader = createContextEventStoreReader(store, {
      include: (entry) => entry.kind === "compaction_event",
    })
    expect(reader.read()).toEqual([compaction])
    expect(reader.read()).toEqual([])
  })
})
