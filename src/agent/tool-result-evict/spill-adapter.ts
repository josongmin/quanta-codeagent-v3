import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  DEFAULT_SPILL_KEEP,
  pruneSpillDir,
  resolveSpillKeep,
  type SpillFsOps,
} from "@/tool/output-spill"
import type { EvictionSpillPort } from "./types"

/**
 * Default {@link EvictionSpillPort} — persist the evicted original to disk,
 * REUSING the existing `output-spill.ts` on-disk surface (§4.4): the same
 * `.quanta/tool-output/<uuid>.txt` file convention and the same
 * `pruneSpillDir(keep)` retention bound (`QUANTA_TOOL_OUTPUT_SPILL_KEEP`). No new
 * on-disk surface, no new retention knob.
 *
 * Unlike `capToolOutput` (which substitutes an 8k-head/4k-tail EXCERPT marker —
 * fine for a one-shot capture cap, but it would keep ~12k of the original and
 * DEFEAT the shrink for a mid-sized stale dump), eviction wants a COMPACT
 * pointer: a single `<persisted-output>` line naming the path so the model can
 * `Read` the full original. The cleared block becomes the bare placeholder + this
 * one-line ref — a true shrink for any body over a few hundred chars.
 *
 * NO-THROW is the PORT contract enforced by the pre-pass
 * (`evict.ts#clearedBody` try/catch): any writer/GC failure propagates as a
 * throw and degrades to a bare-placeholder clear — it never aborts the
 * microcompaction.
 */
export interface DefaultEvictionSpillOptions {
  /** Directory the originals are written into (`.quanta/tool-output`). */
  readonly spillDir: string
  /** Injected writer (path, data) — defaults to a lazy mkdir + writeFileSync.
   *  Override in tests to avoid disk IO. */
  readonly write?: (path: string, data: string) => void
  /** Generate the spill file name (sans dir). Injected for deterministic tests;
   *  defaults to a random uuid (read at call time, not module load). */
  readonly fileName?: () => string
  /** Max retained spill files (reuses `QUANTA_TOOL_OUTPUT_SPILL_KEEP`). */
  readonly spillKeep?: number
  /** Injected fs surface for the post-write GC prune (tests). */
  readonly spillFs?: SpillFsOps
}

const defaultWrite = (path: string, data: string): void => {
  const slash = path.lastIndexOf("/")
  const dir = slash > 0 ? path.slice(0, slash) : ""
  if (dir) mkdirSync(dir, { recursive: true })
  writeFileSync(path, data)
}

/** Compact one-line retrieval marker (the cleared block's ref suffix). */
const refMarker = (path: string, originalChars: number): string =>
  `<persisted-output path="${path}" chars="${originalChars}">` +
  ` full original tool output persisted to disk; Read that file to see it ` +
  `</persisted-output>`

export const createEvictionSpillPort = (opts: DefaultEvictionSpillOptions): EvictionSpillPort => {
  const write = opts.write ?? defaultWrite
  // Lazy `node:crypto` require avoided — randomUUID is read at call time so the
  // adapter has no module-load side effect; tests inject `fileName` instead.
  const fileName =
    opts.fileName ?? ((): string => `${(globalThis.crypto as Crypto).randomUUID()}.txt`)
  return {
    persist: (body: string): string | undefined => {
      const spillPath = join(opts.spillDir, fileName())
      write(spillPath, body)
      // Bound the dir (best-effort, never throws — see pruneSpillDir contract).
      const keep = resolveSpillKeep(opts.spillKeep ?? DEFAULT_SPILL_KEEP)
      if (opts.spillFs !== undefined) pruneSpillDir(opts.spillDir, keep, opts.spillFs)
      else pruneSpillDir(opts.spillDir, keep)
      return refMarker(spillPath, body.length)
    },
  }
}
