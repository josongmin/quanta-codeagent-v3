/**
 * ADR-0161 Phase C — Automation lifecycle helpers + JSONL store happy paths.
 *
 * Pure-helper tests (createAutomation / transitionStatus / recordFire /
 * markError / isFireEligible) + JSONL roundtrip + workspace isolation.
 *
 * Hellgate (corrupt JSONL / dup id / clock skew / EACCES / status invalid)
 * lives in `scheduler-automation-store-hellgate.test.ts`.
 */

import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createAutomation,
  isFireEligible,
  markError,
  recordFire,
  transitionStatus,
} from "@/scheduler/automation"
import { parseRRule } from "@/scheduler/rrule-parser"
import { defaultJsonlAutomationStore } from "@/scheduler/store-jsonl"
import type { Automation, RRule } from "@/scheduler/types"

const ruleOf = (s: string): RRule => {
  const r = parseRRule(s)
  if (!r.ok) throw new Error("bad rule")
  const { ok: _ok, ...rest } = r
  return rest
}

const sampleAutomation = (overrides?: Partial<Automation>): Automation => {
  const base = createAutomation({
    id: "a1",
    title: "weekly upgrade check",
    rule: ruleOf("FREQ=WEEKLY;BYDAY=MO"),
    prompt: "run upgrade audit",
    modelPreference: "gpt-5",
    modelFallbacks: ["claude-4-7-sonnet", "gpt-4-mini"],
    createdAt: Date.UTC(2026, 4, 1),
  })
  return { ...base, ...overrides }
}

describe("automation helpers", () => {
  test("createAutomation produces active 0-count + omits optional keys", () => {
    const a = sampleAutomation()
    expect(a.status).toBe("active")
    expect(a.fireCount).toBe(0)
    expect("lastFiredAt" in a).toBe(false)
    expect("lastErrorMessage" in a).toBe(false)
  })

  test("transitionStatus active → paused", () => {
    const a = sampleAutomation()
    const b = transitionStatus(a, "paused")
    expect(b.status).toBe("paused")
    expect(b).not.toBe(a) // new object
  })

  test("transitionStatus same arm is no-op (returns same ref)", () => {
    const a = sampleAutomation()
    const b = transitionStatus(a, "active")
    expect(b).toBe(a)
  })

  test("transitionStatus deleted is terminal", () => {
    const deleted = transitionStatus(sampleAutomation(), "deleted")
    const back = transitionStatus(deleted, "active")
    expect(back).toBe(deleted) // no transition out of deleted
  })

  test("recordFire increments + sets lastFiredAt + clears any prior error", () => {
    const errored = markError(sampleAutomation(), "all models down")
    const fired = recordFire(errored, Date.UTC(2026, 4, 5))
    expect(fired.fireCount).toBe(1)
    expect(fired.lastFiredAt).toBe(Date.UTC(2026, 4, 5))
    expect("lastErrorMessage" in fired).toBe(false)
  })

  test("markError sets status + lastErrorMessage, preserves prior fire", () => {
    const fired = recordFire(sampleAutomation(), Date.UTC(2026, 4, 5))
    const err = markError(fired, "all unavailable")
    expect(err.status).toBe("error")
    expect(err.lastErrorMessage).toBe("all unavailable")
    expect(err.lastFiredAt).toBe(Date.UTC(2026, 4, 5))
  })

  test("isFireEligible only active", () => {
    expect(isFireEligible(sampleAutomation())).toBe(true)
    expect(isFireEligible(transitionStatus(sampleAutomation(), "paused"))).toBe(false)
    expect(isFireEligible(transitionStatus(sampleAutomation(), "deleted"))).toBe(false)
    expect(isFireEligible(markError(sampleAutomation(), "x"))).toBe(false)
  })
})

describe("JSONL store roundtrip", () => {
  test("save + load roundtrip preserves all fields incl. exactOptional omissions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qsched-"))
    try {
      const store = defaultJsonlAutomationStore({ baseDir: dir })
      const a = sampleAutomation()
      await store.save("/w", a)
      const loaded = await store.load("/w")
      expect(loaded.length).toBe(1)
      const got = loaded[0]
      expect(got).toBeDefined()
      if (got === undefined) return
      expect(got.id).toBe(a.id)
      expect(got.rule.freq).toBe("WEEKLY")
      expect(got.rule.byDay).toEqual([{ day: "MO" }])
      expect("lastFiredAt" in got).toBe(false)
      expect("lastErrorMessage" in got).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("multiple saves — last line wins per id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qsched-"))
    try {
      const store = defaultJsonlAutomationStore({ baseDir: dir })
      await store.save("/w", sampleAutomation())
      await store.save("/w", transitionStatus(sampleAutomation(), "paused"))
      const loaded = await store.load("/w")
      expect(loaded.length).toBe(1)
      expect(loaded[0]?.status).toBe("paused")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("workspace isolation — two workspaces don't mix", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qsched-"))
    try {
      const store = defaultJsonlAutomationStore({ baseDir: dir })
      await store.save("/w1", sampleAutomation())
      await store.save("/w2", { ...sampleAutomation(), id: "a2" })
      const w1 = await store.load("/w1")
      const w2 = await store.load("/w2")
      expect(w1.length).toBe(1)
      expect(w2.length).toBe(1)
      expect(w1[0]?.id).toBe("a1")
      expect(w2[0]?.id).toBe("a2")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("delete is a tombstone — load hides", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qsched-"))
    try {
      const store = defaultJsonlAutomationStore({ baseDir: dir })
      await store.save("/w", sampleAutomation())
      await store.delete("/w", "a1")
      const loaded = await store.load("/w")
      expect(loaded.length).toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("delete unknown id is no-op", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qsched-"))
    try {
      const store = defaultJsonlAutomationStore({ baseDir: dir })
      await store.delete("/w", "missing")
      const loaded = await store.load("/w")
      expect(loaded).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("load on ENOENT (no file) → []", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qsched-"))
    try {
      const store = defaultJsonlAutomationStore({ baseDir: dir })
      const loaded = await store.load("/never")
      expect(loaded).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("complex automation with nth-occurrence + UNTIL roundtrip", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qsched-"))
    try {
      const store = defaultJsonlAutomationStore({ baseDir: dir })
      const complex: Automation = {
        ...sampleAutomation({
          rule: ruleOf("FREQ=MONTHLY;BYDAY=+2MO,-1FR;UNTIL=20261231T120000Z"),
        }),
      }
      await store.save("/w", complex)
      const loaded = await store.load("/w")
      expect(loaded[0]?.rule.byDay).toEqual([
        { day: "MO", nth: 2 },
        { day: "FR", nth: -1 },
      ])
      expect(loaded[0]?.rule.until).toBe(Date.UTC(2026, 11, 31, 12, 0, 0))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("lastFiredAt + lastErrorMessage roundtrip when present", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qsched-"))
    try {
      const store = defaultJsonlAutomationStore({ baseDir: dir })
      const fired = recordFire(sampleAutomation(), Date.UTC(2026, 4, 5))
      const err = markError(fired, "all down")
      await store.save("/w", err)
      const loaded = await store.load("/w")
      expect(loaded[0]?.lastFiredAt).toBe(Date.UTC(2026, 4, 5))
      expect(loaded[0]?.lastErrorMessage).toBe("all down")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
