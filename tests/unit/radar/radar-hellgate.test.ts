/**
 * Radar cards hellgate — ADR-0231.
 *
 * 18 cases lock the proposal-queue MVP surface:
 *
 *   HELL-RC-01  propose round-trip (id auto-issued + status="active")
 *   HELL-RC-02  listActive returns every active card as a frozen array
 *   HELL-RC-03  setStatus("dismissed") drops the card from listActive
 *   HELL-RC-04  setStatus on unknown id → Err("not-found") (no throw)
 *   HELL-RC-05  recordEngagement → engagementCount + 1
 *   HELL-RC-06  recordEngagement on dismissed → Err("not-active")
 *   HELL-RC-07  prune(olderThanMs, now) marks expired by createdAtMs
 *   HELL-RC-08  jsonl-file persistence: propose → reload → identical
 *   HELL-RC-09  jsonl-file: corrupted line → skip + warn (no throw)
 *   HELL-RC-10  jsonl-file: 0600 file permission (security)
 *   HELL-RC-11  card mutation attempt → frozen (throws strict mode)
 *   HELL-RC-12  prune sanity at 1000 cards
 *   HELL-RC-13  in-memory + jsonl-file adapter surface parity
 *   HELL-RC-14  idle-long-task heuristic: both thresholds met → propose
 *   HELL-RC-15  heuristic is pure (no I/O, no clock — same inputs same out)
 *   HELL-RC-16  CardStatus 4-arm exhaustive (TS never-check)
 *   HELL-RC-17  adoptSession (status "adopted") is its own arm
 *   HELL-RC-18  in-memory LRU eviction at cap
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type CardStatus,
  HeadlessRadarStore,
  InMemoryRadarStore,
  JsonlFileRadarStore,
  type ProposeOpts,
  proposeOnIdleForLongTask,
  type RadarCard,
  type RadarStore,
} from "@/radar"

/* ====================================================================== */
/* shared helpers                                                          */
/* ====================================================================== */

const mkProposeOpts = (over: Partial<ProposeOpts> = {}): ProposeOpts => ({
  kind: "suggestion",
  title: "default",
  description: "default description",
  createdAtMs: 1_000,
  ...over,
})

let TMP_DIRS: string[] = []
const newTmpFile = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "radar-hg-"))
  TMP_DIRS.push(dir)
  return join(dir, "cards.jsonl")
}

beforeAll(() => {
  TMP_DIRS = []
})

afterAll(() => {
  for (const d of TMP_DIRS) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* swallow */
    }
  }
})

/* ====================================================================== */
/* HELL-RC-01 .. 07: in-memory port semantics                              */
/* ====================================================================== */

describe("HELL-RC-01..07: in-memory port semantics", () => {
  test("HELL-RC-01: proposeCard round-trip — id auto-issued + status=active", () => {
    const s = new InMemoryRadarStore()
    const c = s.proposeCard(mkProposeOpts({ title: "rc01" }))
    expect(c.id).toBeTruthy()
    expect(c.status).toBe("active")
    expect(c.engagementCount).toBe(0)
    expect(c.title).toBe("rc01")
  })

  test("HELL-RC-02: listActive returns every active card (frozen array)", () => {
    const s = new InMemoryRadarStore()
    s.proposeCard(mkProposeOpts({ title: "a", createdAtMs: 1 }))
    s.proposeCard(mkProposeOpts({ title: "b", createdAtMs: 2 }))
    s.proposeCard(mkProposeOpts({ title: "c", createdAtMs: 3 }))
    const list = s.listActive()
    expect(list.length).toBe(3)
    expect(Object.isFrozen(list)).toBe(true)
    expect(list[0]?.title).toBe("a")
    expect(list[2]?.title).toBe("c")
    expect(() => {
      ;(list as unknown as RadarCard[]).push({
        id: "x",
        kind: "suggestion",
        title: "x",
        description: "x",
        createdAtMs: 0,
        status: "active",
        engagementCount: 0,
      })
    }).toThrow()
  })

  test('HELL-RC-03: setStatus("dismissed") removes card from listActive', () => {
    const s = new InMemoryRadarStore()
    const c = s.proposeCard(mkProposeOpts({ title: "doomed" }))
    expect(s.listActive().length).toBe(1)
    const r = s.setStatus(c.id, "dismissed")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.status).toBe("dismissed")
    expect(s.listActive().length).toBe(0)
  })

  test('HELL-RC-04: setStatus on unknown id → Err("not-found"), no throw', () => {
    const s = new InMemoryRadarStore()
    const r = s.setStatus("does-not-exist", "dismissed")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe("not-found")
  })

  test("HELL-RC-05: recordEngagement increments engagementCount by 1", () => {
    const s = new InMemoryRadarStore()
    const c = s.proposeCard(mkProposeOpts())
    s.recordEngagement(c.id)
    s.recordEngagement(c.id)
    s.recordEngagement(c.id)
    const list = s.listActive()
    expect(list[0]?.engagementCount).toBe(3)
  })

  test('HELL-RC-06: recordEngagement on dismissed → Err("not-active")', () => {
    const s = new InMemoryRadarStore()
    const c = s.proposeCard(mkProposeOpts())
    s.setStatus(c.id, "dismissed")
    const r = s.recordEngagement(c.id)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe("not-active")
  })

  test("HELL-RC-07: prune(olderThanMs, now) marks expired by createdAtMs", () => {
    const s = new InMemoryRadarStore()
    const fresh = s.proposeCard(mkProposeOpts({ createdAtMs: 1_000, title: "fresh" }))
    const stale1 = s.proposeCard(mkProposeOpts({ createdAtMs: 100, title: "stale1" }))
    const stale2 = s.proposeCard(mkProposeOpts({ createdAtMs: 200, title: "stale2" }))
    const pruned = s.prune(500, 1_000)
    expect(pruned).toBe(2)
    const active = s.listActive()
    expect(active.length).toBe(1)
    expect(active[0]?.id).toBe(fresh.id)
    // sealed unused vars to satisfy biome:
    expect(stale1.id).not.toBe(stale2.id)
  })
})

