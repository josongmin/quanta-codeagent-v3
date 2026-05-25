/**
 * ADR-0257 hellgate — `ai_attribution` tool + closed-port adapter.
 *
 * 15 adversarial cases sealing the closed-port contract, deterministic
 * stub behaviour, default-OFF posture, and exhaustive SearchError /
 * License unions.
 *
 *   HELL-AA-01 happy path: snippet → AttributionMatch[]
 *   HELL-AA-02 empty snippet → Err("empty-snippet")
 *   HELL-AA-03 snippet > 10 KB → Err("snippet-too-large")
 *   HELL-AA-04 minSimilarity filters out low-score rows
 *   HELL-AA-05 maxResults caps the returned list
 *   HELL-AA-06 search adapter failure → Err("search-failed", cause)
 *   HELL-AA-07 headless determinism — same snippet ⇒ same matches
 *   HELL-AA-08 every License arm reachable (MIT/Apache-2.0/GPL-3.0/proprietary/unknown)
 *   HELL-AA-09 similarity is always within [0, 1]
 *   HELL-AA-10 default-OFF: `ai_attribution` is NOT in `buildDefaultTools()`
 *   HELL-AA-11 URL is optional (proprietary/unknown rows omit URL)
 *   HELL-AA-12 results sorted by similarity DESC
 *   HELL-AA-13 1000-snippet performance sanity (< 2 s on the deterministic stub)
 *   HELL-AA-14 AbortSignal cancellation → Err("aborted")
 *   HELL-AA-15 SearchError 4-arm closed exhaustive (anchor tuple sealed)
 */

import { describe, expect, test } from "bun:test"
import { err, ok } from "@/shared"
import { buildDefaultTools } from "@/tool"
import { aiAttributionTool } from "@/tool/ai_attribution"
import {
  type AIAttributionSearch,
  type AttributionMatch,
  headlessStub,
  LICENSES,
  SEARCH_ERROR_KINDS,
  type SearchError,
  SNIPPET_MAX_BYTES,
} from "@/tool/ai-attribution"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"

/* ----------------------------- harness --------------------------------- */

const ctx = (signal?: AbortSignal): ToolContext => ({
  cwd: "/work",
  signal: signal ?? new AbortController().signal,
})

interface ExecutableTool {
  execute(input: unknown, c: ToolContext): AsyncIterable<ToolEvent>
}

const collect = async (
  tool: ExecutableTool,
  input: unknown,
  context: ToolContext = ctx(),
): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input, context)) {
    if (ev.type === "result") result = ev.result
  }
  if (result === undefined) throw new Error("no terminal result")
  return result
}

/** Build a port whose `search` is overrideable per case. */
const fakePort = (
  fn: AIAttributionSearch["search"] = headlessStub().search,
): AIAttributionSearch => ({ search: fn })

/* ------------------------- HELL-AA-01 happy path ----------------------- */

