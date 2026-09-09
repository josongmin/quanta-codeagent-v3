import { afterEach, describe, expect, mock, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteStore } from "@/memory"
import {
  ResumeRehydrateRefusedError,
  rehydrateResumeTranscript,
} from "@/sdk/runtime/session/rehydrate"
import { __resetSessionGenerationForTest } from "@/session/generation"
import { listSessions } from "@/session/index-store"
import { indexFilePath, sessionFilePath } from "@/session/paths"
import {
  deleteSession,
  loadSessionById,
  StaleSessionGenerationError,
  saveSessionById,
} from "@/session/store"
import type { SavePayload, SessionMeta } from "@/session/types"
import { __resetRuntimeConfig } from "@/shared"

const mkMeta = (overrides: Partial<SessionMeta> = {}): SessionMeta => ({
  id: overrides.id ?? "sess-1",
  title: overrides.title ?? "T",
  cwd: overrides.cwd ?? "/tmp/work",
  createdAt: overrides.createdAt ?? 1_000,
  lastTouched: overrides.lastTouched ?? 1_000,
  archived: overrides.archived ?? false,
})

const mkPayload = (text: string): SavePayload => ({
  reason: "completed",
  turns: 1,
  messages: [
    { role: "user", content: [{ type: "text", text }] },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
  ],
})

afterEach(() => {
  mock.restore()
})

const withSessionDir = (prefix: string, run: () => Promise<void>): Promise<void> => {
  const envSnapshot = { ...process.env }
  const dir = mkdtempSync(join(tmpdir(), prefix))
  process.env.QUANTA_SESSIONS_DIR = dir
  __resetRuntimeConfig()
  __resetSessionGenerationForTest()
  return run().finally(() => {
    rmSync(dir, { recursive: true, force: true })
    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) delete process.env[key]
    }
    Object.assign(process.env, envSnapshot)
    __resetRuntimeConfig()
    __resetSessionGenerationForTest()
  })
}

describe("SEP7-D-05 delete/save generation", () => {
  afterEach(() => {
    mock.restore()
  })

  test("delete then late save refuses; unrelated session still saves", async () => {
    await withSessionDir("r03-d05-", async () => {
      const meta = mkMeta({ id: "resurrect" })
      await saveSessionById(meta, mkPayload("first"))
      await deleteSession("resurrect")
      await expect(saveSessionById(meta, mkPayload("late"))).rejects.toBeInstanceOf(
        StaleSessionGenerationError,
      )
      expect(await loadSessionById("resurrect")).toBeUndefined()
      expect(await listSessions({ includeArchived: true })).toEqual([])

      const other = mkMeta({ id: "other" })
      await saveSessionById(other, mkPayload("alive"))
      expect((await loadSessionById("other"))?.meta.id).toBe("other")

      await saveSessionById(meta, mkPayload("reborn"), undefined, { create: true })
      expect((await loadSessionById("resurrect"))?.meta.id).toBe("resurrect")
    })
  })

  test("parked save then delete then late old save does not resurrect", async () => {
    const envSnapshot = { ...process.env }
    const dir = mkdtempSync(join(tmpdir(), "r03-d05-park-"))
    process.env.QUANTA_SESSIONS_DIR = dir
    __resetRuntimeConfig()
    __resetSessionGenerationForTest()
    try {
      const service = await import("@/storage/service")
      const realWrite = service.writeFile
      let release: (() => void) | undefined
      const parked = new Promise<void>((resolve) => {
        release = resolve
      })
      let hit = false
      let arm = false
      mock.module("@/storage/service", () => ({
        ...service,
        writeFile: async (p: string, body: string, base?: string) => {
          if (arm && !hit && p.includes("resurrect.json")) {
            hit = true
            await parked
          }
          return realWrite(p, body, base)
        },
      }))
      const store = await import("@/session/store")
      const gen = await import("@/session/generation")
      gen.__resetSessionGenerationForTest()
      const meta = mkMeta({ id: "resurrect" })
      await store.saveSessionById(meta, mkPayload("first"))
      arm = true
      const saveP = store.saveSessionById(meta, mkPayload("parked"))
      for (let i = 0; i < 50 && !hit; i += 1) {
        await Bun.sleep(2)
      }
      const deleteP = store.deleteSession("resurrect")
      release?.()
      await saveP
      await deleteP
      await expect(store.saveSessionById(meta, mkPayload("late"))).rejects.toBeInstanceOf(
        store.StaleSessionGenerationError,
      )
      expect(await store.loadSessionById("resurrect")).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
      for (const key of Object.keys(process.env)) {
        if (!(key in envSnapshot)) delete process.env[key]
      }
      Object.assign(process.env, envSnapshot)
      __resetRuntimeConfig()
      __resetSessionGenerationForTest()
      mock.restore()
    }
  })
})

