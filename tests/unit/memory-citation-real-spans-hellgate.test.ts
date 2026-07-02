/**
 * jul-03 B3 hellgate — REAL sub-spans + provenance + provider rate-limit guard.
 *
 * RED-first battery for the B3 strengthen work (docs/analysis/
 * jul-03-competitor-ux-absorption.md § FINAL "B3 — Memory citation"):
 *
 *   (1) `lineSpanOf` today ALWAYS returns L1..N (whole record) — the `[L{s}-{e}]`
 *       tag is informationally empty. Carrying the recall match text yields a
 *       real 1-based sub-span (the lines the matched substring occupies).
 *   (2) `LineCitation` gains optional provenance (threadId + note) mirroring
 *       Codex `MemoryCitationEntry`.
 *   (3) TOP GAP: `writeBlockReason` reads a LOCAL cost fraction (returns 100 when
 *       no dial). A REAL provider `x-ratelimit-remaining` signal — a SEPARATE
 *       source from the cost fraction — must be able to refuse a write when the
 *       provider window is below threshold, EVEN when the local cost meter reads
 *       100 (no dial). This is the load-bearing distinction.
 *   (4) Arm-state telemetry: the guard is fail-open unless a knob AND a live
 *       source both exist — observing the arm state proves it is not a latent
 *       inert config.
 *
 * Leaf-only (memory-tools.ts) — no I/O, no clock, no env. Punchcard-compliant.
 */

import { describe, expect, test } from "bun:test"
import { type MemoryWriteGuardArm, lineSpanOf, memoryTools } from "@/agent/memory-tools"
import { InMemoryStore } from "@/memory"
import type { Tool, ToolContext, ToolEvent } from "@/tool"

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

