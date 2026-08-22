import { errMessage } from "@/shared"
/**
 * ADR-0068 — read-side helpers (Wave D integration glue).
 *
 * Wave C exposed `FourSectionInput.memorySummaryMd?: string` and the
 * untrusted-wrapper handling. This file owns the LOAD step:
 *
 *   `~/.quanta/memory/memory_summary.md`  →  string | undefined
 *
 * Called ONCE per session start (loop.ts cold path). Absent file ⇒ undefined
 * ⇒ `fourSectionPreset` is byte-identical to the pre-ADR 4-section preset.
 *
 * Pure read — no write, no LLM, no clock. The full `MemoryDirPaths` resolver
 * lives in `paths.ts` (Wave D) so this stays a thin IO module.
 */

import * as nodeFs from "node:fs/promises"
import { MEMORY_SUMMARY_MAX_BYTES } from "./constants"
import { type MemoryDirPaths, MemoryWriteError } from "./types"

/** Minimal fs surface this loader needs. */
export interface ReaderFs {
  readFile(p: string, encoding: "utf8"): Promise<string>
}

/** Load `memory_summary.md` for prompt-inject. Returns `undefined` when the
 *  file is absent (ENOENT) — the 4-section preset stays legacy. Throws
 *  {@link MemoryWriteError} on cap violation (defense in depth — Wave B's
 *  writer enforces too, but this check guarantees the inject channel never
 *  exceeds the cap even if the file was hand-edited beyond the limit). */
export const loadMemorySummary = async (
  paths: MemoryDirPaths,
  fs: ReaderFs = nodeFs as unknown as ReaderFs,
): Promise<string | undefined> => {
  try {
    const content = await fs.readFile(paths.memorySummaryMd, "utf8")
    if (Buffer.byteLength(content, "utf8") > MEMORY_SUMMARY_MAX_BYTES) {
      throw new MemoryWriteError(
        `memory_summary.md exceeds MEMORY_SUMMARY_MAX_BYTES (${Buffer.byteLength(content, "utf8")} > ${MEMORY_SUMMARY_MAX_BYTES})`,
        paths.memorySummaryMd,
      )
    }
    return content
  } catch (e) {
    // ENOENT is the legacy path — distinguish from real IO errors.
    if (isENoEnt(e)) return undefined
    if (e instanceof MemoryWriteError) throw e
    const msg = errMessage(e)
    throw new MemoryWriteError(`Failed to read memory_summary.md: ${msg}`, paths.memorySummaryMd)
  }
}

const isENoEnt = (e: unknown): boolean =>
  typeof e === "object" && e !== null && "code" in e && (e as { code: unknown }).code === "ENOENT"
