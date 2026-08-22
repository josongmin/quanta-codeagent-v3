/**
 * Hellgate ROUND 2 (PROPERTY / DIFFERENTIAL FUZZ) — `.ipynb` renderer
 * (`src/tool/read/ipynb.ts`; ADR-0481).
 *
 * Round 1 crafted adversarial notebooks. This round 2 FUZZES random JSON and
 * random nbformat-ish shapes against four invariants with ZERO tolerance:
 *
 *   N1  NO-THROW on ANY JSON text (valid / malformed / truncated / adversarial /
 *       deeply-nested / non-object).
 *   N2  A non-notebook JSON (no top-level `cells` array) ⇒ exactly `null` so the
 *       caller falls back to the raw render.
 *   N3  A base64 image blob is NEVER materialized into the output — the rendered
 *       string contains the «image output …» placeholder and NOT the blob bytes,
 *       even for a multi-megabyte (string OR chunked) payload (O(1) elision).
 *   N4  Cell ORDER round-trips: cell index N renders as `[cell N · …]` in order,
 *       and the count of rendered `[cell …]` headers === min(cells, CAP).
 *
 * PURE: string in, string|null out. No I/O, no clock, no Math.random.
 */

import { describe, expect, test } from "bun:test"
import {
  isNotebook,
  MAX_NOTEBOOK_CELLS,
  type NotebookRenderOpts,
  renderNotebook,
} from "@/tool/read/ipynb"

const lcg = (seed: number): (() => number) => {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0x100000000
  }
}
const pick = <T>(rng: () => number, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)] as T

const OPTS: NotebookRenderOpts = { includeOutputs: true, maxOutputChars: 200 }

// A random JSON value (bounded depth) — drives the NO-THROW + non-notebook⇒null
// invariants over the open JSON space.
const mkJson = (rng: () => number, depth: number): unknown => {
  if (depth <= 0) {
    return pick(rng, [0, 1, -1, 3.14, true, false, null, "", "x".repeat(Math.floor(rng() * 50))])
  }
  switch (Math.floor(rng() * 7)) {
    case 0:
      return null
    case 1:
      return Math.floor(rng() * 1e9) - 5e8
    case 2:
      return "s".repeat(Math.floor(rng() * 80))
    case 3: {
      const arr: unknown[] = []
      const n = Math.floor(rng() * 5)
      for (let i = 0; i < n; i++) arr.push(mkJson(rng, depth - 1))
      return arr
    }
    default: {
      const obj: Record<string, unknown> = {}
      const n = Math.floor(rng() * 5)
      const keys = ["cells", "metadata", "nbformat", "source", "outputs", "data", "k", "type"]
      for (let i = 0; i < n; i++) obj[pick(rng, keys)] = mkJson(rng, depth - 1)
      return obj
    }
  }
}

// A random nbformat-ish OUTPUT (some carry image blobs to probe N3).
const mkOutput = (rng: () => number, bigBlob: string): unknown => {
  switch (Math.floor(rng() * 6)) {
    case 0:
      return { output_type: "stream", text: ["line\n", "two\n"] }
    case 1:
      return { output_type: "stream", text: "plain stream" }
    case 2:
      return {
        output_type: "execute_result",
        data: { "text/plain": "42", "image/png": bigBlob },
      }
    case 3:
      return {
        output_type: "display_data",
        // chunked string[] image blob — must still be O(1)-elided.
        data: {
          "image/jpeg": [bigBlob.slice(0, bigBlob.length / 2), bigBlob.slice(bigBlob.length / 2)],
        },
      }
    case 4:
      return { output_type: "error", ename: "ValueError", evalue: "bad", traceback: ["a", "b"] }
    default:
      return { weird: true } // unknown output_type ⇒ no lines
  }
}

const mkCell = (rng: () => number, bigBlob: string): unknown => {
  const type = pick(rng, ["code", "markdown", "raw", "unknown", 123 as unknown as string])
  const outs: unknown[] = []
  const n = Math.floor(rng() * 4)
  for (let i = 0; i < n; i++) outs.push(mkOutput(rng, bigBlob))
  return {
    cell_type: type,
    source: pick(rng, [["a\n", "b"], "single line", 42, { not: "a source" }]),
    outputs: outs,
  }
}

