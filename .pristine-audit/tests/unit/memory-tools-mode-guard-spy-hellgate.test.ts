import { describe, expect, test } from "bun:test"
import { lineSpanOf, memoryTools } from "@/agent/memory-tools"
import type { MemoryEntry, MemoryQuery, PersistentStorePort } from "@/memory"
import type { Tool, ToolContext, ToolEvent } from "@/tool"

// ADR-0432 — HARDER hellgate battery (beyond the existing 14). Uses a SPY
// store that records every call so we can assert ZERO store I/O on the
// disabled path, and pins the write-guard boundary (inclusive/exclusive on
// BOTH sides) + the `lineSpanOf` invariants (multi/single/empty). Deterministic
// (no clock / no network / no embedder).

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

interface SpyCalls {
  save: number
  update: number
  delete: number
  get: number
  all: number
  recall: number
}

/** Fully-instrumented spy store. `seed` is queryable so read-path tests stay
 *  meaningful; every method bumps a counter so a test can assert "store
 *  untouched" with `calls === { all zero }`. */
class SpyStore implements PersistentStorePort {
  readonly calls: SpyCalls = { save: 0, update: 0, delete: 0, get: 0, all: 0, recall: 0 }
  private readonly map = new Map<string, MemoryEntry>()
  constructor(seed: readonly MemoryEntry[] = []) {
    for (const e of seed) this.map.set(e.id, e)
  }
  save(entry: MemoryEntry): Promise<void> {
    this.calls.save++
    this.map.set(entry.id, entry)
    return Promise.resolve()
  }
  update(id: string, patch: Partial<MemoryEntry>): Promise<void> {
    this.calls.update++
    const cur = this.map.get(id)
    if (cur) this.map.set(id, { ...cur, ...patch })
    return Promise.resolve()
  }
  delete(id: string): Promise<void> {
    this.calls.delete++
    this.map.delete(id)
    return Promise.resolve()
  }
  get(id: string): Promise<MemoryEntry | undefined> {
    this.calls.get++
    return Promise.resolve(this.map.get(id))
  }
  all(): Promise<MemoryEntry[]> {
    this.calls.all++
    return Promise.resolve([...this.map.values()])
  }
  recall(_query: MemoryQuery): Promise<MemoryEntry[]> {
    this.calls.recall++
    return Promise.resolve([...this.map.values()])
  }
  get totalCalls(): number {
    return Object.values(this.calls).reduce((a, b) => a + b, 0)
  }
}

const entry = (id: string, text: string): MemoryEntry => ({
  id,
  kind: "fact",
  tier: "semantic",
  text,
  tags: [],
  createdAt: 1,
  importance: 0.7,
})

describe("ADR-0432 disabled mode ⇒ ZERO store I/O (spy)", () => {
  test("recall short-circuits BEFORE store.recall", async () => {
    const store = new SpyStore([entry("m1", "a")])
    const tools = memoryTools({ store, threadMode: "disabled" })
    const ev = await run(byName(tools, "memory_search"), { query: "a" })
    expect(ev.type).toBe("result")
    if (ev.type === "result") expect(ev.result.ok).toBe(true)
    // The proof: store.recall was NEVER called (and no other method either).
    expect(store.calls.recall).toBe(0)
    expect(store.totalCalls).toBe(0)
  })

  test("write is typed ok:false and never touches the store", async () => {
    const store = new SpyStore()
    const tools = memoryTools({ store, threadMode: "disabled" })
    const ev = await run(byName(tools, "memory_write"), { text: "x" })
    expect(ev.type).toBe("result")
    if (ev.type === "result") expect(ev.result.ok).toBe(false)
    expect(store.calls.save).toBe(0)
    expect(store.totalCalls).toBe(0)
  })

  test("update is typed ok:false and never reads/writes the store", async () => {
    const store = new SpyStore([entry("m1", "a")])
    const tools = memoryTools({ store, threadMode: "disabled" })
    const ev = await run(byName(tools, "memory_update"), { id: "m1", delete: true })
    expect(ev.type).toBe("result")
    if (ev.type === "result") expect(ev.result.ok).toBe(false)
    // disabled blocks BEFORE the existence-check `store.get`.
    expect(store.calls.get).toBe(0)
    expect(store.calls.delete).toBe(0)
    expect(store.totalCalls).toBe(0)
  })
})

describe("ADR-0432 read-only mode (spy)", () => {
  test("recall DOES hit the store; write is blocked before save", async () => {
    const store = new SpyStore([entry("m1", "a")])
    const tools = memoryTools({ store, threadMode: "read-only" })
    const search = await run(byName(tools, "memory_search"), { query: "a" })
    if (search.type === "result") expect(search.result.ok).toBe(true)
    expect(store.calls.recall).toBe(1)
    const write = await run(byName(tools, "memory_write"), { text: "x" })
    if (write.type === "result") expect(write.result.ok).toBe(false)
    expect(store.calls.save).toBe(0)
  })
})

