/**
 * ADR-0282 — `CrossSessionInjector` closed port.
 *
 * Pure read surface on top of {@link import("../stage1-store").Stage1OutputsStore}
 * that filters + byte-caps the selected-for-phase2 subset for prompt
 * inject. The injector does NOT mutate the store (no `touch`, no
 * `markSelectedForPhase2`); that side-effect belongs to ADR-0281's
 * `MemoryAutoTrigger`.
 *
 * Contract details (cross-impl):
 *
 *  - `selectForInject` is a SYNC pure-read function (no I/O beyond
 *    the underlying store's sync `list`). Same inputs ⇒ same output
 *    for a given store snapshot.
 *  - Returned array is FROZEN (Object.freeze); mutation in strict
 *    mode throws.
 *  - `maxBytes <= 0` ⇒ return `[]` (degenerate, but legal).
 *  - Selection order: ascending `generatedAt` (oldest-first). The
 *    cap is greedy — when the next candidate would overflow, STOP
 *    (do NOT skip over it). This keeps the cache key stable: adding
 *    a new high-byte entry never reshuffles the prefix.
 *  - The injector NEVER throws. A malformed entry from the store
 *    (e.g. non-string `rolloutSummary`) is skipped silently.
 */

import type { Stage1Entry } from "../stage1-store"
import type { InjectOpts } from "./types"

/** `CrossSessionInjector` — the closed port. */
export interface CrossSessionInjector {
  selectForInject(opts: InjectOpts): readonly Stage1Entry[]
}
