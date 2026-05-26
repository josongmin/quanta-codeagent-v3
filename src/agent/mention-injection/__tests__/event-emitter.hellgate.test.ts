/**
 * ADR-0325 — Event-emitter hellgate.
 *
 * The emitter bridges {@link InjectionFragment}s to the ADR-0320
 * {@link TypedHistoryEventStore}. Skill ⇒ skill_activation event.
 * Plugin / app ⇒ no typed event in this ADR (variant-extension is a
 * follow-up ADR — see event-emitter.ts module docstring).
 *
 *   A. Empty / boundary                         (1)
 *   B. Skill → skill_activation                 (1)
 *   C. Plugin / app SKIPPED at typed-event tier (1)
 *   D. turnId / at propagation                  (1)
 *   E. Hostile store impl (NO-THROW)            (1)
 *
 * Total = 5 cases (matches the required 5).
 */

import { describe, expect, test } from "bun:test"
import { createInMemoryTypedHistoryEventStore, type TypedHistoryEvent } from "@/memory/typed-event"
import { emitMentionEvents } from "../event-emitter"
import type { InjectionFragment } from "../types"

const AT = 1_700_000_000_000

const span = (start: number, end: number) => ({ start, end })

const fragment = (
  kind: "skill" | "plugin" | "app",
  target: string,
  bodyText: string,
): InjectionFragment => ({ kind, target, bodyText, originSpan: span(0, 1) })

describe("emitMentionEvents — ADR-0325 hellgate", () => {
  // -------- A. empty / boundary --------------------------------------

  test("A1 — empty fragments ⇒ store unchanged", () => {
    const store = createInMemoryTypedHistoryEventStore()
    emitMentionEvents([], store, AT, undefined)
    expect(store.snapshot()).toEqual([])
  })

  // -------- B. skill → skill_activation ------------------------------

  test("B1 — skill fragment emits exactly one skill_activation event with trigger=user", () => {
    const store = createInMemoryTypedHistoryEventStore()
    emitMentionEvents([fragment("skill", "code-review", "body")], store, AT, "turn-7")
    const snap = store.snapshot()
    expect(snap).toHaveLength(1)
    const ev = snap[0] as TypedHistoryEvent
    expect(ev.kind).toBe("skill_activation")
    if (ev.kind === "skill_activation") {
      expect(ev.skillId).toBe("code-review")
      expect(ev.trigger).toBe("user")
      expect(ev.at).toBe(AT)
      expect(ev.turnId).toBe("turn-7")
    }
  })

  // -------- C. plugin / app skipped at typed-event tier --------------

  test("C1 — plugin and app fragments do NOT produce typed events (variant gap)", () => {
    const store = createInMemoryTypedHistoryEventStore()
    emitMentionEvents(
      [fragment("plugin", "github", "P"), fragment("app", "chrome", "A")],
      store,
      AT,
      "turn-7",
    )
    expect(store.snapshot()).toEqual([])
  })

  // -------- D. turnId / at propagation -------------------------------

  test("D1 — at + turnId-absent: event has no turnId field; multiple skills preserve order", () => {
    const store = createInMemoryTypedHistoryEventStore()
    const at1 = 1_700_000_000_000
    emitMentionEvents(
      [
        fragment("skill", "first", "F"),
        fragment("plugin", "skipped", "X"),
        fragment("skill", "second", "S"),
      ],
      store,
      at1,
      undefined,
    )
    const snap = store.snapshot()
    expect(snap).toHaveLength(2)
    expect(snap[0]?.kind).toBe("skill_activation")
    expect(snap[1]?.kind).toBe("skill_activation")
    if (snap[0]?.kind === "skill_activation") {
      expect(snap[0].skillId).toBe("first")
      expect(snap[0].at).toBe(at1)
      // turnId absent
      expect(Object.hasOwn(snap[0], "turnId")).toBe(false)
    }
    if (snap[1]?.kind === "skill_activation") {
      expect(snap[1].skillId).toBe("second")
    }
  })

  // -------- E. hostile store impl (NO-THROW) -------------------------

  test("E1 — hostile store (append throws) ⇒ emitter does NOT throw", () => {
    const hostileStore = {
      append: () => {
        throw new Error("disk full")
      },
      snapshot: () => [],
      since: () => [],
      clear: () => {},
    } as unknown as Parameters<typeof emitMentionEvents>[1]
    expect(() =>
      emitMentionEvents([fragment("skill", "x", "y")], hostileStore, AT, "t"),
    ).not.toThrow()
  })
})
