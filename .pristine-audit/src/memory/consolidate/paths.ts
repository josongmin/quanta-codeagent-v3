/**
 * ADR-0068 — `MemoryDirPaths` resolver.
 *
 * Single source of truth for `~/.quanta/memory/` and the three filenames
 * inside it. Pure function (no IO) — caller provides `homedir`. Defaults
 * to `os.homedir()`, but tests inject `/tmp/quanta-test-home` directly.
 *
 * The directory itself is created (chmod 0700) by `MemoryWriter.ensureDir()`
 * — paths.ts only does the path math.
 */
import * as os from "node:os"
import * as path from "node:path"
import type { MemoryDirPaths } from "./types"

/** Quanta home subdirectory. Codex parity = `.codex/memories/`; quanta uses
 *  `.quanta/memory/` (singular — matches `src/memory/` slice name). */
const QUANTA_MEMORY_SUBDIR = ".quanta/memory"

/** Resolve the 4 paths of the consolidator's on-disk layout. Pure. */
export const resolveMemoryDirPaths = (homedir: string = os.homedir()): MemoryDirPaths => {
  if (typeof homedir !== "string" || homedir.length === 0) {
    throw new Error("resolveMemoryDirPaths: homedir must be a non-empty string")
  }
  const root = path.join(homedir, QUANTA_MEMORY_SUBDIR)
  return {
    root,
    memoryMd: path.join(root, "MEMORY.md"),
    rawMemoriesMd: path.join(root, "raw_memories.md"),
    memorySummaryMd: path.join(root, "memory_summary.md"),
  }
}
