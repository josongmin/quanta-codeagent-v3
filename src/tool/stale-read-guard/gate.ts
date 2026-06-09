/**
 * Stale-read-guard — the DEFAULT-ON safety gate (ADR-0474; default-ON SOTA++
 * upgrade — Claude-Code staleness parity).
 *
 * WHAT: a single pure predicate over an injected env record. `true` ⇒ the guard
 * is active; the host mints the per-session `ReadFileState` so `read` records
 * mtimes and `write`/`edit`/`apply_patch` reject a target that drifted on disk
 * since the model last read it (TOCTOU clobber protection).
 *
 * DEFAULT-ON, deliberate opt-out: this is a SAFETY control, so it mirrors the
 * filesystem-jail posture (`gateDisabledStrict`) — it is ON unless the operator
 * sets the EXACT kill-switch `QUANTA_STALE_READ_GUARD=off`. A loose `"0"` /
 * `"false"` / `"no"` does NOT silently drop the protection (tearing down a
 * safety control must be unambiguous). The byte-identical legacy path is
 * recovered ONLY by the explicit `=off`.
 *
 * Note on false-positives: the guard NEVER blocks an UNREAD target (a file the
 * model never read has no baseline — a brand-new write or an intentional blind
 * regenerate is allowed). It blocks ONLY the read-then-externally-modified case
 * (see {@link checkFresh}), so default-ON introduces no spurious denials for
 * the new-file / write-then-edit flows.
 *
 * ADR: ADR-0474 (+ default-ON upgrade).
 * Slices imported: NONE (only `@/shared`'s gate SSOT).
 * NO-THROW: returns a boolean, never throws. Reads the INJECTED env record only
 * (never `process.env` directly).
 */

import { gateDisabledStrict } from "@/shared"

/** The env var that DISABLES the stale-read guard. The guard is DEFAULT-ON; set
 *  this to the exact literal `"off"` to opt out. Any other value (incl. `"0"` /
 *  `"false"` / `"no"` / unset) keeps the guard ON — a safety control is not
 *  silently disabled by a stray falsy token (mirrors the fs-jail kill-switch). */
export const STALE_READ_GUARD_ENV = "QUANTA_STALE_READ_GUARD"

/** Pure gate check via the canonical strict kill-switch SSOT
 *  (`@/shared#gateDisabledStrict`) — ON by default; OFF only for the exact
 *  `QUANTA_STALE_READ_GUARD=off`. Mirrors the filesystem jail (default-ON safety
 *  control, deliberate `=off` teardown). */
export const staleReadGuardEnabled = (env: Readonly<Record<string, string | undefined>>): boolean =>
  !gateDisabledStrict(env, STALE_READ_GUARD_ENV)