/* ====================================================================== */
/* HELL-RC-08 .. 10, 13: jsonl-file adapter                                */
/* ====================================================================== */

describe("HELL-RC-08..10,13: jsonl-file adapter", () => {
  test("HELL-RC-08: persistence — propose → reload → identical state", () => {
    const fp = newTmpFile()
    const s1 = new JsonlFileRadarStore({ filePath: fp })
    const c1 = s1.proposeCard(mkProposeOpts({ title: "persist-1", createdAtMs: 1 }))
    const c2 = s1.proposeCard(mkProposeOpts({ title: "persist-2", createdAtMs: 2 }))
    s1.recordEngagement(c1.id)
    s1.setStatus(c2.id, "adopted")

    const s2 = new JsonlFileRadarStore({ filePath: fp })
    const active = s2.listActive()
    // c1 active with engagement=1; c2 was adopted (not active anymore)
    expect(active.length).toBe(1)
    expect(active[0]?.id).toBe(c1.id)
    expect(active[0]?.engagementCount).toBe(1)
  })

  test("HELL-RC-09: corrupted line skipped + warned, no throw", () => {
    const fp = newTmpFile()
    // Seed file with one valid op + two corrupted lines
    const validLine = `${JSON.stringify({
      op: "propose",
      card: {
        id: "ok-1",
        kind: "warning",
        title: "ok",
        description: "ok",
        createdAtMs: 5,
        status: "active",
        engagementCount: 0,
      },
    })}\n`
    writeFileSync(fp, `${validLine}{not-json\n${JSON.stringify({ op: "garbage" })}\n`)

    const warnings: string[] = []
    const s = new JsonlFileRadarStore({
      filePath: fp,
      onWarn: (m) => warnings.push(m),
    })
    expect(warnings.length).toBe(2)
    expect(s.listActive().length).toBe(1)
    expect(s.listActive()[0]?.id).toBe("ok-1")
  })

  test("HELL-RC-10: jsonl file permission is 0600 (security)", () => {
    const fp = newTmpFile()
    const s = new JsonlFileRadarStore({ filePath: fp })
    s.proposeCard(mkProposeOpts())
    const st = statSync(fp)
    const mode = st.mode & 0o777
    expect(mode).toBe(0o600)
  })

  test("HELL-RC-13: in-memory and jsonl-file have identical surface (parity)", () => {
    const fp = newTmpFile()
    const adapters: RadarStore[] = [
      new InMemoryRadarStore(),
      new JsonlFileRadarStore({ filePath: fp }),
    ]
    for (const s of adapters) {
      const c = s.proposeCard(mkProposeOpts({ createdAtMs: 7 }))
      expect(s.listActive().length).toBe(1)
      const e = s.recordEngagement(c.id)
      expect(e.ok).toBe(true)
      const ss = s.setStatus(c.id, "dismissed")
      expect(ss.ok).toBe(true)
      expect(s.listActive().length).toBe(0)
      expect(s.prune(1, 1_000)).toBe(0)
      expect(s.setStatus("unknown", "active").ok).toBe(false)
      expect(s.recordEngagement("unknown").ok).toBe(false)
    }
  })
})

/* ====================================================================== */
/* HELL-RC-11, 12, 18: immutability + perf + LRU                           */
/* ====================================================================== */