// ─────────────────────────────────────────────────────────────────────────────
// (1) REAL sub-spans — carry the recall match text into lineSpanOf.
// ─────────────────────────────────────────────────────────────────────────────
describe("B3 (1) real sub-spans", () => {
  const REC = "alpha line\nbeta MATCH here\ngamma line\ndelta line"

  test("match on line 2 ⇒ non-degenerate span L2-2 (not the whole-record L1-N)", () => {
    const span = lineSpanOf("m", REC, "MATCH")
    expect(span.lineStart).toBe(2)
    expect(span.lineEnd).toBe(2)
    // MUST NOT collapse to the degenerate whole-record span.
    expect(span.lineEnd - span.lineStart).toBeLessThan(3)
  })

  test("multi-line match ⇒ span covers first..last line the match occupies", () => {
    // The needle straddles the newline between line 2 and line 3.
    const span = lineSpanOf("m", REC, "here\ngamma")
    expect(span.lineStart).toBe(2)
    expect(span.lineEnd).toBe(3)
  })

  test("case-insensitive match (mirrors ranking.textScore lc/includes)", () => {
    const span = lineSpanOf("m", REC, "match")
    expect(span.lineStart).toBe(2)
    expect(span.lineEnd).toBe(2)
  })

  test("AUDIT: length-changing lowercase BEFORE the match does not skew the line", () => {
    // `İ` (U+0130) lowercases to TWO code units, so a whole-string
    // `toLowerCase().indexOf(...)` returns an index into the (longer) lowercased
    // string; mapping THAT onto the original text crosses the newline and reports
    // the WRONG line. The match `z` is genuinely on line 1. Regressing `ciIndexOf`
    // back to `text.toLowerCase().indexOf(...)` turns this RED (reports L2-2).
    const span = lineSpanOf("m", "İİz\nrest", "z")
    expect(span.lineStart).toBe(1)
    expect(span.lineEnd).toBe(1)
  })

  test("no match text carried ⇒ whole-record fallback (byte-identical legacy)", () => {
    const span = lineSpanOf("m", REC)
    expect(span.lineStart).toBe(1)
    expect(span.lineEnd).toBe(4)
  })

  test("match text not found ⇒ whole-record fallback (never a bogus span)", () => {
    const span = lineSpanOf("m", REC, "not-present-substring")
    expect(span.lineStart).toBe(1)
    expect(span.lineEnd).toBe(4)
  })

  test("memory_search surfaces the REAL sub-span for the query", async () => {
    const store = new InMemoryStore([
      { id: "m1", kind: "fact", text: REC, tags: [], createdAt: 1, importance: 0.7 },
    ])
    const tools = memoryTools({ store, lineCitations: true })
    const ev = await run(byName(tools, "memory_search"), { query: "MATCH" })
    if (ev.type === "result") {
      expect(ev.result.output).toContain("#m1")
      // Real sub-span for "MATCH" (line 2), NOT the degenerate whole-record L1-4.
      expect(ev.result.output).toContain("[L2-2]")
      expect(ev.result.output).not.toContain("[L1-4]")
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// (2) provenance: threadId + note carried onto the citation.
// ─────────────────────────────────────────────────────────────────────────────
describe("B3 (2) citation provenance", () => {
  test("sessionId ⇒ threadId provenance, reuseRule ⇒ note", () => {
    const span = lineSpanOf("m", "one\ntwo", undefined, {
      threadId: "thread-42",
      note: "reuse only in this checkout",
    })
    expect(span.threadId).toBe("thread-42")
    expect(span.note).toBe("reuse only in this checkout")
  })

  test("absent provenance ⇒ fields omitted (no literal undefined)", () => {
    const span = lineSpanOf("m", "one\ntwo")
    expect("threadId" in span).toBe(false)
    expect("note" in span).toBe(false)
  })

  test("memory_search renders the reuseRule note inline (provenance reaches output)", async () => {
    const store = new InMemoryStore([
      {
        id: "m1",
        kind: "fact",
        text: "alpha\nbeta MATCH",
        tags: [],
        createdAt: 1,
        importance: 0.7,
        sessionId: "thread-7",
        reuseRule: "checkout-specific",
      },
    ])
    const tools = memoryTools({ store, lineCitations: true })
    const ev = await run(byName(tools, "memory_search"), { query: "MATCH" })
    if (ev.type === "result") {
      // Real sub-span for "MATCH" (line 2) AND the reuse note surfaced inline.
      expect(ev.result.output).toContain("[L2-2]")
      expect(ev.result.output).toContain("{checkout-specific}")
    }
  })

  test("memory_search WITHOUT reuseRule ⇒ no note braces (byte-identical omit)", async () => {
    const store = new InMemoryStore([
      { id: "m1", kind: "fact", text: "alpha\nbeta MATCH", tags: [], createdAt: 1, importance: 0.7 },
    ])
    const tools = memoryTools({ store, lineCitations: true })
    const ev = await run(byName(tools, "memory_search"), { query: "MATCH" })
    if (ev.type === "result") {
      expect(ev.result.output).toContain("[L2-2]")
      expect(ev.result.output).not.toContain("{")
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// (3) TOP GAP: provider rate-limit signal refuses a write — SEPARATE from cost.
// ─────────────────────────────────────────────────────────────────────────────
describe("B3 (3) provider rate-limit guard (separate from local cost)", () => {
  test("refuses write when PROVIDER remaining% < threshold even though local cost reads 100", async () => {
    const store = new InMemoryStore()
    const tools = memoryTools({
      store,
      writeGuard: {
        minRemainingPercent: 20,
        // Local cost meter says "plenty" (no dial ⇒ 100) — the OLD signal.
        remainingPercent: () => 100,
        // REAL provider window is nearly exhausted — the NEW load-bearing tap.
        providerRateLimitRemainingPercent: () => 5,
      },
    })
    const ev = await run(byName(tools, "memory_write"), { text: "x" })
    expect(ev.type).toBe("result")
    if (ev.type === "result") {
      expect(ev.result.ok).toBe(false)
      expect(ev.result.output).toContain("rate-limit")
    }
    expect(await store.all()).toHaveLength(0)
  })

  test("provider remaining >= threshold ⇒ write proceeds", async () => {
    const store = new InMemoryStore()
    const tools = memoryTools({
      store,
      writeGuard: {
        minRemainingPercent: 20,
        remainingPercent: () => 100,
        providerRateLimitRemainingPercent: () => 90,
      },
    })
    const ev = await run(byName(tools, "memory_write"), { text: "x" })
    if (ev.type === "result") expect(ev.result.ok).toBe(true)
    expect(await store.all()).toHaveLength(1)
  })

  test("provider tap returns undefined (never observed) ⇒ provider arm inert, falls to local cost", async () => {
    const store = new InMemoryStore()
    const tools = memoryTools({
      store,
      writeGuard: {
        minRemainingPercent: 20,
        remainingPercent: () => 100, // local plenty
        providerRateLimitRemainingPercent: () => undefined, // no provider snapshot yet
      },
    })
    const ev = await run(byName(tools, "memory_write"), { text: "x" })
    // Neither arm blocks ⇒ write proceeds (fail-open when provider unknown).
    if (ev.type === "result") expect(ev.result.ok).toBe(true)
    expect(await store.all()).toHaveLength(1)
  })

  test("local cost arm still fires independently (back-compat preserved)", async () => {
    const store = new InMemoryStore()
    const tools = memoryTools({
      store,
      writeGuard: { minRemainingPercent: 20, remainingPercent: () => 5 },
    })
    const ev = await run(byName(tools, "memory_write"), { text: "x" })
    if (ev.type === "result") {
      expect(ev.result.ok).toBe(false)
      expect(ev.result.output).toContain("budget remaining")
    }
    expect(await store.all()).toHaveLength(0)
  })

  test("provider arm also gates memory_update", async () => {
    const store = new InMemoryStore([
      { id: "m1", kind: "fact", text: "t", tags: [], createdAt: 1, importance: 0.7 },
    ])
    const tools = memoryTools({
      store,
      writeGuard: {
        minRemainingPercent: 50,
        remainingPercent: () => 100,
        providerRateLimitRemainingPercent: () => 10,
      },
    })
    const ev = await run(byName(tools, "memory_update"), { id: "m1", importance: 0.1 })
    if (ev.type === "result") expect(ev.result.ok).toBe(false)
    expect((await store.get("m1"))?.importance).toBeCloseTo(0.7, 5)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// (4) arm-state telemetry — proves the guard is not latent/inert.
// ─────────────────────────────────────────────────────────────────────────────
describe("B3 (4) arm-state telemetry", () => {
  test("onArm observes which arm blocked (provider)", async () => {
    const arms: MemoryWriteGuardArm[] = []
    const store = new InMemoryStore()
    const tools = memoryTools({
      store,
      writeGuard: {
        minRemainingPercent: 20,
        remainingPercent: () => 100,
        providerRateLimitRemainingPercent: () => 5,
        onArm: (a) => arms.push(a),
      },
    })
    await run(byName(tools, "memory_write"), { text: "x" })
    expect(arms).toContainEqual(
      expect.objectContaining({ armed: true, source: "provider", blocked: true }),
    )
  })

  test("onArm observes an ARMED-but-not-blocked evaluation (proves live source, not latent config)", async () => {
    const arms: MemoryWriteGuardArm[] = []
    const store = new InMemoryStore()
    const tools = memoryTools({
      store,
      writeGuard: {
        minRemainingPercent: 20,
        remainingPercent: () => 100,
        providerRateLimitRemainingPercent: () => 90,
        onArm: (a) => arms.push(a),
      },
    })
    await run(byName(tools, "memory_write"), { text: "x" })
    // Provider arm armed (live source present) but did NOT block.
    expect(arms).toContainEqual(
      expect.objectContaining({ armed: true, source: "provider", blocked: false }),
    )
  })
})
