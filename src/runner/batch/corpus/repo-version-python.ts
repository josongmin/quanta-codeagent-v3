/**
 * (repo, version) → CPython minor for the per-instance repro/test env.
 *
 * GENERATED from the official SWE-bench `MAP_REPO_VERSION_TO_SPECS[repo][v].python`
 * (swebench PyPI, 2026-06-20) — GROUND TRUTH, not guessed. A single static per-repo
 * python (the old `PYTHON_FOR_REPO`) is WRONG: one repo spans versions needing
 * different pythons — django 5.0 needs 3.11 (was forced to 3.9 → `No solution found`),
 * scikit-learn 0.20–0.22 needs 3.6 (3.10 fails the old numpy/scipy build). RCA jun-20:
 * this one mismatch killed ~13% of repros (see jun-20-repro-gen-python-version-rca).
 *
 * Regenerate: `uvx --with swebench python -c "from swebench.harness.constants import
 *  MAP_REPO_VERSION_TO_SPECS; ..."`.
 */
const REPO_VERSION_PYTHON: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "astropy/astropy": {
    "v5.3": "3.10",
    "0.1": "3.6",
    "0.2": "3.6",
    "0.3": "3.6",
    "0.4": "3.6",
    "1.1": "3.6",
    "1.2": "3.6",
    "1.3": "3.6",
    "3.0": "3.9",
    "3.1": "3.9",
    "3.2": "3.9",
    "4.1": "3.9",
    "4.2": "3.9",
    "4.3": "3.9",
    "5.0": "3.9",
    "5.1": "3.9",
    "5.2": "3.9",
  },
  "dbt-labs/dbt-core": {
    "0.13": "3.9",
    "0.14": "3.9",
    "0.15": "3.9",
    "0.16": "3.9",
    "0.17": "3.9",
    "0.18": "3.9",
    "0.19": "3.9",
    "0.20": "3.9",
    "0.21": "3.9",
    "1.0": "3.9",
    "1.1": "3.9",
    "1.2": "3.9",
    "1.3": "3.9",
    "1.4": "3.9",
    "1.5": "3.9",
    "1.6": "3.9",
    "1.7": "3.9",
  },
  "django/django": {
    "1.4": "3.5",
    "1.5": "3.5",
    "1.6": "3.5",
    "1.7": "3.5",
    "1.8": "3.5",
    "1.9": "3.5",
    "1.10": "3.5",
    "1.11": "3.5",
    "2.0": "3.5",
    "2.1": "3.5",
    "2.2": "3.5",
    "3.0": "3.6",
    "3.1": "3.6",
    "3.2": "3.6",
    "4.0": "3.8",
    "4.1": "3.9",
    "4.2": "3.9",
    "5.0": "3.11",
    "5.1": "3.11",
    "5.2": "3.11",
  },
  "marshmallow-code/marshmallow": {
    "2.18": "3.9",
    "2.19": "3.9",
    "2.20": "3.9",
    "3.0": "3.9",
    "3.1": "3.9",
    "3.2": "3.9",
    "3.4": "3.9",
    "3.8": "3.9",
    "3.9": "3.9",
    "3.10": "3.9",
    "3.11": "3.9",
    "3.12": "3.9",
    "3.13": "3.9",
    "3.15": "3.9",
    "3.16": "3.9",
    "3.19": "3.9",
  },
  "matplotlib/matplotlib": {
    "1.0": "3.5",
    "1.1": "3.5",
    "1.2": "3.5",
    "1.3": "3.5",
    "1.4": "3.5",
    "1.5": "3.5",
    "2.0": "3.5",
    "2.1": "3.5",
    "2.2": "3.5",
    "3.0": "3.7",
    "3.1": "3.8",
    "3.2": "3.8",
    "3.3": "3.8",
    "3.4": "3.8",
    "3.5": "3.11",
    "3.6": "3.11",
    "3.7": "3.11",
    "3.8": "3.11",
    "3.9": "3.11",
  },
  "mwaskom/seaborn": { "0.11": "3.9", "0.12": "3.9", "0.13": "3.9", "0.14": "3.9" },
  "pallets/flask": {
    "2.0": "3.9",
    "2.1": "3.10",
    "2.2": "3.11",
    "2.3": "3.11",
    "3.0": "3.11",
    "3.1": "3.11",
  },
  "psf/requests": {
    "0.7": "3.9",
    "0.8": "3.9",
    "0.9": "3.9",
    "0.11": "3.9",
    "0.13": "3.9",
    "0.14": "3.9",
    "1.1": "3.9",
    "1.2": "3.9",
    "2.0": "3.9",
    "2.2": "3.9",
    "2.3": "3.9",
    "2.4": "3.9",
    "2.5": "3.9",
    "2.7": "3.9",
    "2.8": "3.9",
    "2.9": "3.9",
    "2.10": "3.9",
    "2.11": "3.9",
    "2.12": "3.9",
    "2.17": "3.9",
    "2.18": "3.9",
    "2.19": "3.9",
    "2.22": "3.9",
    "2.25": "3.9",
    "2.26": "3.9",
    "2.27": "3.9",
    "2.31": "3.9",
    "3.0": "3.9",
  },
  "pvlib/pvlib-python": {
    "0.1": "3.9",
    "0.2": "3.9",
    "0.3": "3.9",
    "0.4": "3.9",
    "0.5": "3.9",
    "0.6": "3.9",
    "0.7": "3.9",
    "0.8": "3.9",
    "0.9": "3.9",
  },
  "pydata/xarray": {
    "0.12": "3.10",
    "0.18": "3.10",
    "0.19": "3.10",
    "0.20": "3.10",
    "2022.03": "3.10",
    "2022.06": "3.10",
    "2022.09": "3.10",
    "2023.07": "3.10",
    "2024.05": "3.10",
  },
  "pydicom/pydicom": {
    "1.0": "3.6",
    "1.1": "3.6",
    "1.2": "3.6",
    "1.3": "3.6",
    "1.4": "3.8",
    "2.0": "3.8",
    "2.1": "3.9",
    "2.2": "3.9",
    "2.3": "3.10",
    "2.4": "3.11",
    "3.0": "3.11",
  },
  "pylint-dev/astroid": {
    "2.5": "3.9",
    "2.6": "3.9",
    "2.7": "3.9",
    "2.8": "3.9",
    "2.9": "3.9",
    "2.10": "3.9",
    "2.12": "3.9",
    "2.13": "3.9",
    "2.14": "3.9",
    "2.15": "3.9",
    "2.16": "3.9",
    "3.0": "3.9",
  },
  "pylint-dev/pylint": {
    "2.8": "3.9",
    "2.9": "3.9",
    "2.10": "3.9",
    "2.11": "3.9",
    "2.13": "3.9",
    "2.14": "3.9",
    "2.15": "3.9",
    "2.16": "3.9",
    "2.17": "3.9",
    "3.0": "3.9",
    "3.1": "3.9",
    "3.2": "3.9",
    "3.3": "3.9",
    "4.0": "3.9",
  },
  "pytest-dev/pytest": {
    "4.4": "3.9",
    "4.5": "3.9",
    "4.6": "3.9",
    "5.0": "3.9",
    "5.1": "3.9",
    "5.2": "3.9",
    "5.3": "3.9",
    "5.4": "3.9",
    "6.0": "3.9",
    "6.2": "3.9",
    "6.3": "3.9",
    "7.0": "3.9",
    "7.1": "3.9",
    "7.2": "3.9",
    "7.4": "3.9",
    "8.0": "3.9",
    "8.1": "3.9",
    "8.2": "3.9",
    "8.3": "3.9",
    "8.4": "3.9",
  },
  "pyvista/pyvista": {
    "0.20": "3.9",
    "0.21": "3.9",
    "0.22": "3.9",
    "0.23": "3.9",
    "0.24": "3.9",
    "0.25": "3.9",
    "0.26": "3.9",
    "0.27": "3.9",
    "0.28": "3.9",
    "0.29": "3.9",
    "0.30": "3.9",
    "0.31": "3.9",
    "0.32": "3.9",
    "0.33": "3.9",
    "0.34": "3.9",
    "0.35": "3.9",
    "0.36": "3.9",
    "0.37": "3.9",
    "0.38": "3.9",
    "0.39": "3.9",
    "0.40": "3.9",
    "0.41": "3.9",
    "0.42": "3.9",
    "0.43": "3.9",
  },
  "scikit-learn/scikit-learn": {
    "0.20": "3.6",
    "0.21": "3.6",
    "0.22": "3.6",
    "1.3": "3.9",
    "1.4": "3.9",
    "1.5": "3.9",
    "1.6": "3.9",
  },
  "sphinx-doc/sphinx": {
    "1.5": "3.9",
    "1.6": "3.9",
    "1.7": "3.9",
    "1.8": "3.9",
    "2.0": "3.9",
    "2.1": "3.9",
    "2.2": "3.9",
    "2.3": "3.9",
    "2.4": "3.9",
    "3.0": "3.9",
    "3.1": "3.9",
    "3.2": "3.9",
    "3.3": "3.9",
    "3.4": "3.9",
    "3.5": "3.9",
    "4.0": "3.9",
    "4.1": "3.9",
    "4.2": "3.9",
    "4.3": "3.9",
    "4.4": "3.9",
    "4.5": "3.9",
    "5.0": "3.9",
    "5.1": "3.9",
    "5.2": "3.9",
    "5.3": "3.9",
    "6.0": "3.9",
    "6.2": "3.9",
    "7.0": "3.9",
    "7.1": "3.9",
    "7.2": "3.9",
    "7.3": "3.9",
    "7.4": "3.9",
    "8.0": "3.10",
    "8.1": "3.10",
  },
  "sqlfluff/sqlfluff": {
    "0.4": "3.9",
    "0.5": "3.9",
    "0.6": "3.9",
    "0.8": "3.9",
    "0.9": "3.9",
    "0.10": "3.9",
    "0.11": "3.9",
    "0.12": "3.9",
    "0.13": "3.9",
    "1.0": "3.9",
    "1.1": "3.9",
    "1.2": "3.9",
    "1.3": "3.9",
    "1.4": "3.9",
    "2.0": "3.9",
    "2.1": "3.9",
    "2.2": "3.9",
  },
  "swe-bench/humaneval": { "1.0": "3.9" },
  "sympy/sympy": {
    "0.7": "3.9",
    "1.0": "3.9",
    "1.1": "3.9",
    "1.2": "3.9",
    "1.4": "3.9",
    "1.5": "3.9",
    "1.6": "3.9",
    "1.7": "3.9",
    "1.8": "3.9",
    "1.9": "3.9",
    "1.10": "3.9",
    "1.11": "3.9",
    "1.12": "3.9",
    "1.13": "3.9",
    "1.14": "3.9",
  },
}

