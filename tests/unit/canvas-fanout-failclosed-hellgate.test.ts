/**
 * DOF-40 — canvas fan-out fail-closed hellgate.
 *
 * Boundary under test: the canvas `*-source.ts` fan-out. Historically a
 * throwing subscriber (a dead / throwing WS `send` on a LIVE connection —
 * not a graceful close) was swallowed with a bare `catch {}` so it could
 * neither poison siblings NOR be observed — SILENT STARVATION.
 *
 * These cases pin BOTH invariants:
 *   1. ISOLATION — a throwing subscriber never starves siblings.
 *   2. SURFACING — the failure is routable via `onSubscriberError` + a
 *      `failureCount()` health signal, no longer silently dropped.
 *   3. OFF byte-identical — with NO observer the behavior is the legacy
 *      swallow (siblings fed, no throw, no new emission) AND the count still
 *      accrues internally without surfacing anywhere the operator sees.
 *
 * Sections:
 *   A. shared `fanOutIsolated` helper (isolation, surfacing, index, ordering,
 *      snapshot-under-mutation, hostile-observer, count).
 *   B. tool-diff source (throwing subscriber isolated + surfaced).
 *   C. usage source (throwing subscriber isolated + surfaced + latest still set).
 *   D. artifact source (throwing subscriber isolated + surfaced).
 *   E. OFF byte-identical (no observer ⇒ legacy swallow, siblings fed).
 *   F. backpressure — many events across many subscribers, one always throws:
 *      siblings receive EVERY event, failures counted per event.
 */

import { describe, expect, test } from "bun:test"
import { createCanvasArtifactSource } from "@/../src/apps/web-daemon/canvas-artifact-source"
import { createCanvasEmitter } from "@/../src/apps/web-daemon/canvas-emitter"
import { type FanoutError, fanOutIsolated } from "@/../src/apps/web-daemon/canvas-fanout"
import {
  type CapturedToolDiff,
  createCanvasToolDiffSource,
} from "@/../src/apps/web-daemon/canvas-tool-diff-source"
import { createCanvasUsageSource } from "@/../src/apps/web-daemon/canvas-usage-source"
import type {
  ContextUsageBreakdown,
  PromptAssembledSnapshot,
} from "@/agent/context/usage-breakdown"
import type { ArtifactRef } from "@/protocol/session"

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const diffInput = { toolCallId: "t1", before: "a\n", after: "b\n", path: "f.ts" }

const artifactRef: ArtifactRef = {
  artifactId: "art-1",
  kind: "image",
  mimeType: "image/png",
  locator: "quanta-artifact://art-1",
  createdAt: "2026-07-19T00:00:00.000Z",
}

const snapshot: PromptAssembledSnapshot = {
  system: [{ type: "text", text: "sys" }],
  layout: "single_block",
  repoRulesPresent: false,
  sessionCtxPresent: false,
  userAppendPresent: false,
  max: 200_000,
}

/* ================================================================== */
/* A. shared helper                                                    */
/* ================================================================== */

