import { describe, expect, test } from "bun:test"
import {
  bucketOf,
  createWorkingMemory,
  FRESH_MAX_MS,
  InMemoryStore,
  type MemoryEntry,
  RECENT_MAX_MS,
  STALE_MAX_MS,
} from "@/memory"

const NOW = 1_700_000_000_000

const entry = (over: Partial<MemoryEntry> & Pick<MemoryEntry, "id">): MemoryEntry => ({
  kind: "fact",
  text: "default text",
  tags: [],
  createdAt: NOW,
  ...over,
})

describe("WorkingMemory", () => {
  test("append + snapshot returns buffered messages", () => {
    const wm = createWorkingMemory<{ role: string; content: unknown }>()
    wm.append({ role: "user", content: "hi" })
    wm.append({ role: "assistant", content: "yo" })
    expect(wm.snapshot()).toHaveLength(2)
    expect(wm.snapshot()[0]).toEqual({ role: "user", content: "hi" })
  })

  test("snapshot is an immutable copy (mutating it does not affect buffer)", () => {
    const wm = createWorkingMemory<{ role: string; content: unknown }>()
    wm.append({ role: "user", content: "a" })
    const snap = wm.snapshot() as { role: string; content: unknown }[]
    snap.push({ role: "user", content: "injected" })
    expect(wm.snapshot()).toHaveLength(1)
  })

  test("seeded constructor copies the initial array", () => {
    const seed = [{ role: "user", content: "seed" }]
    const wm = createWorkingMemory(seed)
    seed.push({ role: "user", content: "mutated" })
    expect(wm.snapshot()).toHaveLength(1)
  })

  test("clear empties the buffer", () => {
    const wm = createWorkingMemory<{ role: string; content: unknown }>()
    wm.append({ role: "user", content: "x" })
    wm.clear()
    expect(wm.snapshot()).toHaveLength(0)
    expect(wm.tokenEstimate()).toBe(0)
  })

  test("replace swaps the buffer with a defensive copy", () => {
    const wm = createWorkingMemory<{ role: string; content: unknown }>()
    wm.append({ role: "user", content: "old" })
    const next = [{ role: "assistant", content: "new" }]
    wm.replace(next)
    next.push({ role: "user", content: "leak" })
    expect(wm.snapshot()).toEqual([{ role: "assistant", content: "new" }])
  })

  test("tokenEstimate is chars/4 of serialized messages, rounded up", () => {
    const wm = createWorkingMemory<{ role: string; content: unknown }>()
    expect(wm.tokenEstimate()).toBe(0)
    const msg = { role: "user", content: "hello" }
    wm.append(msg)
    const expected = Math.ceil(JSON.stringify(msg).length / 4)
    expect(wm.tokenEstimate()).toBe(expected)
    expect(wm.tokenEstimate()).toBeGreaterThan(0)
  })
})

describe("bucketOf thresholds", () => {
  test("zero and negative ages are fresh", () => {
    expect(bucketOf(0)).toBe("fresh")
    expect(bucketOf(-5_000)).toBe("fresh")
    expect(bucketOf(Number.NaN)).toBe("fresh")
    expect(bucketOf(Number.POSITIVE_INFINITY)).toBe("archived")
  })

  test("fresh boundary is inclusive", () => {
    expect(bucketOf(FRESH_MAX_MS)).toBe("fresh")
    expect(bucketOf(FRESH_MAX_MS + 1)).toBe("recent")
  })

  test("recent boundary is inclusive", () => {
    expect(bucketOf(RECENT_MAX_MS)).toBe("recent")
    expect(bucketOf(RECENT_MAX_MS + 1)).toBe("stale")
  })

  test("stale boundary is inclusive; beyond is archived", () => {
    expect(bucketOf(STALE_MAX_MS)).toBe("stale")
    expect(bucketOf(STALE_MAX_MS + 1)).toBe("archived")
  })
})