/** Per-repo fallback for an UNMAPPED version: the HIGHEST python that repo ever
 *  needs. Skews high on purpose — the failure we are fixing is a python forced too
 *  LOW for a modern version; uv resolves most older deps on a newer python, but the
 *  reverse (`requires-python>=3.10` on 3.9) hard-fails. Rarely hit: the map covers
 *  every Verified (repo,version). */
const REPO_FALLBACK_PYTHON: Readonly<Record<string, string>> = {
  "astropy/astropy": "3.10",
  "dbt-labs/dbt-core": "3.9",
  "django/django": "3.11",
  "marshmallow-code/marshmallow": "3.9",
  "matplotlib/matplotlib": "3.11",
  "mwaskom/seaborn": "3.9",
  "pallets/flask": "3.11",
  "psf/requests": "3.9",
  "pvlib/pvlib-python": "3.9",
  "pydata/xarray": "3.10",
  "pydicom/pydicom": "3.11",
  "pylint-dev/astroid": "3.9",
  "pylint-dev/pylint": "3.9",
  "pytest-dev/pytest": "3.9",
  "pyvista/pyvista": "3.9",
  "scikit-learn/scikit-learn": "3.9",
  "sphinx-doc/sphinx": "3.10",
  "sqlfluff/sqlfluff": "3.9",
  "swe-bench/humaneval": "3.9",
  "sympy/sympy": "3.9",
}