describe("A. fanOutIsolated", () => {
  test("A1 delivers to every subscriber", () => {
    const got: number[] = []
    const subs = [(v: number) => got.push(v), (v: number) => got.push(v * 10)]
    const failures = fanOutIsolated(subs, 3, undefined)
    expect(got).toEqual([3, 30])
    expect(failures).toBe(0)
  })

  test("A2 ISOLATION — a throwing subscriber does not starve siblings", () => {
    const got: number[] = []
    const subs = [
      (v: number) => got.push(v),
      (_v: number) => {
        throw new Error("dead socket")
      },
      (v: number) => got.push(v + 1),
    ]
    const failures = fanOutIsolated(subs, 5, undefined)
    // Sibling BEFORE and AFTER the throw both receive it.
    expect(got).toEqual([5, 6])
    expect(failures).toBe(1)
  })

  test("A3 SURFACING — throwing subscriber routes to the observer w/ index + message", () => {
    const seen: FanoutError[] = []
    const subs = [
      (_v: number) => undefined,
      (_v: number) => {
        throw new Error("boom-42")
      },
    ]
    fanOutIsolated(subs, 1, (e) => seen.push(e))
    expect(seen).toHaveLength(1)
    expect(seen[0]?.subscriberIndex).toBe(1)
    expect(seen[0]?.message).toContain("boom-42")
    expect(seen[0]?.error).toBeInstanceOf(Error)
  })

  test("A4 snapshot-under-mutation — a subscriber that unsubscribes mid-fan-out does not perturb", () => {
    const got: string[] = []
    const set = new Set<(v: string) => void>()
    const a = (v: string) => {
      got.push(`a:${v}`)
      set.delete(b) // unsubscribe a sibling mid-iteration
    }
    const b = (v: string) => got.push(`b:${v}`)
    set.add(a)
    set.add(b)
    fanOutIsolated(set, "x", undefined)
    // Snapshot taken before the loop ⇒ b still receives this event.
    expect(got).toEqual(["a:x", "b:x"])
  })

  test("A5 hostile observer — a throwing observer never breaks the fan-out", () => {
    const got: number[] = []
    const subs = [
      (_v: number) => {
        throw new Error("sub-fail")
      },
      (v: number) => got.push(v),
    ]
    const failures = fanOutIsolated(subs, 9, () => {
      throw new Error("observer-also-throws")
    })
    // Observer threw, but the second subscriber STILL got fed.
    expect(got).toEqual([9])
    expect(failures).toBe(1)
  })

  test("A6 multiple throwers counted independently", () => {
    const subs = [
      () => {
        throw new Error("1")
      },
      () => undefined,
      () => {
        throw new Error("2")
      },
    ]
    const seen: number[] = []
    const failures = fanOutIsolated(subs, 0, (e) => seen.push(e.subscriberIndex))
    expect(failures).toBe(2)
    expect(seen).toEqual([0, 2])
  })
})

/* ================================================================== */
/* B. tool-diff source                                                 */
/* ================================================================== */

describe("B. tool-diff source", () => {
  test("B1 ISOLATION + SURFACING", () => {
    const seen: FanoutError[] = []
    const src = createCanvasToolDiffSource({ onSubscriberError: (e) => seen.push(e) })
    const sibling: CapturedToolDiff[] = []
    src.subscribe(() => {
      throw new Error("bad-conn")
    })
    src.subscribe((d) => sibling.push(d))
    src.sink.capture(diffInput)
    expect(sibling).toHaveLength(1)
    expect(sibling[0]).toEqual(diffInput)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.message).toContain("bad-conn")
    expect(src.failureCount()).toBe(1)
  })
})

/* ================================================================== */
/* C. usage source                                                     */
/* ================================================================== */

describe("C. usage source", () => {
  test("C1 ISOLATION + SURFACING + latest() still updated despite a throw", () => {
    const seen: FanoutError[] = []
    const src = createCanvasUsageSource({ onSubscriberError: (e) => seen.push(e) })
    const sibling: ContextUsageBreakdown[] = []
    src.subscribe(() => {
      throw new Error("usage-conn-dead")
    })
    src.subscribe((v) => sibling.push(v))
    src.sink(snapshot)
    expect(sibling).toHaveLength(1)
    expect(src.latest()).toBeDefined()
    expect(seen).toHaveLength(1)
    expect(src.failureCount()).toBe(1)
  })
})

/* ================================================================== */
/* D. artifact source                                                  */
/* ================================================================== */

describe("D. artifact source", () => {
  test("D1 ISOLATION + SURFACING", () => {
    const seen: FanoutError[] = []
    const src = createCanvasArtifactSource({ onSubscriberError: (e) => seen.push(e) })
    const sibling: ArtifactRef[] = []
    src.subscribe(() => {
      throw new Error("art-conn-dead")
    })
    src.subscribe((r) => sibling.push(r))
    src.sink.capture(artifactRef)
    expect(sibling).toHaveLength(1)
    expect(sibling[0]).toEqual(artifactRef)
    expect(seen).toHaveLength(1)
    expect(src.failureCount()).toBe(1)
  })
})

/* ================================================================== */
/* E. OFF byte-identical (no observer)                                 */
/* ================================================================== */

