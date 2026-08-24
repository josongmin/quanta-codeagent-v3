/**
 * HELLGATE — `src/retrieval/indexer/default-scanner.ts` `chunkOneFile`
 * knob branch (RFC jun-6 §4.3, default-scanner.ts:~73-95).
 *
 * Round-1 gap: the syntax-aware branch in `chunkOneFile` — gated by
 * `QUANTA_SYNTAX_CHUNK` AND a wired `parser` — was never exercised through
 * `createDefaultIndexer`. The three load-bearing arms:
 *
 *   1. knob ON  + parser wired (ok:true)  ⇒ AST-aligned syntactic chunks emitted.
 *   2. knob ON  + parser THROWS           ⇒ scan still completes via the
 *                                            line-window `chunkFile` fallback
 *                                            (the defensive `catch` path).
 *   3. knob OFF + parser wired            ⇒ parser NEVER consulted; output is
 *                                            byte-identical to the line-window.
 *
 * Drives a FAKE `CodeParserPort` (no real WASM / grammar) into the real
 * indexer over a temp workspace. Determinism: synthetic line markers.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CodeParserPort, ParsedFile, ParseOutcome } from "@/retrieval/code-parser"
import { fakeParser } from "@/retrieval/code-parser"
import { createDefaultIndexer, type FileChunk } from "@/retrieval/indexer"
import { __resetRuntimeConfig } from "@/shared"
import { nth } from "../../_helpers/expect-present"

const SCAN_GLOB = "**/*.ts"

let tmp = ""
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "scanner-syntax-"))
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

/** N lines of `Lk` markers (1-based), newline-terminated. */
const linesFile = (n: number): string =>
  `${Array.from({ length: n }, (_, i) => `L${i + 1}`).join("\n")}\n`

const collectCorpus = (ix: ReturnType<typeof createDefaultIndexer>): readonly FileChunk[] =>
  Array.from(ix.getCorpus())

describe("default-scanner chunkOneFile — knob ON + parser (ok:true) ⇒ syntactic chunks", () => {
  test("AST-aligned chunks are emitted (one chunk per oversized decl, not line-windows)", async () => {
    // A 300-line file whose ONLY decls are two oversized functions. The
    // syntactic chunker emits one whole-decl chunk per function; the
    // line-window chunker (window 50 / overlap 20) would emit ~8 overlapping
    // chunks. The shapes are distinguishable.
    const text = linesFile(300)
    await writeFile(join(tmp, "a.ts"), text)

    const parsed: ParsedFile = {
      lang: "typescript",
      decls: [
        {
          kind: "function",
          name: "first",
          startLine: 1,
          endLine: 150,
          signatureEndLine: 1,
          children: [],
        },
        {
          kind: "function",
          name: "second",
          startLine: 151,
          endLine: 300,
          signatureEndLine: 151,
          children: [],
        },
      ],
    }
    // Key the fake parser's table by the EXACT file text the scanner reads.
    const fp = fakeParser(new Map<string, ParseOutcome>([[text, { ok: true, parsed }]]))

    process.env.QUANTA_SYNTAX_CHUNK = "1"
    __resetRuntimeConfig()

    const ix = createDefaultIndexer({
      scanner: { root: tmp, glob: SCAN_GLOB },
      parser: fp,
      // maxLinesSplit large enough that each 150-line leaf stays whole.
      chunker: { windowLines: 50, overlapLines: 20 },
    })
    const r = await ix.scanInitial()
    expect(r.ok).toBe(true)

    const chunks = collectCorpus(ix).filter((c) => c.path === "a.ts")
    // Parser WAS consulted exactly once for the file.
    expect(fp.calls()).toBe(1)
    // Two decl-aligned chunks, contiguous & non-overlapping, covering [1,300].
    const sorted = [...chunks].sort((x, y) => x.startLine - y.startLine)
    expect(sorted.length).toBe(2)
    expect(nth(sorted, 0, "sorted").startLine).toBe(1)
    expect(nth(sorted, 0, "sorted").endLine).toBe(150)
    expect(nth(sorted, 1, "sorted").startLine).toBe(151)
    expect(nth(sorted, 1, "sorted").endLine).toBe(300)
    ix.stop()
  })

  test("the syntactic output DIFFERS from the line-window output (proves branch taken)", async () => {
    const text = linesFile(300)
    await writeFile(join(tmp, "a.ts"), text)
    const parsed: ParsedFile = {
      lang: "typescript",
      decls: [
        {
          kind: "function",
          name: "whole",
          startLine: 1,
          endLine: 300,
          signatureEndLine: 1,
          children: [],
        },
      ],
    }
    const fp = fakeParser(new Map<string, ParseOutcome>([[text, { ok: true, parsed }]]))
    process.env.QUANTA_SYNTAX_CHUNK = "1"
    __resetRuntimeConfig()
    const ix = createDefaultIndexer({
      scanner: { root: tmp, glob: SCAN_GLOB },
      parser: fp,
      // maxLinesSplit not set ⇒ default 150 < 300 ⇒ leaf line-window split,
      // but with the syntactic window default, not the chunker's overlap. The
      // outcome differs from chunkFile's overlapping windows regardless.
      chunker: { windowLines: 50, overlapLines: 20 },
    })
    await ix.scanInitial()
    const synChunks = collectCorpus(ix).filter((c) => c.path === "a.ts")

    // Build the line-window baseline by scanning the SAME file with the knob OFF.
    delete process.env.QUANTA_SYNTAX_CHUNK
    __resetRuntimeConfig()
    const ix2 = createDefaultIndexer({
      scanner: { root: tmp, glob: SCAN_GLOB },
      parser: fp,
      chunker: { windowLines: 50, overlapLines: 20 },
    })
    await ix2.scanInitial()
    const winChunks = collectCorpus(ix2).filter((c) => c.path === "a.ts")

    const fingerprint = (cs: readonly FileChunk[]): string =>
      [...cs]
        .sort((a, b) => a.startLine - b.startLine)
        .map((c) => `${c.startLine}-${c.endLine}`)
        .join(",")
    expect(fingerprint(synChunks)).not.toBe(fingerprint(winChunks))
    ix.stop()
    ix2.stop()
  })
})

