import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  __resetSharedPyrightSessionsForTest,
  __setPyrightClientFactoryForTest,
  __setPyrightWarmupTimingForTest,
  lspNavProvider,
} from "@/agent/lsp-bridge"
import { type Location, LspClient, type LspClientOptions } from "@/lsp"

/**
 * Hellgate for the pooled-pyright session lifecycle (lsp-bridge.ts). Drives the
 * REAL pool through `lspNavProvider().open` but injects a SCRIPTABLE fake client
 * so the concurrency/lifecycle bugs are deterministically reachable without a
 * live pyright. Requires `pyright-langserver` on PATH only because the provider
 * probes `--version` for availability; the actual client is the fake.
 */
const pyrightOnPath = Bun.which("pyright-langserver") !== null
const gate = pyrightOnPath ? describe : describe.skip

type DefFn = () => Promise<Location[] | null>

class FakePyrightClient extends LspClient {
  defCalls = 0
  primeCalls = 0
  stopCalls = 0
  defImpl: DefFn = async () => []
  constructor(options: LspClientOptions = {}) {
    super({ defaultCommand: ["unused"], languageIdFor: () => "python" }, options)
  }
  override async start(): Promise<void> {}
  override async stop(): Promise<void> {
    this.stopCalls += 1
  }
  override async prime(): Promise<void> {
    this.primeCalls += 1
  }
  override async definition(): Promise<Location[] | null> {
    this.defCalls += 1
    return this.defImpl()
  }
}

const fatal = (): Error => new Error("transport: server stopped")

afterEach(async () => {
  await __resetSharedPyrightSessionsForTest()
  __setPyrightClientFactoryForTest(null)
  __setPyrightWarmupTimingForTest(null)
})

gate("pyright pool lifecycle (fake client)", () => {
  test("fatal error tears the session down ONCE and sibling handles fail soft (no hammering a stopped client)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pyr-pool-"))
    const file = join(dir, "noimports.py") // no import ⇒ warm-up probe is null ⇒ trivial
    writeFileSync(file, "def f(x):\n    return x\n")
    const fake = new FakePyrightClient()
    __setPyrightClientFactoryForTest(() => fake)
    try {
      const h1 = await lspNavProvider().open(file, dir)
      const h2 = await lspNavProvider().open(file, dir) // same cwd ⇒ shared entry, refs=2
      expect(h1).not.toBeNull()
      expect(h2).not.toBeNull()

      // h1's call throws a FATAL error → triggers teardown (client.stop once).
      fake.defImpl = async () => {
        throw fatal()
      }
      await expect(h1?.definition(file, { line: 0, character: 0 })).rejects.toThrow()
      // teardown is fired with `void` (not awaited) — let the microtask settle.
      await new Promise((r) => setTimeout(r, 10))
      expect(fake.stopCalls).toBe(1)

      const defCallsAfterTeardown = fake.defCalls
      // h2 (sibling, still "open") now calls → must fail soft with the closed
      // sentinel and NOT drive the stopped client again.
      await expect(h2?.definition(file, { line: 0, character: 0 })).rejects.toThrow(
        /shared session closed/,
      )
      expect(fake.defCalls).toBe(defCallsAfterTeardown) // RED-on-injection: no extra client call
      // releasing both handles must not double-stop or throw.
      await h1?.stop()
      await h2?.stop()
      expect(fake.stopCalls).toBe(1) // teardown already stopped it; release is a no-op stop
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("warm-up budget exhaustion does NOT mark the file prepared — the next call re-attempts warm-up", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pyr-pool-"))
    const file = join(dir, "withimport.py") // has an import ⇒ warm-up probe is non-null
    writeFileSync(file, "from exc import MyError\n\ndef g():\n    return MyError\n")
    const fake = new FakePyrightClient()
    fake.defImpl = async () => [] // never "ready" ⇒ warm-up always exhausts
    __setPyrightClientFactoryForTest(() => fake)
    __setPyrightWarmupTimingForTest({ budgetMs: 200, retryMs: 50 }) // ≥1 probe, fast exhaust
    try {
      const h = await lspNavProvider().open(file, dir)
      expect(h).not.toBeNull()
      const after1 = fake.defCalls // warm-up probes (≥1) + the open() warm-up
      await h?.definition(file, { line: 3, character: 11 })
      const delta = fake.defCalls - after1
      // With the fix the file was NOT marked prepared, so this call RE-runs the
      // warm-up loop (≥1 probe) + the nav call ⇒ delta ≥ 2.
      // RED-on-injection: if exhaustion marked it prepared (the bug), the call
      // skips warm-up and only does the single nav call ⇒ delta === 1.
      expect(delta).toBeGreaterThanOrEqual(2)
      await h?.stop()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
