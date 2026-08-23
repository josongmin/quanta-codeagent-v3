/**
 * A PYTHON INTERPRETER VERSION FLOOR as data a bootstrap can declare and an
 * executor can compare — the family-agnostic half of "this evaluator needs a
 * newer interpreter than the box's default".
 *
 * It lives beside {@link ../profiles/types} rather than inside a family's owner
 * because BOTH sides need it and they may not import each other: the family
 * harness declares the floor (a family fact), while `remote/**` compares it on
 * the box (transport). The same split the digest expectation already uses.
 *
 * ## Why a VERSION check and not a syntax check
 *
 * The failure this exists to prevent is not a parse error. A module can compile
 * cleanly on an old interpreter and still die at import: PEP 604 annotations
 * (`int | None`) are ordinary expressions EVALUATED when the `def` executes
 * unless the module opts into `from __future__ import annotations`. On Python
 * 3.9 that evaluation raises
 *
 * ```text
 * TypeError: unsupported operand type(s) for |: 'type' and 'NoneType'
 * ```
 *
 * `py_compile` reports success on exactly that file. So there is nothing to
 * check ahead of time EXCEPT the interpreter's version, which is why the floor
 * is declared as a number rather than inferred from a dry run.
 *
 * ## 🔴 The comparison is NUMERIC because the lexical one is backwards
 *
 * `"3.9" > "3.10"` is TRUE. A string comparison — the obvious thing to reach for
 * when both values arrive as text out of `--version` — ADMITS the single
 * interpreter version that is known to fail. {@link meetsPythonFloor} therefore
 * compares `(major, minor)` as integers, and a test pins that 3.9 is refused
 * *although it sorts above the floor lexically*.
 */

/** A `(major, minor)` interpreter version. Patch level is deliberately absent:
 *  no floor this repo has ever needed is finer-grained than a minor release,
 *  and carrying a patch number would invite comparing pre-release suffixes. */
export interface PythonVersion {
  readonly major: number
  readonly minor: number
}

/**
 * The floor a bootstrap command's interpreter must satisfy, carried IN the plan
 * data so the comparison belongs to the executor (where a test can drive it)
 * rather than to a remote shell's exit status.
 *
 * `reason` and `remedy` travel WITH the number on purpose: a refusal that says
 * only "needs 3.10" sends an operator to read source to find out why, and the
 * whole point is that they should not have to.
 */
export interface FamilyBootstrapPythonFloor {
  readonly minimum: PythonVersion
  /** WHY this floor exists — the construct that needs it and what breaks below it. */
  readonly reason: string
  /** What the operator should DO about it. */
  readonly remedy: string
}

/**
 * A version as an interpreter announces it: `Python 3.11.14`.
 *
 * The `Python` prefix is REQUIRED rather than convenient. Output reaches this
 * function as stdout and stderr concatenated, so a bare `\d+\.\d+` would happily
 * match a version inside a traceback, a path like `/usr/lib/python3.9/`, or a
 * pip warning — and would then report a confident, wrong answer. Anchoring on
 * the announcement means anything we do not understand parses as `null` and
 * fails closed.
 */
const PYTHON_VERSION_ANNOUNCEMENT = /\bPython\s+(\d+)\.(\d+)/

/**
 * Read the interpreter version out of `--version` output, or `null`.
 *
 * Accepts stdout OR stderr: `python --version` wrote to stderr before 3.4, and
 * callers hand both streams in together.
 */
export const parsePythonVersion = (output: string): PythonVersion | null => {
  if (typeof output !== "string") return null
  const match = PYTHON_VERSION_ANNOUNCEMENT.exec(output)
  if (match === null) return null
  const major = Number(match[1])
  const minor = Number(match[2])
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return null
  return { major, minor }
}

/** `3.10` — how an operator reads a version. */
export const formatPythonVersion = (version: PythonVersion): string =>
  `${version.major}.${version.minor}`

/**
 * Is `observed` at least `floor`? NUMERIC, major-dominant.
 *
 * Major dominates so that 2.99 does not beat 3.10 on the minor alone.
 */
export const meetsPythonFloor = (observed: PythonVersion, floor: PythonVersion): boolean =>
  observed.major !== floor.major ? observed.major > floor.major : observed.minor >= floor.minor

export interface PythonFloorRefusalInput {
  /** What this interpreter is FOR, e.g. "evaluator interpreter". */
  readonly label: string
  /** The executable that was probed. */
  readonly executable: string
  /** What it reported, or `null` when nothing readable came back. */
  readonly observed: PythonVersion | null
  readonly floor: FamilyBootstrapPythonFloor
}

/**
 * The operator-facing refusal — the ONE message shape both wiring points use,
 * so a gate refusal and a bootstrap refusal cannot drift into saying different
 * things about the same rule.
 *
 * It names the three things a traceback does not: what was FOUND, what is
 * REQUIRED, and what to DO. An unreadable probe gets its own sentence rather
 * than being reported as some version-shaped default.
 */
export const describePythonFloorRefusal = (input: PythonFloorRefusalInput): string => {
  const required = formatPythonVersion(input.floor.minimum)
  const found =
    input.observed === null
      ? `reported NO Python version at all (probe output unreadable)`
      : `is Python ${formatPythonVersion(input.observed)}, below the required ${required}`
  return (
    `the ${input.label} at ${input.executable} ${found}. ` +
    `REQUIRED: Python >=${required}. ${input.floor.reason} ` +
    `REMEDY: ${input.floor.remedy}`
  )
}
