import { describe, expect, test } from "bun:test"
import { reproValidationCmd } from "@/runner/batch/eval/repro-command"

describe("reproValidationCmd", () => {
  test("SWE-bench repro command uses project-env argv, not bare python", () => {
    const cmd = reproValidationCmd({
      repo: "django/django",
      version: "3.1",
      scriptPath: "/sandbox/reproduce_issue.py",
    })
    expect(cmd).toContain("uv run")
    expect(cmd).toContain("--with-editable .")
    expect(cmd).toContain("python -s /sandbox/reproduce_issue.py")
    expect(cmd.startsWith("python ")).toBe(false)
  })

  test("non-SWE fixture still uses explicit python3, never ambiguous python", () => {
    expect(
      reproValidationCmd({
        repo: undefined,
        version: undefined,
        scriptPath: "/sandbox/reproduce_issue.py",
      }),
    ).toBe("python3 -s /sandbox/reproduce_issue.py")
  })
})