describe("ADR-0432 write-guard exact boundary (remaining vs minRemainingPercent)", () => {
  // Implementation gate: block iff `remainingPercent() < minRemainingPercent`.
  // ⇒ STRICTLY-less blocks. Therefore the boundary `remaining == min` is
  // INCLUSIVE on the ALLOW side (equal ⇒ write proceeds). We test BOTH sides
  // of the boundary plus the exact equality.
  const writeWith = async (remaining: number, min: number) => {
    const store = new SpyStore()
    const tools = memoryTools({
      store,
      writeGuard: { minRemainingPercent: min, remainingPercent: () => remaining },
    })
    const ev = await run(byName(tools, "memory_write"), { text: "x" })
    const ok = ev.type === "result" ? ev.result.ok : undefined
    return { ok, saves: store.calls.save }
  }

  test("remaining == min ⇒ ALLOWED (inclusive boundary)", async () => {
    const r = await writeWith(20, 20)
    expect(r.ok).toBe(true)
    expect(r.saves).toBe(1)
  })

  test("remaining = min - epsilon (just below) ⇒ BLOCKED", async () => {
    const r = await writeWith(19.999999, 20)
    expect(r.ok).toBe(false)
    expect(r.saves).toBe(0)
  })

  test("remaining = min + epsilon (just above) ⇒ ALLOWED", async () => {
    const r = await writeWith(20.000001, 20)
    expect(r.ok).toBe(true)
    expect(r.saves).toBe(1)
  })

  test("remaining = 0, min = 0 ⇒ ALLOWED (0 < 0 is false)", async () => {
    const r = await writeWith(0, 0)
    expect(r.ok).toBe(true)
    expect(r.saves).toBe(1)
  })

  test("non-finite remaining ⇒ guard skipped (write proceeds, fail-open)", async () => {
    const r = await writeWith(Number.NaN, 50)
    expect(r.ok).toBe(true)
    expect(r.saves).toBe(1)
  })
})

describe("ADR-0432 lineSpanOf invariants (1-based, in-bounds, never degenerate)", () => {
  test("multi-line ⇒ L1..N where N == line count", () => {
    const span = lineSpanOf("r", "a\nb\nc")
    expect(span).toEqual({ recordId: "r", lineStart: 1, lineEnd: 3 })
  })

  test("single-line ⇒ L1-1", () => {
    const span = lineSpanOf("r", "only one")
    expect(span).toEqual({ recordId: "r", lineStart: 1, lineEnd: 1 })
  })

  test("empty record ⇒ L1-1 (non-empty invariant: never < L1-1)", () => {
    const span = lineSpanOf("r", "")
    expect(span).toEqual({ recordId: "r", lineStart: 1, lineEnd: 1 })
  })

  test("trailing newline ⇒ end counts the empty trailing segment (still ≥ start)", () => {
    const span = lineSpanOf("r", "a\n")
    expect(span.lineStart).toBe(1)
    expect(span.lineEnd).toBeGreaterThanOrEqual(span.lineStart)
    expect(span.lineEnd).toBe(2)
  })

  test("invariant: lineStart === 1 and lineEnd >= lineStart for arbitrary text", () => {
    for (const text of ["", "x", "x\n", "x\ny", "\n\n\n", "a\nb\nc\nd\ne"]) {
      const span = lineSpanOf("r", text)
      expect(span.lineStart).toBe(1)
      expect(span.lineEnd).toBeGreaterThanOrEqual(span.lineStart)
    }
  })
})

describe("ADR-0432 citation line numbers are 1-based + within record bounds", () => {
  // jul-03 B3: the emitted span is now the REAL sub-range the query matches, no
  // longer the degenerate whole-record L1..N. "line" first hits line 1 ("line
  // one") ⇒ [L1-1]. The bounds invariant (1 <= s <= e <= totalLines) still holds.
  test("emitted [L<s>-<e>] is the real matched sub-span within record bounds", async () => {
    const text = "line one\nline two\nline three"
    const total = text.split("\n").length
    const store = new SpyStore([entry("m1", text)])
    const tools = memoryTools({ store, lineCitations: true })
    const ev = await run(byName(tools, "memory_search"), { query: "line" })
    expect(ev.type).toBe("result")
    if (ev.type === "result") {
      const m = ev.result.output.match(/\[L(\d+)-(\d+)\]/)
      expect(m).not.toBeNull()
      if (m) {
        const start = Number(m[1])
        const end = Number(m[2])
        // Real sub-span: "line" first matches on line 1.
        expect(start).toBe(1)
        expect(end).toBe(1)
        // Bounds invariant preserved.
        expect(start).toBeGreaterThanOrEqual(1)
        expect(end).toBeGreaterThanOrEqual(start)
        expect(end).toBeLessThanOrEqual(total)
      }
    }
  })

  test("a query matching a LATER line yields a non-degenerate span (proves real offset carry)", async () => {
    const text = "line one\nline two\nline three"
    const store = new SpyStore([entry("m1", text)])
    const tools = memoryTools({ store, lineCitations: true })
    const ev = await run(byName(tools, "memory_search"), { query: "three" })
    expect(ev.type).toBe("result")
    if (ev.type === "result") {
      // "three" only appears on line 3 ⇒ [L3-3], NOT the whole-record L1-3.
      expect(ev.result.output).toContain("[L3-3]")
      expect(ev.result.output).not.toContain("[L1-3]")
    }
  })
})