describe("HELL-RC-11,12,18: invariants", () => {
  test("HELL-RC-11: returned cards are frozen — mutation throws", () => {
    const s = new InMemoryRadarStore()
    const c = s.proposeCard(mkProposeOpts())
    expect(Object.isFrozen(c)).toBe(true)
    expect(() => {
      ;(c as { title: string }).title = "mutated"
    }).toThrow()
  })

  test("HELL-RC-12: prune sanity at 1000 cards completes promptly", () => {
    const s = new InMemoryRadarStore({ cap: 2_000 })
    for (let i = 0; i < 1_000; i++) {
      s.proposeCard(mkProposeOpts({ createdAtMs: i }))
    }
    const t0 = Date.now()
    const pruned = s.prune(100, 1_000)
    const dt = Date.now() - t0
    // Expect 900 to expire (createdAtMs 0..899 < 900 cutoff)
    expect(pruned).toBe(900)
    // Loose sanity — < 500ms — guards against accidental O(n²).
    expect(dt).toBeLessThan(500)
  })

  test("HELL-RC-18: LRU eviction at cap drops oldest card", () => {
    const s = new InMemoryRadarStore({ cap: 3 })
    const c1 = s.proposeCard(mkProposeOpts({ createdAtMs: 1, title: "c1" }))
    const c2 = s.proposeCard(mkProposeOpts({ createdAtMs: 2, title: "c2" }))
    const c3 = s.proposeCard(mkProposeOpts({ createdAtMs: 3, title: "c3" }))
    const c4 = s.proposeCard(mkProposeOpts({ createdAtMs: 4, title: "c4" }))
    // c1 should be evicted (oldest)
    expect(s.setStatus(c1.id, "dismissed").ok).toBe(false)
    expect(s.setStatus(c2.id, "active").ok).toBe(true)
    expect(s.setStatus(c3.id, "active").ok).toBe(true)
    expect(s.setStatus(c4.id, "active").ok).toBe(true)
  })
})

/* ====================================================================== */
/* HELL-RC-14, 15: heuristic                                               */
/* ====================================================================== */

describe("HELL-RC-14,15: idle-long-task heuristic", () => {
  test("HELL-RC-14: both thresholds met → propose", () => {
    const out = proposeOnIdleForLongTask({
      idleMs: 60_000,
      lastTaskDurationMs: 45_000,
      idleThresholdMs: 30_000,
      taskDurationThresholdMs: 30_000,
      nowMs: 1_000_000,
      sessionId: "sess-1",
    })
    expect(out).not.toBeNull()
    expect(out?.kind).toBe("next-step")
    expect(out?.sessionId).toBe("sess-1")
    expect(out?.createdAtMs).toBe(1_000_000)
  })

  test("HELL-RC-14b: threshold unmet → null", () => {
    const noIdle = proposeOnIdleForLongTask({
      idleMs: 5_000,
      lastTaskDurationMs: 60_000,
      idleThresholdMs: 30_000,
      taskDurationThresholdMs: 30_000,
      nowMs: 0,
    })
    expect(noIdle).toBeNull()

    const noLongTask = proposeOnIdleForLongTask({
      idleMs: 60_000,
      lastTaskDurationMs: 5_000,
      idleThresholdMs: 30_000,
      taskDurationThresholdMs: 30_000,
      nowMs: 0,
    })
    expect(noLongTask).toBeNull()
  })

  test("HELL-RC-15: heuristic is pure (same inputs → same output)", () => {
    const inputs = {
      idleMs: 60_000,
      lastTaskDurationMs: 45_000,
      idleThresholdMs: 30_000,
      taskDurationThresholdMs: 30_000,
      nowMs: 1_000_000,
    }
    const a = proposeOnIdleForLongTask(inputs)
    const b = proposeOnIdleForLongTask(inputs)
    expect(a).toEqual(b as ProposeOpts | null)
  })
})

/* ====================================================================== */
/* HELL-RC-16, 17: status union exhaustive + adoptSession                  */
/* ====================================================================== */

describe("HELL-RC-16,17: status union", () => {
  test("HELL-RC-16: CardStatus 4-arm exhaustive (TS never check at type-time)", () => {
    const cover = (s: CardStatus): string => {
      switch (s) {
        case "active":
          return "a"
        case "adopted":
          return "ad"
        case "dismissed":
          return "d"
        case "expired":
          return "e"
        default: {
          // If a new arm is added without updating this switch, TS will
          // surface a type-error here at compile time (`never` widening).
          const _exhaustive: never = s
          return _exhaustive
        }
      }
    }
    expect(cover("active")).toBe("a")
    expect(cover("adopted")).toBe("ad")
    expect(cover("dismissed")).toBe("d")
    expect(cover("expired")).toBe("e")
  })

  test('HELL-RC-17: adoptSession transitions to "adopted" — distinct arm', () => {
    const s = new InMemoryRadarStore()
    const c = s.proposeCard(mkProposeOpts())
    const r = s.setStatus(c.id, "adopted")
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.status).toBe("adopted")
      expect(r.value.status).not.toBe("active")
      expect(r.value.status).not.toBe("dismissed")
      expect(r.value.status).not.toBe("expired")
    }
    expect(s.listActive().length).toBe(0)
  })
})

/* ====================================================================== */
/* Sanity smoke: HeadlessRadarStore is a shape-conformant stub             */
/* ====================================================================== */

describe("headless-stub smoke", () => {
  test("headless surface conforms — listActive is empty + ops error", () => {
    const s = new HeadlessRadarStore()
    expect(s.listActive().length).toBe(0)
    expect(s.setStatus("x", "dismissed").ok).toBe(false)
    expect(s.recordEngagement("x").ok).toBe(false)
    expect(s.prune(1, 2)).toBe(0)
  })
})
