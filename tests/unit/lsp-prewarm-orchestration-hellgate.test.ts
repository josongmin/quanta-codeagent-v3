/**
 * Hellgate for the RFC jun-17 prewarm/evict ORCHESTRATION around the pyright
 * pool. Uses a FAKE pyright client (injected via the existing test seam) so no
 * `pyright-langserver` binary is required — `prewarmLspWorkspace` does not probe
 * availability, so the whole path is reachable hermetically. Anchor files carry
 * NO imports so the readiness probe resolves true immediately (no timing).
 *
 *   PO-01  resolvePrewarmAnchor picks the Python file in a polyglot tree.
 *   PO-02  resolvePrewarmAnchor returns null when no warm-capable file exists.
 *   PO-03  startBackgroundLspPrewarm warms exactly one workspace + releases.
 *   PO-04  maybeStartLspPrewarm is GATED (disabled ⇒ nothing spawned).
 *   PO-05  maybeStartLspPrewarm is FIRE-AND-FORGET (returns before the warm runs).
 *   PO-06  disposeSessionResources evicts the pool ONLY when evictLspPoolOnEnd
 *          is set (RED-on-injection: flag off ⇒ the warm child leaks).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { maybeStartLspPrewarm } from "@/agent/loop/session-bootstrap"
import { disposeSessionResources } from "@/agent/loop/session-lifecycle"
import {
  __acquirePyrightTestIsolationForTest,
  __resetSharedPyrightSessionsForTest,
  __setPyrightClientFactoryForTest,
  evictLspWorkspaces,
  prewarmLspWorkspace,
  resolvePrewarmAnchor,
  startBackgroundLspPrewarm,
} from "@/agent/lsp-bridge"
import type { AnchorDirEntry, AnchorDirLister } from "@/agent/mention-injection"
import { LspClient } from "@/lsp"

let created = 0
class FakePyright extends LspClient {
  stopCalls = 0
  constructor() {
    super({ defaultCommand: ["unused"], languageIdFor: () => "python" })
    created += 1
  }
  override async start(): Promise<void> {}
  override async stop(): Promise<void> {
    this.stopCalls += 1
  }
  override async prime(): Promise<void> {}
  override async definition(): Promise<null> {
    return null
  }
}

const lastClients: FakePyright[] = []
let releasePyrightTestIsolation: (() => void) | undefined
beforeEach(async () => {
  releasePyrightTestIsolation = await __acquirePyrightTestIsolationForTest()
})
afterEach(async () => {
  try {
    await __resetSharedPyrightSessionsForTest()
    __setPyrightClientFactoryForTest(null)
    created = 0
    lastClients.length = 0
  } finally {
    releasePyrightTestIsolation?.()
    releasePyrightTestIsolation = undefined
  }
})

const installFakeFactory = (): void => {
  __setPyrightClientFactoryForTest(() => {
    const c = new FakePyright()
    lastClients.push(c)
    return c
  })
}

/** Wait for the background task's observable effect without asserting a fixed
 * scheduler delay. The bounded deadline keeps a missing fire-and-forget launch
 * RED while allowing a contended full-suite worker to run the queued warm. */
const waitForCreatedClient = async (timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (created === 0) {
    if (Date.now() >= deadline) {
      throw new Error(`background LSP prewarm did not create a client within ${timeoutMs}ms`)
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
}

/** Hermetic lister over an in-memory tree (no fs walk). */
const fakeLister = (tree: Record<string, AnchorDirEntry[]>): AnchorDirLister => ({
  readDir: async (dir: string): Promise<readonly AnchorDirEntry[]> => tree[dir] ?? [],
})

describe("RFC jun-17 — prewarm/evict orchestration", () => {
  test("PO-01: resolvePrewarmAnchor picks the Python file in a polyglot tree", async () => {
    const tree = {
      "/repo": [
        { name: "app.ts", isDirectory: false },
        { name: "main.py", isDirectory: false },
      ],
    }
    const anchor = await resolvePrewarmAnchor("/repo", fakeLister(tree))
    expect(anchor).toBe(join("/repo", "main.py"))
  })

  test("PO-02: resolvePrewarmAnchor returns null when no warm-capable file exists", async () => {
    const tree = { "/repo": [{ name: "app.ts", isDirectory: false }] }
    const anchor = await resolvePrewarmAnchor("/repo", fakeLister(tree))
    expect(anchor).toBeNull()
  })

  test("PO-03: startBackgroundLspPrewarm warms exactly one workspace then releases", async () => {
    installFakeFactory()
    const dir = mkdtempSync(join(tmpdir(), "po-"))
    writeFileSync(join(dir, "m.py"), "def f():\n    return 1\n") // no import ⇒ ready=true
    try {
      await startBackgroundLspPrewarm(dir)
      expect(created).toBe(1)
      // A subsequent real prewarm of the same cwd is a warm HIT (no new client).
      await prewarmLspWorkspace(join(dir, "m.py"), dir)
      expect(created).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("PO-04: maybeStartLspPrewarm gated — disabled ⇒ nothing spawned", async () => {
    installFakeFactory()
    const dir = mkdtempSync(join(tmpdir(), "po-"))
    writeFileSync(join(dir, "m.py"), "x = 1\n")
    try {
      // Disabled (slot absent).
      maybeStartLspPrewarm({ cwd: dir } as never)
      await new Promise((r) => setTimeout(r, 30))
      expect(created).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("PO-05: maybeStartLspPrewarm is fire-and-forget (returns before the warm runs)", async () => {
    installFakeFactory()
    const dir = mkdtempSync(join(tmpdir(), "po-"))
    writeFileSync(join(dir, "m.py"), "x = 1\n")
    try {
      maybeStartLspPrewarm({ cwd: dir, lspPrewarm: { enabled: true } } as never)
      // Synchronously after the call the warm has NOT run (async anchor synth +
      // client spawn happen on later microtasks). This is the "session start is
      // not delayed" guarantee.
      expect(created).toBe(0)
      // …but it DOES run after yielding (the warm was actually scheduled).
      // Do not encode a 50ms scheduler promise: full-suite CPU contention can
      // delay this task without changing fire-and-forget behavior.
      await waitForCreatedClient()
      expect(created).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("PO-06: disposeSessionResources evicts ONLY when evictLspPoolOnEnd is set", async () => {
    installFakeFactory()
    const dir = mkdtempSync(join(tmpdir(), "po-"))
    writeFileSync(join(dir, "m.py"), "x = 1\n")
    const baseCfg = { cwd: dir, stream: { emit: () => {} } }
    try {
      // --- flag OFF: warm entry must survive dispose (idle-TTL only). ---
      await prewarmLspWorkspace(join(dir, "m.py"), dir)
      expect(created).toBe(1)
      await disposeSessionResources({
        cfg: { ...baseCfg } as never,
        features: {} as never,
      })
      const stoppedOff = lastClients[0]?.stopCalls ?? 0
      expect(stoppedOff).toBe(0) // NOT evicted

      // --- flag ON: dispose must evict (client stopped, pool emptied). ---
      await disposeSessionResources({
        cfg: { ...baseCfg, evictLspPoolOnEnd: true } as never,
        features: {} as never,
      })
      expect(lastClients[0]?.stopCalls).toBe(1) // evicted
      // Pool emptied ⇒ a fresh prewarm spawns a NEW client.
      await prewarmLspWorkspace(join(dir, "m.py"), dir)
      expect(created).toBe(2)
      await evictLspWorkspaces(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
