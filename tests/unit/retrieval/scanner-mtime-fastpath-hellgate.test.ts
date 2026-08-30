/**
 * HELLGATE — G9-04 / G9-15: the stat-signature (mtimeMs+size) fast path
 * promised by `delta-tracker.ts`'s docstring must actually exist.
 *
 * `scanDelta` runs on a 5s interval (runner/assemble/search-pipeline.ts);
 * without the fast path every tick re-reads, re-sha1s and re-chunks the
 * ENTIRE corpus (and re-parses under QUANTA_SYNTAX_CHUNK). These proofs:
 *
 *   FP-01  second scan with NO changes performs ZERO content reads
 *          (readFile spy, with a built-in wiring control: the FIRST scan
 *          through the same spy shows >0 reads, so a silent spy cannot
 *          fake a pass).
 *   FP-02  paired control — a modified file IS re-read and re-chunked
 *          (corpus serves the NEW content), while the untouched sibling
 *          is not re-read.
 *   FP-03  knob ON + parser: an unchanged corpus is NOT re-parsed on the
 *          delta tick; a modified file IS re-parsed.
 *   FP-04  deletions are still detected with a warm fast-path cache.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { promises as fsp } from "node:fs"
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ParseOutcome } from "@/retrieval/code-parser"
import { fakeParser } from "@/retrieval/code-parser"
import { createDefaultIndexer, type FileChunk } from "@/retrieval/indexer"
import { __resetRuntimeConfig } from "@/shared"

const SCAN_GLOB = "**/*.ts"

let tmp = ""
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "scanner-fastpath-"))
})
afterEach(async () => {
  delete process.env.QUANTA_SYNTAX_CHUNK
  __resetRuntimeConfig()
  try {
    await rm(tmp, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

/** CONTENT reads under `root`: corpus `.ts` files only. The spy also sees
 *  `loadIgnore`'s `.gitignore`/`.quantaignore` probes (config, re-read every
 *  scan by design) and unrelated reads from the surrounding process. */
const readsUnder = (calls: readonly unknown[][], root: string): number =>
  calls.filter((c) => String(c[0]).startsWith(root) && String(c[0]).endsWith(".ts")).length

const corpusOf = (ix: ReturnType<typeof createDefaultIndexer>): readonly FileChunk[] =>
  Array.from(ix.getCorpus())

describe("scanner stat-signature fast path (G9-04)", () => {
  test("FP-01 no-change delta tick does ZERO content reads (first scan proves the spy is live)", async () => {
    for (let i = 0; i < 5; i++) {
      await writeFile(join(tmp, `f${i}.ts`), `export const x${i} = ${i}\n`)
    }
    const ix = createDefaultIndexer({ scanner: { root: tmp, glob: SCAN_GLOB } })
    const spy = spyOn(fsp, "readFile")
    try {
      const r1 = await ix.scanInitial()
      expect(r1.ok).toBe(true)
      // Wiring control: the spy DOES observe the scanner's reads.
      expect(readsUnder(spy.mock.calls, tmp)).toBe(5)
      spy.mockClear()
      const r2 = await ix.scanDelta()
      expect(r2.ok).toBe(true)
      if (!r2.ok) throw new Error("unreachable")
      expect(r2.value.added).toBe(0)
      expect(r2.value.modified).toBe(0)
      expect(r2.value.deleted).toBe(0)
      // THE fast path: nothing changed ⇒ no file content is read again.
      expect(readsUnder(spy.mock.calls, tmp)).toBe(0)
    } finally {
      spy.mockRestore()
      ix.stop()
    }
  })

  test("FP-02 paired control — a modified file IS re-read and re-chunked; its sibling is not", async () => {
    await writeFile(join(tmp, "hot.ts"), "export const hot = 1\n")
    await writeFile(join(tmp, "cold.ts"), "export const cold = 1\n")
    const ix = createDefaultIndexer({ scanner: { root: tmp, glob: SCAN_GLOB } })
    const r1 = await ix.scanInitial()
    expect(r1.ok).toBe(true)
    // Bump mtime past filesystem timestamp granularity, then rewrite.
    await new Promise((res) => setTimeout(res, 20))
    await writeFile(join(tmp, "hot.ts"), "export const hot = 999 // CHANGED\n")
    const spy = spyOn(fsp, "readFile")
    try {
      const r2 = await ix.scanDelta()
      expect(r2.ok).toBe(true)
      if (!r2.ok) throw new Error("unreachable")
      expect(r2.value.modified).toBe(1)
      const reads = spy.mock.calls
        .map((c) => String(c[0]))
        .filter((p) => p.startsWith(tmp) && p.endsWith(".ts"))
      expect(reads).toContain(join(tmp, "hot.ts"))
      expect(reads).not.toContain(join(tmp, "cold.ts"))
      // Re-processing is REAL: the corpus serves the new content.
      const hotChunks = corpusOf(ix).filter((c) => c.path === "hot.ts")
      expect(hotChunks.length).toBeGreaterThan(0)
      expect(hotChunks.some((c) => c.text.includes("CHANGED"))).toBe(true)
    } finally {
      spy.mockRestore()
      ix.stop()
    }
  })

  test("FP-03 QUANTA_SYNTAX_CHUNK: no-change tick does not re-parse; a change re-parses", async () => {
    await writeFile(join(tmp, "a.ts"), "export const a = 1\n")
    await writeFile(join(tmp, "b.ts"), "export const b = 1\n")
    process.env.QUANTA_SYNTAX_CHUNK = "1"
    __resetRuntimeConfig()
    // Empty table ⇒ every parse returns {ok:false} and the line-window
    // fallback chunks; only the CALL COUNT matters here.
    const fp = fakeParser(new Map<string, ParseOutcome>())
    const ix = createDefaultIndexer({ scanner: { root: tmp, glob: SCAN_GLOB }, parser: fp })
    const r1 = await ix.scanInitial()
    expect(r1.ok).toBe(true)
    expect(fp.calls()).toBe(2)
    const r2 = await ix.scanDelta()
    expect(r2.ok).toBe(true)
    // Unchanged corpus ⇒ zero tree-sitter re-parses on the tick.
    expect(fp.calls()).toBe(2)
    await new Promise((res) => setTimeout(res, 20))
    await writeFile(join(tmp, "a.ts"), "export const a = 2\n")
    const r3 = await ix.scanDelta()
    expect(r3.ok).toBe(true)
    if (!r3.ok) throw new Error("unreachable")
    expect(r3.value.modified).toBe(1)
    // Paired control: the changed file alone is re-parsed.
    expect(fp.calls()).toBe(3)
    ix.stop()
  })

  test("FP-04 deletion is still detected with a warm fast-path cache", async () => {
    await writeFile(join(tmp, "a.ts"), "x\n")
    await writeFile(join(tmp, "b.ts"), "y\n")
    const ix = createDefaultIndexer({ scanner: { root: tmp, glob: SCAN_GLOB } })
    await ix.scanInitial()
    const warm = await ix.scanDelta() // warm the cache first
    expect(warm.ok).toBe(true)
    await unlink(join(tmp, "b.ts"))
    const r = await ix.scanDelta()
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.value.deleted).toBe(1)
    expect(corpusOf(ix).map((c) => c.path)).not.toContain("b.ts")
    ix.stop()
  })
})
