import { describe, expect, test } from "bun:test"
import { memoryTools } from "@/agent/memory-tools"
import { EMBED_DIM, type EmbedderPort, InMemoryStore, type MemoryEntry } from "@/memory"
import type { Tool, ToolContext, ToolEvent } from "@/tool"

const ctx: ToolContext = { cwd: "/tmp", signal: new AbortController().signal }

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

const fakeEmbedder = (): EmbedderPort => ({
  embed: async (texts: string[]) => texts.map(fakeVec),
})

/** Drive a tool's execute() to completion; return the single result. */
const run = async (tool: Tool, input: unknown): Promise<ToolEvent> => {
  let last: ToolEvent | undefined
  for await (const ev of tool.execute(input, ctx)) last = ev
  if (!last) throw new Error("tool yielded no events")
  return last
}

const byName = (tools: Tool[], name: string): Tool => {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`no tool ${name}`)
  return t
}

describe("memoryTools", () => {
  test("returns exactly three tools with correct flags", () => {
    const tools = memoryTools({ store: new InMemoryStore() })
    expect(tools.map((t) => t.name).sort()).toEqual([
      "memory_search",
      "memory_update",
      "memory_write",
    ])
    const search = byName(tools, "memory_search")
    expect(search.isReadOnly()).toBe(true)
    expect(search.isConcurrencySafe({})).toBe(true)
    const write = byName(tools, "memory_write")
    expect(write.isReadOnly()).toBe(false)
    expect(write.isConcurrencySafe({})).toBe(false)
    const update = byName(tools, "memory_update")
    expect(update.isReadOnly()).toBe(false)
    expect(update.isConcurrencySafe({})).toBe(false)
  })

  test("memory_search returns numbered list", async () => {
    const store = new InMemoryStore([
      { id: "m1", kind: "fact", text: "uses Bun", tags: [], createdAt: 1, importance: 0.7 },
    ])
    const tools = memoryTools({ store, embedder: fakeEmbedder() })
    const ev = await run(byName(tools, "memory_search"), { query: "runtime" })
    expect(ev).toEqual({
      type: "result",
      result: { ok: true, output: "#m1 (fact, 0.70) uses Bun" },
    })
  })

  test("memory_search tier filter restricts results", async () => {
    const store = new InMemoryStore([
      {
        id: "sem",
        kind: "fact",
        tier: "semantic",
        text: "durable knowledge",
        tags: [],
        createdAt: 1,
      },
      { id: "epi", kind: "fact", tier: "episodic", text: "session recap", tags: [], createdAt: 1 },
    ])
    const tools = memoryTools({ store })
    const ev = await run(byName(tools, "memory_search"), { query: "x", tier: "episodic" })
    expect(ev.type).toBe("result")
    if (ev.type === "result") {
      expect(ev.result.ok).toBe(true)
      expect(ev.result.output).toContain("#epi")
      expect(ev.result.output).not.toContain("#sem")
    }
  })

  test("memory_search kind filter restricts results", async () => {
    const store = new InMemoryStore([
      { id: "f1", kind: "fact", text: "a fact", tags: [], createdAt: 1 },
      { id: "d1", kind: "decision", text: "a decision", tags: [], createdAt: 1 },
    ])
    const tools = memoryTools({ store })
    const ev = await run(byName(tools, "memory_search"), { query: "a", kind: "decision" })
    expect(ev.type).toBe("result")
    if (ev.type === "result") {
      expect(ev.result.output).toContain("#d1")
      expect(ev.result.output).not.toContain("#f1")
    }
  })

  test("memory_search minImportance drops low-value entries", async () => {
    const store = new InMemoryStore([
      { id: "lo", kind: "fact", text: "weak", tags: [], createdAt: 1, importance: 0.2 },
      { id: "hi", kind: "fact", text: "strong", tags: [], createdAt: 1, importance: 0.9 },
    ])
    const tools = memoryTools({ store })
    const ev = await run(byName(tools, "memory_search"), { query: "x", minImportance: 0.5 })
    expect(ev.type).toBe("result")
    if (ev.type === "result") {
      expect(ev.result.output).toContain("#hi")
      expect(ev.result.output).not.toContain("#lo")
    }
  })

  test("memory_search without new filters preserves current behavior", async () => {
    const store = new InMemoryStore([
      {
        id: "sem",
        kind: "fact",
        tier: "semantic",
        text: "x1",
        tags: [],
        createdAt: 1,
        importance: 0.2,
      },
      {
        id: "epi",
        kind: "decision",
        tier: "episodic",
        text: "x2",
        tags: [],
        createdAt: 1,
        importance: 0.1,
      },
    ])
    const tools = memoryTools({ store })
    const ev = await run(byName(tools, "memory_search"), { query: "x" })
    expect(ev.type).toBe("result")
    if (ev.type === "result") {
      expect(ev.result.output).toContain("#sem")
      expect(ev.result.output).toContain("#epi")
    }
  })

  test("memory_search no matches", async () => {
    const tools = memoryTools({ store: new InMemoryStore() })
    const ev = await run(byName(tools, "memory_search"), { query: "x" })
    expect(ev.type).toBe("result")
    if (ev.type === "result") {
      expect(ev.result.ok).toBe(true)
      expect(ev.result.output).toBe("No matching memories.")
    }
  })

  test("memory_write saves an entry (with embedding)", async () => {
    const store = new InMemoryStore()
    const tools = memoryTools({ store, embedder: fakeEmbedder() })
    const ev = await run(byName(tools, "memory_write"), {
      text: "prefer tabs",
      kind: "preference",
      tags: ["style"],
      importance: 0.9,
    })
    expect(ev.type).toBe("result")
    if (ev.type === "result") {
      expect(ev.result.ok).toBe(true)
      expect(ev.result.output).toMatch(/^Saved memory mem:tool:/)
    }
    const all = await store.all()
    expect(all).toHaveLength(1)
    expect(all[0]?.kind).toBe("preference")
    expect(all[0]?.tier).toBe("semantic")
    expect(all[0]?.importance).toBeCloseTo(0.9, 5)
    expect(all[0]?.embedding?.length).toBe(EMBED_DIM)
  })

  test("memory_write defaults kind/importance", async () => {
    const store = new InMemoryStore()
    const tools = memoryTools({ store })
    await run(byName(tools, "memory_write"), { text: "a note" })
    const all = await store.all()
    expect(all[0]?.kind).toBe("observation")
    expect(all[0]?.importance).toBeCloseTo(0.6, 5)
  })

  test("memory_update unknown id → ok:false", async () => {
    const tools = memoryTools({ store: new InMemoryStore() })
    const ev = await run(byName(tools, "memory_update"), { id: "nope" })
    expect(ev.type).toBe("result")
    if (ev.type === "result") {
      expect(ev.result.ok).toBe(false)
      expect(ev.result.output).toContain("Unknown memory id")
    }
  })

  test("memory_update delete removes the entry", async () => {
    const store = new InMemoryStore([{ id: "m1", kind: "fact", text: "x", tags: [], createdAt: 1 }])
    const tools = memoryTools({ store })
    const ev = await run(byName(tools, "memory_update"), { id: "m1", delete: true })
    expect(ev.type).toBe("result")
    if (ev.type === "result") {
      expect(ev.result.ok).toBe(true)
      expect(ev.result.output).toBe("Deleted m1.")
    }
    expect(await store.get("m1")).toBeUndefined()
  })

  test("memory_update re-embeds on text change", async () => {
    const seed: MemoryEntry = { id: "m1", kind: "fact", text: "old", tags: [], createdAt: 1 }
    const store = new InMemoryStore([seed])
    const tools = memoryTools({ store, embedder: fakeEmbedder() })
    const ev = await run(byName(tools, "memory_update"), { id: "m1", text: "brand new text" })
    expect(ev.type).toBe("result")
    if (ev.type === "result") expect(ev.result.ok).toBe(true)
    const e = await store.get("m1")
    expect(e?.text).toBe("brand new text")
    expect(e?.embedding).toEqual(fakeVec("brand new text"))
  })

  test("memory_update patches tags/importance only", async () => {
    const store = new InMemoryStore([
      { id: "m1", kind: "fact", text: "keep", tags: ["a"], createdAt: 1, importance: 0.2 },
    ])
    const tools = memoryTools({ store })
    await run(byName(tools, "memory_update"), { id: "m1", tags: ["b"], importance: 0.95 })
    const e = await store.get("m1")
    expect(e?.text).toBe("keep")
    expect(e?.tags).toEqual(["b"])
    expect(e?.importance).toBeCloseTo(0.95, 5)
  })

  test("inputSchema rejects bad input via safeParse", () => {
    const tools = memoryTools({ store: new InMemoryStore() })
    const search = byName(tools, "memory_search")
    expect(search.inputSchema.safeParse({}).success).toBe(false)
    expect(search.inputSchema.safeParse({ query: "q", limit: 99 }).success).toBe(false)
    expect(search.inputSchema.safeParse({ query: "q" }).success).toBe(true)
    expect(search.inputSchema.safeParse({ query: "q", tier: "bogus" }).success).toBe(false)
    expect(search.inputSchema.safeParse({ query: "q", kind: "bogus" }).success).toBe(false)
    expect(search.inputSchema.safeParse({ query: "q", minImportance: 2 }).success).toBe(false)
    expect(
      search.inputSchema.safeParse({
        query: "q",
        tier: "semantic",
        kind: "fact",
        minImportance: 0.5,
      }).success,
    ).toBe(true)

    const write = byName(tools, "memory_write")
    expect(write.inputSchema.safeParse({ text: "" }).success).toBe(false)
    expect(write.inputSchema.safeParse({ text: "ok", kind: "bogus" }).success).toBe(false)
    expect(write.inputSchema.safeParse({ text: "ok", importance: 2 }).success).toBe(false)
    expect(write.inputSchema.safeParse({ text: "ok" }).success).toBe(true)

    const update = byName(tools, "memory_update")
    expect(update.inputSchema.safeParse({}).success).toBe(false)
    expect(update.inputSchema.safeParse({ id: "x", importance: -1 }).success).toBe(false)
    expect(update.inputSchema.safeParse({ id: "x" }).success).toBe(true)
  })

  test("execute never throws even when the store blows up", async () => {
    const boom = {
      save: () => Promise.reject(new Error("boom")),
      update: () => Promise.reject(new Error("boom")),
      delete: () => Promise.reject(new Error("boom")),
      get: () => Promise.reject(new Error("boom")),
      all: () => Promise.reject(new Error("boom")),
      recall: () => Promise.reject(new Error("boom")),
    }
    const tools = memoryTools({ store: boom })
    const ev = await run(byName(tools, "memory_write"), { text: "t" })
    expect(ev.type).toBe("result")
    if (ev.type === "result") expect(ev.result.ok).toBe(false)
  })
})