describe("ADR-0257 ai-attribution-hellgate", () => {
  test("HELL-AA-01 snippet returns AttributionMatch[]", async () => {
    const t = aiAttributionTool(headlessStub())
    const r = await collect(t, { snippet: "const x = 1" })
    expect(r.ok).toBe(true)
    expect(r.output).toMatch(/matches?:/)
    // Each rendered line has the score-license-source shape.
    const matchLines = r.output.split("\n").slice(1)
    expect(matchLines.length).toBeGreaterThan(0)
    for (const line of matchLines) {
      expect(line).toMatch(/^ {2}\[\d\.\d{4}] [A-Za-z0-9.+-]+ {2}.+$/)
    }
  })

  /* ----------------------- HELL-AA-02 empty snippet -------------------- */

  test("HELL-AA-02 empty snippet → Err('empty-snippet')", async () => {
    const t = aiAttributionTool(headlessStub())
    const r = await collect(t, { snippet: "" })
    expect(r.ok).toBe(false)
    expect(r.output.startsWith("empty-snippet:")).toBe(true)
  })

  /* ----------------------- HELL-AA-03 snippet too large ---------------- */

  test("HELL-AA-03 snippet > 10 KB → Err('snippet-too-large')", async () => {
    const t = aiAttributionTool(headlessStub())
    const big = "x".repeat(SNIPPET_MAX_BYTES + 1)
    const r = await collect(t, { snippet: big })
    expect(r.ok).toBe(false)
    expect(r.output.startsWith("snippet-too-large:")).toBe(true)
    expect(r.output).toContain(String(SNIPPET_MAX_BYTES + 1))
    expect(r.output).toContain(String(SNIPPET_MAX_BYTES))
  })

  /* ----------------------- HELL-AA-04 minSimilarity -------------------- */

  test("HELL-AA-04 minSimilarity filters out low-score rows", async () => {
    const t = aiAttributionTool(headlessStub())
    const open = await collect(t, { snippet: "function foo() {}" })
    const tight = await collect(t, { snippet: "function foo() {}", minSimilarity: 0.9 })
    expect(open.ok).toBe(true)
    expect(tight.ok).toBe(true)
    const openCount = open.output.split("\n").length - 1
    const tightCount = tight.output.startsWith("(no matches)")
      ? 0
      : tight.output.split("\n").length - 1
    expect(tightCount).toBeLessThan(openCount)
    // Every tight-mode line's score MUST be >= 0.9.
    if (tightCount > 0) {
      for (const line of tight.output.split("\n").slice(1)) {
        const m = line.match(/^ {2}\[(\d\.\d{4})]/)
        expect(m).not.toBeNull()
        const score = Number(m?.[1])
        expect(score).toBeGreaterThanOrEqual(0.9)
      }
    }
  })

  /* ----------------------- HELL-AA-05 maxResults cap ------------------- */

  test("HELL-AA-05 maxResults caps the returned list", async () => {
    const t = aiAttributionTool(headlessStub())
    const r = await collect(t, { snippet: "let y = 2", maxResults: 2 })
    expect(r.ok).toBe(true)
    const matchLines = r.output.split("\n").slice(1)
    expect(matchLines.length).toBe(2)
  })

  /* ----------------------- HELL-AA-06 search-failed -------------------- */

  test("HELL-AA-06 adapter failure → Err('search-failed', cause)", async () => {
    const t = aiAttributionTool(
      fakePort(async () => err({ kind: "search-failed", cause: "network unreachable" })),
    )
    const r = await collect(t, { snippet: "anything" })
    expect(r.ok).toBe(false)
    expect(r.output).toBe("search-failed: network unreachable")
  })

  /* ----------------------- HELL-AA-07 determinism ---------------------- */

  test("HELL-AA-07 headless determinism — same snippet ⇒ same matches", async () => {
    const t1 = aiAttributionTool(headlessStub())
    const t2 = aiAttributionTool(headlessStub())
    const snippet = "export const SECRET = 42"
    const a = await collect(t1, { snippet })
    const b = await collect(t2, { snippet })
    expect(a.output).toBe(b.output)
    // A different snippet MUST produce a different output (otherwise the
    // hash isn't being consumed).
    const c = await collect(t1, { snippet: `${snippet} // sibling` })
    expect(a.output).not.toBe(c.output)
  })

  /* ----------------------- HELL-AA-08 license arms --------------------- */

  test("HELL-AA-08 every License arm is reachable in stub output", async () => {
    const t = aiAttributionTool(headlessStub())
    // Pull a generous result set so all five base rows survive sorting.
    const r = await collect(t, { snippet: "verify-license-arms", maxResults: 10 })
    expect(r.ok).toBe(true)
    for (const lic of LICENSES) {
      expect(r.output).toContain(` ${lic}  `)
    }
    expect(LICENSES.length).toBe(5)
  })

  /* ----------------------- HELL-AA-09 similarity range ----------------- */

  test("HELL-AA-09 similarity is always within [0, 1] (even from a misbehaving adapter)", async () => {
    // Stub-side: every rendered score parses inside [0, 1].
    const t = aiAttributionTool(headlessStub())
    const r = await collect(t, { snippet: "range-check" })
    expect(r.ok).toBe(true)
    for (const line of r.output.split("\n").slice(1)) {
      const m = line.match(/^ {2}\[(\d\.\d{4})]/)
      expect(m).not.toBeNull()
      const score = Number(m?.[1])
      expect(score).toBeGreaterThanOrEqual(0)
      expect(score).toBeLessThanOrEqual(1)
    }
    // Adapter-side defense: a port that lies (similarity 1.7, -0.4) MUST be
    // dropped — the rendered output contains only the in-range row.
    const liarMatches: AttributionMatch[] = [
      { source: "liar:high", license: "MIT", similarity: 1.7 },
      { source: "liar:low", license: "MIT", similarity: -0.4 },
      { source: "liar:ok", license: "MIT", similarity: 0.5 },
    ]
    const t2 = aiAttributionTool(fakePort(async () => ok(liarMatches)))
    const r2 = await collect(t2, { snippet: "x" })
    expect(r2.ok).toBe(true)
    expect(r2.output).toContain("liar:ok")
    expect(r2.output).not.toContain("liar:high")
    expect(r2.output).not.toContain("liar:low")
  })

  /* ----------------------- HELL-AA-10 default-OFF ---------------------- */

  test("HELL-AA-10 default-OFF: ai_attribution is NOT in buildDefaultTools()", () => {
    const names = buildDefaultTools().map((t) => t.name)
    expect(names).not.toContain("ai_attribution")
  })

  /* ----------------------- HELL-AA-11 URL optional --------------------- */

  test("HELL-AA-11 URL is optional — some rows expose URL, some do not", async () => {
    const t = aiAttributionTool(headlessStub())
    const r = await collect(t, { snippet: "url-check", maxResults: 10 })
    expect(r.ok).toBe(true)
    const lines = r.output.split("\n").slice(1)
    // At least one row WITH https URL.
    expect(lines.some((l) => l.includes("https://"))).toBe(true)
    // At least one row WITHOUT URL (proprietary / unknown base rows).
    expect(lines.some((l) => !l.includes("https://"))).toBe(true)
  })

  /* ----------------------- HELL-AA-12 sort desc ------------------------ */

  test("HELL-AA-12 matches are sorted by similarity DESC", async () => {
    const t = aiAttributionTool(headlessStub())
    const r = await collect(t, { snippet: "sort-check", maxResults: 10 })
    expect(r.ok).toBe(true)
    const scores: number[] = []
    for (const line of r.output.split("\n").slice(1)) {
      const m = line.match(/^ {2}\[(\d\.\d{4})]/)
      if (m?.[1] !== undefined) scores.push(Number(m[1]))
    }
    expect(scores.length).toBeGreaterThan(1)
    for (let i = 1; i < scores.length; i++) {
      const prev = scores[i - 1] as number
      const cur = scores[i] as number
      expect(prev).toBeGreaterThanOrEqual(cur)
    }
  })

  /* ----------------------- HELL-AA-13 perf sanity ---------------------- */

  test("HELL-AA-13 1000-snippet perf sanity completes well under 2 s on stub", async () => {
    const t = aiAttributionTool(headlessStub())
    const started = Date.now()
    for (let i = 0; i < 1000; i++) {
      const r = await collect(t, { snippet: `snippet-${i}` })
      expect(r.ok).toBe(true)
    }
    const elapsed = Date.now() - started
    expect(elapsed).toBeLessThan(2000)
  })

  /* ----------------------- HELL-AA-14 abort cancellation --------------- */

  test("HELL-AA-14 AbortSignal cancellation → Err('aborted')", async () => {
    const ac = new AbortController()
    ac.abort()
    const t = aiAttributionTool(headlessStub())
    const r = await collect(t, { snippet: "abort-me" }, ctx(ac.signal))
    expect(r.ok).toBe(false)
    expect(r.output.startsWith("aborted:")).toBe(true)
  })

  /* ----------------------- HELL-AA-15 closed-union exhaustiveness ------ */

  test("HELL-AA-15 SearchError 4-arm closed exhaustive (anchor tuple sealed)", () => {
    // The anchor tuple in `types.ts` MUST list exactly these 4 kinds; a
    // future 5th variant requires updating BOTH the union and this tuple.
    const sorted: string[] = [...SEARCH_ERROR_KINDS].sort()
    expect(sorted).toEqual(["aborted", "empty-snippet", "search-failed", "snippet-too-large"])
    expect(SEARCH_ERROR_KINDS.length).toBe(4)
    // Exhaustive switch sanity — TS infers `never` after all arms.
    const branch = (e: SearchError): string => {
      switch (e.kind) {
        case "empty-snippet":
          return "a"
        case "snippet-too-large":
          return "b"
        case "search-failed":
          return "c"
        case "aborted":
          return "d"
      }
    }
    expect(branch({ kind: "empty-snippet" })).toBe("a")
    expect(branch({ kind: "snippet-too-large", sizeBytes: 1, maxBytes: 0 })).toBe("b")
    expect(branch({ kind: "search-failed", cause: "x" })).toBe("c")
    expect(branch({ kind: "aborted" })).toBe("d")
  })
})
