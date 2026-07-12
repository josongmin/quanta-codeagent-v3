/**
 * jul-13 edit-fresh-hash — shared helpers so EVERY single-flat-file mutating tool
 * (`edit` / `write` / `scripted_replace`) hands the model a fresh content hash on
 * success AND keeps the DEFAULT-ON stale-read guard consistent, with ONE wording
 * and ONE baseline-refresh implementation (no per-tool reinvention).
 *
 * WHY (measured): the ADR-0398 `expected_hash` precondition lets the model
 * optimistic-lock an edit, but without a fresh hash on success a sequential
 * same-file edit self-invalidates (measured ~41% of edits hit stale_precondition
 * from the model's OWN prior edit). And the ADR-0474 mtime stale-read guard is
 * DEFAULT-ON, so a successful mutation that advanced the file's mtime would make a
 * chained (no-re-read) edit fail `stale_read` unless the mutation re-records the
 * baseline. Both are cured here, gated by `ctx.editFreshHash` (QUANTA_EDIT_FRESH_HASH).
 *
 * SLICES IMPORTED: `@/storage` (sha256 + FileSystemPort) + this slice's `../types`.
 * NO-THROW on the baseline refresh: the mutation is already committed, so a stat
 * failure must never fail it.
 */

import { type FileSystemPort, sha256Hex } from "@/storage"
import type { EditToolContext } from "../types"

/** The note a SUCCESSFUL single-file mutation appends to its output so the model
 *  reuses the digest as the next same-file edit's `expected_hash` WITHOUT a
 *  re-read. `bytes` is the POST-mutation file content already in memory (no extra
 *  read). Gated ⇒ `""` (BYTE-IDENTICAL legacy output) when the flag is off. */
export const freshHashNote = (ctx: Pick<EditToolContext, "editFreshHash">, bytes: string): string =>
  ctx.editFreshHash === true
    ? `\nfresh sha256: ${sha256Hex(bytes)} (pass as expected_hash for the next edit to this file — no re-read needed)`
    : ""

/** After a SUCCESSFUL commit, refresh the stale-read guard baseline to the
 *  just-written mtime — a successful mutation IS a fresh read of its own output.
 *  Without this the DEFAULT-ON mtime guard (`guardWrite`, strict `>`) would veto a
 *  fresh-hash CHAINED edit with `stale_read` because the mutation skipped the
 *  re-read the baseline expects. An EXTERNAL modification still advances the mtime
 *  past what the mutation recorded, so TOCTOU protection is preserved. Gated by
 *  `ctx.editFreshHash` ⇒ no stat / no state mutation (byte-identical) when off.
 *  Records under the SAME resolved path key `guardWrite` stats. Best-effort. */
export const refreshStaleReadBaseline = async (
  fs: FileSystemPort,
  ctx: EditToolContext,
  target: { readonly path: string; readonly base: string },
): Promise<void> => {
  if (ctx.editFreshHash !== true || ctx.readFileState === undefined) return
  try {
    const committed = await fs.statFile(target.path, target.base)
    ctx.readFileState.record(committed.path, committed.mtimeMs)
  } catch {
    // Post-commit best-effort: leave the pre-mutation baseline on a stat failure.
  }
}
