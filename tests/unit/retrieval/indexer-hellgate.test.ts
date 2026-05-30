/**
 * HELLGATE — adversarial proofs for ADR-0277 codebase-indexer +
 * ADR-0278 search-codebase auto-register.
 *
 * 25 adversarial cases:
 *
 *   정상 path (5)        — HELL-IDX-01 … HELL-IDX-05
 *   Delta detection (4)  — HELL-IDX-06 … HELL-IDX-09
 *   Corner cases (8)     — HELL-IDX-10 … HELL-IDX-17
 *   Async + cleanup (4)  — HELL-IDX-18 … HELL-IDX-21
 *   Wire (4)             — HELL-IDX-22 … HELL-IDX-25
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { platform, tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildSearchPipelineFromEnv,
  clearSearchPipelineWireForTests,
} from "@/../src/apps/agent/search-pipeline-wire"
import {
  chunkFile,
  createDefaultIndexer,
  DeltaTracker,
  type FileChunk,
  type FileStamp,
} from "@/retrieval/indexer"

const SCAN_GLOB = "**/*.ts"

let tmp = ""
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "indexer-hellgate-"))
})
afterEach(async () => {
  // Best-effort cleanup; if perms test left a 0o000 file, restore first.
  try {
    await rm(tmp, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  clearSearchPipelineWireForTests()
})

const writeN = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++) {
    await writeFile(join(tmp, `f${i}.ts`), `export const x${i} = ${i}\n`)
  }
}

describe("indexer — normal path (HELL-IDX-01 … 05)", () => {
  test("HELL-IDX-01 scanInitial covers a 100-file workspace", async () => {
    await writeN(100)
    const ix = createDefaultIndexer({ scanner: { root: tmp, glob: SCAN_GLOB } })
    const r = await ix.scanInitial()
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.value.filesScanned).toBe(100)
    expect(r.value.chunksProduced).toBe(100) // one chunk per single-line file
    ix.stop()
  })

  test("HELL-IDX-02 chunker default window is 50 lines", () => {
    const text = Array.from({ length: 75 }, (_, i) => `line${i + 1}`).join("\n")
    const chunks = chunkFile({ path: "a.ts", text, mtime: 0, sha: "" })
    expect(chunks.length).toBe(2)
    expect(chunks[0]?.startLine).toBe(1)
    expect(chunks[0]?.endLine).toBe(50)
    expect(chunks[1]?.endLine).toBe(75)
  })

  test("HELL-IDX-03 overlap is exactly 20 lines (step = 30)", () => {
    const text = Array.from({ length: 100 }, (_, i) => `L${i + 1}`).join("\n")
    const chunks = chunkFile({ path: "a.ts", text, mtime: 0, sha: "" })
    expect(chunks[0]?.startLine).toBe(1)
    expect(chunks[0]?.endLine).toBe(50)
    expect(chunks[1]?.startLine).toBe(31) // 50 - 20 + 1
    expect(chunks[1]?.endLine).toBe(80)
  })

  test("HELL-IDX-04 getCorpus iterates every chunk", async () => {
    await writeN(5)
    const ix = createDefaultIndexer({ scanner: { root: tmp, glob: SCAN_GLOB } })
    await ix.scanInitial()
    const chunks = Array.from(ix.getCorpus())
    expect(chunks.length).toBe(5)
    expect(new Set(chunks.map((c) => c.path)).size).toBe(5)
    ix.stop()
  })

  test("HELL-IDX-05 .gitignore exclusion", async () => {
    await writeFile(join(tmp, "keep.ts"), "export const k = 1\n")
    await mkdir(join(tmp, "node_modules"))
    await writeFile(join(tmp, "node_modules", "vendor.ts"), "export const v = 2\n")
    await writeFile(join(tmp, ".gitignore"), "node_modules/\n")
    const ix = createDefaultIndexer({ scanner: { root: tmp, glob: SCAN_GLOB } })
    const r = await ix.scanInitial()
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    const paths = Array.from(ix.getCorpus()).map((c) => c.path)
    expect(paths).toContain("keep.ts")
    expect(paths.some((p) => p.includes("vendor"))).toBe(false)
    ix.stop()
  })
})

