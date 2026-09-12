/**
 * ADR-0068 — `MemoryDirPaths` resolver.
 *
 * Single source of truth for `<quanta-home>/memory/` and the three filenames
 * inside it. Pure function (no IO) — the caller provides the QUANTA home root
 * (`quantaHomeDirFrom(env)` at a composition root; tests inject a scratch root).
 *
 * The directory itself is created (chmod 0700) by `MemoryWriter.ensureDir()`
 * — paths.ts only does the path math.
 */
import * as path from "node:path"
import type { MemoryDirPaths } from "./types"

/** Subdirectory of the QUANTA home. Codex parity = `.codex/memories/`; quanta uses
 *  `memory/` (singular — matches the `src/memory/` slice name). */
const MEMORY_SUBDIR = "memory"

/**
 * Resolve the 4 paths of the consolidator's on-disk layout, under the QUANTA HOME.
 * Pure, and the parameter is REQUIRED.
 *
 * # What this used to be, and why the signature changed
 *
 * It was `resolveMemoryDirPaths(homedir = os.homedir())`, joining an OS home with
 * `.quanta/memory`. So sessions and knobs followed `QUANTA_HOME` / `QUANTA_CONFIG_DIR`
 * and memory did not. Measured with `QUANTA_HOME` pointed at a scratch dir:
 *
 *   quantaHomeDir()    /tmp/qh.XXXX
 *   sessions index     /tmp/qh.XXXX/sessions/index.jsonl
 *   memory store       /Users/<me>/.quanta/memory/memory.sqlite    <- not relocated
 *
 * A run that believed it was isolated opened the developer's real store. The repo's
 * own `hermeticQuantaHomeEnv` helper was not hermetic for memory for the same reason.
 *
 * The default parameter is GONE on purpose: a `string` default cannot be
 * type-checked, so a caller that kept passing an OS home would silently write to the
 * wrong root. Renaming and requiring the argument makes every call site a compile
 * error until it is reviewed.
 *
 * NOT a migration. `quantaHomeDirFrom({})` is `~/.quanta`, so with the env unset the
 * resolved root is byte-identical to the old one — measured. Only a RELOCATED home
 * changes, which is the fix.
 */
export const resolveMemoryDirPathsUnder = (quantaHome: string): MemoryDirPaths => {
  if (typeof quantaHome !== "string" || quantaHome.length === 0) {
    throw new Error("resolveMemoryDirPathsUnder: quantaHome must be a non-empty string")
  }
  const root = path.join(quantaHome, MEMORY_SUBDIR)
  return {
    root,
    memoryMd: path.join(root, "MEMORY.md"),
    rawMemoriesMd: path.join(root, "raw_memories.md"),
    memorySummaryMd: path.join(root, "memory_summary.md"),
  }
}
