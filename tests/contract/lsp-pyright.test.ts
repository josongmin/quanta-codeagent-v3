import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PyrightAdapter } from "@/lsp"
import { requireContract } from "./_guard"

const COMMAND = ["pyright-langserver", "--stdio"]

/** Probe whether the Pyright language server is actually launchable in this
 *  environment. The whole suite must stay 0-fail when it is absent, so this
 *  gates the real round-trip tests. */
const pyrightAvailable = async (): Promise<boolean> => {
  try {
    const proc = Bun.spawn([COMMAND[0] as string, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const exit = await Promise.race([
      proc.exited,
      new Promise<number>((resolve) => setTimeout(() => resolve(-1), 5_000)),
    ])
    try {
      proc.kill()
    } catch {
      // already exited
    }
    // `--version` exits non-zero on some builds but still proves the binary
    // resolves and runs; -1 means our timeout fired (treat as unavailable).
    return exit !== -1
  } catch {
    return false
  }
}

const available = requireContract("pyright-langserver", await pyrightAvailable())

const tmpDirs: string[] = []
const makeTmpDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "quanta-lsp-"))
  tmpDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }
})

describe("PyrightAdapter (integration)", () => {
  if (!available) {
    test.skip("pyright-langserver not installed — skipping real round trip", () => {
      // biome-ignore lint/suspicious/noConsole: intentional skip signal for CI
      console.log("[lsp-pyright.test] pyright-langserver unavailable; tests skipped")
    })
    return
  }

  test("reports an error diagnostic for a type-mismatched file", async () => {
    const dir = makeTmpDir()
    const file = join(dir, "bad.py")
    writeFileSync(file, 'x: int = "not an int"\n')

    const adapter = new PyrightAdapter({ cwd: dir, requestTimeoutMs: 9_000 })
    try {
      await adapter.start()
      const diags = await adapter.diagnostics(file)

      const errors = diags.filter((d) => d.severity === "error")
      expect(errors.length).toBeGreaterThan(0)

      const first = errors[0]
      expect(first).toBeDefined()
      if (first) {
        expect(first.uri).toContain("bad.py")
        expect(typeof first.message).toBe("string")
        expect(first.message.length).toBeGreaterThan(0)
        // The error is on line 0 (zero-based LSP coords).
        expect(first.range.start.line).toBe(0)
        expect(first.range.end.character).toBeGreaterThanOrEqual(first.range.start.character)
      }
    } finally {
      await adapter.stop()
    }
  }, 15_000)

  test("reports no error diagnostics for a clean file", async () => {
    const dir = makeTmpDir()
    const file = join(dir, "good.py")
    writeFileSync(file, "x: int = 1\n\n\ndef add(a: int, b: int) -> int:\n    return a + b\n")

    const adapter = new PyrightAdapter({ cwd: dir, requestTimeoutMs: 9_000 })
    try {
      await adapter.start()
      const diags = await adapter.diagnostics(file)
      expect(diags.filter((d) => d.severity === "error")).toHaveLength(0)
    } finally {
      await adapter.stop()
    }
  }, 15_000)

  test("stop() terminates the server process and is idempotent", async () => {
    const dir = makeTmpDir()
    const adapter = new PyrightAdapter({ cwd: dir, requestTimeoutMs: 6_000 })
    await adapter.start()
    await adapter.stop()
    // Second stop must be a no-op, not a throw or hang.
    await adapter.stop()
    expect(true).toBe(true)
  }, 15_000)
})
