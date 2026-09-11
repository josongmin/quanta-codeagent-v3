import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TypescriptAdapter } from "@/lsp"
import {
  canExecute,
  capability,
  requireCapability,
} from "../../tools/dev/capability-receipt-consumer"
import { requireContract } from "./_guard"

/**
 * ─── capability receipt (TVH-11) ─────────────────────────────────────────────
 *
 * Was a `Bun.spawn(["typescript-language-server", "--version"])` at MODULE LOAD, re-run
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
const lsp = requireCapability(capability("typescript-language-server"))
const available = requireContract("typescript-language-server", canExecute(lsp))

const tmpDirs: string[] = []
const REPO_TYPESCRIPT = join(import.meta.dir, "..", "..", "node_modules", "typescript")
const makeTmpDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "quanta-lsp-ts-"))
  tmpDirs.push(dir)
  // typescript-language-server resolves the `typescript` package FROM THE
  // WORKSPACE (or an explicit tsserver.path), never from its own global
  // install — an empty temp workspace fails `initialize` with "Could not find
  // a valid TypeScript installation" on any host where typescript is not
  // globally adjacent (CI installs both side by side; a dev machine usually
  // does not). Provision the workspace with the repo's real typescript so the
  // contract exercises the adapter, not the host's global-install layout.
  if (existsSync(REPO_TYPESCRIPT)) {
    mkdirSync(join(dir, "node_modules"))
    symlinkSync(REPO_TYPESCRIPT, join(dir, "node_modules", "typescript"))
  }
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

describe("TypescriptAdapter (integration)", () => {
  if (!available) {
    test.skip("typescript-language-server not installed — skipping real round trip", () => {
      // biome-ignore lint/suspicious/noConsole: intentional skip signal for CI
      console.log("[lsp-typescript.test] typescript-language-server unavailable; tests skipped")
    })
    return
  }

  test("reports an error diagnostic for a type-mismatched file", async () => {
    const dir = makeTmpDir()
    const file = join(dir, "bad.ts")
    writeFileSync(file, 'const n: number = "s"\nexport { n }\n')

    const adapter = new TypescriptAdapter({ cwd: dir, requestTimeoutMs: 9_000 })
    try {
      await adapter.start()
      const diags = await adapter.diagnostics(file)

      const errors = diags.filter((d) => d.severity === "error")
      expect(errors.length).toBeGreaterThan(0)

      const first = errors[0]
      expect(first).toBeDefined()
      if (first) {
        expect(first.uri).toContain("bad.ts")
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
    const file = join(dir, "good.ts")
    writeFileSync(file, "export const add = (a: number, b: number): number => a + b\n")

    const adapter = new TypescriptAdapter({ cwd: dir, requestTimeoutMs: 9_000 })
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
    const adapter = new TypescriptAdapter({ cwd: dir, requestTimeoutMs: 6_000 })
    await adapter.start()
    await adapter.stop()
    // W1-A audit fix: previous `expect(true).toBe(true)` was vapor — it
    // passed without expressing intent. `resolves.toBeUndefined()` makes the
    // idempotent contract explicit at the assertion site (second `stop()`
    // settles cleanly and returns `void`).
    await expect(adapter.stop()).resolves.toBeUndefined()
  }, 15_000)
})