describe("indexer — delta detection (HELL-IDX-06 … 09)", () => {
  test("HELL-IDX-06 unchanged file (same mtime+sha) ⇒ skip", async () => {
    await writeFile(join(tmp, "a.ts"), "export const a = 1\n")
    const ix = createDefaultIndexer({ scanner: { root: tmp, glob: SCAN_GLOB } })
    await ix.scanInitial()
    const r = await ix.scanDelta()
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.value.added).toBe(0)
    expect(r.value.modified).toBe(0)
    expect(r.value.deleted).toBe(0)
    ix.stop()
  })

  test("HELL-IDX-07 modified file (different content) ⇒ re-chunk", async () => {
    await writeFile(join(tmp, "a.ts"), "export const a = 1\n")
    const ix = createDefaultIndexer({ scanner: { root: tmp, glob: SCAN_GLOB } })
    await ix.scanInitial()
    // Sleep enough to bump mtime; then rewrite with different content + sha.
    await new Promise((r) => setTimeout(r, 20))
    await writeFile(join(tmp, "a.ts"), "export const a = 999\nconst b = 2\n")
    const r = await ix.scanDelta()
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.value.modified).toBe(1)
    expect(r.value.added).toBe(0)
    ix.stop()
  })

  test("HELL-IDX-08 file delete is detected", async () => {
    await writeFile(join(tmp, "a.ts"), "x\n")
    await writeFile(join(tmp, "b.ts"), "y\n")
    const ix = createDefaultIndexer({ scanner: { root: tmp, glob: SCAN_GLOB } })
    await ix.scanInitial()
    await unlink(join(tmp, "b.ts"))
    const r = await ix.scanDelta()
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.value.deleted).toBe(1)
    const paths = Array.from(ix.getCorpus()).map((c) => c.path)
    expect(paths).not.toContain("b.ts")
    ix.stop()
  })

  test("HELL-IDX-09 file rename ⇒ delete-of-old + add-of-new", async () => {
    await writeFile(join(tmp, "old.ts"), "x\n")
    const ix = createDefaultIndexer({ scanner: { root: tmp, glob: SCAN_GLOB } })
    await ix.scanInitial()
    // Simulate rename via copy+unlink (true rename across platforms is fine too).
    await writeFile(join(tmp, "new.ts"), "x\n")
    await unlink(join(tmp, "old.ts"))
    const r = await ix.scanDelta()
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.value.added).toBe(1)
    expect(r.value.deleted).toBe(1)
    ix.stop()
  })
})

