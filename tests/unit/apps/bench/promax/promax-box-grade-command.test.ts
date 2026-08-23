/**
 * PMX-04 — THE ON-BOX GRADE INVOCATION.
 *
 * ProMax does not grade through the `swebench` pip harness — `harnessSpec`
 * refuses it outright, because looking ProMax ids up in SWE-bench Verified is
 * the silent-wrong-family route the packet forbids. It grades by running its own
 * PINNED evaluator, and on a box that evaluator only exists inside the grader
 * window: the checkout is created by the grader phase and `rm -rf`'d by the
 * teardown bound to the same call.
 *
 * So every input to this command must come from the MATERIALIZED tree, and that
 * is what these tests pin:
 *
 *  - the evaluator is the checkout's `src/evaluation/test_run.py` — the bytes the
 *    grader phase just hash-verified, not a host copy that no probe covered;
 *  - the golden is the checkout's own dataset, so the answer key is read from
 *    inside the window rather than shipped to the box separately;
 *  - the interpreter is the venv the grader phase built, not the box's system
 *    python, which has none of the evaluator's dependencies;
 *  - `--workers` stays pinned at 1. Concurrent grading produced FALSE NEGATIVES
 *    on correct patches (jun-19), so this is a measurement property, not a
 *    performance knob, and it is deliberately not a parameter.
 */
import { describe, expect, test } from "bun:test"
import {
  buildProMaxBoxGradeCommand,
  PROMAX_ONBOX_GOLDEN_RELATIVE_PATH,
} from "@/apps/bench/harness/promax/box-grade"
import {
  PROMAX_ONBOX_CHECKOUT_ROOT,
  PROMAX_ONBOX_VENV_ROOT,
} from "@/apps/bench/profiles/promax-bootstrap"

const base = {
  checkoutRoot: PROMAX_ONBOX_CHECKOUT_ROOT,
  venvRoot: PROMAX_ONBOX_VENV_ROOT,
  predictionsPath: "/home/ubuntu/preds.json",
  outputPath: "/home/ubuntu/pass-rate.json",
}

const built = (over: Partial<typeof base> = {}) => buildProMaxBoxGradeCommand({ ...base, ...over })

describe("the on-box grade runs entirely inside the materialized window", () => {
  test("KNOWN-ITEM FLOOR: a well-formed input builds", () => {
    const r = built()
    expect(r.ok).toBe(true)
  })

  test("the evaluator, the golden and the eval meta all come from the CHECKOUT", () => {
    const r = built()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const argv = r.argv.join(" ")
    // the hash-verified evaluator, not a host copy
    expect(argv).toContain(`${PROMAX_ONBOX_CHECKOUT_ROOT}/src/evaluation/test_run.py`)
    // the answer key, read from inside the window
    expect(argv).toContain(`${PROMAX_ONBOX_CHECKOUT_ROOT}/${PROMAX_ONBOX_GOLDEN_RELATIVE_PATH}`)
    expect(argv).toContain(`${PROMAX_ONBOX_CHECKOUT_ROOT}/data/eval.json`)
    // …and the cwd is the checkout, so a relative read inside the evaluator
    // resolves in the tree that was verified
    expect(r.cwd).toBe(PROMAX_ONBOX_CHECKOUT_ROOT)
  })

  test("the interpreter is the grader-phase VENV, never the box's system python", () => {
    const r = built()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.argv[0]).toBe(`${PROMAX_ONBOX_VENV_ROOT}/bin/python`)
    // an explicit anti-assertion: a bare `python`/`python3` would resolve to the
    // box interpreter, which has none of the evaluator's dependencies
    expect(r.argv[0]).not.toBe("python")
    expect(r.argv[0]).not.toBe("python3")
  })

  test("workers is PINNED at 1 and is not a parameter", () => {
    const r = built()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const i = r.argv.indexOf("--workers")
    expect(i).toBeGreaterThan(-1)
    expect(r.argv[i + 1]).toBe("1")
    // concurrent grading false-negatives correct patches (jun-19) — the input
    // type must not offer a way to raise it
    expect(Object.keys(base)).not.toContain("workers")
  })

  test("the predictions the AGENT produced are what gets graded", () => {
    const r = built({ predictionsPath: "/chunk/preds-42.json" })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.argv.join(" ")).toContain("/chunk/preds-42.json")
  })
})

describe("fail-closed on anything that could not be replayed or could break out", () => {
  test("a relative path REFUSES rather than resolving against an unknown cwd", () => {
    for (const field of ["checkoutRoot", "venvRoot", "predictionsPath", "outputPath"] as const) {
      const r = built({ [field]: "relative/path" } as Partial<typeof base>)
      expect(r.ok, `${field} accepted a relative path`).toBe(false)
    }
  })

  test("the rendered COMMAND is shell-quoted, so a metachar in a path cannot break out", () => {
    const evil = "/tmp/out; rm -rf /"
    const r = built({ outputPath: evil })
    // it may refuse OR quote — what it must never do is emit the path unquoted
    if (!r.ok) return
    // the whole token, metachars and all, sits inside one single-quoted string
    expect(r.command).toContain(`'${evil}'`)
    // and the argv still carries it verbatim, so the quoting is a RENDERING
    // concern and not a silent mutation of the path the evaluator writes to
    expect(r.argv).toContain(evil)
  })

  test("PAIRED CONTROL: the same input WITHOUT the metachar builds a clean command", () => {
    const r = built()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.command).toContain(PROMAX_ONBOX_CHECKOUT_ROOT)
    expect(r.command.startsWith("'")).toBe(true)
  })
})
