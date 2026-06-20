/**
 * Hellgate — T-4 microchunk routing (jun-20 multi-auth fleet).
 *
 * Microchunking is the cheap path to per-problem parallelism. The teeth:
 *  - chunkSize=1 yields one instance per chunk,
 *  - runIds are unique, deterministic, and stably ordered (no collision),
 *  - slices carry ONLY verbatim source lines (no token material injected),
 *  - the pool consumes the produced chunks unchanged.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assertUniqueChunkRunIds } from "../../src/apps/bench/remote/pool"
import {
  baseRunIdFromPath,
  planMicrochunks,
  writeMicrochunks,
} from "../../src/apps/bench/slicing/microchunk"

const row = (id: string): string =>
  JSON.stringify({ instance_id: id, repo: "demo/repo", base_commit: "0".repeat(40) })

const DATASET = [row("django__django-1"), row("sklearn__sklearn-2"), row("sympy__sympy-3")].join("\n")

describe("T-4 planMicrochunks (pure)", () => {
  test("chunkSize=1 ⇒ one instance per chunk, order preserved", () => {
    const chunks = planMicrochunks(DATASET, "ds", 1)
    expect(chunks.length).toBe(3)
    expect(chunks.map((c) => c.instanceIds)).toEqual([
      ["django__django-1"],
      ["sklearn__sklearn-2"],
      ["sympy__sympy-3"],
    ])
  })

  test("runIds are unique, FS-safe, and zero-padded for lexicographic run order", () => {
    const many = Array.from({ length: 12 }, (_v, i) => row(`r__r-${i}`)).join("\n")
    const chunks = planMicrochunks(many, "big", 1)
    const ids = chunks.map((c) => c.runId)
    expect(new Set(ids).size).toBe(ids.length) // unique
    // TEETH on the PADDING specifically (deleting padStart turns these red): with
    // 12 chunks the ordinal width is 2, so chunk 1 is `big-01-…` and chunk 10 is
    // `big-10-…`. An unpadded impl would emit `big-1-…`/`big-10-…` and fail the first.
    expect(ids[0]).toMatch(/^big-01-/)
    expect(ids[8]).toMatch(/^big-09-/)
    expect(ids[9]).toMatch(/^big-10-/)
    // and zero-padding makes lexicographic sort == run order even when SHUFFLED
    const shuffled = [ids[5], ids[0], ids[11], ids[2]].filter((x): x is string => x !== undefined)
    expect([...shuffled].sort()).toEqual([ids[0], ids[2], ids[5], ids[11]])
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]+$/) // no slashes/spaces
  })

  test("deterministic — same input twice ⇒ identical runIds", () => {
    expect(planMicrochunks(DATASET, "ds", 1).map((c) => c.runId)).toEqual(
      planMicrochunks(DATASET, "ds", 1).map((c) => c.runId),
    )
  })

  test("chunkSize>1 groups instances and pads ordinals", () => {
    const chunks = planMicrochunks(DATASET, "ds", 2)
    expect(chunks.length).toBe(2)
    expect(chunks[0]?.instanceIds).toEqual(["django__django-1", "sklearn__sklearn-2"])
    expect(chunks[1]?.instanceIds).toEqual(["sympy__sympy-3"])
  })

  test("duplicate instance ids still yield unique runIds (ordinal prefix saves it)", () => {
    const dup = [row("same__x-1"), row("same__x-1")].join("\n")
    const chunks = planMicrochunks(dup, "ds", 1)
    expect(new Set(chunks.map((c) => c.runId)).size).toBe(2)
  })

  test("blank lines skipped; empty dataset ⇒ no chunks", () => {
    expect(planMicrochunks("\n\n  \n", "ds", 1)).toEqual([])
  })

  test("slice lines are VERBATIM from the source (no rewriting / no token bytes)", () => {
    const chunks = planMicrochunks(DATASET, "ds", 1)
    expect(chunks[0]?.lines).toEqual([row("django__django-1")])
    // round-trips to the exact source object — proves nothing is injected
    expect(JSON.parse(chunks[0]?.lines[0] ?? "{}").instance_id).toBe("django__django-1")
  })
})

describe("T-4 writeMicrochunks (filesystem) ↔ pool", () => {
  test("materializes slices the pool accepts, with no token material on disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "microchunk-"))
    try {
      const dsPath = join(dir, "verified.jsonl")
      const fs = require("node:fs") as typeof import("node:fs")
      fs.writeFileSync(dsPath, `${DATASET}\n`)
      const outDir = join(dir, "slices")
      const chunks = writeMicrochunks({ datasetPath: dsPath, chunkSize: 1, outDir })
      expect(chunks.length).toBe(3)
      // the pool's own uniqueness guard accepts them unchanged
      expect(() =>
        assertUniqueChunkRunIds(chunks.map((c) => ({ runId: c.runId, datasetPath: c.datasetPath }))),
      ).not.toThrow()
      // each slice file holds exactly its instance line(s) — and zero auth bytes
      for (const c of chunks) {
        const body = readFileSync(c.datasetPath, "utf8")
        expect(body.trim().split("\n").length).toBe(1)
        expect(body).not.toMatch(/access_token|refresh_token|id_token|chatgpt\.json/)
      }
      // no stray files beyond the 3 slices
      expect(readdirSync(outDir).filter((f) => f.endsWith(".jsonl")).length).toBe(3)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("baseRunIdFromPath strips extension and sanitizes", () => {
    expect(baseRunIdFromPath("/a/b/SWE bench.verified.jsonl")).toBe("SWE_bench_verified")
  })
})
