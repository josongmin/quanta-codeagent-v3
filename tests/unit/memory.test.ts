import { describe, expect, test } from "bun:test"
import { persistSession, recallContext, SESSION_TAG } from "@/agent/memory"
import type { LLMPort, Message, StreamEvent } from "@/llm"
import {
  EMBED_DIM,
  type EmbedderPort,
  InMemoryStore,
  type MemoryEntry,
  type PersistentStorePort,
} from "@/memory"

const assistant = (text: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
})
const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] })

/** Deterministic 1536-vec derived from a string hash (stable per text). */
const fakeVec = (text: string): number[] => {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = (h ^ text.charCodeAt(i)) * 16777619
  const out = new Array<number>(EMBED_DIM)
  for (let i = 0; i < EMBED_DIM; i++) {
    h = (h ^ (h << 13)) >>> 0
    out[i] = ((h % 2000) - 1000) / 1000
  }
  return out
}

/** FakeEmbedder: deterministic per-text vectors; optionally always throws. */
const fakeEmbedder = (opts?: { throws?: boolean }): EmbedderPort => ({
  embed: async (texts: string[]) => {
    if (opts?.throws) throw new Error("embed down")
    return texts.map(fakeVec)
  },
})

/** FakeLLM: streams `out` as one text_delta + message_stop, or throws. */
const fakeLLM = (out: string | { throw: true }): LLMPort => ({
  stream(): AsyncIterable<StreamEvent> {
    return {
      async *[Symbol.asyncIterator]() {
        if (typeof out !== "string") throw new Error("llm down")
        yield { type: "text_delta", delta: out }
        yield { type: "message_stop", stop_reason: "end_turn" }
      },
    }
  },
})

/** Wrap a store so update() always throws (reinforcement robustness test). */
const throwingUpdate = (inner: PersistentStorePort): PersistentStorePort => ({
  save: (e) => inner.save(e),
  update: () => Promise.reject(new Error("update boom")),
  delete: (id) => inner.delete(id),
  get: (id) => inner.get(id),
  all: () => inner.all(),
  recall: (q) => inner.recall(q),
})

describe("recallContext", () => {
  test("lexical-only recall, formatted block", async () => {
    const store = new InMemoryStore([
      { id: "a", kind: "fact", text: "uses Postgres 16", tags: [], createdAt: 1 },
    ])
    const out = await recallContext({ store }, "database")
    expect(out).toBe("## Relevant memory\n- (fact) uses Postgres 16")
  })

  test("with embedder embeds the query (still recalls)", async () => {
    const store = new InMemoryStore([
      { id: "a", kind: "fact", text: "uses Postgres 16", tags: [], createdAt: 1 },
    ])
    const out = await recallContext({ store, embedder: fakeEmbedder() }, "db engine")
    expect(out).toContain("- (fact) uses Postgres 16")
  })

  test("embedder throwing degrades to lexical (no throw)", async () => {
    const store = new InMemoryStore([{ id: "a", kind: "fact", text: "x", tags: [], createdAt: 1 }])
    const out = await recallContext({ store, embedder: fakeEmbedder({ throws: true }) }, "q")
    expect(out).toContain("- (fact) x")
  })

  test("empty primary (tiers filter) falls back to SESSION_TAG", async () => {
    const store = new InMemoryStore([
      {
        id: "s1",
        kind: "decision",
        tier: "episodic",
        text: "decided on Bun",
        tags: [SESSION_TAG],
        createdAt: 1,
      },
    ])
    // Primary restricted to semantic → empty; fallback (tags, no tier) finds it.
    const out = await recallContext({ store }, "anything", { tiers: ["semantic"] })
    expect(out).toBe("## Relevant memory\n- (decision) decided on Bun")
  })

  test("empty store → null", async () => {
    const out = await recallContext({ store: new InMemoryStore() }, "q")
    expect(out).toBeNull()
  })

  test("reinforcement bumps accessCount and importance", async () => {
    const store = new InMemoryStore([
      { id: "a", kind: "fact", text: "t", tags: [], createdAt: 1, importance: 0.5, accessCount: 2 },
    ])
    await recallContext({ store }, "t")
    const e = await store.get("a")
    expect(e?.accessCount).toBe(3)
    expect(e?.importance).toBeCloseTo(0.52, 5)
    expect(typeof e?.lastAccessedAt).toBe("number")
  })

  test("reinforcement failure does not break recall", async () => {
    const inner = new InMemoryStore([{ id: "a", kind: "fact", text: "t", tags: [], createdAt: 1 }])
    const out = await recallContext({ store: throwingUpdate(inner) }, "t")
    expect(out).toContain("- (fact) t")
  })

  test("text truncated to 600 chars + ellipsis", async () => {
    const long = "x".repeat(700)
    const store = new InMemoryStore([{ id: "a", kind: "fact", text: long, tags: [], createdAt: 1 }])
    const out = await recallContext({ store }, "x")
    expect(out).toBe(`## Relevant memory\n- (fact) ${"x".repeat(600)}…`)
  })
})