describe("SEP7-D-06 index projection recovery", () => {
  test("corrupt index row is recovered from snapshot on unrelated upsert", async () => {
    await withSessionDir("r03-d06-", async () => {
      const keep = mkMeta({ id: "keep", lastTouched: 200 })
      await saveSessionById(keep, mkPayload("keep"))
      const victim = mkMeta({ id: "victim", lastTouched: 100 })
      await saveSessionById(victim, mkPayload("victim"))
      writeFileSync(
        indexFilePath(),
        `${JSON.stringify(keep)}\n{ not json\n${JSON.stringify({ id: "victim" })}\n`,
      )
      const other = mkMeta({ id: "other", lastTouched: 300 })
      await saveSessionById(other, mkPayload("other"))
      expect((await listSessions()).map((m) => m.id).sort()).toEqual(["keep", "other", "victim"])
      expect(readFileSync(`${indexFilePath()}.invalid`, "utf8")).toContain("{ not json")
    })
  })

  test("snapshot without index entry is rediscovered on upsert", async () => {
    await withSessionDir("r03-d06b-", async () => {
      const ghost = mkMeta({ id: "ghost", lastTouched: 50 })
      await saveSessionById(ghost, mkPayload("ghost"))
      writeFileSync(indexFilePath(), "")
      const other = mkMeta({ id: "visible", lastTouched: 80 })
      await saveSessionById(other, mkPayload("visible"))
      expect((await listSessions()).map((m) => m.id).sort()).toEqual(["ghost", "visible"])
    })
  })

  test("snapshot without index entry is rediscovered on list", async () => {
    await withSessionDir("r03-d06c-", async () => {
      const ghost = mkMeta({ id: "ghost", lastTouched: 50 })
      await saveSessionById(ghost, mkPayload("ghost"))
      writeFileSync(indexFilePath(), "")
      expect((await listSessions()).map((m) => m.id)).toEqual(["ghost"])
    })
  })
})

describe("SEP7-D-07 typed snapshot read", () => {
  test("corrupt snapshot refuses rehydrate and does not overwrite bytes", async () => {
    await withSessionDir("r03-d07-", async () => {
      const id = "corrupt-resume"
      mkdirSync(process.env.QUANTA_SESSIONS_DIR ?? "", { recursive: true })
      const path = sessionFilePath(id)
      const broken = "{ not a session"
      writeFileSync(path, broken)
      await expect(rehydrateResumeTranscript(id)).rejects.toBeInstanceOf(
        ResumeRehydrateRefusedError,
      )
      expect(readFileSync(path, "utf8")).toBe(broken)
      expect(await loadSessionById(id)).toBeUndefined()
    })
  })

  test("missing snapshot stays allowed empty resume", async () => {
    await withSessionDir("r03-d07b-", async () => {
      expect(await rehydrateResumeTranscript("no-such")).toBeUndefined()
    })
  })

  test("valid empty transcript is allowed", async () => {
    await withSessionDir("r03-d07c-", async () => {
      const meta = mkMeta({ id: "empty-ok" })
      await saveSessionById(meta, { reason: "completed", turns: 0, messages: [] })
      expect(await rehydrateResumeTranscript("empty-ok")).toEqual([])
    })
  })

  test("schema mismatch is corrupt, not a fresh resume", async () => {
    await withSessionDir("r03-d07-schema-", async () => {
      const id = "schema-mismatch"
      const path = sessionFilePath(id)
      const raw = JSON.stringify({
        version: 1,
        meta: mkMeta({ id }),
        reason: "completed",
        turns: 0,
        messages: [],
      })
      writeFileSync(path, raw)
      await expect(rehydrateResumeTranscript(id)).rejects.toMatchObject({
        name: "ResumeRehydrateRefusedError",
        component: "corrupt",
      })
      expect(readFileSync(path, "utf8")).toBe(raw)
    })
  })

  test("unreadable snapshot path refuses instead of collapsing to missing", async () => {
    await withSessionDir("r03-d07-unread-", async () => {
      const id = "unreadable"
      const path = sessionFilePath(id)
      mkdirSync(path)
      await expect(rehydrateResumeTranscript(id)).rejects.toMatchObject({
        name: "ResumeRehydrateRefusedError",
        component: "unreadable",
      })
    })
  })
})

describe("SEP7-D-10 column-local embedding update", () => {
  test("text-only update preserves corrupt embedding BLOB", async () => {
    const seen: number[] = []
    const db = new SqliteStore(":memory:", {
      onCorruptEmbedding: (e) => {
        seen.push(e.byteLength)
      },
    })
    try {
      await db.save({
        id: "blob",
        kind: "fact",
        text: "before",
        tags: ["t"],
        createdAt: 1,
      })
      db.rawDbForTest()
        .query("UPDATE memories SET embedding = $b WHERE id = 'blob'")
        .run({
          $b: new Uint8Array([0x00]),
        })
      await db.update("blob", { text: "after" })
      const raw = db
        .rawDbForTest()
        .query("SELECT embedding FROM memories WHERE id = 'blob'")
        .get() as {
        embedding: Uint8Array
      }
      expect([...raw.embedding]).toEqual([0x00])
      expect((await db.get("blob"))?.text).toBe("after")
      expect(seen.length).toBeGreaterThan(0)

      await db.update("blob", { embedding: undefined })
      const cleared = db
        .rawDbForTest()
        .query("SELECT embedding FROM memories WHERE id = 'blob'")
        .get() as { embedding: Uint8Array | null }
      expect(cleared.embedding).toBeNull()

      await db.update("missing-row", { text: "nope" })
      await db.update("blob", { embedding: new Array(1536).fill(0.1) })
      const set = db
        .rawDbForTest()
        .query("SELECT embedding FROM memories WHERE id = 'blob'")
        .get() as { embedding: Uint8Array | null }
      expect(set.embedding).not.toBeNull()
      expect(set.embedding?.byteLength).toBe(1536 * 4)
    } finally {
      db.close()
    }
  })
})
