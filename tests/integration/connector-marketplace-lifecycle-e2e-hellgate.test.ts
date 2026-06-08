/**
 * §1.6 e2e HELLGATE — connector DirectoryApp install LIFECYCLE V1 end-to-end
 * over a REAL file-backed store (JSON on disk), gated by
 * `QUANTA_CONNECTOR_MARKETPLACE`, with a real injected clock.
 *
 * Drives the full lifecycle: gate-check → install (persisted to disk) →
 * reload-from-disk (a fresh marketplace over the same dir) → disable → enable →
 * uninstall, asserting install metadata + state transitions survive a reload.
 * This proves the lifecycle state machine + the injected-store seam, not just an
 * in-memory shape.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createConnectorMarketplace,
  type DirectoryApp,
  type InstalledApp,
  type InstalledAppStorePort,
  isConnectorMarketplaceEnabled,
} from "../../src/connectors/connector-marketplace"

const APP: DirectoryApp = {
  id: "acme-notes",
  name: "Acme Notes",
  description: "Notes connector.",
  installUrl: "https://apps.acme.com/notes/install",
  version: "1.2.0",
}

/** A real file-backed store: a JSON map on disk, re-read each op (so a fresh
 *  marketplace instance over the same file sees prior installs — the
 *  "reload-after-crash" property). */
const fileStore = (path: string): InstalledAppStorePort => {
  const readAll = async (): Promise<Record<string, InstalledApp>> => {
    try {
      return JSON.parse(await readFile(path, "utf8")) as Record<string, InstalledApp>
    } catch {
      return {}
    }
  }
  const writeAll = async (m: Record<string, InstalledApp>): Promise<void> => {
    await writeFile(path, JSON.stringify(m), "utf8")
  }
  return {
    async get(id) {
      return (await readAll())[id]
    },
    async put(app) {
      const m = await readAll()
      m[app.id] = app
      await writeAll(m)
    },
    async delete(id) {
      const m = await readAll()
      delete m[id]
      await writeAll(m)
    },
    async list() {
      return Object.values(await readAll())
    },
  }
}

let dir = ""
afterEach(async () => {
  delete process.env.QUANTA_CONNECTOR_MARKETPLACE
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = ""
})

describe("§1.6 connector marketplace lifecycle — e2e (file-backed)", () => {
  test("gate is default-OFF (byte-identical: host won't construct the marketplace)", () => {
    delete process.env.QUANTA_CONNECTOR_MARKETPLACE
    expect(isConnectorMarketplaceEnabled()).toBe(false)
  })

  test("full lifecycle survives a reload from disk", async () => {
    dir = await mkdtemp(join(tmpdir(), "qcav3-conn-mkt-e2e-"))
    const path = join(dir, "apps.json")
    process.env.QUANTA_CONNECTOR_MARKETPLACE = "1"
    expect(isConnectorMarketplaceEnabled()).toBe(true)

    // clock advances across ops so installedAt/lastUpdatedAt are distinguishable.
    let t = 1000
    const clock = { now: () => t }

    // 1. install (persisted to disk)
    const m1 = createConnectorMarketplace({ store: fileStore(path), clock })
    const installed = await m1.install(APP)
    expect(installed.ok).toBe(true)
    if (installed.ok) {
      expect(installed.app.state).toBe("enabled")
      expect(installed.app.installedAt).toBe(1000)
    }

    // 2. RELOAD: a brand-new marketplace over the SAME file sees the install.
    t = 2000
    const m2 = createConnectorMarketplace({ store: fileStore(path), clock })
    expect((await m2.list()).map((a) => a.id)).toEqual(["acme-notes"])

    // 3. disable through the reloaded instance — installedAt preserved, updatedAt bumped.
    const disabled = await m2.disable("acme-notes")
    expect(disabled.ok).toBe(true)
    if (disabled.ok) {
      expect(disabled.app.state).toBe("disabled")
      expect(disabled.app.installedAt).toBe(1000)
      expect(disabled.app.lastUpdatedAt).toBe(2000)
    }

    // 4. enable again
    t = 3000
    const enabled = await m2.enable("acme-notes")
    if (enabled.ok) {
      expect(enabled.app.state).toBe("enabled")
      expect(enabled.app.lastUpdatedAt).toBe(3000)
    }

    // 5. uninstall — disk store no longer carries it.
    const removed = await m2.uninstall("acme-notes")
    expect(removed.ok).toBe(true)
    const m3 = createConnectorMarketplace({ store: fileStore(path), clock })
    expect(await m3.list()).toEqual([])
  })

  test("RED-ON-INJECTION: install of a malformed app is rejected, store stays empty", async () => {
    dir = await mkdtemp(join(tmpdir(), "qcav3-conn-mkt-bad-"))
    const path = join(dir, "apps.json")
    process.env.QUANTA_CONNECTOR_MARKETPLACE = "1"
    const m = createConnectorMarketplace({ store: fileStore(path), clock: { now: () => 1 } })
    const r = await m.install({ ...APP, installUrl: "javascript:alert(1)" } as DirectoryApp)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe("invalid-app")
    // nothing persisted
    expect(await m.list()).toEqual([])
  })
})
