import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PyrightAdapter } from "@/lsp"
import {
  canExecute,
  capability,
  requireCapability,
} from "../../tools/dev/capability-receipt-consumer"
import { requireContract } from "./_guard"

/**
 * ─── capability receipt (TVH-11) ─────────────────────────────────────────────
 *
 * Was a `Bun.spawn(["pyright-langserver", "--version"])` at MODULE LOAD, re-run
 * per contract file that asks the same question, with an uncleared 5,000ms
 * `Promise.race` timer on the winning path. The tier's capability producer
 * probes once, under one deadline, and this reads the receipt — importing the
 * file now starts nothing.
 *
 * `requireCapability` preserves the `_guard.ts` CI contract: under
 * `QUANTA_REQUIRE_CAPABILITIES`, a `blocked` receipt (nobody probed) or a
 * `failed-setup` (the probe wedged) THROWS instead of passing for the absent
 * tool's reason.
 */
const lsp = requireCapability(capability("pyright-langserver"))
const available = requireContract("pyright-langserver", canExecute(lsp))

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
    // W1-A audit fix: previous `expect(true).toBe(true)` was vapor — it
    // passed without expressing intent. `resolves.toBeUndefined()` makes the
    // idempotent contract explicit (second `stop()` settles cleanly).
    await expect(adapter.stop()).resolves.toBeUndefined()
  }, 15_000)
})