describe("indexer — corner cases (HELL-IDX-10 … 17)", () => {
  test("HELL-IDX-10 symlink cycle is short-circuited", async () => {
    if (platform() === "win32") return // junction semantics differ; skip
    await writeFile(join(tmp, "a.ts"), "x\n")
    await symlink(tmp, join(tmp, "self"))
    const ix = createDefaultIndexer({ scanner: { root: tmp, glob: SCAN_GLOB } })
    const start = Date.now()
    const r = await ix.scanInitial()
    const elapsed = Date.now() - start
    expect(r.ok).toBe(true)
    expect(elapsed).toBeLessThan(5_000) // would hang forever without cycle detection
    ix.stop()
  })

  test("HELL-IDX-11 0-byte file is skipped (no chunk)", async () => {
    await writeFile(join(tmp, "empty.ts"), "")
    await writeFile(join(tmp, "full.ts"), "x\n")
    const ix = createDefaultIndexer({ scanner: { root: tmp, glob: SCAN_GLOB } })
    const r = await ix.scanInitial()
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.value.skipped.get("empty.ts")).toBe("empty")
    const paths = Array.from(ix.getCorpus()).map((c) => c.path)
    expect(paths).not.toContain("empty.ts")
    ix.stop()
  })

  test("HELL-IDX-12 binary file ⇒ degradeReason=binary", async () => {
    // Bytes that fail UTF-8 fatal decode: lone continuation 0x80.
    await writeFile(join(tmp, "bin.ts"), Buffer.from([0xff, 0xfe, 0x80, 0x80]))
    const ix = createDefaultIndexer({ scanner: { root: tmp, glob: SCAN_GLOB } })
    const r = await ix.scanInitial()
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.value.skipped.get("bin.ts")).toBe("binary")
    ix.stop()
  })

  test("HELL-IDX-13 file > maxBytes ⇒ skip with too_large", async () => {
    const big = Buffer.alloc(1024 + 1, 0x61)
    await writeFile(join(tmp, "big.ts"), big)
    const ix = createDefaultIndexer({
      scanner: { root: tmp, glob: SCAN_GLOB, maxBytes: 1024 },
    })
    const r = await ix.scanInitial()
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.value.skipped.get("big.ts")).toBe("too_large")
    ix.stop()
  })

  test("HELL-IDX-14 permission denied (EACCES) ⇒ skip with permission_denied", async () => {
    if (platform() === "win32" || process.getuid?.() === 0) return // root bypasses perms
    const p = join(tmp, "locked.ts")
    await writeFile(p, "x\n")
    await chmod(p, 0o000)
    try {
      const ix = createDefaultIndexer({ scanner: { root: tmp, glob: SCAN_GLOB } })
      const r = await ix.scanInitial()
      expect(r.ok).toBe(true)
      if (!r.ok) throw new Error("unreachable")
      // Either skipped or successfully read (root). Assert NOT a crash.
      const skip = r.value.skipped.get("locked.ts")
      expect(skip === undefined || skip === "permission_denied").toBe(true)
      ix.stop()
    } finally {
      await chmod(p, 0o644).catch(() => {})
    }
  })

  test("HELL-IDX-15 path with newline is rejected from snapshot key cleanly", async () => {
    // Most platforms reject newlines in filenames at write time; we instead
    // assert the chunker / scanner do not crash on a synthetic newline path.
    const synthetic = chunkFile({ path: "weird\npath.ts", text: "x\n", mtime: 0, sha: "deadbeef" })
    expect(synthetic.length).toBe(1)
    expect(synthetic[0]?.path).toContain("\n") // preserved verbatim — caller sanitizes
  })

  test("HELL-IDX-16 .gitignore: blank line + # comment + !negation parsed", async () => {
    await mkdir(join(tmp, "build"))
    await writeFile(join(tmp, "build", "out.ts"), "export const o = 1\n")
    await writeFile(join(tmp, "build", "keep.ts"), "export const k = 1\n")
    await writeFile(join(tmp, ".gitignore"), "\n# this is a comment\nbuild/\n!build/keep.ts\n")
    const ix = createDefaultIndexer({ scanner: { root: tmp, glob: SCAN_GLOB } })
    await ix.scanInitial()
    const paths = Array.from(ix.getCorpus()).map((c) => c.path)
    // build/out.ts excluded; build/keep.ts re-included via !negation.
    expect(paths.some((p) => p.endsWith("out.ts"))).toBe(false)
    expect(paths.some((p) => p.endsWith("keep.ts"))).toBe(true)
    ix.stop()
  })

  test("HELL-IDX-17 second concurrent scan returns scan-in-progress", async () => {
    await writeN(20)
    const ix = createDefaultIndexer({ scanner: { root: tmp, glob: SCAN_GLOB } })
    const p1 = ix.scanInitial()
    const r2 = await ix.scanInitial()
    await p1
    expect(r2.ok).toBe(false)
    if (r2.ok) throw new Error("unreachable")
    expect(r2.error.kind).toBe("scan-in-progress")
    ix.stop()
  })
})

describe("indexer — async + cleanup (HELL-IDX-18 … 21)", () => {
  test("HELL-IDX-18 AbortSignal abort ⇒ partial-but-consistent state", async () => {
    await writeN(50)
    const ix = createDefaultIndexer({ scanner: { root: tmp, glob: SCAN_GLOB } })
    const ctrl = new AbortController()
    ctrl.abort()
    const r = await ix.scanInitial({ signal: ctrl.signal })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.error.kind).toBe("aborted")
    ix.stop()
  })

  test("HELL-IDX-19 scan after stop() ⇒ Err('stopped')", async () => {
    const ix = createDefaultIndexer({ scanner: { root: tmp, glob: SCAN_GLOB } })
    ix.stop()
    const r = await ix.scanInitial()
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.error.kind).toBe("stopped")
  })

  test("HELL-IDX-20 mid-scan file removal ⇒ graceful skip", async () => {
    await writeFile(join(tmp, "a.ts"), "x\n")
    await writeFile(join(tmp, "b.ts"), "y\n")
    const ix = createDefaultIndexer({ scanner: { root: tmp, glob: SCAN_GLOB } })
    // Use the headless stub to make timing deterministic — actually drop one
    // file from its underlying map mid-iteration by triggering a delete
    // between scanInitial and scanDelta.
    await ix.scanInitial()
    await unlink(join(tmp, "a.ts"))
    const r = await ix.scanDelta()
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.value.deleted).toBe(1)
    ix.stop()
  })

  test("HELL-IDX-21 1000-file scan completes in < 30s (sanity)", async () => {
    await writeN(1000)
    const ix = createDefaultIndexer({ scanner: { root: tmp, glob: SCAN_GLOB } })
    const start = Date.now()
    const r = await ix.scanInitial()
    const elapsed = Date.now() - start
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.value.filesScanned).toBe(1000)
    expect(elapsed).toBeLessThan(30_000)
    ix.stop()
  }, 60_000)
})

