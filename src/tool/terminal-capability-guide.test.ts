import { describe, expect, test } from "bun:test"
import { TERMINAL_OPERATOR_GUIDE, terminalOperatorGuide } from "./terminal-capability-guide"

describe("terminal-operator capability guide (TB21-06 TC-3)", () => {
  test("covers the SOTA levers that close the #1 failure mode (exe-not-in-PATH)", () => {
    const g = terminalOperatorGuide()
    expect(g).toBe(TERMINAL_OPERATOR_GUIDE)
    // env-probe (#5): probe before assuming a tool exists
    expect(g).toMatch(/command -v|--version/)
    expect(g.toLowerCase()).toContain("not found")
    // install-on-demand: detect the present package manager (not a fixed one)
    expect(g).toMatch(/apt-get|dnf|apk/)
    expect(g.toLowerCase()).toContain("install")
    // exit-code completion (#2) + structured-exec over keystroke (#1)
    expect(g.toLowerCase()).toContain("exit code")
    expect(g).toContain("container_exec")
    expect(g).toContain("pty_")
    // self-verify (#6)
    expect(g.toLowerCase()).toContain("verify")
  })

  test("is GENERAL operator guidance — no benchmark / harness / answer-key naming", () => {
    const g = TERMINAL_OPERATOR_GUIDE
    // (a) no harness / bench naming
    expect(g).not.toMatch(/TerminalBench|terminal-bench|Harbor|BaseAgent/i)
    for (const w of ["benchmark", "gold", "test case"]) expect(g.toLowerCase()).not.toContain(w)
    // (b) the REAL answer-key shape (memory: no-answer-key) — a leaked HINT is task-specific, not
    // the word "benchmark". A denylist can't fully prove generality, but pin the dangerous shapes
    // the *_STEER hardcoded-gold incident taught: pinned package versions, pytest node-ids, concrete
    // source-file paths, and "for this/the task" framing must NOT appear in general guidance.
    expect(g).not.toMatch(/==\s*\d/) // pip/np version pin (e.g. numpy==1.21)
    expect(g).not.toMatch(/::/) // pytest node-id (tests/x.py::test_y)
    expect(g).not.toMatch(/\b[\w./-]+\.(py|js|ts|c|cpp|go|rs|java)\b/) // a concrete source-file path
    expect(g.toLowerCase()).not.toMatch(/this task|the task|should pass|expected output/)
  })

  test("is a self-contained non-empty section (no wiring side effects)", () => {
    expect(TERMINAL_OPERATOR_GUIDE.trim().length).toBeGreaterThan(200)
  })
})
