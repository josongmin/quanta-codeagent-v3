/**
 * ★ HELLGATE — ADR-0554: importance decay is bounded to ONCE PER AGE WINDOW.
 *
 * Defect this pins (measured before the fix): `shouldDecay` in
 * src/memory/eviction.ts was gated only by AGE (>30d ⇒ "archived"), and the
 * sweep runs on EVERY persistSession (one per interactive turn). An entry
 * that crossed 30d therefore had its importance halved PER SWEEP — four
 * sessions in one afternoon took 0.5 → 0.25 → 0.125 → 0.0625 → 0.03. Decay was
 * coupled to SESSION COUNT, not ELAPSED TIME. Because the importance term in
 * ranking is `importance * 4`, that alone (2.0 → 0.125 points) is what let a
 * 1-hour episodic entry outrank a 31-day semantic one.
 *
 * Contract after the fix: a survivor decays at most once per archived window
 * (DECAY_WINDOW_MS = STALE_MAX_MS), tracked by a DEDICATED `lastDecayedAt`
 * field — NOT `updatedAt`, which every adapter stamps on every update AND
 * reinforce() stamps on every recall. Legacy rows (no field) decay on their
 * first sweep exactly as before, so the C5 boundary contracts stay intact.
 */

import { Database } from "bun:sqlite"
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { persistSession, recallContext } from "@/agent/memory"
import type { Message } from "@/llm"
import { InMemoryStore, SqliteStore } from "@/memory"
import { DECAY_WINDOW_MS, EVICTION_DECAY, planEviction } from "@/memory/eviction"
import type { MemoryEntry, MemoryTier } from "@/memory/types"
import { STALE_MAX_MS } from "@/memory/types"

const DAY = 24 * 60 * 60 * 1000
const TEST_NOW = 1_700_000_000_000
const fixedNow = (): number => TEST_NOW

const entry = (over: Partial<MemoryEntry> & { id: string }): MemoryEntry => ({
  kind: "fact",
  text: "old archived knowledge",
  tags: [],
  tier: "semantic",
  createdAt: TEST_NOW - 31 * DAY,
  importance: 0.5,
  ...over,
})

const assistant = (text: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
})

/** One real persistSession sweep at `now`. Distinct summary per call so the
 *  heuristic dedup never short-circuits (the sweep runs regardless, but a
 *  distinct insert per turn is the realistic per-turn shape). */
const sweep = async (store: InMemoryStore, now: number, i: number): Promise<void> => {
  await persistSession(
    { store, now: () => now },
    { sessionId: `s${i}`, finalMessages: [assistant(`unrelated brand new summary ${i}`)] },
  )
}

describe("decay-frequency hellgate — window constant", () => {
  test("DECAY_WINDOW_MS is the archived window itself (STALE_MAX_MS = 30d) — no invented interval", () => {
    expect(DECAY_WINDOW_MS).toBe(STALE_MAX_MS)
    expect(DECAY_WINDOW_MS).toBe(30 * DAY)
  })
})

describe("H1 — four sweeps at the SAME now decay ONCE (session count ≠ elapsed time)", () => {
  test("planner: an entry decayed at `now` is NOT re-planned for decay at the same `now`", () => {
    const first = planEviction([entry({ id: "a" })], undefined, TEST_NOW)
    expect(first.decay).toEqual(["a"])
    const again = planEviction([entry({ id: "a", lastDecayedAt: TEST_NOW })], undefined, TEST_NOW)
    expect(again.decay).toEqual([])
    expect(again.delete).toEqual([])
  })

  test("e2e: 31-day entry, 4 persistSession sweeps in one afternoon → 0.5 → 0.25, not 0.03", async () => {
    const store = new InMemoryStore([entry({ id: "arch" })])
    for (let i = 0; i < 4; i++) await sweep(store, TEST_NOW, i)
    const e = await store.get("arch")
    expect(e?.importance).toBeCloseTo(0.5 * EVICTION_DECAY, 8) // 0.25
    // wiring-proof: the sweep STAMPED the dedicated field with the injected clock.
    expect(e?.lastDecayedAt).toBe(TEST_NOW)
  })
})

