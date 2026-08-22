import { describe, expect, test } from "bun:test"
import { memoryTools } from "@/agent/memory-tools"
import { InMemoryStore } from "@/memory"
import type { Tool, ToolContext, ToolEvent } from "@/tool"

// ADR-0432 — line-level citations + per-thread memory mode + write-guard.
// Hellgate battery: adversarial proof that each axis is correct AND that the
// absent-config path stays byte-identical to the legacy memory-tools surface.

const ctx: ToolContext = { cwd: "/tmp", signal: new AbortController().signal }

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

const seeded = () =>
  new InMemoryStore([
    {
      id: "m1",
      kind: "fact",
      text: "line one\nline two\nline three",
      tags: [],
      createdAt: 1,
      importance: 0.7,
    },
  ])

describe("ADR-0432 line-level citations", () => {
  test("memory_search appends REAL matched sub-span when lineCitations on", async () => {
    const tools = memoryTools({ store: seeded(), lineCitations: true })
    const ev = await run(byName(tools, "memory_search"), { query: "line" })
    expect(ev.type).toBe("result")
    if (ev.type === "result") {
      expect(ev.result.ok).toBe(true)
      expect(ev.result.output).toContain("#m1")
      // jul-03 B3: "line" first matches on line 1 ⇒ [L1-1] (REAL sub-span),
      // NOT the degenerate whole-record L1-3.
      expect(ev.result.output).toContain("[L1-1]")
      expect(ev.result.output).not.toContain("[L1-3]")
    }
  })

  test("single-line record cites L1-1", async () => {
    const store = new InMemoryStore([
      { id: "s", kind: "fact", text: "just one line", tags: [], createdAt: 1, importance: 0.7 },
    ])
    const tools = memoryTools({ store, lineCitations: true })
    const ev = await run(byName(tools, "memory_search"), { query: "line" })
    if (ev.type === "result") expect(ev.result.output).toContain("L1-1")
  })

  test("lineCitations OFF ⇒ byte-identical legacy output (no span)", async () => {
    const a = memoryTools({ store: seeded() })
    const evA = await run(byName(a, "memory_search"), { query: "line" })
    const b = memoryTools({ store: seeded(), lineCitations: false })
    const evB = await run(byName(b, "memory_search"), { query: "line" })
    expect(evA).toEqual(evB)
    if (evA.type === "result") {
      expect(evA.result.output).not.toContain("L1-")
    }
  })
})

describe("ADR-0432 per-thread memory mode", () => {
  test("disabled ⇒ recall is a no-op (no store read)", async () => {
    const tools = memoryTools({ store: seeded(), threadMode: "disabled" })
    const ev = await run(byName(tools, "memory_search"), { query: "line" })
    expect(ev.type).toBe("result")
    if (ev.type === "result") {
      expect(ev.result.ok).toBe(true)
      expect(ev.result.output).not.toContain("#m1")
    }
  })

  test("disabled ⇒ write is a no-op blocked typed", async () => {
    const store = new InMemoryStore()
    const tools = memoryTools({ store, threadMode: "disabled" })
    const ev = await run(byName(tools, "memory_write"), { text: "x" })
    expect(ev.type).toBe("result")
    if (ev.type === "result") expect(ev.result.ok).toBe(false)
    expect(await store.all()).toHaveLength(0)
  })

  test("disabled ⇒ update is a no-op blocked typed", async () => {
    const store = seeded()
    const tools = memoryTools({ store, threadMode: "disabled" })
    const ev = await run(byName(tools, "memory_update"), { id: "m1", delete: true })
    expect(ev.type).toBe("result")
    if (ev.type === "result") expect(ev.result.ok).toBe(false)
    expect(await store.get("m1")).toBeDefined()
  })

  test("read-only ⇒ recall yes, write blocked typed", async () => {
    const store = seeded()
    const tools = memoryTools({ store, threadMode: "read-only" })
    const search = await run(byName(tools, "memory_search"), { query: "line" })
    if (search.type === "result") {
      expect(search.result.ok).toBe(true)
      expect(search.result.output).toContain("#m1")
    }
    const write = await run(byName(tools, "memory_write"), { text: "x" })
    if (write.type === "result") expect(write.result.ok).toBe(false)
    const update = await run(byName(tools, "memory_update"), { id: "m1", importance: 0.1 })
    if (update.type === "result") expect(update.result.ok).toBe(false)
    // store unmutated
    expect(await store.all()).toHaveLength(1)
    expect((await store.get("m1"))?.importance).toBeCloseTo(0.7, 5)
  })

  test("enabled (explicit) ⇒ identical to default", async () => {
    const a = memoryTools({ store: seeded(), threadMode: "enabled" })
    const evA = await run(byName(a, "memory_search"), { query: "line" })
    const b = memoryTools({ store: seeded() })
    const evB = await run(byName(b, "memory_search"), { query: "line" })
    expect(evA).toEqual(evB)
  })

  test("absent mode ⇒ write succeeds (byte-identical default)", async () => {
    const store = new InMemoryStore()
    const tools = memoryTools({ store })
    const ev = await run(byName(tools, "memory_write"), { text: "x" })
    if (ev.type === "result") expect(ev.result.ok).toBe(true)
    expect(await store.all()).toHaveLength(1)
  })
})

describe("ADR-0432 write-guard (budget remaining %)", () => {
  test("blocks write when remaining < min_remaining_percent", async () => {
    const store = new InMemoryStore()
    const tools = memoryTools({
      store,
      writeGuard: { minRemainingPercent: 20, remainingPercent: () => 10 },
    })
    const ev = await run(byName(tools, "memory_write"), { text: "x" })
    expect(ev.type).toBe("result")
    if (ev.type === "result") expect(ev.result.ok).toBe(false)
    expect(await store.all()).toHaveLength(0)
  })

  test("allows write when remaining >= min_remaining_percent", async () => {
    const store = new InMemoryStore()
    const tools = memoryTools({
      store,
      writeGuard: { minRemainingPercent: 20, remainingPercent: () => 50 },
    })
    const ev = await run(byName(tools, "memory_write"), { text: "x" })
    if (ev.type === "result") expect(ev.result.ok).toBe(true)
    expect(await store.all()).toHaveLength(1)
  })

  test("guard also gates update", async () => {
    const store = seeded()
    const tools = memoryTools({
      store,
      writeGuard: { minRemainingPercent: 20, remainingPercent: () => 5 },
    })
    const ev = await run(byName(tools, "memory_update"), { id: "m1", importance: 0.1 })
    if (ev.type === "result") expect(ev.result.ok).toBe(false)
    expect((await store.get("m1"))?.importance).toBeCloseTo(0.7, 5)
  })

  test("guard does NOT gate search (read path)", async () => {
    const tools = memoryTools({
      store: seeded(),
      writeGuard: { minRemainingPercent: 99, remainingPercent: () => 1 },
    })
    const ev = await run(byName(tools, "memory_search"), { query: "line" })
    if (ev.type === "result") {
      expect(ev.result.ok).toBe(true)
      expect(ev.result.output).toContain("#m1")
    }
  })

  test("absent guard ⇒ write always allowed (default-OFF byte-identical)", async () => {
    const store = new InMemoryStore()
    const tools = memoryTools({ store })
    const ev = await run(byName(tools, "memory_write"), { text: "x" })
    if (ev.type === "result") expect(ev.result.ok).toBe(true)
    expect(await store.all()).toHaveLength(1)
  })
})
