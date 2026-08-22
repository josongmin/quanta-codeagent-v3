/**
 * Stale-read-guard — the DEFAULT-ON safety gate (ADR-0474; default-ON SOTA++
 * upgrade — Claude-Code staleness parity).
 *
 * WHAT: a single pure predicate over an injected env record. `true` ⇒ the guard
 * is active; the host mints the per-session `ReadFileState` so `read` records
 * mtimes and `write`/`edit`/`apply_patch` reject a target that drifted on disk
 * since the model last read it (TOCTOU clobber protection).
 *
 * DEFAULT-ON, deliberate opt-out: a staleness/correctness safety control that
 * uses the STRICT kill-switch vocabulary (`gateDisabledStrict`) — ON unless the
 * operator sets EXACTLY `QUANTA_STALE_READ_GUARD=off`. A stray falsy token
 * (`0` / `false` / `no`) that may appear in an env by accident must NOT silently
 * tear down the TOCTOU clobber protection; only a deliberate literal `off` (like
 * the fs-jail kill-switch) disables it. This strict posture is enforced SRC-WIDE
 * by the dangerous-gate-strict ratchet (`gateDisabledStrict` required, no loose
 * `gateDisabled` alias) so the guard cannot be silently weakened.
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
 *  it to EXACTLY `off` to opt out. Unset (or any other value, including stray
 *  falsy tokens like `0`/`false`) keeps the guard ON — only a deliberate literal
 *  `off` tears down the safety control. */
export const STALE_READ_GUARD_ENV = "QUANTA_STALE_READ_GUARD"

/** Pure gate check via the canonical STRICT kill-switch SSOT
 *  (`@/shared#gateDisabledStrict`) — ON by default; OFF only for the literal
 *  `off`. A safety control whose accidental teardown by a stray falsy token must
 *  be impossible, so it uses the strict `=off`-only vocabulary (enforced by the
 *  dangerous-gate-strict ratchet), like the fs-jail kill-switch. */
export const staleReadGuardEnabled = (env: Readonly<Record<string, string | undefined>>): boolean =>
  !gateDisabledStrict(env, STALE_READ_GUARD_ENV)
