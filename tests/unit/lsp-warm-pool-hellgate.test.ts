/**
 * Hellgate for the GENERIC SharedWorkspacePool (RFC jun-17 code-intelligence
 * warm backend). Drives the REAL pool through a FAKE {@link WarmBackend} whose
 * id is NOT "pyright" and a scriptable fake client — proving the pool's
 * lifecycle (cwd-key map, refcount, `startPromise` join, prepared dedup, fatal
 * teardown, evict, idle reuse) is engine-AGNOSTIC. If any pyright-specific
 * assumption leaked back into the pool, a non-pyright backend would break here.
 *
 *   WP-01  backend-swap: a non-pyright backend drives the full nav surface.
 *   WP-02  join: concurrent opens on one cwd share ONE client + ONE start().
 *   WP-03  prewarm keeps the workspace warm ⇒ the first real open is a warm hit
 *          (no second client spawned).
 *   WP-04  evict tears the workspace down (client.stop) and empties the pool
 *          (RED-on-injection: skipping evict leaves a leaked entry).
 *   WP-05  readiness=false does NOT mark prepared ⇒ the next call re-attempts.
 *   WP-06  supports() gates prewarm ⇒ an unsupported anchor spawns nothing.
 *   WP-07  fatal transport error tears down ONCE; siblings fail soft.
 */
import { describe, expect, test } from "bun:test"
import { SharedWorkspacePool, type WarmBackend } from "@/agent/lsp-workspace-pool"
import { LspClient } from "@/lsp"

const LOC = [
  {
    uri: "file:///x.fake",
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
  },
]

class FakeClient extends LspClient {
  startCalls = 0
  stopCalls = 0
  primeCalls = 0
  defCalls = 0
  defImpl: () => Promise<typeof LOC | null> = async () => LOC
  constructor() {
    super({ defaultCommand: ["unused"], languageIdFor: () => "fake" })
  }
  override async start(): Promise<void> {
    this.startCalls += 1
  }
  override async stop(): Promise<void> {
    this.stopCalls += 1
  }
  override async prime(): Promise<void> {
    this.primeCalls += 1
  }
  override async definition(): Promise<typeof LOC | null> {
    this.defCalls += 1
    return this.defImpl()
  }
}

interface BackendProbe {
  backend: WarmBackend
  createCalls: () => number
  ensureCalls: () => number
  clients: () => FakeClient[]
}

/** A non-pyright WarmBackend whose readiness is scriptable. Tracks how many
 *  clients it spawned + how many readiness probes ran. */
const makeBackend = (opts?: { ready?: boolean; client?: FakeClient }): BackendProbe => {
  let createCount = 0
  let ensureCount = 0
  const clients: FakeClient[] = []
  const ready = opts?.ready ?? true
  const backend: WarmBackend = {
    id: "fake-engine",
    supports: (filePath) => filePath.endsWith(".fake"),
    createClient: () => {
      createCount += 1
      const c = opts?.client ?? new FakeClient()
      clients.push(c)
      return c
    },
    ensureFileReady: async () => {
      ensureCount += 1
      return ready
    },
  }
  return {
    backend,
    createCalls: () => createCount,
    ensureCalls: () => ensureCount,
    clients: () => clients,
  }
}

