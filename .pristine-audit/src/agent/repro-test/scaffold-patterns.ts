/**
 * SSOT for bench repro-scaffold basenames (RFC jun-29 repro-adapter, Phase 1b).
 *
 * The repro rail drops generated scaffold files (`__repro_N_<uuid>.py`, the canonical
 * `reproduce_issue.py`) + their pytest execution sidecars into the sandbox worktree. SEVERAL
 * subsystems must recognize these so they're NEVER treated as submitted source edits — the
 * artifact filter, snapshot strip, patch hygiene, and the mention-injection anchor synth. Those
 * recognizers had DRIFTED into THREE independent definitions (a duplicate regex in anchor-synth,
 * a string literal in patch-hygiene, the regexes in repro-artifacts). A polyglot repro (Go/JS
 * scaffolds with a different extension) would silently leak through any site still hardcoding
 * `.py` — the exact contamination/hygiene breakage the adapter RFC fences.
 *
 * This LEAF module (no imports → no cycle; importable by both `agent/**` and `runner/**`) is the
 * single source those recognizers + the {@link ../../runner/batch/eval/repro-adapter} consume.
 * Today it carries only the Python scaffold shapes (byte-identical to the prior scattered
 * definitions); a future language adapter ADDS its scaffold pattern to {@link REPRO_SCAFFOLD_SCRIPT_PATTERNS}
 * and every recognizer tracks it automatically.
 */

/** The canonical, fixed-name repro scaffold (hygiene allowlists this exact basename). */
export const REPRO_CANONICAL_BASENAME = "reproduce_issue.py"

/** Build the per-sample Python repro scaffold basename. The matching pattern is
 *  {@link REPRO_PY_SCRIPT_BASENAME_RE}. */
export const reproScriptBasename = (seq: number, uuid: string): string =>
  `__repro_${seq}_${uuid}.py`

/** Python repro SCRIPT basenames: per-sample `__repro_N_<uuid>.py` + the canonical name. */
export const REPRO_PY_SCRIPT_BASENAME_RE = /^(__repro_\d+_[0-9a-fA-F-]+\.py|reproduce_issue\.py)$/

/** Python repro pytest-report SIDECAR basenames (`<script>.pytest-report.json`). */
export const REPRO_PY_REPORT_BASENAME_RE =
  /^(__repro_\d+_[0-9a-fA-F-]+\.py|reproduce_issue\.py)\.pytest-report\.json$/

/** All repro SCRIPT basename patterns across languages (today: Python only). Anchor synth + any
 *  "is this a generated repro source file" check consume THIS (scripts only — not sidecars). */
export const REPRO_SCAFFOLD_SCRIPT_PATTERNS: readonly RegExp[] = [REPRO_PY_SCRIPT_BASENAME_RE]

/** All repro ARTIFACT basename patterns (scripts + execution sidecars), across languages. The
 *  artifact filter / snapshot strip consume THIS (must exclude BOTH from submitted source). */
export const REPRO_SCAFFOLD_ARTIFACT_PATTERNS: readonly RegExp[] = [
  REPRO_PY_SCRIPT_BASENAME_RE,
  REPRO_PY_REPORT_BASENAME_RE,
]

/** Is `name` a generated repro SCRIPT basename (not a sidecar)? */
export const isReproScriptBasename = (name: string): boolean =>
  REPRO_SCAFFOLD_SCRIPT_PATTERNS.some((re) => re.test(name))

/** Is `name` ANY repro artifact basename (script OR execution sidecar)? */
export const isReproArtifactBasename = (name: string): boolean =>
  REPRO_SCAFFOLD_ARTIFACT_PATTERNS.some((re) => re.test(name))
