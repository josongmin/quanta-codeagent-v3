/**
 * Startup environment-probe slice — shared types (ADR-0466).
 *
 * Faithful absorption of Cursor's CloudAgentStartupWarning /
 * CloudAgentStartupWarningType + CloudSetupBlocker: at session start the agent
 * probes its toolchain and surfaces a structured warning list so it can ADAPT
 * (e.g. "python3 missing → don't try to run pytest") instead of blindly
 * invoking a tool that isn't there.
 *
 * Slice: @/runtime (may import @/storage, @/shared). This file imports nothing
 * but type primitives — it is the pure type kernel of the slice.
 *
 * Contract:
 *   - NO-THROW: the probe runner returns a `StartupWarning[]` (worst case
 *     `[]`). It NEVER throws and NEVER blocks startup. The injected
 *     {@link ProbeExecPort} is itself no-throw: detection failure is encoded
 *     as `Err`, not a rejection that escapes the boundary.
 *   - DEFAULT-OFF: the runner is gated by an explicit `enabled` arg (the
 *     composition root sets it from `QUANTA_ENABLE_ENV_PROBE=1`). When OFF the
 *     runner returns `[]` WITHOUT invoking the exec port — byte-identical to a
 *     deployment that has no probe at all.
 *   - NO HEURISTICS: the checks are a CLOSED, declared list. The only thing
 *     "detected" about the project is the PRESENCE of a declared manifest
 *     (package.json / pyproject.toml) — read, never guessed.
 */

import type { Result } from "@/shared"

/**
 * Closed enumeration of warning kinds. Mirrors Cursor's
 * CloudAgentStartupWarningType taxonomy, narrowed to the categories this
 * read-only probe can actually establish from a deterministic check:
 *
 *   - "missing-toolchain"   — a declared core binary (node/bun/python3/git) is
 *                             absent from PATH.
 *   - "missing-test-runner" — the project's manifest implies a test runner
 *                             (e.g. a `test` script / a `pytest` dep) but the
 *                             runner binary isn't resolvable.
 *
 * Surfaces branch exhaustively on this union; `assertNever` over it guards the
 * degradationHint mapper.
 */
export const ALL_WARNING_KINDS = ["missing-toolchain", "missing-test-runner"] as const

/** Warning-kind literal union, derived from {@link ALL_WARNING_KINDS}. */
export type WarningKind = (typeof ALL_WARNING_KINDS)[number]

/** Severity. `info` = degraded-but-usable (a non-core tool is absent);
 *  `warn` = a capability the project clearly expects is unavailable. There is
 *  deliberately NO `error` level — the probe NEVER blocks startup, so it has no
 *  fatal class. */
export type WarningSeverity = "info" | "warn"

/**
 * A single structured startup warning. `target` is the concrete subject (the
 * binary name or the runner name); `degradationHint` is human/agent-readable
 * guidance the agent folds into context so it adapts rather than failing
 * mid-turn.
 */
export interface StartupWarning {
  readonly kind: WarningKind
  readonly target: string
  readonly severity: WarningSeverity
  readonly degradationHint: string
}

/**
 * One declared detection probe. The check list (see `checks.ts`) is a CLOSED
 * array of these — there is no dynamic discovery. Each check names a binary to
 * resolve and the warning shape to emit when it's absent.
 */
export interface ProbeCheck {
  /** Stable id for observability/diagnostics (e.g. `"toolchain:node"`). NOT
   *  consumed by the runner: emission order comes from the check array's
   *  position, and there is intentionally NO dedupe — a binary that satisfies
   *  two distinct checks (e.g. `bun` as both a core toolchain AND the JS test
   *  runner) yields one warning per check by design. */
  readonly id: string
  /** The binary to detect on PATH (e.g. `"python3"`). */
  readonly target: string
  /** The detection argv: `[bin, ...args]` — e.g. `["python3", "--version"]`.
   *  The exec port runs this and reports `found`. */
  readonly probeArgv: readonly [string, ...string[]]
  /** Warning kind to emit when absent. */
  readonly kind: WarningKind
  /** Severity to emit when absent. */
  readonly severity: WarningSeverity
}

/** Outcome of a single detection: whether the binary resolved, plus an
 *  optional parsed version string (advisory only — never gates anything). */
export interface ProbeExecResult {
  readonly found: boolean
  readonly version?: string
}

/**
 * Port: run ONE detection command. The real adapter shells out (composition
 * root); tests inject a deterministic fake.
 *
 * NO-THROW: a detection that errors (spawn failure, timeout, permission)
 * resolves `Err` — the runner treats an `Err` as "this check could not be
 * established" and SKIPS it (no warning, no crash), exactly the
 * graceful-degradation contract. A successful run resolves `Ok({found,...})`.
 */
export type ProbeExecPort = (
  argv: readonly [string, ...string[]],
) => Promise<Result<ProbeExecResult, ProbeExecError>>

/** Why a detection couldn't be established. Advisory — the runner only cares
 *  that it's an `Err` (skip the check), but the kind aids observability. */
export interface ProbeExecError {
  readonly kind: "spawn-failed" | "timeout" | "io-error"
  readonly detail: string
}

/**
 * Project manifest presence — the ONLY thing read about the project itself.
 * The composition root passes this in (read from disk via @/storage); the
 * runner stays pure. `undefined` fields mean "manifest absent".
 */
export interface ProjectManifest {
  /** Parsed package.json `scripts.test` value, if a package.json exists and
   *  declares one. Presence implies a JS/TS test runner is expected. */
  readonly packageJsonTestScript?: string
  /** Whether a pyproject.toml exists. Presence implies a python test runner
   *  (pytest) is expected. */
  readonly hasPyproject: boolean
}
