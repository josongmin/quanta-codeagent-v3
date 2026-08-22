/**
 * Hellgate for the strict-admission READY proof (jun-23 plan, LSP-01).
 *
 * `proveStrictLspReady` is the seam that raises strict-LSP admission from
 * "binary launchable" to "task-relevant workspace verified-ready". It drives the
 * SAME pyright warm backend the real solve uses (via the module pool + the test
 * client-factory override), and returns a typed {@link LspGroundingReceipt}.
 *
 *   SR-01  a launchable + warm-ready Python workspace ⇒ outcome=ok, stage=ready.
 *   SR-02  a launchable-but-COLD workspace (readiness budget exhausted) ⇒
 *          ready_timeout — the exact case launchability-only admission missed.
 *   SR-03  a fatal transport death during the probe ⇒ fatal_transport.
 *   SR-04  a language with NO warm pool ⇒ launch-stage ok (binary preflight is
 *          the only authority; no divergent second readiness heuristic).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  __acquirePyrightTestIsolationForTest,
  __resetSharedPyrightSessionsForTest,
  __setPyrightClientFactoryForTest,
  __setPyrightWarmupTimingForTest,
  proveStrictLspReady,
} from "@/agent/lsp-bridge"
import { type Location, LspClient, type LspClientOptions } from "@/lsp"
import { __resetRuntimeConfig } from "@/shared"

const READY_BUDGET_KEY = "QUANTA_LSP_READY_TIMEOUT_MS"
const priorReadyBudget = process.env[READY_BUDGET_KEY]

type DefFn = () => Promise<Location[] | null>

class FakePyrightClient extends LspClient {
  startImpl: () => Promise<void> = async () => {}
  defImpl: DefFn = async () => []
  constructor(options: LspClientOptions = {}) {
    super({ defaultCommand: ["unused"], languageIdFor: () => "python" }, options)
  }
  override async start(): Promise<void> {
    await this.startImpl()
  }
  override async stop(): Promise<void> {}
  override async prime(): Promise<void> {}
  override async definition(): Promise<Location[] | null> {
    return this.defImpl()
  }
}

const mkRepo = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix))

let releasePyrightTestIsolation: (() => void) | undefined
beforeEach(async () => {
  releasePyrightTestIsolation = await __acquirePyrightTestIsolationForTest()
})
afterEach(async () => {
  try {
    await __resetSharedPyrightSessionsForTest()
    __setPyrightClientFactoryForTest(null)
    __setPyrightWarmupTimingForTest(null)
    if (priorReadyBudget === undefined) delete process.env[READY_BUDGET_KEY]
    else process.env[READY_BUDGET_KEY] = priorReadyBudget
    __resetRuntimeConfig()
  } finally {
    releasePyrightTestIsolation?.()
    releasePyrightTestIsolation = undefined
  }
})

describe("strict LSP ready proof (LSP-01)", () => {
  test("SR-01: warm-ready Python workspace ⇒ ok/ready", async () => {
    const dir = mkRepo("sr-ok-")
    const file = join(dir, "core.py") // no import ⇒ readiness is trivially true once started
    writeFileSync(file, "def add(a, b):\n    return a + b\n")
    __setPyrightClientFactoryForTest(() => new FakePyrightClient())
    try {
      const r = await proveStrictLspReady(file, dir, "pyright-langserver")
      expect(r.outcome).toBe("ok")
      expect(r.stage).toBe("ready")
      expect(r.backend).toBe("pyright")
      expect(r.language).toBe("pyright-langserver")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("SR-02: launchable-but-COLD workspace ⇒ ready_timeout (the launchability-only gap)", async () => {
    const dir = mkRepo("sr-cold-")
    // An import gives `ensurePyrightFileReady` a probe symbol to poll; a fake
    // client that never resolves it exhausts the (tiny) readiness budget.
    const file = join(dir, "withimport.py")
    writeFileSync(file, "from exc import MyError\n\n\ndef g():\n    return MyError\n")
    const fake = new FakePyrightClient()
    fake.defImpl = async () => [] // never resolves the probe symbol
    __setPyrightClientFactoryForTest(() => fake)
    __setPyrightWarmupTimingForTest({ budgetMs: 120, retryMs: 40 }) // ≥1 probe, fast exhaust
    try {
      const r = await proveStrictLspReady(file, dir, "pyright-langserver")
      expect(r.outcome).toBe("ready_timeout")
      expect(r.stage).toBe("ready")
      // PAIRED CONTROL: the SAME workspace with a resolving server is ok — proving
      // the timeout is about readiness, not the wiring.
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("SR-02b: same workspace, server resolves the probe ⇒ ok (paired control)", async () => {
    const dir = mkRepo("sr-warm-")
    const file = join(dir, "withimport.py")
    writeFileSync(file, "from exc import MyError\n\n\ndef g():\n    return MyError\n")
    const fake = new FakePyrightClient()
    fake.defImpl = async () => [
      {
        uri: `file://${file}`,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      },
    ]
    __setPyrightClientFactoryForTest(() => fake)
    __setPyrightWarmupTimingForTest({ budgetMs: 500, retryMs: 40 })
    try {
      const r = await proveStrictLspReady(file, dir, "pyright-langserver")
      expect(r.outcome).toBe("ok")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("SR-03: fatal transport death during the probe ⇒ fatal_transport", async () => {
    const dir = mkRepo("sr-fatal-")
    const file = join(dir, "core.py")
    writeFileSync(file, "def add(a, b):\n    return a + b\n")
    const fake = new FakePyrightClient()
    fake.startImpl = async () => {
      throw new Error("transport: server stopped unexpectedly")
    }
    __setPyrightClientFactoryForTest(() => fake)
    try {
      const r = await proveStrictLspReady(file, dir, "pyright-langserver")
      expect(r.outcome).toBe("fatal_transport")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("SR-04: language with NO warm pool ⇒ launch-stage ok (no divergent heuristic)", async () => {
    const dir = mkRepo("sr-nopool-")
    const file = join(dir, "Main.java")
    writeFileSync(file, "class Main {}\n")
    const r = await proveStrictLspReady(file, dir, "jdtls")
    expect(r.outcome).toBe("ok")
    expect(r.stage).toBe("launch")
    expect(r.reason).toContain("no warm pool")
    rmSync(dir, { recursive: true, force: true })
  })

  test("SR-05: QUANTA_LSP_READY_TIMEOUT_MS reaches the READ SITE (knob → budgetMs, not just parse)", async () => {
    // The audit gap: the knob test only proved env→runtimeConfig parse. THIS
    // proves the value actually becomes ensurePyrightFileReady's budget. Set a
    // tiny budget + a never-resolving server: the ready proof must time out
    // FAST (~one poll). RED-on-injection: if the read site drops
    // `?? runtimeConfig().lspReadyTimeoutMs`, the budget falls back to 90_000 →
    // this blocks ~90 s and fails the durationMs assertion / the test timeout.
    // NOTE: no `__setPyrightWarmupTimingForTest` — that override would mask the
    // knob (it takes precedence), so the knob must be the ONLY budget source.
    const dir = mkRepo("sr-knob-")
    const file = join(dir, "withimport.py")
    writeFileSync(file, "from exc import MyError\n\n\ndef g():\n    return MyError\n")
    const fake = new FakePyrightClient()
    fake.defImpl = async () => [] // never resolves the probe symbol
    __setPyrightClientFactoryForTest(() => fake)
    process.env[READY_BUDGET_KEY] = "300" // 300ms budget via the knob
    __resetRuntimeConfig()
    try {
      const r = await proveStrictLspReady(file, dir, "pyright-langserver")
      expect(r.outcome).toBe("ready_timeout")
      // The budget the knob set bounds the wall time. Inert knob ⇒ 90s default
      // ⇒ this far exceeds 5s. (retryMs is the real 1s, so ~1 poll ≈ ~1s here.)
      expect(r.durationMs ?? Number.POSITIVE_INFINITY).toBeLessThan(5000)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)
})
