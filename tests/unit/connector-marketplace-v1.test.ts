/**
 * §1.6 — connector MARKETPLACE V1 (DirectoryApp lifecycle / installUrl).
 *
 * The existing connector catalog (`mcp-connector-catalog.ts`) is a FLAT list.
 * The audit wants a Codex/Claude-Code-style DirectoryApp with a real install
 * LIFECYCLE (installUrl → installed → enabled/disabled → uninstalled) and
 * install metadata (installedAt/lastUpdatedAt from an injected clock).
 *
 * V1 SCOPE (this slice): the DirectoryApp schema + the pure lifecycle core over
 * an injected `InstalledAppStorePort` + `ClockPort`. DEFERRED: the marketplace
 * UI, the remote registry fetch, and auto-update — explicitly out of V1.
 *
 * Discipline: pure core (injected clock + store), typed NO-THROW results,
 * default-OFF (`QUANTA_CONNECTOR_MARKETPLACE`).
 */
import { describe, expect, test } from "bun:test"
import {
  createConnectorMarketplace,
  createInMemoryInstalledAppStore,
  DirectoryAppSchema,
  isConnectorMarketplaceEnabled,
} from "../../src/connectors/connector-marketplace"

const APP = {
  id: "acme-notes",
  name: "Acme Notes",
  description: "Notes connector.",
  installUrl: "https://apps.acme.com/notes/install",
  version: "1.2.0",
}

const fixedClock = (t: number): { now: () => number } => ({ now: () => t })

describe("§1.6 DirectoryAppSchema", () => {
  test("accepts a valid DirectoryApp", () => {
    expect(DirectoryAppSchema.safeParse(APP).success).toBe(true)
  })
  test("rejects a non-URL installUrl", () => {
    expect(DirectoryAppSchema.safeParse({ ...APP, installUrl: "not a url" }).success).toBe(false)
  })
  test("RED-ON-INJECTION: rejects non-http(s) installUrl schemes (javascript/file/data)", () => {
    for (const u of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x"]) {
      expect(DirectoryAppSchema.safeParse({ ...APP, installUrl: u }).success).toBe(false)
    }
  })
  test("accepts http (not only https)", () => {
    expect(DirectoryAppSchema.safeParse({ ...APP, installUrl: "http://x.example/i" }).success).toBe(
      true,
    )
  })
  test("rejects an empty id", () => {
    expect(DirectoryAppSchema.safeParse({ ...APP, id: "" }).success).toBe(false)
  })
  test("rejects an unknown extra key (strict)", () => {
    expect(DirectoryAppSchema.safeParse({ ...APP, rogue: 1 }).success).toBe(false)
  })
})

describe("§1.6 isConnectorMarketplaceEnabled — default-OFF gate", () => {
  test("OFF by default (gate unset)", () => {
    const orig = process.env.QUANTA_CONNECTOR_MARKETPLACE
    delete process.env.QUANTA_CONNECTOR_MARKETPLACE
    try {
      expect(isConnectorMarketplaceEnabled()).toBe(false)
    } finally {
      if (orig !== undefined) process.env.QUANTA_CONNECTOR_MARKETPLACE = orig
    }
  })
  test("ON when gate =1", () => {
    expect(isConnectorMarketplaceEnabled({ QUANTA_CONNECTOR_MARKETPLACE: "1" })).toBe(true)
  })
})

describe("§1.6 lifecycle core — install / enable / disable / uninstall", () => {
  test("install records the app with state=enabled + installedAt from the clock", async () => {
    const store = createInMemoryInstalledAppStore()
    const m = createConnectorMarketplace({ store, clock: fixedClock(1000) })
    const r = await m.install(APP)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.app.id).toBe("acme-notes")
      expect(r.app.state).toBe("enabled")
      expect(r.app.installedAt).toBe(1000)
      expect(r.app.lastUpdatedAt).toBe(1000)
      expect(r.app.version).toBe("1.2.0")
    }
    expect((await m.list()).map((a) => a.id)).toEqual(["acme-notes"])
  })

  test("installing an already-installed id is rejected (typed error)", async () => {
    const m = createConnectorMarketplace({
      store: createInMemoryInstalledAppStore(),
      clock: fixedClock(1),
    })
    await m.install(APP)
    const again = await m.install(APP)
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.error).toBe("already-installed")
  })

  test("disable then enable round-trips state + bumps lastUpdatedAt", async () => {
    let t = 100
    const m = createConnectorMarketplace({ store: createInMemoryInstalledAppStore(), clock: { now: () => t } })
    await m.install(APP)
    t = 200
    const d = await m.disable("acme-notes")
    expect(d.ok).toBe(true)
    if (d.ok) {
      expect(d.app.state).toBe("disabled")
      expect(d.app.lastUpdatedAt).toBe(200)
      expect(d.app.installedAt).toBe(100) // unchanged
    }
    t = 300
    const e = await m.enable("acme-notes")
    if (e.ok) {
      expect(e.app.state).toBe("enabled")
      expect(e.app.lastUpdatedAt).toBe(300)
    }
  })

  test("uninstall removes the app; list no longer contains it", async () => {
    const m = createConnectorMarketplace({
      store: createInMemoryInstalledAppStore(),
      clock: fixedClock(1),
    })
    await m.install(APP)
    const u = await m.uninstall("acme-notes")
    expect(u.ok).toBe(true)
    expect(await m.list()).toEqual([])
  })

  test("NO-THROW: lifecycle op on an unknown id returns a typed 'not-installed' error", async () => {
    const m = createConnectorMarketplace({
      store: createInMemoryInstalledAppStore(),
      clock: fixedClock(1),
    })
    for (const op of [m.disable("ghost"), m.enable("ghost"), m.uninstall("ghost")]) {
      const r = await op
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toBe("not-installed")
    }
  })

  test("install rejects a schema-invalid app (typed 'invalid-app' error, no throw)", async () => {
    const m = createConnectorMarketplace({
      store: createInMemoryInstalledAppStore(),
      clock: fixedClock(1),
    })
    const r = await m.install({ ...APP, installUrl: "nope" } as never)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe("invalid-app")
  })

  test("list is deterministic (sorted by id)", async () => {
    const m = createConnectorMarketplace({
      store: createInMemoryInstalledAppStore(),
      clock: fixedClock(1),
    })
    await m.install({ ...APP, id: "zeta" })
    await m.install({ ...APP, id: "alpha" })
    expect((await m.list()).map((a) => a.id)).toEqual(["alpha", "zeta"])
  })
})