describe("H2 — sweeps spaced ≥ one archived window apart DO decay each time (elapsed-time semantics)", () => {
  test("planner: lastDecayedAt exactly one window ago ⇒ decays; one ms short ⇒ does not", () => {
    const due = planEviction(
      [
        entry({
          id: "a",
          createdAt: TEST_NOW - 90 * DAY,
          lastDecayedAt: TEST_NOW - DECAY_WINDOW_MS,
        }),
      ],
      undefined,
      TEST_NOW,
    )
    expect(due.decay).toEqual(["a"])
    const notYet = planEviction(
      [
        entry({
          id: "a",
          createdAt: TEST_NOW - 90 * DAY,
          lastDecayedAt: TEST_NOW - DECAY_WINDOW_MS + 1,
        }),
      ],
      undefined,
      TEST_NOW,
    )
    expect(notYet.decay).toEqual([])
  })

  test("e2e: three sweeps one window apart → 0.5 → 0.25 → 0.125 → 0.0625", async () => {
    const store = new InMemoryStore([entry({ id: "arch" })])
    await sweep(store, TEST_NOW, 0)
    expect((await store.get("arch"))?.importance).toBeCloseTo(0.25, 8)
    await sweep(store, TEST_NOW + DECAY_WINDOW_MS, 1)
    expect((await store.get("arch"))?.importance).toBeCloseTo(0.125, 8)
    await sweep(store, TEST_NOW + 2 * DECAY_WINDOW_MS, 2)
    const e = await store.get("arch")
    expect(e?.importance).toBeCloseTo(0.0625, 8)
    expect(e?.lastDecayedAt).toBe(TEST_NOW + 2 * DECAY_WINDOW_MS)
  })
})

describe("H3 — paired control: the C5 age boundary is untouched", () => {
  test("29-day entry never decays across 4 sweeps (importance and field untouched)", async () => {
    const store = new InMemoryStore([entry({ id: "young", createdAt: TEST_NOW - 29 * DAY })])
    for (let i = 0; i < 4; i++) await sweep(store, TEST_NOW, i)
    const e = await store.get("young")
    expect(e?.importance).toBe(0.5)
    expect(e?.lastDecayedAt).toBeUndefined()
  })

  test("30d + 1ms legacy row (no lastDecayedAt) decays on its FIRST sweep, exactly as before", async () => {
    const plan = planEviction(
      [entry({ id: "past", createdAt: TEST_NOW - STALE_MAX_MS - 1 })],
      undefined,
      TEST_NOW,
    )
    expect(plan.decay).toEqual(["past"])
    const store = new InMemoryStore([entry({ id: "past", createdAt: TEST_NOW - STALE_MAX_MS - 1 })])
    await sweep(store, TEST_NOW, 0)
    expect((await store.get("past"))?.importance).toBeCloseTo(0.25, 8)
  })

  test("exactly 30d (stale, not archived) is never decayed, with or without the field", () => {
    for (const lastDecayedAt of [undefined, TEST_NOW - 2 * DECAY_WINDOW_MS]) {
      const e = entry({ id: "at", createdAt: TEST_NOW - STALE_MAX_MS })
      if (lastDecayedAt !== undefined) e.lastDecayedAt = lastDecayedAt
      expect(planEviction([e], undefined, TEST_NOW).decay).toEqual([])
    }
  })
})

describe("H4 — tier symmetry: no tier is exempt, both are bounded identically", () => {
  test("planner: both tiers decay on first plan, neither re-decays at the same now", () => {
    const tiers: MemoryTier[] = ["semantic", "episodic"]
    const fresh = tiers.map((tier) => entry({ id: tier, tier }))
    expect(planEviction(fresh, undefined, TEST_NOW).decay.sort()).toEqual(["episodic", "semantic"])
    const stamped = tiers.map((tier) => entry({ id: tier, tier, lastDecayedAt: TEST_NOW }))
    expect(planEviction(stamped, undefined, TEST_NOW).decay).toEqual([])
  })

  test("e2e: semantic and episodic 31-day entries both land on exactly 0.25 after 4 same-now sweeps", async () => {
    const store = new InMemoryStore([
      entry({ id: "sem", tier: "semantic" }),
      entry({ id: "epi", tier: "episodic", text: "old archived episode" }),
    ])
    for (let i = 0; i < 4; i++) await sweep(store, TEST_NOW, i)
    expect((await store.get("sem"))?.importance).toBeCloseTo(0.25, 8)
    expect((await store.get("epi"))?.importance).toBeCloseTo(0.25, 8)
  })
})

