/**
 * Startup environment-probe — the pure probe runner (ADR-0466).
 *
 * Slice: @/runtime. Imports only this slice's `types`/`checks` + `@/shared`.
 *
 * Contract:
 *   - NO-THROW: returns `StartupWarning[]`; worst case `[]`. Never throws,
 *     never blocks startup. A check whose exec port resolves `Err` (detection
 *     couldn't be established) is SKIPPED — no warning, no crash. Even if the
 *     injected port itself REJECTS (programmer bug), each call is wrapped so
 *     the rejection degrades to "skip this check".
 *   - DEFAULT-OFF: `opts.enabled === false` (or absent) ⇒ return `[]` WITHOUT
 *     invoking the exec port at all. Byte-identical to no probe.
 *   - DETERMINISTIC: same checks + same port answers ⇒ same warning list in a
 *     stable order (CORE_CHECKS order, then derived test-runner checks). No
 *     wall-clock, no randomness, no Set-iteration-order dependence.
 *   - ABORT: an optional `AbortSignal` short-circuits the remaining checks and
 *     returns the warnings accumulated so far (no throw).
 */

import { errMessage, type Result } from "@/shared"
import { CORE_CHECKS, degradationHint, testRunnerChecks } from "./checks"
import type {
  ProbeCheck,
  ProbeExecError,
  ProbeExecPort,
  ProbeExecResult,
  ProjectManifest,
  StartupWarning,
} from "./types"

export interface ProbeOpts {
  /** DEFAULT-OFF gate. Composition root sets this from the canonical `gateOn`
   *  SSOT over `QUANTA_ENABLE_ENV_PROBE` (any truthy token `1`/`on`/`true`/`yes`).
   *  Absent/false ⇒ no probe runs. */
  readonly enabled?: boolean
  /** Declared project manifest (read from disk by the composition root).
   *  Drives the conditional test-runner checks. When omitted, only CORE
   *  toolchain checks run. */
  readonly manifest?: ProjectManifest
  /** Aborts the remaining checks; returns warnings gathered so far. */
  readonly signal?: AbortSignal
}

const EMPTY_MANIFEST: ProjectManifest = { hasPyproject: false }

/** Wrap a single exec-port call so a programmer-bug REJECTION degrades to an
 *  `Err` (skip the check) instead of escaping the no-throw boundary. */
const safeExec = async (
  exec: ProbeExecPort,
  argv: readonly [string, ...string[]],
): Promise<Result<ProbeExecResult, ProbeExecError>> => {
  try {
    return await exec(argv)
  } catch (e) {
    return {
      ok: false,
      error: { kind: "io-error", detail: errMessage(e) },
    }
  }
}

/** Build the warning for an absent target (total over WarningKind via the
 *  mapper's own assertNever). */
const toWarning = (check: ProbeCheck): StartupWarning => ({
  kind: check.kind,
  target: check.target,
  severity: check.severity,
  degradationHint: degradationHint(check.kind, check.target),
})

/**
 * Run the closed check list and produce graceful-degradation warnings.
 *
 * @param exec  injected detection port (real adapter shells out; tests fake).
 * @param opts  gate + manifest + abort.
 */
export const runEnvProbe = async (
  exec: ProbeExecPort,
  opts: ProbeOpts = {},
): Promise<StartupWarning[]> => {
  // DEFAULT-OFF: do not even touch the exec port.
  if (opts.enabled !== true) return []

  const manifest = opts.manifest ?? EMPTY_MANIFEST
  // Deterministic order: core toolchain first, then manifest-derived runners.
  const checks: readonly ProbeCheck[] = [...CORE_CHECKS, ...testRunnerChecks(manifest)]

  const warnings: StartupWarning[] = []
  for (const check of checks) {
    if (opts.signal?.aborted === true) break // abort → return what we have
    const result = await safeExec(exec, check.probeArgv)
    if (!result.ok) continue // detection couldn't be established → skip, no crash
    if (!result.value.found) warnings.push(toWarning(check))
    // found === true ⇒ no warning. version is advisory; intentionally unused
    // here (it can be surfaced by a richer adapter later without changing the
    // warning contract).
  }
  return warnings
}
