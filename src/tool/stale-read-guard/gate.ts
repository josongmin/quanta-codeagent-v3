/**
 * Stale-read-guard — the DEFAULT-ON safety gate (ADR-0474; default-ON SOTA++
 * upgrade — Claude-Code staleness parity).
 *
 * WHAT: a single pure predicate over an injected env record. `true` ⇒ the guard
 * is active; the host mints the per-session `ReadFileState` so `read` records
 * mtimes and `write`/`edit`/`apply_patch` reject a target that drifted on disk
 * since the model last read it (TOCTOU clobber protection).
 *
 * DEFAULT-ON, deliberate opt-out: a staleness/correctness guard (NOT a security
 * boundary like the fs-jail, which prevents filesystem ESCAPE), so it uses the
 * STANDARD kill-switch vocabulary (`gateDisabled`) — ON unless the operator sets
 * any recognized falsy token: `QUANTA_STALE_READ_GUARD=off` / `0` / `false` /
 * `no`. This matches the seed-loop convention (`QUANTA_X=0` wins) so the off
 * escape hatch is uniform with every other CLI feature gate; disabling it only
 * permits a stale overwrite (same blast radius as `=off`), never a path escape,
 * so the strict `=off`-only posture is not warranted here. The byte-identical
 * legacy path is recovered by any falsy token.
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

import { gateDisabled } from "@/shared"

/** The env var that DISABLES the stale-read guard. The guard is DEFAULT-ON; set
 *  it to any recognized falsy token (`off` / `0` / `false` / `no`) to opt out.
 *  Unset (or any non-falsy value) keeps the guard ON. */
export const STALE_READ_GUARD_ENV = "QUANTA_STALE_READ_GUARD"

/** Pure gate check via the canonical kill-switch SSOT (`@/shared#gateDisabled`)
 *  — ON by default; OFF for any falsy token (`off`/`0`/`false`/`no`). A
 *  staleness/correctness guard (not a path-escape security boundary), so it
 *  honors the standard disable vocabulary like every other CLI feature gate. */
export const staleReadGuardEnabled = (env: Readonly<Record<string, string | undefined>>): boolean =>
  !gateDisabled(env, STALE_READ_GUARD_ENV)
