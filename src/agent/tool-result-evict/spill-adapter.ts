import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { logger } from "@/shared"
import {
  DEFAULT_SPILL_KEEP,
  describeSpillRefusal,
  openSpillDir,
  pruneSpillDir,
  resolveSpillKeep,
  type SpillDirRefusal,
  type SpillFsOps,
  writeFailedRefusal,
} from "@/tool/output-spill"
import type { EvictionSpillPort } from "./types"

/**
 * Default {@link EvictionSpillPort} — persist the evicted original to disk,
 * REUSING the existing `output-spill.ts` on-disk surface (§4.4): the same
 * `.quanta/tool-output/<uuid>.txt` file convention and the same
 * `pruneSpillDir(keep)` retention bound. No new on-disk surface, no new
 * retention knob. The port never reads env or `runtimeConfig`: `keep` is the
 * injected {@link DefaultEvictionSpillOptions.spillKeep}, else
 * `DEFAULT_SPILL_KEEP`. `QUANTA_TOOL_OUTPUT_SPILL_KEEP` reaches it only if the
 * composition root passes `cfg.toolOutputSpillKeep` as `spillKeep`.
 *
 * Unlike `capToolOutput` (which substitutes an 8k-head/4k-tail EXCERPT marker —
 * fine for a one-shot capture cap, but it would keep ~12k of the original and
 * DEFEAT the shrink for a mid-sized stale dump), eviction wants a COMPACT
 * pointer: a single `<persisted-output>` line naming the path so the model can
 * `Read` the full original. The cleared block becomes the bare placeholder + this
 * one-line ref — a true shrink for any body over a few hundred chars.
 *
 * NO-THROW is the PORT contract, backstopped by the pre-pass
 * (`evict.ts#clearedBody` try/catch, which degrades a throw to a bare-placeholder
 * clear). This adapter does not rely on it for spill IO: the GC never throws, and
 * a failed open or write becomes an `<unpersisted-output>` block.
 *
 * CONTAINMENT (NW-2): the spill dir is opened by the SAME `openSpillDir` guard
 * the registry spill uses. A refused dir (a repo-shipped `.quanta` or
 * `.quanta/tool-output` symlink, a non-directory, or an IO failure) gets no
 * write and no prune, and a write that fails in an opened dir gets no prune; the
 * cleared block carries the refusal reason instead of a path, so the model knows
 * the original cannot be re-read.
 */
export interface DefaultEvictionSpillOptions {
  /** `<cwd>/.quanta/tool-output`, the directory the originals are written into.
   *  Opened by `openSpillDir` before every write or prune. */
  readonly spillDir: string
  /** Injected writer (path, data), called only after the spill dir was opened —
   *  defaults to writeFileSync. A throw is the `write-failed` refusal. Override
   *  in tests to avoid the file write. */
  readonly write?: (path: string, data: string) => void
  /** Generate the spill file name (sans dir). Injected for deterministic tests;
   *  defaults to a random uuid (read at call time, not module load). */
  readonly fileName?: () => string
  /** Max retained spill files, resolved by `resolveSpillKeep`; omitted ⇒
   *  `DEFAULT_SPILL_KEEP`. Supplied by the composition root, never read from env
   *  here. */
  readonly spillKeep?: number
  /** Injected fs surface for the post-write GC prune (tests). */
  readonly spillFs?: SpillFsOps
}

const defaultWrite = (path: string, data: string): void => {
  writeFileSync(path, data)
}

/** Compact one-line retrieval marker (the cleared block's ref suffix). The
 *  best-effort caveat is LOAD-BEARING copy: the spill file is bounded by the
 *  shared `pruneSpillDir(keep)` retention (the injected `spillKeep`), so a later
 *  eviction or registry spill can GC this file before the model reads it.
 *  Telling the model the read is best-effort (may be gone) stops it treating a
 *  failed `Read` of a reclaimed path as a hard error. */
const refMarker = (path: string, originalChars: number): string =>
  `<persisted-output path="${path}" chars="${originalChars}">` +
  ` full original tool output persisted to disk; Read that file to see it ` +
  `(best-effort: the file may have been reclaimed by spill retention — if the ` +
  `Read fails, proceed without it) ` +
  `</persisted-output>`

/** The cleared block's suffix when the spill dir was refused: no path to Read,
 *  and the reason why. */
const refusedMarker = (refusal: SpillDirRefusal, originalChars: number): string =>
  `<unpersisted-output chars="${originalChars}">` +
  ` full original tool output was not persisted to disk: ${describeSpillRefusal(refusal)}; ` +
  `it cannot be re-read ` +
  `</unpersisted-output>`

/** Log the refusal for the operator and return the model-facing block. */
const refused = (refusal: SpillDirRefusal, originalChars: number): string => {
  logger.warn(`tool-result-evict.spill-adapter: spill refused — ${describeSpillRefusal(refusal)}`)
  return refusedMarker(refusal, originalChars)
}

export const createEvictionSpillPort = (opts: DefaultEvictionSpillOptions): EvictionSpillPort => {
  const write = opts.write ?? defaultWrite
  // Lazy `node:crypto` require avoided — randomUUID is read at call time so the
  // adapter has no module-load side effect; tests inject `fileName` instead.
  const fileName =
    opts.fileName ?? ((): string => `${(globalThis.crypto as Crypto).randomUUID()}.txt`)
  return {
    persist: (body: string): string | undefined => {
      const opened = openSpillDir(opts.spillDir)
      if (!opened.ok) return refused(opened.refusal, body.length)
      const spillPath = join(opened.dir, fileName())
      try {
        write(spillPath, body)
      } catch (e) {
        // No prune: same as a refused dir. A partly written file can remain; the
        // next successful spill's prune bounds it.
        return refused(writeFailedRefusal(spillPath, e), body.length)
      }
      // Bound the dir (best-effort, never throws — see pruneSpillDir contract).
      const keep = resolveSpillKeep(opts.spillKeep ?? DEFAULT_SPILL_KEEP)
      if (opts.spillFs !== undefined) pruneSpillDir(opened.dir, keep, opts.spillFs)
      else pruneSpillDir(opened.dir, keep)
      return refMarker(spillPath, body.length)
    },
  }
}