describe("E. OFF byte-identical (no observer injected)", () => {
  test("E1 tool-diff — legacy swallow: siblings fed, capture never throws, no observer fires", () => {
    const src = createCanvasToolDiffSource() // no opts — legacy construction
    const sibling: unknown[] = []
    src.subscribe(() => {
      throw new Error("dead")
    })
    src.subscribe((d) => sibling.push(d))
    // Must NOT throw (byte-identical NO-THROW).
    expect(() => src.sink.capture(diffInput)).not.toThrow()
    expect(sibling).toHaveLength(1)
  })

  test("E2 usage — legacy swallow", () => {
    const src = createCanvasUsageSource()
    const sibling: unknown[] = []
    src.subscribe(() => {
      throw new Error("dead")
    })
    src.subscribe((v) => sibling.push(v))
    expect(() => src.sink(snapshot)).not.toThrow()
    expect(sibling).toHaveLength(1)
    expect(src.latest()).toBeDefined()
  })

  test("E3 artifact — legacy swallow", () => {
    const src = createCanvasArtifactSource()
    const sibling: unknown[] = []
    src.subscribe(() => {
      throw new Error("dead")
    })
    src.subscribe((r) => sibling.push(r))
    expect(() => src.sink.capture(artifactRef)).not.toThrow()
    expect(sibling).toHaveLength(1)
  })
})

/* ================================================================== */
/* F. backpressure — many events, one always-dead subscriber           */
/* ================================================================== */

describe("F. backpressure", () => {
  test("F1 100 events across 3 subscribers, one always throws — siblings get all 100", () => {
    const seen: FanoutError[] = []
    const src = createCanvasToolDiffSource({ onSubscriberError: (e) => seen.push(e) })
    const s1: number[] = []
    const s2: number[] = []
    let dispatched = 0
    src.subscribe(() => {
      s1.push(dispatched)
    })
    src.subscribe(() => {
      throw new Error("perma-dead")
    })
    src.subscribe(() => {
      s2.push(dispatched)
    })
    for (let i = 0; i < 100; i++) {
      dispatched = i
      src.sink.capture({ ...diffInput, toolCallId: `t${i}` })
    }
    // Every live sibling saw every event.
    expect(s1).toHaveLength(100)
    expect(s2).toHaveLength(100)
    // The dead subscriber failed on every event — counted + surfaced each time.
    expect(src.failureCount()).toBe(100)
    expect(seen).toHaveLength(100)
  })
})

/* ================================================================== */
/* G. per-connection emitter send-throw surfaced (live-conn ws.send)   */
/* ================================================================== */

describe("G. canvas emitter send-throw", () => {
  const usageView = {
    segments: [{ id: "System", tokens: 1, chars: 4, color: "cyan" }],
    total: 1,
    max: 100,
  } as unknown as ContextUsageBreakdown

  test("G1 a throwing ws.send is SURFACED (observer + count), turn never breaks", () => {
    const seen: { message: string }[] = []
    const em = createCanvasEmitter({
      ws: {
        send() {
          throw new Error("live-socket-send-failed")
        },
      },
      onSendError: (e) => seen.push(e),
    })
    // Must NOT throw (turn safety).
    expect(() => em.feedUsage(usageView)).not.toThrow()
    expect(seen).toHaveLength(1)
    expect(seen[0]?.message).toContain("live-socket-send-failed")
    expect(em.sendFailureCount()).toBe(1)
  })

  test("G2 OFF byte-identical — no observer ⇒ legacy swallow, no throw, count still accrues internally", () => {
    const em = createCanvasEmitter({
      ws: {
        send() {
          throw new Error("dead")
        },
      },
    })
    expect(() => em.feedUsage(usageView)).not.toThrow()
    // Count accrues but nothing the operator sees fires (no observer wired).
    expect(em.sendFailureCount()).toBe(1)
  })

  test("G3 hostile observer never breaks the turn", () => {
    const em = createCanvasEmitter({
      ws: {
        send() {
          throw new Error("dead")
        },
      },
      onSendError: () => {
        throw new Error("observer-throws")
      },
    })
    expect(() => em.feedUsage(usageView)).not.toThrow()
    expect(em.sendFailureCount()).toBe(1)
  })

  test("G4 healthy send ⇒ zero failures, frame delivered", () => {
    const frames: string[] = []
    const em = createCanvasEmitter({ ws: { send: (f) => frames.push(f) } })
    em.feedUsage(usageView)
    expect(frames).toHaveLength(1)
    expect(em.sendFailureCount()).toBe(0)
  })
})