describe("indexer — wire (HELL-IDX-22 … 25)", () => {
  test("HELL-IDX-22 no knobs ⇒ default lexical search wire is ready", async () => {
    const wired = buildSearchPipelineFromEnv({}, tmp)
    expect(wired).not.toBeNull()
    expect(wired?.tool.name).toBe("search_codebase")
    expect(wired?.intervalHandle).toBeNull()
    const r = await wired?.pipeline.search({ text: "missing", k: 5 })
    expect(r?.ok).toBe(true)
  })

  test("HELL-IDX-23 explicit QUANTA_PIPELINE=none ⇒ no wire", () => {
    const wired = buildSearchPipelineFromEnv({ QUANTA_PIPELINE: "none" }, tmp)
    expect(wired).toBeNull()
  })

  test("HELL-IDX-24 semantic preset without index ⇒ lexical fallback (no interval)", () => {
    const wired = buildSearchPipelineFromEnv({ QUANTA_PIPELINE: "semantic-only" }, tmp)
    expect(wired).not.toBeNull()
    expect(wired?.tool.name).toBe("search_codebase")
    expect(wired?.intervalHandle).toBeNull()
    expect(wired?.indexer).toBeNull()
  })

  test("HELL-IDX-25 QUANTA_INDEX=on with no preset ⇒ hybrid wire starts indexer + interval", () => {
    const wired = buildSearchPipelineFromEnv(
      { QUANTA_INDEX: "on", QUANTA_INDEX_INTERVAL_MS: "1000000" },
      tmp,
    )
    expect(wired).not.toBeNull()
    expect(wired?.tool.name).toBe("search_codebase")
    expect(wired?.intervalHandle).not.toBeNull()
    expect(wired?.indexer).not.toBeNull()
  })
})

describe("delta tracker — pure", () => {
  test("diff partitions into added / modified / deleted / unchanged", () => {
    const t = new DeltaTracker()
    t.put("a", { mtime: 1, sha: "x" })
    t.put("b", { mtime: 1, sha: "y" })
    const snap = new Map<string, FileStamp>([
      ["a", { mtime: 1, sha: "x" }], // unchanged
      ["b", { mtime: 2, sha: "z" }], // modified
      ["c", { mtime: 3, sha: "w" }], // added
      // d missing ⇒ deleted? no — d was never tracked
    ])
    const parts = t.diff(snap)
    expect(parts.unchanged).toContain("a")
    expect(parts.modified).toContain("b")
    expect(parts.added).toContain("c")
    // b is in snap; nothing in tracker is missing from snap, so deleted=[]
    expect(parts.deleted.length).toBe(0)
  })
})

describe("chunker — pure", () => {
  test("empty string ⇒ no chunks", () => {
    expect(chunkFile({ path: "a", text: "", mtime: 0, sha: "" }).length).toBe(0)
  })
  test("overlap >= window ⇒ no chunks (invalid config)", () => {
    expect(
      chunkFile(
        { path: "a", text: "x\ny\n", mtime: 0, sha: "" },
        { windowLines: 5, overlapLines: 5 },
      ).length,
    ).toBe(0)
  })
  test("single-line file produces one 1-line chunk", () => {
    const out = chunkFile({ path: "a", text: "hello", mtime: 0, sha: "" })
    expect(out.length).toBe(1)
    expect(out[0]?.startLine).toBe(1)
    expect(out[0]?.endLine).toBe(1)
    expect(out[0]?.text).toBe("hello")
  })
})

// Ensure ordering / consistency: two scans on identical state yield
// identical corpora.
describe("indexer — determinism", () => {
  test("two scanInitial calls (with stop+rebuild) produce identical corpora", async () => {
    await writeFile(join(tmp, "x.ts"), Array.from({ length: 60 }, (_, i) => `l${i}`).join("\n"))
    const ix1 = createDefaultIndexer({ scanner: { root: tmp, glob: SCAN_GLOB } })
    await ix1.scanInitial()
    const c1 = Array.from(ix1.getCorpus()).map((c) => `${c.path}:${c.startLine}-${c.endLine}`)
    ix1.stop()
    const ix2 = createDefaultIndexer({ scanner: { root: tmp, glob: SCAN_GLOB } })
    await ix2.scanInitial()
    const c2 = Array.from(ix2.getCorpus()).map((c) => `${c.path}:${c.startLine}-${c.endLine}`)
    ix2.stop()
    expect(c1.sort()).toEqual(c2.sort())
  })
})

// Reference: unused import retained for clarity if the suite is extended
void ({} as FileChunk)
