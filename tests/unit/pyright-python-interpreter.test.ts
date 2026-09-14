import { describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolvePythonInterpreter } from "@/lsp/adapters/pyright"

/**
 * Guards the interpreter resolution that the pyright workspace handshake depends
 * on: without a real `pythonPath`, pyright hangs every request. The bench
 * sandbox creates its own venv, so that must win over a PATH interpreter.
 */
describe("resolvePythonInterpreter", () => {
  test("prefers the project's own .venv ONLY with the trusted opt-in (SEC-2)", () => {
    const dir = mkdtempSync(join(tmpdir(), "pyr-interp-"))
    try {
      mkdirSync(join(dir, ".venv", "bin"), { recursive: true })
      const venvPy = join(dir, ".venv", "bin", "python")
      writeFileSync(venvPy, "#!/bin/sh\n")
      chmodSync(venvPy, 0o755)
      // SEC-2: pyright EXECUTES this interpreter, so a repo-relative venv is only
      // consulted for a trusted workspace (allowWorkspaceInterpreter=true, e.g.
      // the bench sandbox). The untrusted default must NOT pick it.
      expect(resolvePythonInterpreter(dir, true)).toBe(venvPy)
      expect(resolvePythonInterpreter(dir)).not.toBe(venvPy)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("falls back to a non-empty interpreter when no venv exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "pyr-interp-"))
    try {
      const p = resolvePythonInterpreter(dir)
      // Always yields *something* (PATH python3 or the bare name) so the config
      // never ships an empty/undefined pythonPath (which re-introduces the hang).
      expect(typeof p).toBe("string")
      expect(p.length).toBeGreaterThan(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
