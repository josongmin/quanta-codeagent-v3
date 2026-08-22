/**
 * PMX-01 — the TYPED ProMax settings VALUE OBJECT.
 *
 * WHAT THIS IS NOT. It is deliberately NOT a second bench-config resolver. The
 * packet's integration authority forbids "a second ProMax config resolver or
 * in-process argv-to-env bridge": there is ONE composition-root resolver
 * (`run-config.ts`'s `resolveBenchRunConfig`, jun-30 T2), and it calls
 * {@link resolveProMaxSettings} exactly once as part of that single generic
 * resolution. This module owns only the SHAPE, the env-key names, and the
 * fail-closed validation of the two operator knobs — a family-specific value
 * object that exists only AFTER generic resolution, which is precisely what the
 * ticket permits.
 *
 * WHY ITS OWN ENV KEYS. Reusing `QUANTA_SWEBENCH_PRO_*` would make a ProMax run
 * inherit the ScaleAI Pro harness location, and `pro`/`promax` are required
 * never to share a grader (README invariant 1). The keys below are distinct by
 * construction and asserted distinct by `promax-family.test.ts`.
 *
 * NO INVENTED DEFAULTS. PMX-00's `requireExplicitBundleRoot` refuses to search
 * for or download a bundle — "there is deliberately no search path, no
 * `~/.quanta` default, and no 'most recent bundle'". So `bundleRoot` and
 * `python` stay `undefined` when unset, and the consumer that actually needs
 * them refuses loudly at the point of use. What IS frozen here is
 * `upstreamCommit`: the pinned campaign commit from PMX-00's re-verified
 * snapshot, which is an identity, not a default.
 */
import { PROMAX_V1_SNAPSHOT } from "./provenance/frozen-snapshot"

/** Absolute root of the operator's VERIFIED, frozen upstream bundle checkout. */
export const PROMAX_BUNDLE_ROOT_ENV = "QUANTA_PROMAX_BUNDLE_ROOT"
/** Interpreter that runs the pinned `test_run.py` (bare name or absolute path). */
export const PROMAX_PYTHON_ENV = "QUANTA_PROMAX_PYTHON"

/** Every env key this module reads. Exported so a drift guard can assert the
 *  ProMax axis never reaches for a `QUANTA_SWEBENCH_PRO_*` knob. */
export const PROMAX_SETTING_ENV_KEYS = [PROMAX_BUNDLE_ROOT_ENV, PROMAX_PYTHON_ENV] as const

export interface ProMaxSettings {
  /** The FROZEN upstream commit this build of Quanta grades ProMax against. Not
   *  operator-settable: a campaign that could re-point its evaluator mid-flight
   *  is not reproducible (PMX-00). */
  readonly upstreamCommit: string
  /** Operator-supplied absolute bundle root, or `undefined` when unset. */
  readonly bundleRoot: string | undefined
  /** Operator-supplied interpreter, or `undefined` when unset. */
  readonly python: string | undefined
}

/** A knob that is PRESENT but unusable is an error, not a fallback: an operator
 *  who exported `QUANTA_PROMAX_BUNDLE_ROOT=` meant to name a bundle, and quietly
 *  ignoring them would grade against a different tree than they believe. Absent
 *  is the only input allowed to mean "unset". */
const readOptional = (raw: string | undefined, key: string): string | undefined => {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  if (trimmed === "") {
    throw new Error(
      `bench: ${key} is set but blank. Unset it entirely, or give it a real value. ` +
        "REFUSING to treat an explicitly-set-but-empty ProMax setting as absent.",
    )
  }
  return trimmed
}

/**
 * Resolve the ProMax settings from one env snapshot. PURE (env in, value out) —
 * it reads no ambient `process.env` of its own, so the composition root decides
 * which env is authoritative, exactly as the family selector does.
 *
 * Fail-closed on an explicit-but-unusable value; silent for an absent one.
 */
export const resolveProMaxSettings = (env: NodeJS.ProcessEnv): ProMaxSettings => {
  const bundleRoot = readOptional(env[PROMAX_BUNDLE_ROOT_ENV], PROMAX_BUNDLE_ROOT_ENV)
  if (bundleRoot !== undefined && !bundleRoot.startsWith("/")) {
    // Same rule the pinned-evaluator invocation boundary already enforces: a
    // cwd-relative (or `~`-relative, which no exec layer expands) campaign path
    // cannot be replayed from a report.
    throw new Error(
      `bench: ${PROMAX_BUNDLE_ROOT_ENV}="${bundleRoot}" is not an absolute path. ` +
        "A cwd- or shell-relative bundle root cannot be replayed from a report, and " +
        "`~` is not expanded inside an env value. Pass the absolute root of the " +
        "already-verified frozen bundle.",
    )
  }
  return {
    upstreamCommit: PROMAX_V1_SNAPSHOT.upstream_git_commit,
    bundleRoot,
    python: readOptional(env[PROMAX_PYTHON_ENV], PROMAX_PYTHON_ENV),
  }
}

/**
 * Render the ProMax settings as PLAN NOTES — the `key=value` tokens a dry-run
 * plan prints so an operator can see WHICH frozen bundle a launch would use
 * before it spends anything. Empty for every other family (the profile decides),
 * which is what keeps existing plans byte-identical.
 */
export const proMaxPlanNotes = (settings: ProMaxSettings): readonly string[] => [
  `[dry-run] promax-upstream-commit=${settings.upstreamCommit}`,
  `[dry-run] promax-bundle-root=${settings.bundleRoot ?? `(unset — set ${PROMAX_BUNDLE_ROOT_ENV})`}`,
  `[dry-run] promax-python=${settings.python ?? "(unset — the pinned evaluator boundary defaults to `python`)"}`,
]
