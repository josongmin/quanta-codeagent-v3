/**
 * `reproRunArgv` — runs an Agentless repro script under the SAME project env the
 * synthesized testCmd uses. The bug it fixes: a bare `python3 <script>` on the
 * box host cannot `import` the target project (not pip-installed there), so every
 * repro hit ModuleNotFoundError and the primary rail never fired. The argv must
 * mirror `synthesizeTestCmd`'s `uvx --with-editable .` env strategy.
 */
import { describe, expect, test } from "bun:test"
import { reproRunArgv } from "@/runner/batch/corpus/dataset"

describe("reproRunArgv", () => {
  test("wraps the script in a uvx editable-install env (not a bare python)", () => {
    const argv = reproRunArgv("sympy/sympy", "/sandbox/__repro_0.py")
    // It must NOT be a bare interpreter — that is the exact bug.
    expect(argv[0]).toBe("uvx")
    expect(argv).toContain("--with-editable")
    // `.` installs the repo from the sandbox cwd so its modules import.
    expect(argv[argv.indexOf("--with-editable") + 1]).toBe(".")
    // The script is the final positional arg, invoked via `python`.
    expect(argv[argv.length - 1]).toBe("/sandbox/__repro_0.py")
    expect(argv[argv.length - 2]).toBe("python")
  })

  test("pins the repo's known python version (light-tier repos ⇒ 3.9)", () => {
    const argv = reproRunArgv("pallets/flask", "/s/x.py")
    expect(argv[argv.indexOf("--python") + 1]).toBe("3.9")
  })

  test("unknown repo ⇒ falls back to 3.10 (safer for modern code)", () => {
    const argv = reproRunArgv("some/unknown-repo", "/s/x.py")
    expect(argv[argv.indexOf("--python") + 1]).toBe("3.10")
  })
})
