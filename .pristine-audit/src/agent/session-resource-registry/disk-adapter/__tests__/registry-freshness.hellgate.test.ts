/**
 * T04 hellgate — session registry FRESHNESS is owned by one `touchOnActivity`.
 *
 * Audit ref: Tier-1 "Session registry freshness" + L2 H7.
 *
 * The bug class: `meta.json.lastTouched` was refreshed ONLY on `getOrCreate`
 * (mint + cache-hit). A long-lived session that keeps APPENDING events through
 * an already-handed-out `store` reference never re-touched its meta, so the
 * disk GC (TTL on `meta.lastTouched`) would EVICT an actively-appending
 * session — destroying live state on the next `sweepDiskRegistry`.
 *
 * T04 consolidates every freshness write into ONE `touchOnActivity(id)` that
 * covers append AND cache-hit, and the GC's restart/replay path is reproven:
 *   1. append refreshes meta.lastTouched (the missing axis).
 *   2. a still-appending session SURVIVES a TTL sweep.
 *   3. a genuinely idle session is still evicted (no over-retention regression).
 */
import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TypedHistoryEvent } from "@/memory/typed-event"
import { createDiskSessionResourceRegistry } from "../disk-store"
import { sweepDiskRegistry } from "../gc"

const tempStorage = async (): Promise<string> => mkdtemp(join(tmpdir(), "t04-fresh-"))

const ev = (at: number): TypedHistoryEvent => ({
  kind: "context_update",
  field: "cwd",
  prev: "/a",
  next: "/b",
  at,
  turnId: `t${at}`,
})

const readMeta = async (dir: string, id: string): Promise<{ lastTouched: number } | null> => {
  try {
    const raw = await readFile(join(dir, id, "meta.json"), "utf8")
    return JSON.parse(raw) as { lastTouched: number }
  } catch {
    return null
  }
}

const waitFor = async <T>(
  fn: () => Promise<T | null>,
  ok: (v: T) => boolean,
): Promise<T | null> => {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    const v = await fn()
    if (v !== null && ok(v)) return v
    await new Promise((r) => setTimeout(r, 10))
  }
  return fn()
}

describe("T04 §1 — append refreshes meta.lastTouched (the missing axis)", () => {
  test("appending through the store handle bumps meta.json.lastTouched", async () => {
    const dir = await tempStorage()
    let clock = 1_000
    const reg = createDiskSessionResourceRegistry({ storageDir: dir, now: () => clock })
    const r = reg.getOrCreate("sess-fresh")
    // initial meta written at clock=1000
    const m0 = await waitFor(
      () => readMeta(dir, "sess-fresh"),
      (m) => m.lastTouched === 1_000,
    )
    expect(m0?.lastTouched).toBe(1_000)

    // advance the clock, append WITHOUT another getOrCreate.
    clock = 9_999
    r.store.append(ev(9_999))

    const m1 = await waitFor(
      () => readMeta(dir, "sess-fresh"),
      (m) => m.lastTouched === 9_999,
    )
    expect(m1?.lastTouched).toBe(9_999)
  })
})

describe("T04 §2 — actively-appending session survives a TTL sweep", () => {
  test("recent append keeps the session out of the GC eviction set", async () => {
    const dir = await tempStorage()
    let clock = 0
    const reg = createDiskSessionResourceRegistry({
      storageDir: dir,
      ttlMs: 1_000,
      now: () => clock,
    })
    const r = reg.getOrCreate("sess-active")
    await waitFor(
      () => readMeta(dir, "sess-active"),
      (m) => m.lastTouched === 0,
    )

    // Time jumps well past the TTL, but the session keeps working: append
    // refreshes freshness right before the sweep window.
    clock = 10_000
    r.store.append(ev(10_000))
    await waitFor(
      () => readMeta(dir, "sess-active"),
      (m) => m.lastTouched === 10_000,
    )

    // Sweep at a time only slightly after the last append — still inside TTL.
    clock = 10_500
    const result = await sweepDiskRegistry({ storageDir: dir, ttlMs: 1_000, now: () => clock })
    expect(result.evicted).toBe(0)
    expect(await readMeta(dir, "sess-active")).not.toBeNull()
  })
})

describe("T04 §3 — genuinely idle session is still evicted (no over-retention)", () => {
  test("a session with no recent activity past TTL is swept", async () => {
    const dir = await tempStorage()
    let clock = 0
    const reg = createDiskSessionResourceRegistry({
      storageDir: dir,
      ttlMs: 1_000,
      now: () => clock,
    })
    reg.getOrCreate("sess-idle")
    await waitFor(
      () => readMeta(dir, "sess-idle"),
      (m) => m.lastTouched === 0,
    )

    // No further activity. Sweep far past the TTL.
    clock = 1_000_000
    const result = await sweepDiskRegistry({ storageDir: dir, ttlMs: 1_000, now: () => clock })
    expect(result.evicted).toBe(1)
    expect(await readMeta(dir, "sess-idle")).toBeNull()
  })
})
