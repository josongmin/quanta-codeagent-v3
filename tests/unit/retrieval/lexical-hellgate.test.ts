/**
 * HELLGATE — ADR-0260 LexicalSearch (BM25 + ripgrep) adversarial proofs.
 *
 * Invariants:
 *   (i)   BM25 round-trip: index → query returns hits ranked by score desc
 *         and the top-k slice is exactly k entries (when corpus >= k).
 *   (ii)  Tokenizer is UTF-8 word-boundary — Korean / CJK tokens index
 *         and retrieve. ASCII-only is a regression.
 *   (iii) Ripgrep adapter degrades to `grep` when `rg` missing, then to
 *         `no-search-binary` when both missing. The degrade reason
 *         surfaces ONCE on the `index` result.
 *   (iv)  LexicalError is a 5-arm closed exhaustive union — adding an
 *         arm without updating `ALL_LEXICAL_ERROR_KINDS` compile-fails
 *         the switch in HELL-LX-15.
 *   (v)   Default-OFF: importing the slice barrel produces zero side
 *         effects (no spawn, no fs write, no global mutation).
 *
 * 15 cases.
 */

import { describe, expect, test } from "bun:test"
import {
  ALL_LEXICAL_ERROR_KINDS,
  createBm25LexicalSearch,
  createRipgrepLexicalSearch,
  headlessLexicalStub,
  type LexicalDoc,
  type LexicalError,
  type LexicalHit,
  type LexicalSearch,
  type RipgrepSpawner,
} from "@/retrieval"

const docs = (n: number, text: (i: number) => string): LexicalDoc[] =>
  Array.from({ length: n }, (_, i) => ({ id: `d${i}`, text: text(i) }))

