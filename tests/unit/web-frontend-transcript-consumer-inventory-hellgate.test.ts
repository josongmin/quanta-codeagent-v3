import { describe, expect, test } from "bun:test"
import { SESSION_EVENT_TYPES } from "@/protocol/session"
import type { SessionEvent } from "../../apps/web-frontend/src/types/protocol"
import {
  applyUnsupportedSessionEventToTranscript,
  initialTranscript,
  TRANSCRIPT_MUTATING_SESSION_EVENT_TYPES,
  TRANSCRIPT_NOOP_SESSION_EVENT_TYPES,
} from "../../apps/web-frontend/src/ws/session-hooks"

describe("web frontend transcript consumer inventory hellgate", () => {
  test("mutating + explicit no-op inventories partition canonical SessionEvent types exactly", () => {
    const canonical = [...SESSION_EVENT_TYPES].sort()
    const mutating = [...TRANSCRIPT_MUTATING_SESSION_EVENT_TYPES].sort()
    const noop = [...TRANSCRIPT_NOOP_SESSION_EVENT_TYPES].sort()
    const combined = [...new Set([...mutating, ...noop])].sort()

    expect(combined).toEqual(canonical)

    const noopSet = new Set<string>(noop)
    expect(mutating.filter((type) => noopSet.has(type))).toEqual([])
  })

  test("unsupported forward-compat strategy is an exact no-op", () => {
    const futureEvent = {
      type: "turn.some.future.kind",
      eventId: "future-1",
      emittedAt: "2026-06-12T00:00:00.000Z",
      seq: 999,
      revision: 1,
    } as unknown as SessionEvent

    const next = applyUnsupportedSessionEventToTranscript(initialTranscript, futureEvent)
    expect(next).toBe(initialTranscript)
  })

  test("inventory teeth: removing one canonical mutating event breaks the partition", () => {
    const canonical = [...SESSION_EVENT_TYPES].sort()
    const mutated = [
      ...TRANSCRIPT_MUTATING_SESSION_EVENT_TYPES.filter((type) => type !== "turn.started"),
      ...TRANSCRIPT_NOOP_SESSION_EVENT_TYPES,
    ].sort()

    expect(mutated).not.toEqual(canonical)
  })
})
