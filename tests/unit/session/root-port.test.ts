import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import {
  archivedFilePathAsync,
  archiveSession,
  defaultSessionRootProvider,
  deleteSession,
  forkSession,
  indexFilePathAsync,
  listSessions,
  loadSessionById,
  renameSession,
  rewindToMessage,
  type SavePayload,
  SessionIdError,
  type SessionMeta,
  saveSessionById,
  sessionEnvelopePath,
  sessionEnvelopePathAsync,
  sessionFilePath,
  sessionFilePathAsync,
  sessionsRoot,
  sessionsRootAsync,
  staticSessionRootProvider,
  unarchiveSession,
} from "@/session"
import { __resetRuntimeConfig } from "@/shared"

/**
 * SessionRootProvider port tests (Audit-W blocker #2). Three concerns:
 *
 *  1. **byte-identical default** — passing no provider (or the explicit
 *     `defaultSessionRootProvider`) MUST yield exactly `sessionsRoot()`.
 *  2. **provider injection works** — when a custom provider returns a
 *     tenant-specific root, every async path helper resolves under it.
 *  3. **multi-tenant isolation** — two providers writing concurrently
 *     keep their files in disjoint trees (the data-leak scenario the
 *     port exists to eliminate).
 */
describe("SessionRootProvider", () => {
  let envSnapshot: NodeJS.ProcessEnv

  beforeEach(() => {
    envSnapshot = { ...process.env }
    __resetRuntimeConfig()
  })
  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) delete process.env[key]
    }
    Object.assign(process.env, envSnapshot)
    __resetRuntimeConfig()
  })

  describe("byte-identical default", () => {
    test("sessionsRootAsync() with no provider == sessionsRoot()", async () => {
      // No root override at all (the preload's fenced QUANTA_HOME included), so the
      // second assertion checks the real default. Pure resolution. The fence is put back
      // by name — bun shares one process across files.
      const priorQuantaHome = process.env.QUANTA_HOME
      try {
        delete process.env.QUANTA_SESSIONS_DIR
        delete process.env.QUANTA_HOME
        delete process.env.QUANTA_CONFIG_DIR
        __resetRuntimeConfig()
        expect(await sessionsRootAsync()).toBe(sessionsRoot())
        expect(await sessionsRootAsync()).toBe(join(homedir(), ".quanta", "sessions"))
      } finally {
        if (priorQuantaHome === undefined) delete process.env.QUANTA_HOME
        else process.env.QUANTA_HOME = priorQuantaHome
        __resetRuntimeConfig()
      }
    })

    test("sessionsRootAsync(defaultSessionRootProvider) == sessionsRoot()", async () => {
      process.env.QUANTA_SESSIONS_DIR = "/tmp/byte-identical"
      __resetRuntimeConfig()
      expect(await sessionsRootAsync(defaultSessionRootProvider)).toBe(sessionsRoot())
      expect(await sessionsRootAsync(defaultSessionRootProvider)).toBe("/tmp/byte-identical")
    })

    test("sessionFilePathAsync() with no provider == sessionFilePath()", async () => {
      process.env.QUANTA_SESSIONS_DIR = "/tmp/bi-paths"
      __resetRuntimeConfig()
      expect(await sessionFilePathAsync("abc")).toBe(sessionFilePath("abc"))
    })

    test("default provider re-reads runtimeConfig after __resetRuntimeConfig", async () => {
      process.env.QUANTA_SESSIONS_DIR = "/tmp/first-root"
      __resetRuntimeConfig()
      expect(await sessionsRootAsync()).toBe("/tmp/first-root")
      process.env.QUANTA_SESSIONS_DIR = "/tmp/second-root"
      __resetRuntimeConfig()
      expect(await sessionsRootAsync()).toBe("/tmp/second-root")
    })
  })

  describe("provider injection", () => {
    test("staticSessionRootProvider returns the configured root verbatim", async () => {
      const provider = staticSessionRootProvider("/var/quanta/sessions/u-42")
      expect(await sessionsRootAsync(provider)).toBe("/var/quanta/sessions/u-42")
    })

    test("all async path helpers route through the injected provider", async () => {
      const provider = staticSessionRootProvider("/srv/tenant/abc")
      expect(await sessionFilePathAsync("s1", provider)).toBe("/srv/tenant/abc/s1.json")
      expect(await archivedFilePathAsync("s1", provider)).toBe("/srv/tenant/abc/archived/s1.json")
      expect(await indexFilePathAsync(provider)).toBe("/srv/tenant/abc/index.jsonl")
      expect(await sessionEnvelopePathAsync("s1", provider)).toBe("/srv/tenant/abc/s1.jsonl")
    })

    test("JSONL path helpers reject traversal ids with the same guard as snapshot paths", async () => {
      const provider = staticSessionRootProvider("/srv/tenant/abc")
      expect(() => sessionEnvelopePath("../escape")).toThrow(SessionIdError)
      await expect(sessionEnvelopePathAsync("../escape", provider)).rejects.toBeInstanceOf(
        SessionIdError,
      )
    })

    test("a custom inline provider can do async work (e.g. IPC stub)", async () => {
      let calls = 0
      const provider = {
        async resolve(): Promise<string> {
          calls += 1
          await Promise.resolve()
          return "/tmp/web-tenant-root"
        },
      }
      expect(await sessionsRootAsync(provider)).toBe("/tmp/web-tenant-root")
      expect(await sessionFilePathAsync("id-1", provider)).toBe("/tmp/web-tenant-root/id-1.json")
      // resolve() is called once per `*Async` invocation — no caching at the
      // port layer (intentional: tenants may rotate roots between calls).
      expect(calls).toBe(2)
    })
  })

  describe("multi-tenant isolation (the data-leak scenario)", () => {
    let tenantA: string
    let tenantB: string

    beforeEach(() => {
      tenantA = mkdtempSync(join(tmpdir(), "session-tenant-a-"))
      tenantB = mkdtempSync(join(tmpdir(), "session-tenant-b-"))
      // Default root points at a third location so we can prove tenant
      // writes do NOT leak to the legacy CLI path.
      process.env.QUANTA_SESSIONS_DIR = mkdtempSync(join(tmpdir(), "session-default-"))
      __resetRuntimeConfig()
    })
    afterEach(() => {
      const defaultDir = process.env.QUANTA_SESSIONS_DIR
      rmSync(tenantA, { recursive: true, force: true })
      rmSync(tenantB, { recursive: true, force: true })
      if (defaultDir !== undefined) rmSync(defaultDir, { recursive: true, force: true })
    })

    test("two providers write to disjoint roots; default root stays empty", async () => {
      const providerA = staticSessionRootProvider(tenantA)
      const providerB = staticSessionRootProvider(tenantB)

      const meta = (id: string): SessionMeta => ({
        id,
        title: `t-${id}`,
        cwd: "/work",
        createdAt: 1_000,
        lastTouched: 1_000,
        archived: false,
      })
      const payload = (text: string): SavePayload => ({
        reason: "completed",
        turns: 1,
        messages: [{ role: "user", content: [{ type: "text", text }] }],
      })

      await saveSessionById(meta("shared-id"), payload("from-A"), providerA)
      await saveSessionById(meta("shared-id"), payload("from-B"), providerB)

      // Each tenant's file lives under its own root.
      expect(existsSync(join(tenantA, "shared-id.json"))).toBe(true)
      expect(existsSync(join(tenantB, "shared-id.json"))).toBe(true)

      // The legacy/default root MUST NOT have the file — that would be the
      // cross-tenant leak the port exists to prevent.
      const defaultDir = process.env.QUANTA_SESSIONS_DIR
      expect(defaultDir).toBeDefined()
      if (defaultDir !== undefined) {
        expect(existsSync(join(defaultDir, "shared-id.json"))).toBe(false)
      }

      // And the two tenants read back their OWN content — no cross-read.
      const fromA = await loadSessionById("shared-id", providerA)
      const fromB = await loadSessionById("shared-id", providerB)
      expect(fromA?.messages[0]?.content[0]).toMatchObject({ type: "text", text: "from-A" })
      expect(fromB?.messages[0]?.content[0]).toMatchObject({ type: "text", text: "from-B" })
    })

    test("provider-less load on a tenant id returns undefined (no leak in the OTHER direction)", async () => {
      // Tenant writes via injected provider.
      const providerA = staticSessionRootProvider(tenantA)
      await saveSessionById(
        {
          id: "tenant-only",
          title: "x",
          cwd: "/w",
          createdAt: 1,
          lastTouched: 1,
          archived: false,
        },
        {
          reason: "completed",
          turns: 1,
          messages: [{ role: "user", content: [{ type: "text", text: "secret" }] }],
        },
        providerA,
      )
      // Default-provider load (CLI surface) MUST NOT find the tenant file —
      // even though both live on the same OS, the resolver scopes them apart.
      const leaked = await loadSessionById("tenant-only")
      expect(leaked).toBeUndefined()
    })

    test("provider-aware mutators keep files and index entries inside the tenant root", async () => {
      const provider = staticSessionRootProvider(tenantA)
      const defaultDir = process.env.QUANTA_SESSIONS_DIR
      expect(defaultDir).toBeDefined()
      await saveSessionById(
        {
          id: "mut-1",
          title: "tenant-title",
          cwd: "/work",
          createdAt: 1,
          lastTouched: 1,
          archived: false,
          gitSha: "cafefeed",
        },
        {
          reason: "completed",
          turns: 2,
          messages: [
            { role: "user", content: [{ type: "text", text: "a" }], id: "m0" },
            { role: "assistant", content: [{ type: "text", text: "b" }], id: "m1" },
            { role: "user", content: [{ type: "text", text: "c" }], id: "m2" },
          ],
        },
        provider,
      )

      await renameSession("mut-1", "tenant-renamed", provider)
      await rewindToMessage("mut-1", "m1", provider)
      const forkedId = await forkSession("mut-1", { newId: "mut-fork" }, provider)
      expect(forkedId).toBe("mut-fork")
      await archiveSession("mut-1", provider)
      await unarchiveSession("mut-1", provider)

      const tenantList = await listSessions({ includeArchived: true }, provider)
      expect(tenantList.map((m) => m.id).sort()).toEqual(["mut-1", "mut-fork"])
      const defaultList = await listSessions({ includeArchived: true })
      expect(defaultList.map((m) => m.id)).not.toContain("mut-1")
      expect(defaultList.map((m) => m.id)).not.toContain("mut-fork")

      const tenantSession = await loadSessionById("mut-1", provider)
      expect(tenantSession?.meta.title).toBe("tenant-renamed")
      expect(tenantSession?.meta.gitSha).toBe("cafefeed")
      expect(tenantSession?.messages.map((m) => m.id)).toEqual(["m0", "m1"])
      if (defaultDir !== undefined) {
        expect(existsSync(join(defaultDir, "mut-1.json"))).toBe(false)
        expect(existsSync(join(defaultDir, "mut-fork.json"))).toBe(false)
      }

      await deleteSession("mut-fork", provider)
      await deleteSession("mut-1", provider)
      expect(await loadSessionById("mut-fork", provider)).toBeUndefined()
      expect(await loadSessionById("mut-1", provider)).toBeUndefined()
    })
  })
})
