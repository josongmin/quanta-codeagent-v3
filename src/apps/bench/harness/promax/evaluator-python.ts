/**
 * PMX-04 — the interpreter version the PINNED ProMax evaluator requires.
 *
 * ONE owner for a fact two wiring points need: the gate run (which refuses
 * before spawning `test_run.py`) and the remote bootstrap plan (which refuses a
 * box before provisioning it). Neither re-types the number.
 *
 * ## The floor is DERIVED, not assumed
 *
 * An AST scan of the pinned evaluator — `src/evaluation/test_run.py` at
 * `PROMAX_V1_SNAPSHOT.evaluator_sha256`
 * (`af2ee720de8a51a921f4af2617937c45f4e3b983549b640756b0fa8b2c1bf42d`) — finds
 * EXACTLY ONE version-gated construct in the whole file, at line 64:
 *
 * ```python
 * def _extract_omnigril_exit(text: str) -> int | None:
 * ```
 *
 * a PEP 604 union (3.10). There is no `match` statement, no `except*`, no
 * 3.11-only stdlib import, and no `from __future__ import annotations` that
 * would defer the annotation. So the floor is **3.10**.
 *
 * 🔴 It is deliberately NOT 3.11. 3.11 is merely what the operator who first hit
 * this happened to install (`uv python install 3.11`); pinning the floor to the
 * workaround rather than to the requirement would refuse a perfectly good 3.10
 * box for no reason.
 *
 * ## The failure below the floor is a TypeError, NOT a SyntaxError
 *
 * This was recorded wrongly in two doc comments before it was measured. The
 * pinned file COMPILES cleanly on 3.9 — `py_compile.compile(..., doraise=True)`
 * succeeds — because PEP 604 unions are syntactically valid everywhere; they are
 * ordinary expressions, evaluated when the `def` executes. Importing the module
 * on 3.9.6 produces:
 *
 * ```text
 *   File ".../src/evaluation/test_run.py", line 64, in <module>
 *     def _extract_omnigril_exit(text: str) -> int | None:
 * TypeError: unsupported operand type(s) for |: 'type' and 'NoneType'
 * ```
 *
 * Two consequences, both load-bearing:
 *
 *  1. a syntax pre-check (`python -m py_compile`, a linter) CANNOT catch this.
 *     The interpreter's version is the only thing checkable in advance.
 *  2. the error an operator sees names the evaluator's source line, so it reads
 *     as "the pinned evaluator is broken" rather than "your interpreter is too
 *     old" — which is precisely why this became folklore instead of a bug
 *     report, and why the refusal below spells out the remedy.
 */
import type { FamilyBootstrapPythonFloor } from "../../profiles/python-version"

/**
 * The floor, with the evidence and the fix attached.
 *
 * `reason` and `remedy` are part of the VALUE rather than of a call site so
 * every refusal — gate, bootstrap executor, readiness classifier — says the
 * same thing about the same rule.
 */
export const PROMAX_EVALUATOR_PYTHON_FLOOR: FamilyBootstrapPythonFloor = Object.freeze({
  minimum: Object.freeze({ major: 3, minor: 10 }),
  reason:
    "The pinned evaluator src/evaluation/test_run.py annotates with a PEP 604 union " +
    "(`int | None`, line 64) and does not import `annotations` from `__future__`, so the " +
    "annotation is evaluated at import. On 3.9 that raises `TypeError: unsupported operand " +
    "type(s) for |: 'type' and 'NoneType'` — the file compiles, then dies at import, and the " +
    "traceback points at the evaluator's own source rather than at the interpreter.",
  remedy:
    "point the campaign at a dedicated Python >=3.10 interpreter (e.g. `uv python install 3.11` " +
    "and pass its `bin/python3.11`), not the system `python3`.",
})