describe("persistSession", () => {
  test("heuristic path (no llm) persists final assistant text", async () => {
    const store = new InMemoryStore()
    await persistSession(
      { store },
      { sessionId: "s1", finalMessages: [user("hi"), assistant("Final decision: ship it.")] },
    )
    const all = await store.all()
    expect(all).toHaveLength(1)
    expect(all[0]?.text).toBe("Final decision: ship it.")
    expect(all[0]?.tags).toContain(SESSION_TAG)
  })

  test("no assistant text → no-op", async () => {
    const store = new InMemoryStore()
    await persistSession({ store }, { sessionId: "s1", finalMessages: [user("hi")] })
    expect((await store.all()).length).toBe(0)
  })

  test("distill path (FakeLLM JSON array) inserts records", async () => {
    const store = new InMemoryStore()
    const json = JSON.stringify([
      {
        kind: "fact",
        tier: "semantic",
        text: "uses Bun runtime",
        tags: ["stack"],
        importance: 0.9,
      },
    ])
    await persistSession(
      { store, llm: fakeLLM(json) },
      { sessionId: "s2", finalMessages: [user("q"), assistant("done")] },
    )
    const all = await store.all()
    expect(all).toHaveLength(1)
    expect(all[0]?.text).toBe("uses Bun runtime")
    expect(all[0]?.kind).toBe("fact")
  })

  test("re-running a session updates rather than duplicates (deterministic id)", async () => {
    const store = new InMemoryStore()
    const input = { sessionId: "s3", finalMessages: [user("q"), assistant("stable summary")] }
    await persistSession({ store }, input)
    await persistSession({ store }, input)
    // Second run: exact-text dupe → heuristic skip. Still one entry.
    expect((await store.all()).length).toBe(1)
  })

  test("heuristic skip on exact-text dupe", async () => {
    const store = new InMemoryStore([
      { id: "old", kind: "decision", text: "ship it", tags: [SESSION_TAG], createdAt: 1 },
    ])
    await persistSession({ store }, { sessionId: "s4", finalMessages: [assistant("ship it")] })
    expect((await store.all()).length).toBe(1)
  })

  test("LLM merge op updates target, does not save candidate", async () => {
    const store = new InMemoryStore([
      {
        id: "old",
        kind: "fact",
        text: "alpha beta gamma delta",
        tags: [],
        createdAt: Date.now(),
      },
    ])
    const op = JSON.stringify({
      action: "merge",
      intoId: "old",
      text: "alpha beta gamma delta merged",
      tags: ["db"],
      importance: 0.8,
    })
    await persistSession(
      { store, llm: fakeLLM(op), distill: false },
      { sessionId: "s5", finalMessages: [assistant("alpha beta gamma delta epsilon")] },
    )
    const all = await store.all()
    expect(all).toHaveLength(1)
    expect(all[0]?.text).toBe("alpha beta gamma delta merged")
    expect(all[0]?.importance).toBeCloseTo(0.8, 5)
  })

  test("LLM supersede op saves candidate and marks old superseded", async () => {
    const store = new InMemoryStore([
      { id: "old", kind: "fact", text: "one two three four five", tags: [], createdAt: Date.now() },
    ])
    const op = JSON.stringify({ action: "supersede", oldId: "old" })
    await persistSession(
      { store, llm: fakeLLM(op), distill: false },
      { sessionId: "s6", finalMessages: [assistant("one two three four six")] },
    )
    const all = await store.all()
    expect(all).toHaveLength(2)
    const old = all.find((e) => e.id === "old")
    expect(old?.supersededBy).toBeDefined()
  })

  test("LLM skip op persists nothing", async () => {
    const store = new InMemoryStore([
      { id: "old", kind: "fact", text: "uses postgres database thing", tags: [], createdAt: 1 },
    ])
    await persistSession(
      { store, llm: fakeLLM('{"action":"skip"}'), distill: false },
      { sessionId: "s7", finalMessages: [assistant("uses postgres database stuff")] },
    )
    expect((await store.all()).length).toBe(1)
  })

  test("eviction deletes cap-overflow entries", async () => {
    const seed: MemoryEntry[] = []
    for (let i = 0; i < 6; i++) {
      seed.push({
        id: `e${i}`,
        kind: "fact",
        tier: "episodic",
        text: `entry ${i}`,
        tags: [],
        createdAt: 1000 + i,
        importance: 0.1,
      })
    }
    const store = new InMemoryStore(seed)
    await persistSession(
      { store, evictionCaps: { episodicMax: 2 } },
      { sessionId: "s8", finalMessages: [assistant("a fresh distinct summary line")] },
    )
    const all = await store.all()
    const episodic = all.filter((e) => e.tier === "episodic")
    expect(episodic.length).toBeLessThanOrEqual(2)
  })

  test("eviction decays archived low-value survivors", async () => {
    const old = Date.now() - 40 * 24 * 60 * 60 * 1000 // 40d → archived
    const store = new InMemoryStore([
      {
        id: "arch",
        kind: "fact",
        tier: "semantic",
        text: "old archived knowledge",
        tags: [],
        createdAt: old,
        importance: 0.8,
      },
    ])
    await persistSession(
      { store },
      { sessionId: "s9", finalMessages: [assistant("an unrelated brand new summary")] },
    )
    const e = await store.get("arch")
    expect(e?.importance).toBeCloseTo(0.4, 5) // 0.8 * EVICTION_DECAY(0.5)
  })

  test("never throws when distill/store blow up", async () => {
    const boomStore: PersistentStorePort = {
      save: () => Promise.reject(new Error("save boom")),
      update: () => Promise.reject(new Error("update boom")),
      delete: () => Promise.reject(new Error("delete boom")),
      get: () => Promise.reject(new Error("get boom")),
      all: () => Promise.reject(new Error("all boom")),
      recall: () => Promise.reject(new Error("recall boom")),
    }
    await expect(
      persistSession(
        { store: boomStore, llm: fakeLLM({ throw: true }) },
        { sessionId: "s10", finalMessages: [assistant("text")] },
      ),
    ).resolves.toBeUndefined()
  })
})
