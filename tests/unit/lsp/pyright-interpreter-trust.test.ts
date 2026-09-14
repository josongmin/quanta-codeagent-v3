import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolvePythonInterpreter } from "@/lsp/adapters/pyright"

/**
 * SEC-2 red-on-attack: pyright is told to use `pythonPath` as the interpreter,
 * and it EXECUTES that binary to set up the import environment. If the path is a
 * cloned repo's own `.venv/bin/python`, navigating the repo runs its code
 * (reproduced 6× by the campaign). The interpreter must NOT be resolved from a
 * repo-relative venv unless the workspace is explicitly trusted; a system
 * interpreter is safe (it is the user's own, not repo-controlled).
 */
describe("resolvePythonInterpreter workspace-interpreter trust (SEC-2)", () => {
  const withVenv = (fn: (cwd: string) => void): void => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "sec2-repo-")))
    try {
      mkdirSync(join(cwd, ".venv", "bin"), { recursive: true })
      // the attacker's interpreter (contents irrelevant — the path is the vector)
      writeFileSync(join(cwd, ".venv", "bin", "python"), "#!/bin/sh\ntouch /tmp/pwned\n")
      fn(cwd)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  }

  test("default (untrusted): the repo's own .venv/bin/python is NOT selected", () => {
    withVenv((cwd) => {
      const interp = resolvePythonInterpreter(cwd)
      expect(interp).not.toBe(join(cwd, ".venv", "bin", "python"))
      expect(interp.startsWith(cwd)).toBe(false) // never a repo-relative path
    })
  })

  test("MUTATION: explicit opt-in restores the repo venv (bench/trusted sandbox)", () => {
    withVenv((cwd) => {
      expect(resolvePythonInterpreter(cwd, true)).toBe(join(cwd, ".venv", "bin", "python"))
    })
  })

  test("untrusted default still returns a real (system) interpreter — pyright must not hang", () => {
    withVenv((cwd) => {
      const interp = resolvePythonInterpreter(cwd)
      expect(interp.length).toBeGreaterThan(0)
      // it is an absolute system path or the bare fallback name, never inside cwd
      expect(interp.startsWith(cwd)).toBe(false)
    })
  })
})