describe("InMemoryStore", () => {
  test("save then recall round-trips and isolates against mutation", async () => {
    const store = new InMemoryStore()
    const tags = ["alpha"]
    await store.save(entry({ id: "1", text: "the quick brown fox", tags }))
    tags.push("mutated-after-save")
    const got = await store.recall({})
    expect(got).toHaveLength(1)
    expect(got[0]?.tags).toEqual(["alpha"])
    // returned copy is isolated too
    got[0]?.tags.push("x")
    expect((await store.recall({}))[0]?.tags).toEqual(["alpha"])
  })

  test("save with empty id rejects", async () => {
    const store = new InMemoryStore()
    await expect(store.save(entry({ id: "" }))).rejects.toThrow("id is required")
  })

  test("save upserts by id", async () => {
    const store = new InMemoryStore()
    await store.save(entry({ id: "1", text: "v1" }))
    await store.save(entry({ id: "1", text: "v2" }))
    const got = await store.recall({})
    expect(got).toHaveLength(1)
    expect(got[0]?.text).toBe("v2")
    expect(store.size).toBe(1)
  })

  test("seed constructor + size", () => {
    const store = new InMemoryStore([entry({ id: "a" }), entry({ id: "b" })])
    expect(store.size).toBe(2)
  })

  test("empty query returns all, ranked by freshness then createdAt/id desc", async () => {
    const store = new InMemoryStore([
      entry({ id: "old", createdAt: NOW - STALE_MAX_MS - 1 }), // archived
      entry({ id: "mid", createdAt: NOW - RECENT_MAX_MS - 1 }), // stale
      entry({ id: "new1", createdAt: NOW }), // fresh
      entry({ id: "new2", createdAt: NOW }), // fresh, tie
    ])
    const got = await store.recall({})
    // fresh first; tie between new1/new2 (same createdAt) broken by id desc
    expect(got.map((e) => e.id)).toEqual(["new2", "new1", "mid", "old"])
  })

  test("tag filter requires overlap; ranking rewards more overlap", async () => {
    const store = new InMemoryStore([
      entry({ id: "none", tags: ["zzz"] }),
      entry({ id: "one", tags: ["alpha"] }),
      entry({ id: "two", tags: ["Alpha", "beta"] }), // case-insensitive
    ])
    const got = await store.recall({ tags: ["alpha", "beta"] })
    expect(got.map((e) => e.id)).toEqual(["two", "one"])
  })

  test("text substring filter is case-insensitive; exact match ranks higher", async () => {
    const store = new InMemoryStore([
      entry({ id: "miss", text: "nothing relevant" }),
      entry({ id: "sub", text: "contains NEEDLE inside" }),
      entry({ id: "exact", text: "needle" }),
    ])
    const got = await store.recall({ text: "needle" })
    expect(got.map((e) => e.id)).toEqual(["exact", "sub"])
  })

  test("kind filter restricts results", async () => {
    const store = new InMemoryStore([
      entry({ id: "f", kind: "fact" }),
      entry({ id: "d", kind: "decision" }),
      entry({ id: "o", kind: "observation" }),
    ])
    const got = await store.recall({ kinds: ["decision", "observation"] })
    expect(got.map((e) => e.id).sort()).toEqual(["d", "o"])
  })

  test("freshness filter restricts by recency bucket", async () => {
    // recall() ranks against real Date.now(); use real-time-relative ages.
    const realNow = Date.now()
    const store = new InMemoryStore([
      entry({ id: "fresh", createdAt: realNow }),
      entry({ id: "stale", createdAt: realNow - RECENT_MAX_MS - 1 }),
    ])
    const got = await store.recall({ freshness: ["fresh"] })
    expect(got.map((e) => e.id)).toEqual(["fresh"])
  })

  test("limit caps results; default is 20", async () => {
    const many = Array.from({ length: 25 }, (_v, i) =>
      entry({ id: `e${String(i).padStart(2, "0")}`, createdAt: NOW + i }),
    )
    const store = new InMemoryStore(many)
    expect(await store.recall({})).toHaveLength(20)
    expect(await store.recall({ limit: 3 })).toHaveLength(3)
    expect(await store.recall({ limit: 0 })).toHaveLength(0)
    expect(await store.recall({ limit: -1 })).toHaveLength(0)
  })

  test("no-match query returns empty", async () => {
    const store = new InMemoryStore([entry({ id: "1", text: "abc", tags: ["x"] })])
    expect(await store.recall({ text: "zzzzz" })).toEqual([])
    expect(await store.recall({ tags: ["nope"] })).toEqual([])
    expect(await store.recall({ kinds: ["decision"] })).toEqual([])
  })

  test("empty store returns empty", async () => {
    expect(await new InMemoryStore().recall({})).toEqual([])
  })
})