/** Parse "3.11" → [3, 11] for numeric comparison (string compare is wrong:
 *  "3.9" > "3.11" lexicographically). */
const minorTuple = (v: string): readonly [number, number] => {
  const [a, b] = v.split(".")
  return [Number(a) || 0, Number(b) || 0]
}

/** The lowest CPython our repro/test runner can actually provide. uv's managed
 *  interpreters (python-build-standalone) start at 3.8/3.9 — swebench's
 *  ground-truth 3.5/3.6 for old django/sklearn/matplotlib are UNAVAILABLE
 *  ("No interpreter found for Python 3.6"), and 3.9 ran those repos fine for a
 *  year (the old static `PYTHON_FOR_REPO`). So we FLOOR at 3.9: keep swebench's
 *  value when it is ≥3.9 (the fix — django 5.0 → 3.11), but never go below it.
 *  RCA jun-20 audit: the un-floored map regressed old django from "3.9 runs" to
 *  "3.6 no-interpreter". */
const UV_FLOOR = "3.9"

/** `a` is a strictly-lower CPython minor than `b` ("3.6" < "3.9"). */
const isLowerMinor = (a: string, b: string): boolean => {
  const [aa, ab] = minorTuple(a)
  const [ba, bb] = minorTuple(b)
  return aa < ba || (aa === ba && ab < bb)
}

