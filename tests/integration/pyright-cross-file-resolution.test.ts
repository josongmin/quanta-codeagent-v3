import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PyrightAdapter } from "@/lsp/adapters/pyright"

/**
 * REAL-pyright hellgate. The existing `lsp-client-persistent-sync-hellgate`
 * test drives a FAKE scripted server, so it stayed green while the workspace
 * handshake silently broke EVERY real query (definition timed out forever
 * because the `workspace/configuration` response omitted `pythonPath`, so
 * pyright never set up the workspace import environment).
 *
 * This test spawns the REAL `pyright-langserver` on a tiny 2-file project and
 * asserts a CROSS-FILE import resolves to its defining file. TEETH: drop
 * `pythonPath` from `buildWorkspaceConfiguration` (pyright.ts) OR the
 * `workspace/didChangeConfiguration` push (base.ts) and this times out → null →
 * fails. It is the regression guard for the whole class.
 *
 * Skips cleanly when `pyright-langserver` is not on PATH (CI without pyright).
 */
const pyrightOnPath = Bun.which("pyright-langserver") !== null
const gate = pyrightOnPath ? describe : describe.skip

gate("pyright cross-file resolution (real server)", () => {
  test("resolves a cross-file import to its defining file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pyright-xfile-"))
    writeFileSync(join(dir, "exc.py"), "class MyError(Exception):\n    pass\n")
    writeFileSync(
      join(dir, "use.py"),
      'from exc import MyError\n\ndef run():\n    raise MyError("x")\n',
    )
    const usePath = join(dir, "use.py")
    const client = new PyrightAdapter({ cwd: dir })
    const ac = new AbortController()
    try {
      await client.start(ac.signal)
      // Poll while pyright indexes; `raise MyError` is at use.py line 3 (0-based),
      // char 10 ("    raise " = 10 chars before `M`).
      let resolved: { uri: string }[] | null = null
      const deadline = Date.now() + 25_000
      while (Date.now() < deadline) {
        const defs = await client
          .definition(usePath, { line: 3, character: 10 }, ac.signal)
          .catch(() => null)
        if (defs && defs.length > 0) {
          resolved = defs
          break
        }
        await new Promise((r) => setTimeout(r, 50))
      }
      // RED-on-injection: without pythonPath + the didChangeConfiguration push,
      // pyright never answers → `resolved` stays null → this fails.
      expect(resolved).not.toBeNull()
      expect(resolved?.[0]?.uri ?? "").toContain("exc.py")
    } finally {
      await client.stop().catch(() => undefined)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 40_000)
})