describe("SharedWorkspacePool — generic engine-agnostic lifecycle (fake backend)", () => {
  test("WP-01: a NON-pyright backend drives the full nav surface (engine-swap proof)", async () => {
    const probe = makeBackend()
    const pool = new SharedWorkspacePool(probe.backend)
    expect(pool.backendId).toBe("fake-engine")
    const session = await pool.open("/repo/a.fake", "/repo")
    expect(session).not.toBeNull()
    const defs = await session?.definition("/repo/a.fake", { line: 0, character: 0 })
    expect(defs).toEqual(LOC)
    expect(probe.createCalls()).toBe(1)
    await session?.stop()
    await pool.disposeAll()
    expect(probe.clients()[0]?.stopCalls).toBe(1)
    expect(pool.__sizeForTest).toBe(0)
  })

  test("WP-02: concurrent opens on one cwd share ONE client and ONE start()", async () => {
    const probe = makeBackend()
    const pool = new SharedWorkspacePool(probe.backend)
    const [h1, h2] = await Promise.all([
      pool.open("/repo/a.fake", "/repo"),
      pool.open("/repo/b.fake", "/repo"),
    ])
    expect(h1).not.toBeNull()
    expect(h2).not.toBeNull()
    expect(probe.createCalls()).toBe(1) // shared cwd entry
    expect(probe.clients()[0]?.startCalls).toBe(1) // startPromise joined, not re-run
    await h1?.stop()
    await h2?.stop()
    await pool.disposeAll()
  })

  test("WP-03: prewarm keeps the workspace warm ⇒ first real open is a warm hit", async () => {
    const probe = makeBackend()
    const pool = new SharedWorkspacePool(probe.backend)
    await pool.prewarm("/repo/anchor.fake", "/repo")
    expect(probe.createCalls()).toBe(1)
    expect(pool.__sizeForTest).toBe(1) // ref released to 0 but entry kept warm by idle-TTL
    // First real call reuses the warm entry — NO second client spawned.
    const session = await pool.open("/repo/other.fake", "/repo")
    expect(session).not.toBeNull()
    expect(probe.createCalls()).toBe(1)
    await session?.stop()
    await pool.disposeAll()
  })

  test("WP-04: evict tears the workspace down and empties the pool (RED-on-injection)", async () => {
    const probe = makeBackend()
    const pool = new SharedWorkspacePool(probe.backend)
    const session = await pool.open("/repo/a.fake", "/repo")
    await session?.stop()
    expect(pool.__sizeForTest).toBe(1)
    await pool.evict("/repo")
    // Teeth: without the evict wiring the entry persists (leaked daemon) and the
    // client is never stopped — both observable here.
    expect(pool.__sizeForTest).toBe(0)
    expect(probe.clients()[0]?.stopCalls).toBe(1)
    // Idempotent: a second evict on an absent cwd is a no-op.
    await pool.evict("/repo")
    expect(probe.clients()[0]?.stopCalls).toBe(1)
  })

  test("WP-05: readiness=false does NOT mark prepared ⇒ next call re-attempts warm", async () => {
    const probe = makeBackend({ ready: false })
    const pool = new SharedWorkspacePool(probe.backend)
    const session = await pool.open("/repo/a.fake", "/repo")
    expect(session).not.toBeNull()
    const after1 = probe.ensureCalls() // open() ran ensureFileReady at least once
    await session?.definition("/repo/a.fake", { line: 0, character: 0 })
    // RED-on-injection: if exhaustion wrongly marked the file prepared, this call
    // skips ensureFileReady (delta 0). With the fix it re-attempts (delta ≥ 1).
    expect(probe.ensureCalls() - after1).toBeGreaterThanOrEqual(1)
    await session?.stop()
    await pool.disposeAll()
  })

  test("WP-06: supports() gates prewarm ⇒ an unsupported anchor spawns nothing", async () => {
    const probe = makeBackend()
    const pool = new SharedWorkspacePool(probe.backend)
    await pool.prewarm("/repo/notes.txt", "/repo") // not ".fake"
    expect(probe.createCalls()).toBe(0)
    expect(pool.__sizeForTest).toBe(0)
  })

  test("WP-07: fatal transport error tears down ONCE; sibling handle fails soft", async () => {
    const probe = makeBackend()
    const pool = new SharedWorkspacePool(probe.backend)
    const h1 = await pool.open("/repo/a.fake", "/repo")
    const h2 = await pool.open("/repo/a.fake", "/repo") // shared entry, refs=2
    const client = probe.clients()[0]
    if (client) {
      client.defImpl = async () => {
        throw new Error("transport: server stopped")
      }
    }
    await expect(h1?.definition("/repo/a.fake", { line: 0, character: 0 })).rejects.toThrow()
    await new Promise((r) => setTimeout(r, 10)) // teardown fired with `void`
    expect(client?.stopCalls).toBe(1)
    // Sibling now fails soft with the closed sentinel — no second client drive.
    await expect(h2?.definition("/repo/a.fake", { line: 0, character: 0 })).rejects.toThrow(
      /shared session closed/,
    )
    await h1?.stop()
    await h2?.stop()
    expect(client?.stopCalls).toBe(1) // release after teardown is a no-op stop
  })

  test("WP-08: hard-evict is terminal — an entry materialized AFTER evict is reaped (leak-race fix)", async () => {
    const probe = makeBackend()
    const pool = new SharedWorkspacePool(probe.backend)
    // Simulate the bench race: evict runs BEFORE the (late) prewarm/open creates
    // the entry. Without the tombstone the open would leave a started client +
    // 30-min idle timer that nothing reaps.
    await pool.evict("/repo")
    const session = await pool.open("/repo/a.fake", "/repo")
    expect(session).toBeNull() // reaped on materialization
    expect(probe.createCalls()).toBe(1) // a client WAS constructed…
    expect(probe.clients()[0]?.stopCalls).toBe(1) // …and immediately stopped
    expect(pool.__sizeForTest).toBe(0) // no leaked entry
  })

  test("WP-09: an already-aborted signal spawns nothing (aborted prewarm)", async () => {
    const probe = makeBackend()
    const pool = new SharedWorkspacePool(probe.backend)
    const ctrl = new AbortController()
    ctrl.abort()
    const session = await pool.open("/repo/a.fake", "/repo", ctrl.signal)
    expect(session).toBeNull()
    // RED-on-injection: without the pre-acquire abort check a client is created
    // and started despite the aborted signal.
    expect(probe.createCalls()).toBe(0)
    expect(pool.__sizeForTest).toBe(0)
  })
})
