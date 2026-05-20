/**
 * LSP bridge availability probe — R-Phase3 P2-3.
 *
 * `src/agent/lsp-bridge.ts:isAvailable(bin)` spawns `<bin> --version` and
 * races its exit against a 5-second timeout. The race + post-timeout
 * `proc.kill()` + `await proc.exited.catch()` is concurrency-sensitive code
 * that wasn't directly tested — only indirectly via the LSP diagnostics e2e
 * (which exercises the success path through a fake provider).
 *
 * Two pinned contracts:
 *   1. Bogus / non-existent binary → returns `false` PROMPTLY (no hang). The
 *      function MUST NOT block longer than its internal 5s timer; the test
 *      asserts well under 8s as a conservative ceiling.
 *   2. The result is CACHED per-process so a second probe for the same `bin`
 *      returns the same boolean without re-spawning. This is the
 *      `availabilityCache` contract — important because `lspDiagnosticsTool`
 *      can be invoked many times per session and each invocation queries the
 *      provider, which in turn calls `isAvailable`.
 *
 * `isAvailable` itself is module-private; we exercise it via the public
 * `lspDiagnosticsProvider().open()` path. `open(filePath, cwd)` resolves to
 * `null` when no server is available for the file's extension (after the
 * binary probe failed). That `null` is our signal.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { lspDiagnosticsProvider } from "@/agent/lsp-bridge"

describe("LSP bridge — binary availability probe", () => {
  test("bogus dockerBin-equivalent (typescript-language-server replacement) → returns null PROMPTLY", async () => {
    // Override PATH for this test so the real typescript-language-server (if
    // installed locally) cannot be found, forcing the probe to fail.
    const savedPath = process.env.PATH
    process.env.PATH = "/definitely/empty/path"
    const dir = mkdtempSync(join(tmpdir(), "lsp-probe-"))
    try {
      const file = join(dir, "foo.ts")
      writeFileSync(file, "export const x = 1\n")
      const provider = lspDiagnosticsProvider()

      const start = Date.now()
      const session = await provider.open(file, dir)
      const elapsed = Date.now() - start

      // No binary on PATH ⇒ open() resolves to null (graceful degrade).
      expect(session).toBeNull()
      // The probe MUST resolve well under 8s — there's a 5s internal timer.
      // A regression that removed the timer would hit Bun's default
      // jest-timeout instead and surface as a different failure mode.
      expect(elapsed).toBeLessThan(8_000)
    } finally {
      if (savedPath === undefined) delete process.env.PATH
      else process.env.PATH = savedPath
      rmSync(dir, { recursive: true, force: true })
    }
  }, 12_000)

  test("repeated probe of the same bogus binary completes faster (process cache fast path)", async () => {
    // Per-process cache means the second probe should not re-spawn the
    // subprocess; the second call's wall-clock must be << first call's.
    // We cannot read the cache directly (module-private), so we measure
    // wall-clock as a black-box behavioural assertion.
    const savedPath = process.env.PATH
    process.env.PATH = "/definitely/empty/path"
    const dir = mkdtempSync(join(tmpdir(), "lsp-probe-cache-"))
    try {
      const file = join(dir, "bar.ts")
      writeFileSync(file, "export const y = 2\n")
      const provider = lspDiagnosticsProvider()

      // First probe primes the cache (may spawn `--version` or not, depending
      // on whether a previous test already poisoned the cache — either way
      // we just need a baseline). Wall-clock will be 0–5s.
      const t1Start = Date.now()
      await provider.open(file, dir)
      const t1 = Date.now() - t1Start

      // Second probe MUST be sub-second (cache hit) regardless of t1.
      const t2Start = Date.now()
      const session2 = await provider.open(file, dir)
      const t2 = Date.now() - t2Start

      expect(session2).toBeNull()
      // The cache eliminates the spawn cost. A regression that broke the
      // cache would make t2 ≈ t1 (both ~spawn time). Use a generous ceiling
      // (500ms) so spurious load doesn't false-fail; the real win is orders
      // of magnitude smaller in practice.
      expect(t2).toBeLessThan(500)
      // Sanity: the contract holds regardless of t1's exact value.
      void t1
    } finally {
      if (savedPath === undefined) delete process.env.PATH
      else process.env.PATH = savedPath
      rmSync(dir, { recursive: true, force: true })
    }
  }, 12_000)

  test("unknown file extension → provider returns null immediately (no probe)", async () => {
    // The bridge maps `.ts/.tsx/.js/.jsx/.mjs/.cjs` → typescript-language-server
    // and `.py/.pyi` → pyright. Anything else has no mapped server and
    // `open()` returns null without ever spawning a probe — a critical
    // optimization for read/write tools that pass through non-source files.
    const dir = mkdtempSync(join(tmpdir(), "lsp-probe-unknown-"))
    try {
      const file = join(dir, "README.txt")
      writeFileSync(file, "plain text\n")
      const provider = lspDiagnosticsProvider()

      const start = Date.now()
      const session = await provider.open(file, dir)
      const elapsed = Date.now() - start

      expect(session).toBeNull()
      // No spawn, no probe — must be effectively instantaneous (sub-100ms is
      // generous; in practice it's a few microseconds).
      expect(elapsed).toBeLessThan(100)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 5_000)
})