describe("default-scanner chunkOneFile — knob ON + parser THROWS ⇒ line-window fallback", () => {
  test("scan completes and falls back to line-window chunks when parse() rejects", async () => {
    const text = linesFile(120)
    await writeFile(join(tmp, "a.ts"), text)

    let parseCalls = 0
    // A NON-conformant parser that violates the NO-THROW contract — the
    // scanner's defensive `catch` must absorb it and fall back.
    const throwingParser: CodeParserPort = {
      async parse(): Promise<ParseOutcome> {
        parseCalls += 1
        throw new Error("synthetic parser fault")
      },
    }

    process.env.QUANTA_SYNTAX_CHUNK = "1"
    __resetRuntimeConfig()

    const ix = createDefaultIndexer({
      scanner: { root: tmp, glob: SCAN_GLOB },
      parser: throwingParser,
      chunker: { windowLines: 50, overlapLines: 20 },
    })
    const r = await ix.scanInitial()

    // Scan SUCCEEDED despite the throw (no error surfaced past the boundary).
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.value.filesScanned).toBe(1)
    expect(parseCalls).toBe(1)

    // Output equals the pure line-window chunker: 120 lines, window 50 /
    // overlap 20 ⇒ step 30 ⇒ chunks at [1-50],[31-80],[61-110],[91-120].
    const chunks = collectCorpus(ix)
      .filter((c) => c.path === "a.ts")
      .sort((a, b) => a.startLine - b.startLine)
    expect(chunks.length).toBe(4)
    expect(nth(chunks, 0, "chunks").startLine).toBe(1)
    expect(nth(chunks, 0, "chunks").endLine).toBe(50)
    expect(nth(chunks, 1, "chunks").startLine).toBe(31)
    expect(nth(chunks, chunks.length - 1, "chunks").endLine).toBe(120)
    ix.stop()
  })

  test("a throwing parser over a multi-file workspace still scans every file", async () => {
    for (let i = 0; i < 5; i++) {
      await writeFile(join(tmp, `f${i}.ts`), linesFile(10))
    }
    const throwingParser: CodeParserPort = {
      async parse(): Promise<ParseOutcome> {
        throw new Error("boom")
      },
    }
    process.env.QUANTA_SYNTAX_CHUNK = "1"
    __resetRuntimeConfig()
    const ix = createDefaultIndexer({
      scanner: { root: tmp, glob: SCAN_GLOB },
      parser: throwingParser,
    })
    const r = await ix.scanInitial()
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.value.filesScanned).toBe(5)
    // Each 10-line file ⇒ exactly one line-window chunk.
    expect(collectCorpus(ix).length).toBe(5)
    ix.stop()
  })
})

describe("default-scanner chunkOneFile — knob OFF ⇒ parser never consulted", () => {
  test("knob off + parser wired ⇒ byte-identical to line-window, parser calls == 0", async () => {
    const text = linesFile(120)
    await writeFile(join(tmp, "a.ts"), text)
    // ok:true table that, IF consulted, would produce a single whole-file
    // syntactic chunk — distinguishable from the 4 overlapping windows.
    const parsed: ParsedFile = {
      lang: "typescript",
      decls: [
        {
          kind: "function",
          name: "w",
          startLine: 1,
          endLine: 60,
          signatureEndLine: 1,
          children: [],
        },
      ],
    }
    const fp = fakeParser(new Map<string, ParseOutcome>([[text, { ok: true, parsed }]]))

    // Knob OFF (env unset).
    delete process.env.QUANTA_SYNTAX_CHUNK
    __resetRuntimeConfig()

    const ix = createDefaultIndexer({
      scanner: { root: tmp, glob: SCAN_GLOB },
      parser: fp,
      chunker: { windowLines: 50, overlapLines: 20 },
    })
    const r = await ix.scanInitial()
    expect(r.ok).toBe(true)
    // Parser NEVER consulted when the knob is off.
    expect(fp.calls()).toBe(0)
    // Line-window output: 4 chunks (the same as the throwing-fallback case).
    const chunks = collectCorpus(ix)
      .filter((c) => c.path === "a.ts")
      .sort((a, b) => a.startLine - b.startLine)
    expect(chunks.length).toBe(4)
    expect(nth(chunks, 0, "chunks").endLine).toBe(50)
    ix.stop()
  })

  test("knob unparseable value (not a gate-on token) ⇒ treated as OFF", async () => {
    const text = linesFile(30)
    await writeFile(join(tmp, "a.ts"), text)
    const fp = fakeParser(
      new Map<string, ParseOutcome>([
        [text, { ok: true, parsed: { lang: "typescript", decls: [] } }],
      ]),
    )
    process.env.QUANTA_SYNTAX_CHUNK = "maybe"
    __resetRuntimeConfig()
    const ix = createDefaultIndexer({
      scanner: { root: tmp, glob: SCAN_GLOB },
      parser: fp,
    })
    await ix.scanInitial()
    expect(fp.calls()).toBe(0)
    ix.stop()
  })
})