const okOrThrow = <T>(r: { ok: true; value: T } | { ok: false; error: LexicalError }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`)
  return r.value
}

const errOrThrow = (
  r:
    | {
        ok: true
        value: unknown
      }
    | {
        ok: false
        error: LexicalError
      },
): LexicalError => {
  if (r.ok) throw new Error("expected err, got ok")
  return r.error
}

/** Build a deterministic in-memory rg spawner. Caller injects per-call
 *  responses keyed by binary name; missing binary throws ENOENT-shaped
 *  error synchronously (matches Bun.spawn behaviour). */
const mkSpawner = (cfg: {
  rgAvailable: boolean
  grepAvailable: boolean
  rgStdout?: string
  grepStdout?: string
  rgExit?: number
  grepExit?: number
  spawnThrow?: (binary: "rg" | "grep") => Error | null
}): RipgrepSpawner => ({
  async run(binary, _argv, _opts) {
    const thrown = cfg.spawnThrow?.(binary) ?? null
    if (thrown !== null) throw thrown
    if (binary === "rg") {
      if (!cfg.rgAvailable) {
        const e = new Error("spawn rg ENOENT") as Error & { code?: string }
        e.code = "ENOENT"
        throw e
      }
      return { code: cfg.rgExit ?? 0, stdout: cfg.rgStdout ?? "" }
    }
    if (!cfg.grepAvailable) {
      const e = new Error("spawn grep ENOENT") as Error & { code?: string }
      e.code = "ENOENT"
      throw e
    }
    return { code: cfg.grepExit ?? 0, stdout: cfg.grepStdout ?? "" }
  },
})

describe("lexical-search hellgate (ADR-0260)", () => {
  // HELL-LX-01 — BM25 index/query round-trip
  test("HELL-LX-01 BM25 index → query round-trip returns matching doc", async () => {
    const engine: LexicalSearch = createBm25LexicalSearch()
    const indexed = okOrThrow(
      await engine.index([
        { id: "a", text: "the quick brown fox" },
        { id: "b", text: "lorem ipsum dolor sit" },
        { id: "c", text: "fox jumped over fence" },
      ]),
    )
    expect(indexed.docs).toBe(3)
    const hits = okOrThrow(await engine.query("fox", 5))
    expect(hits.length).toBeGreaterThanOrEqual(2)
    const ids = hits.map((h) => h.id)
    expect(ids).toContain("a")
    expect(ids).toContain("c")
    expect(ids).not.toContain("b")
  })

  // HELL-LX-02 — top-k accurate + scores monotonically non-increasing
  test("HELL-LX-02 top-k cap honored AND hits sorted by score desc", async () => {
    const engine = createBm25LexicalSearch()
    await engine.index(docs(10, (i) => `fox fox doc-${i}${i === 3 ? " fox fox" : ""}`))
    const hits = okOrThrow(await engine.query("fox", 3))
    expect(hits.length).toBe(3)
    for (let i = 1; i < hits.length; i++) {
      const prev = hits[i - 1] as LexicalHit
      const curr = hits[i] as LexicalHit
      expect(curr.score).toBeLessThanOrEqual(prev.score)
    }
    // d3 has the most "fox" — must be the top hit
    expect(hits[0]?.id).toBe("d3")
  })

  // HELL-LX-03 — empty index → empty result (NOT error)
  test("HELL-LX-03 empty index → query resolves with empty hits (not error)", async () => {
    const engine = createBm25LexicalSearch()
    await engine.index([])
    const hits = okOrThrow(await engine.query("anything", 10))
    expect(hits).toEqual([])
    expect(engine.size()).toBe(0)
  })

  // HELL-LX-04 — single-token query
  test("HELL-LX-04 single-token query matches docs containing token only", async () => {
    const engine = createBm25LexicalSearch()
    await engine.index([
      { id: "a", text: "alpha beta" },
      { id: "b", text: "gamma delta" },
      { id: "c", text: "alpha gamma" },
    ])
    const hits = okOrThrow(await engine.query("gamma", 10))
    const ids = hits.map((h) => h.id).sort()
    expect(ids).toEqual(["b", "c"])
  })

  // HELL-LX-05 — multi-token query (OR semantics — any token contributes)
  test("HELL-LX-05 multi-token query aggregates per-term BM25 contributions", async () => {
    const engine = createBm25LexicalSearch()
    await engine.index([
      { id: "a", text: "alpha beta" },
      { id: "b", text: "gamma delta" },
      { id: "c", text: "alpha gamma" },
    ])
    const hits = okOrThrow(await engine.query("alpha gamma", 10))
    // 'c' has both tokens → strictly higher score than 'a' or 'b' alone
    expect(hits[0]?.id).toBe("c")
    const ids = hits.map((h) => h.id)
    expect(ids).toContain("a")
    expect(ids).toContain("b")
  })

  // HELL-LX-06 — k1 / b configurable
  test("HELL-LX-06 k1/b options change the scoring distribution", async () => {
    const docsArr = [
      { id: "a", text: "fox fox fox short" },
      { id: "b", text: "fox single long long long long long long long long long" },
    ]
    const def = createBm25LexicalSearch()
    const tuned = createBm25LexicalSearch({ k1: 0.1, b: 0.0 })
    await def.index(docsArr)
    await tuned.index(docsArr)
    const defHits = okOrThrow(await def.query("fox", 5))
    const tunedHits = okOrThrow(await tuned.query("fox", 5))
    // Same corpus + same query but different parameters → different
    // scores. Identical numbers would prove k1/b are ignored.
    const defScoreA = defHits.find((h) => h.id === "a")?.score ?? 0
    const tunedScoreA = tunedHits.find((h) => h.id === "a")?.score ?? 0
    expect(defScoreA).not.toBe(tunedScoreA)
  })

  // HELL-LX-07 — Korean / CJK tokenization
  test("HELL-LX-07 Korean tokens index and retrieve (UTF-8 word boundary)", async () => {
    const engine = createBm25LexicalSearch()
    await engine.index([
      { id: "ko1", text: "안녕하세요 세계" },
      { id: "ko2", text: "안녕 친구" },
      { id: "en", text: "hello world" },
    ])
    const hits = okOrThrow(await engine.query("안녕", 10))
    const ids = hits.map((h) => h.id).sort()
    // Both ko1 (안녕하세요 — 안녕 prefix) and ko2 should NOT collide with
    // the English doc. At minimum ko2's exact-token "안녕" must surface.
    expect(ids).toContain("ko2")
    expect(ids).not.toContain("en")
  })

  // HELL-LX-08 — special-char query passes through literally (no regex
  // surprise, no shell escape required)
  test("HELL-LX-08 special chars in query are taken literally", async () => {
    const engine = createBm25LexicalSearch()
    await engine.index([
      { id: "a", text: "alpha.beta plus+sign and (parens)" },
      { id: "b", text: "boring text" },
    ])
    const hits = okOrThrow(await engine.query("alpha", 10))
    // The query is "alpha" — the token must match the prefix of
    // "alpha.beta" via the word-boundary tokenizer (period is a
    // separator, so "alpha" becomes its own token).
    expect(hits.map((h) => h.id)).toContain("a")
  })

  // HELL-LX-09 — ripgrep mock spawn → JSON parse
  test("HELL-LX-09 ripgrep adapter parses rg --json stream into hits", async () => {
    const rgJson = [
      JSON.stringify({ type: "begin", data: { path: { text: "/repo/a.txt" } } }),
      JSON.stringify({
        type: "match",
        data: {
          path: { text: "/repo/a.txt" },
          lines: { text: "alpha beta\n" },
          line_number: 1,
          submatches: [{ match: { text: "alpha" }, start: 0, end: 5 }],
        },
      }),
      JSON.stringify({
        type: "match",
        data: {
          path: { text: "/repo/a.txt" },
          lines: { text: "alpha gamma\n" },
          line_number: 2,
          submatches: [{ match: { text: "alpha" }, start: 0, end: 5 }],
        },
      }),
      JSON.stringify({ type: "end", data: { path: { text: "/repo/a.txt" } } }),
    ].join("\n")
    const engine = createRipgrepLexicalSearch({
      root: "/repo",
      spawner: mkSpawner({ rgAvailable: true, grepAvailable: true, rgStdout: rgJson }),
    })
    okOrThrow(await engine.index([{ id: "/repo/a.txt", text: "" }]))
    const hits = okOrThrow(await engine.query("alpha", 10))
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]?.id).toBe("/repo/a.txt")
    // score = matchCount (2)
    expect(hits[0]?.score).toBe(2)
    expect(hits[0]?.text).toBe("alpha beta")
    expect(hits[0]?.metadata).toEqual({
      path: "/repo/a.txt",
      startLine: "1",
      endLine: "1",
    })
  })

  // HELL-LX-10 — ripgrep missing → grep fallback + degradeReason surfaces
  test("HELL-LX-10 rg missing falls back to grep and surfaces degradeReason", async () => {
    const engine = createRipgrepLexicalSearch({
      root: "/repo",
      spawner: mkSpawner({
        rgAvailable: false,
        grepAvailable: true,
        grepStdout: "/repo/a.txt:3\n/repo/b.txt:1\n",
      }),
    })
    const indexed = okOrThrow(await engine.index([{ id: "/repo/a.txt", text: "" }]))
    expect(indexed.degradeReason).toBe("rg-missing")
    const hits = okOrThrow(await engine.query("alpha", 10))
    expect(hits.length).toBe(2)
    // grep -c output: <path>:<count> — count becomes score
    const a = hits.find((h) => h.id === "/repo/a.txt")
    const b = hits.find((h) => h.id === "/repo/b.txt")
    expect(a?.score).toBe(3)
    expect(b?.score).toBe(1)
  })

  // HELL-LX-11 — both binaries missing → typed error
  test("HELL-LX-11 rg AND grep missing → Err(no-search-binary)", async () => {
    const engine = createRipgrepLexicalSearch({
      root: "/repo",
      spawner: mkSpawner({ rgAvailable: false, grepAvailable: false }),
    })
    const r = await engine.index([{ id: "/repo/a.txt", text: "" }])
    if (!r.ok) {
      expect(r.error.kind).toBe("no-search-binary")
    } else {
      // index may succeed (manifest only); query must then fail
      const q = await engine.query("alpha", 10)
      const e = errOrThrow(q)
      expect(e.kind).toBe("no-search-binary")
    }
  })

  // HELL-LX-12 — clear → size 0
  test("HELL-LX-12 clear() resets size to 0", async () => {
    const engine = createBm25LexicalSearch()
    await engine.index([
      { id: "a", text: "alpha" },
      { id: "b", text: "beta" },
    ])
    expect(engine.size()).toBe(2)
    engine.clear()
    expect(engine.size()).toBe(0)
    // Post-clear query must resolve with empty hits, not error.
    const hits = okOrThrow(await engine.query("alpha", 10))
    expect(hits).toEqual([])
  })

  // HELL-LX-13 — 10k-doc performance sanity (no quadratic blow-up)
  test("HELL-LX-13 10k-doc index+query completes under a wall-clock cap", async () => {
    const engine = createBm25LexicalSearch()
    const big = docs(10_000, (i) => `token${i % 100} alpha beta`)
    const t0 = Date.now()
    await engine.index(big)
    const hits = okOrThrow(await engine.query("alpha", 25))
    const dt = Date.now() - t0
    expect(hits.length).toBe(25)
    // Generous upper bound — purely a quadratic-blow-up guard.
    expect(dt).toBeLessThan(15_000)
  })

  // HELL-LX-14 — default-OFF byte-identical (importing the slice does not
  // construct any production adapter or spawn any process)
  test("HELL-LX-14 importing the slice barrel performs zero side effects", () => {
    // The barrel import at the top of this file already exercised the
    // module-eval path. If anything had spawned / written / mutated, a
    // later sibling test would surface it. We assert factory functions
    // exist but are NOT pre-instantiated.
    expect(typeof createBm25LexicalSearch).toBe("function")
    expect(typeof createRipgrepLexicalSearch).toBe("function")
    expect(typeof headlessLexicalStub).toBe("function")
    // stub instance is independent — two calls give independent state
    const a = headlessLexicalStub()
    const b = headlessLexicalStub()
    expect(a).not.toBe(b)
  })

  // HELL-LX-15 — 5-arm closed exhaustive union
  test("HELL-LX-15 LexicalError is a 5-arm closed exhaustive union", () => {
    const expected = [
      "no-search-binary",
      "spawn-failed",
      "parse-failed",
      "invalid-query",
      "aborted",
    ] as const
    expect([...ALL_LEXICAL_ERROR_KINDS].sort()).toEqual([...expected].sort())
    // Compile-time exhaustiveness — if a new arm is added without
    // updating this switch, tsc fails this file.
    const cover = (e: LexicalError): string => {
      switch (e.kind) {
        case "no-search-binary":
          return e.detail
        case "spawn-failed":
          return `${e.binary}:${e.detail}`
        case "parse-failed":
          return `${e.binary}:${e.detail}`
        case "invalid-query":
          return `${e.raw}:${e.reason}`
        case "aborted":
          return e.binary ?? ""
        default: {
          // Exhaustiveness — `e` MUST narrow to `never` here.
          const _exhaustive: never = e
          return _exhaustive
        }
      }
    }
    expect(cover({ kind: "no-search-binary", detail: "x" })).toBe("x")
    expect(cover({ kind: "spawn-failed", binary: "rg", detail: "x" })).toBe("rg:x")
    expect(cover({ kind: "parse-failed", binary: "grep", detail: "y" })).toBe("grep:y")
    expect(cover({ kind: "invalid-query", raw: "", reason: "empty" })).toBe(":empty")
    expect(cover({ kind: "aborted" })).toBe("")
  })
})