describe("H5 — the decay window is independent of updatedAt (recall must not shield or force decay)", () => {
  test("planner: recalled just now (updatedAt=now) but last decayed a window ago ⇒ still decays", () => {
    const plan = planEviction(
      [
        entry({
          id: "hot-ancient",
          createdAt: TEST_NOW - 90 * DAY,
          lastDecayedAt: TEST_NOW - DECAY_WINDOW_MS,
          updatedAt: TEST_NOW,
          lastAccessedAt: TEST_NOW,
          accessCount: 5,
        }),
      ],
      undefined,
      TEST_NOW,
    )
    expect(plan.decay).toEqual(["hot-ancient"])
  })

  test("planner: stale updatedAt (60d) but decayed just now ⇒ NOT decayed again", () => {
    const plan = planEviction(
      [
        entry({
          id: "cold",
          createdAt: TEST_NOW - 90 * DAY,
          lastDecayedAt: TEST_NOW,
          updatedAt: TEST_NOW - 60 * DAY,
        }),
      ],
      undefined,
      TEST_NOW,
    )
    expect(plan.decay).toEqual([])
  })

  test("e2e: a real recall (reinforce → updatedAt bump) between two same-now sweeps does not re-open the window", async () => {
    const store = new InMemoryStore([entry({ id: "arch" })])
    await sweep(store, TEST_NOW, 0)
    const afterFirst = await store.get("arch")
    expect(afterFirst?.importance).toBeCloseTo(0.25, 8)

    // Real reinforce path: recallContext bumps accessCount/lastAccessedAt/
    // importance(+0.02) via store.update, which stamps updatedAt.
    const block = await recallContext({ store, now: fixedNow }, "old archived knowledge")
    expect(block).not.toBeNull()
    const reinforced = await store.get("arch")
    expect(reinforced?.accessCount).toBe(1) // proves the reinforce actually ran
    expect(reinforced?.importance).toBeCloseTo(0.27, 8)
    expect(reinforced?.lastAccessedAt).toBe(TEST_NOW)
    // updatedAt is a REAL-clock adapter stamp (> the injected 2023 clock) — the
    // very reason it cannot double as the decay clock.
    expect(reinforced?.updatedAt ?? 0).toBeGreaterThan(TEST_NOW)
    expect(reinforced?.lastDecayedAt).toBe(TEST_NOW) // the update did not clobber it

    await sweep(store, TEST_NOW, 1)
    const e = await store.get("arch")
    expect(e?.importance).toBeCloseTo(0.27, 8) // NOT 0.135
  })
})

describe("H6 — sqlite adapter persists lastDecayedAt and heals a pre-migration db additively", () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "decay-freq-hellgate-"))
  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  test("put → get round-trips lastDecayedAt; absent stays absent (exactOptionalPropertyTypes)", async () => {
    const store = new SqliteStore(":memory:")
    try {
      await store.save(entry({ id: "with", lastDecayedAt: TEST_NOW - DAY }))
      await store.save(entry({ id: "without" }))
      expect((await store.get("with"))?.lastDecayedAt).toBe(TEST_NOW - DAY)
      expect("lastDecayedAt" in ((await store.get("without")) as object)).toBe(false)
      // update() carries the field through the merge path the sweep uses.
      await store.update("without", { importance: 0.25, lastDecayedAt: TEST_NOW })
      const upd = await store.get("without")
      expect(upd?.lastDecayedAt).toBe(TEST_NOW)
      expect(upd?.importance).toBe(0.25)
    } finally {
      store.close()
    }
  })

  test("pre-migration db (table created WITHOUT last_decayed_at) opens, gains the column, keeps legacy rows", async () => {
    const path = join(tmpRoot, "legacy.db")
    const raw = new Database(path)
    raw.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY, kind TEXT, tier TEXT, text TEXT, tags TEXT,
        importance REAL, created_at INTEGER, updated_at INTEGER, access_count INTEGER,
        last_accessed_at INTEGER, embedding BLOB, superseded_by TEXT, session_id TEXT,
        task_group TEXT, applies_to_cwd TEXT, reuse_rule TEXT
      )
    `)
    raw
      .query(
        "INSERT INTO memories (id, kind, tier, text, tags, importance, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("legacy", "fact", "semantic", "old archived knowledge", "[]", 0.5, TEST_NOW - 31 * DAY)
    const before = raw.query("PRAGMA table_info(memories)").all() as Array<{ name: string }>
    expect(before.map((c) => c.name)).not.toContain("last_decayed_at")
    raw.close()

    const store = new SqliteStore(path)
    try {
      const after = store.rawDbForTest().query("PRAGMA table_info(memories)").all() as Array<{
        name: string
      }>
      expect(after.map((c) => c.name)).toContain("last_decayed_at")
      const legacy = await store.get("legacy")
      expect(legacy?.importance).toBe(0.5)
      expect("lastDecayedAt" in (legacy as object)).toBe(false)
      // Legacy row ⇒ decays on its first sweep (as before)…
      expect(planEviction([legacy as MemoryEntry], undefined, TEST_NOW).decay).toEqual(["legacy"])
      // …and the stamp survives a close/reopen of the file db.
      await store.update("legacy", { importance: 0.25, lastDecayedAt: TEST_NOW })
    } finally {
      store.close()
    }
    const reopened = new SqliteStore(path)
    try {
      const e = await reopened.get("legacy")
      expect(e?.lastDecayedAt).toBe(TEST_NOW)
      expect(planEviction([e as MemoryEntry], undefined, TEST_NOW).decay).toEqual([])
    } finally {
      reopened.close()
    }
  })
})
