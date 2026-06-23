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
  startImpl: () => Promise<void> = async () => {}
  defImpl: () => Promise<typeof LOC | null> = async () => LOC
  constructor() {
    super({ defaultCommand: ["unused"], languageIdFor: () => "fake" })
  }
  override async start(): Promise<void> {
    this.startCalls += 1
    await this.startImpl()
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

  test("WP-10: hard-evicted in-flight open degrades without warn noise", async () => {
    const fake = new FakeClient()
    let releaseStart!: () => void
    fake.startImpl = () =>
      new Promise<void>((resolve) => {
        releaseStart = resolve
      })
    const probe = makeBackend({ client: fake })
    const pool = new SharedWorkspacePool(probe.backend)
    const origWrite = process.stderr.write.bind(process.stderr)
    const stderr: string[] = []
    // biome-ignore lint/suspicious/noExplicitAny: stream override for capture
    ;(process.stderr.write as any) = (chunk: string | Uint8Array): boolean => {
      stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString())
      return true
    }
    try {
      const pending = pool.open("/repo/a.fake", "/repo")
      expect(probe.createCalls()).toBe(1)
      await pool.evict("/repo")
      releaseStart()
      expect(await pending).toBeNull()
      expect(fake.stopCalls).toBe(1)
      expect(stderr.join("")).not.toContain("failed to ready shared nav session")
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore stream
      ;(process.stderr.write as any) = origWrite
    }
  })

  // --- proveReady: typed strict-admission ready proof (LSP-01) ---------------

  /** A backend whose readiness probe is scriptable to RESOLVE true/false or
   *  REJECT — exercising proveReady's three outcome classes against the real
   *  pool machinery (start join, warmFile boolean, fatal teardown). */
  const makeProbeBackend = (
    ensure: () => Promise<boolean>,
    opts?: { startImpl?: () => Promise<void> },
  ): { backend: WarmBackend; clients: () => FakeClient[] } => {
    const clients: FakeClient[] = []
    const backend: WarmBackend = {
      id: "fake-engine",
      supports: (f) => f.endsWith(".fake"),
      createClient: () => {
        const c = new FakeClient()
        if (opts?.startImpl) c.startImpl = opts.startImpl
        clients.push(c)
        return c
      },
      ensureFileReady: () => ensure(),
    }
    return { backend, clients: () => clients }
  }

  test("WP-11: proveReady on a ready workspace ⇒ outcome=ok, stage=ready, kept warm", async () => {
    const probe = makeProbeBackend(async () => true)
    const pool = new SharedWorkspacePool(probe.backend)
    const receipt = await pool.proveReady("/repo/a.fake", "/repo", { language: "fake" })
    expect(receipt.outcome).toBe("ok")
    expect(receipt.stage).toBe("ready")
    expect(receipt.backend).toBe("fake-engine")
    expect(receipt.language).toBe("fake")
    expect(typeof receipt.durationMs).toBe("number")
    // Released, not evicted: the entry stays warm for the subsequent solve.
    expect(pool.__sizeForTest).toBe(1)
    await pool.disposeAll()
  })

  test("WP-12: ensureFileReady=false ⇒ ready_timeout (proveReady is STRICTER than open)", async () => {
    // PAIRED CONTROL — same not-ready backend, two callers:
    //   open()      → returns a NON-null session (best-effort warm degrade)
    //   proveReady()→ returns ready_timeout (admission must NOT pass)
    // This is the exact gap launchability-only admission could not see.
    const openProbe = makeProbeBackend(async () => false)
    const openPool = new SharedWorkspacePool(openProbe.backend)
    const session = await openPool.open("/repo/a.fake", "/repo")
    expect(session).not.toBeNull() // open degrades soft — still hands back a handle
    await openPool.disposeAll()

    const proveProbe = makeProbeBackend(async () => false)
    const provePool = new SharedWorkspacePool(proveProbe.backend)
    const receipt = await provePool.proveReady("/repo/a.fake", "/repo", { language: "fake" })
    expect(receipt.outcome).toBe("ready_timeout")
    expect(receipt.stage).toBe("ready")
    await provePool.disposeAll()
  })

  test("WP-13: start() rejection ⇒ outcome=start_failed, stage=launch", async () => {
    const probe = makeProbeBackend(async () => true, {
      startImpl: async () => {
        throw new Error("spawn pyright-langserver ENOENT")
      },
    })
    const pool = new SharedWorkspacePool(probe.backend)
    const receipt = await pool.proveReady("/repo/a.fake", "/repo", { language: "fake" })
    expect(receipt.outcome).toBe("start_failed")
    expect(receipt.stage).toBe("launch")
    expect(receipt.reason).toContain("ENOENT")
    await pool.disposeAll()
  })

  test("WP-14: fatal transport during ready ⇒ fatal_transport; pre-aborted ⇒ expected_cancel", async () => {
    const fatal = makeProbeBackend(async () => {
      throw new Error("language server stopped unexpectedly")
    })
    const fatalPool = new SharedWorkspacePool(fatal.backend)
    const r1 = await fatalPool.proveReady("/repo/a.fake", "/repo", { language: "fake" })
    expect(r1.outcome).toBe("fatal_transport")
    await fatalPool.disposeAll()

    const ok = makeProbeBackend(async () => true)
    const okPool = new SharedWorkspacePool(ok.backend)
    const r2 = await okPool.proveReady("/repo/a.fake", "/repo", {
      language: "fake",
      signal: AbortSignal.abort(),
    })
    expect(r2.outcome).toBe("expected_cancel")
    // A pre-aborted probe spawns NOTHING.
    expect(ok.clients().length).toBe(0)
    await okPool.disposeAll()
  })

  test("WP-15: proveReady on a hard-evicted cwd reaps + reports expected_cancel (open() parity)", async () => {
    // Late-eviction reap parity with open()'s WP-10: a bench session-end evict
    // tombstones the cwd, then proveReady materializes a FRESH entry for it. The
    // reap branch must tear that entry down (no leaked daemon on a tombstoned
    // cwd) and report the lifecycle cancel — NOT a misleading ready result.
    // RED-on-injection: delete the `hardEvicted` reap branch ⇒ outcome=ok with a
    // leaked entry (__sizeForTest === 1).
    const probe = makeProbeBackend(async () => true)
    const pool = new SharedWorkspacePool(probe.backend)
    await pool.evict("/repo") // tombstone the cwd (no live entry yet)
    const receipt = await pool.proveReady("/repo/a.fake", "/repo", { language: "fake" })
    expect(receipt.outcome).toBe("expected_cancel")
    expect(receipt.stage).toBe("ready")
    expect(pool.__sizeForTest).toBe(0) // reaped, not leaked
    await pool.disposeAll()
  })
})