/** The default python for a repo with NO entry in either map (truly unknown). */
const UNKNOWN_REPO_DEFAULT = "3.11"

/** Telemetry sinks for the two cases where the chosen python is NOT exact swebench
 *  ground truth — so a downstream repro failure is attributable to the ENV override
 *  rather than mis-scored as a model failure. Both are optional; default = no-op. */
export interface PythonResolveTelemetry {
  /** Fired when {@link UV_FLOOR} overrode the (repo,version) ground-truth python. */
  readonly onFloor?: (event: {
    repo: string
    version: string
    /** swebench ground-truth python that was overridden. */
    truth: string
    /** floored python actually used. */
    used: string
  }) => void
  /** Fired when a (repo,version) had NO exact map entry and fell to a per-repo /
   *  conservative guess. */
  readonly onFallback?: (event: { repo: string; version: string; used: string }) => void
}

/** When the UV_FLOOR overrode the swebench ground truth, the truth + used pair —
 *  so a floored instance is attributable to the env, not the model. */
export interface PythonFloored {
  readonly truth: string
  readonly used: string
}

/** Rich (attributable) result of {@link resolvePythonForRepoVersion}. */
export interface ResolvedRepoPython {
  /** The CPython minor the repro/test env should use. */
  readonly used: string
  /** swebench ground-truth python for this (repo,version) when an exact map entry
   *  exists (PRE-floor); `undefined` when the value came from a fallback guess. */
  readonly truth?: string
  /** Present iff {@link UV_FLOOR} overrode `truth` (truth < floor). The signal the
   *  caller needs to NOT mis-score a floored repro as a model failure. */
  readonly pythonFloored?: PythonFloored
  /** Present iff no exact (repo,version) entry existed and a per-repo /
   *  conservative guess was used. A silent guess made visible. */
  readonly fallbackUsed?: { repo: string; version: string; used: string }
}

/**
 * Attributable resolver: exact (repo,version) swebench ground-truth → per-repo high
 * fallback → conservative {@link UNKNOWN_REPO_DEFAULT}, then FLOORED at
 * {@link UV_FLOOR} (uv cannot provide < 3.8; 3.9 is the proven-runnable floor for
 * the old codebases swebench pins to 3.5/3.6).
 *
 * Unlike the bare {@link pythonForRepoVersion} string shim, this surfaces WHY the
 * chosen python differs from ground truth:
 *  - `pythonFloored` when UV_FLOOR overrode an exact truth (so a repro failure on a
 *    floored instance is an ENV override, not a model miss — same class as the prior
 *    13% static-mapping bug, opposite direction), and
 *  - `fallbackUsed` when no exact entry existed (a silent guess made visible).
 * Both also fire the matching {@link PythonResolveTelemetry} sink for logging.
 */
export const resolvePythonForRepoVersion = (
  repo: string,
  version: string | undefined,
  telemetry?: PythonResolveTelemetry,
): ResolvedRepoPython => {
  const exact = version !== undefined ? REPO_VERSION_PYTHON[repo]?.[version] : undefined
  const truth = exact // PRE-floor swebench ground truth, when known.
  const py = exact ?? REPO_FALLBACK_PYTHON[repo] ?? UNKNOWN_REPO_DEFAULT
  const floored = isLowerMinor(py, UV_FLOOR)
  const used = floored ? UV_FLOOR : py

  let pythonFloored: PythonFloored | undefined
  if (floored && truth !== undefined) {
    pythonFloored = { truth, used }
    telemetry?.onFloor?.({ repo, version: version ?? "", truth, used })
  }

  let fallbackUsed: ResolvedRepoPython["fallbackUsed"]
  if (exact === undefined) {
    fallbackUsed = { repo, version: version ?? "", used }
    telemetry?.onFallback?.({ repo, version: version ?? "", used })
  }

  return {
    used,
    ...(truth !== undefined ? { truth } : {}),
    ...(pythonFloored !== undefined ? { pythonFloored } : {}),
    ...(fallbackUsed !== undefined ? { fallbackUsed } : {}),
  }
}

/** CPython minor for an instance's repro/test env. Thin string-returning shim over
 *  {@link resolvePythonForRepoVersion} — kept for callers that only need the value.
 *  Use the resolver directly to get floor/fallback ATTRIBUTION (see #12). */
export const pythonForRepoVersion = (repo: string, version: string | undefined): string =>
  resolvePythonForRepoVersion(repo, version).used