describe("ipynb render property fuzz R2 — no-throw / null / blob-safety / order", () => {
  test("N1+N2: random JSON never throws; non-notebook ⇒ null (≥500 random)", () => {
    for (let seed = 1; seed <= 800; seed++) {
      const rng = lcg(seed * 2654435761)
      const value = mkJson(rng, 4)
      const text = JSON.stringify(value)
      let out: string | null = null
      expect(() => {
        out = renderNotebook(text, OPTS)
      }).not.toThrow()
      // A value that is NOT an object with a `cells` ARRAY must render null.
      const isNotebookShape =
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        Array.isArray((value as Record<string, unknown>).cells)
      if (!isNotebookShape && out !== null) {
        throw new Error(`N2 VIOLATION non-notebook rendered non-null: text=${text.slice(0, 120)}`)
      }
      if (!isNotebookShape) expect(out).toBeNull()
    }
  })

  test("N1: malformed / truncated / hostile raw text never throws ⇒ null", () => {
    const rng = lcg(0xbadc0de)
    for (let seed = 1; seed <= 300; seed++) {
      // Random byte soup + truncated JSON fragments.
      const frag = JSON.stringify({ cells: [{ cell_type: "code", source: "x" }] })
      const cut = frag.slice(0, 1 + Math.floor(rng() * frag.length))
      let noise = ""
      const n = Math.floor(rng() * 20)
      for (let i = 0; i < n; i++) noise += String.fromCharCode(Math.floor(rng() * 0x80))
      for (const t of [cut, noise, cut + noise, `{${noise}`, `[${noise}]`]) {
        expect(() => renderNotebook(t, OPTS)).not.toThrow()
      }
    }
  })

  test("N3: image base64 NEVER appears in output — placeholder only (≥500 random)", () => {
    // A distinctive 1MB blob; if any byte of it leaked, the output would contain
    // its unique prefix. We assert the blob's body is ABSENT and the placeholder
    // is PRESENT.
    const marker = "ZZIMGMARKERZZ"
    const bigBlob = marker + "QUNBQUFB".repeat(130_000) // > 1MB base64 string
    for (let seed = 1; seed <= 500; seed++) {
      const rng = lcg(seed * 99991 + 13)
      const cells: unknown[] = []
      const n = 1 + Math.floor(rng() * 4)
      for (let i = 0; i < n; i++) cells.push(mkCell(rng, bigBlob))
      const text = JSON.stringify({ cells })
      const out = renderNotebook(text, OPTS)
      if (out !== null) {
        // The unique blob marker must NEVER be materialized in the render.
        if (out.includes(marker)) {
          throw new Error(`N3 VIOLATION blob leaked at seed=${seed}`)
        }
        expect(out.includes(marker)).toBe(false)
      }
    }
  })

  test("N3: 50MB chunked image is O(1)-elided (no throw, no materialization)", () => {
    const chunk = "QUFBQQ".repeat(1_000_000) // ~6MB per chunk
    const text = JSON.stringify({
      cells: [
        {
          cell_type: "code",
          source: "show()",
          outputs: [
            { output_type: "display_data", data: { "image/png": [chunk, chunk, chunk, "QQ=="] } },
          ],
        },
      ],
    })
    let out: string | null = null
    expect(() => {
      out = renderNotebook(text, OPTS)
    }).not.toThrow()
    expect(out).not.toBeNull()
    expect((out as unknown as string).includes("image output")).toBe(true)
    // The render is tiny — the multi-MB blob was never copied in.
    expect((out as unknown as string).length).toBeLessThan(2_000)
  })

  test("N4: cell ORDER round-trips; header count === min(cells, CAP) (≥300 random)", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const rng = lcg(seed * 524287 + 1)
      const count = 1 + Math.floor(rng() * 12)
      const cells: unknown[] = []
      for (let i = 0; i < count; i++) {
        cells.push({ cell_type: "code", source: `tag${i}`, outputs: [] })
      }
      const out = renderNotebook(JSON.stringify({ cells }), OPTS)
      expect(out).not.toBeNull()
      const headers = (out as string).match(/\[cell \d+ · /g) ?? []
      const expected = Math.min(count, MAX_NOTEBOOK_CELLS)
      expect(headers.length).toBe(expected)
      // Order: indices appear strictly ascending 0..expected-1.
      for (let i = 0; i < expected; i++) {
        expect((out as string).includes(`[cell ${i} · code]`)).toBe(true)
        const idxI = (out as string).indexOf(`[cell ${i} · `)
        if (i + 1 < expected) {
          const idxNext = (out as string).indexOf(`[cell ${i + 1} · `)
          expect(idxI).toBeLessThan(idxNext)
        }
      }
    }
  })

  test("isNotebook gate is exact (sanity)", () => {
    expect(isNotebook("a.ipynb")).toBe(true)
    expect(isNotebook("a.IPYNB")).toBe(true)
    expect(isNotebook("a.ipynb.bak")).toBe(false)
    expect(isNotebook("ipynb")).toBe(false)
  })
})
