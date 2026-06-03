/**
 * Stale-read-guard — the post-bash stale-files reminder renderer (ADR-0474).
 *
 * WHAT: turns the stale-path list from {@link staleAfterBash} into a single
 * `<system-reminder>…</system-reminder>` block the host injects after a bash
 * turn so the model knows which previously-read files were rewritten and must be
 * re-read before any further edit.
 *
 * ADR: ADR-0474.
 * Slices imported: `@/shared` (embedUntrusted — the ONE enforced path for
 * embedding paths into a named tag block; defangs forged boundaries so a path
 * carrying `</system-reminder>` cannot break out).
 * NO-THROW: returns a string (empty when no stale files), never throws.
 */

import { embedUntrusted } from "@/shared"

/**
 * Render the stale-files reminder, or `""` when the list is empty (the host
 * injects nothing — byte-identical to a turn with no stale files).
 *
 * The wording commands the corrective action (re-read before editing) so the
 * model self-heals; the path list is untrusted content funneled through
 * {@link embedUntrusted}. Paths are listed one per line, in the order given
 * (the detector already sorts them deterministically).
 */
export const renderStaleReminder = (stalePaths: readonly string[]): string => {
  if (stalePaths.length === 0) return ""
  const noun = stalePaths.length === 1 ? "file" : "files"
  const body =
    `The command you just ran modified ${stalePaths.length} ${noun} you had previously read. ` +
    `Their on-disk contents no longer match what you read. ` +
    `Re-read ${stalePaths.length === 1 ? "it" : "them"} with the read tool before editing:\n` +
    stalePaths.map((p) => `  - ${p}`).join("\n")
  return embedUntrusted("system-reminder", body)
}
