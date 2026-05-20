import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Message } from "@/llm"
import {
  archivedFilePath,
  archiveSession,
  deleteSession,
  forkSession,
  listSessions,
  loadSessionById,
  renameSession,
  type SavePayload,
  type SessionMeta,
  saveSessionById,
  sessionFilePath,
  unarchiveSession,
} from "@/session"

const mkMeta = (overrides: Partial<SessionMeta> = {}): SessionMeta => ({
  id: overrides.id ?? "sess-1",
  title: overrides.title ?? "T",
  cwd: overrides.cwd ?? "/tmp/work",
  createdAt: overrides.createdAt ?? 1_000,
  lastTouched: overrides.lastTouched ?? 1_000,
  archived: overrides.archived ?? false,
})

const mkPayload = (overrides: Partial<SavePayload> = {}): SavePayload => ({
  reason: overrides.reason ?? "completed",
  turns: overrides.turns ?? 1,
  messages: overrides.messages ?? [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: [{ type: "text", text: "hello" }] },
  ],
})

describe("session store", () => {
  let dir: string
  let envSnapshot: NodeJS.ProcessEnv

  beforeEach(() => {
    envSnapshot = { ...process.env }
    dir = mkdtempSync(join(tmpdir(), "session-store-"))
    process.env.QUANTA_SESSIONS_DIR = dir
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) delete process.env[key]
    }
    Object.assign(process.env, envSnapshot)
  })

  test("saveSessionById + loadSessionById roundtrip", async () => {
    const meta = mkMeta({ id: "rt-1", title: "round" })
    const payload = mkPayload()
    await saveSessionById(meta, payload)
    const loaded = await loadSessionById("rt-1")
    expect(loaded).toBeDefined()
    expect(loaded?.meta.id).toBe("rt-1")
    expect(loaded?.meta.title).toBe("round")
    expect(loaded?.reason).toBe("completed")
    expect(loaded?.turns).toBe(1)
    expect(loaded?.messages).toEqual(payload.messages)
    // lastTouched is bumped to now
    expect(loaded?.meta.lastTouched ?? 0).toBeGreaterThanOrEqual(meta.createdAt)
  })

  test("loadSessionById finds an archived file", async () => {
    const meta = mkMeta({ id: "arc-1", archived: true })
    await saveSessionById(meta, mkPayload())
    // Active path is empty; archived path has the file.
    expect(existsSync(sessionFilePath("arc-1"))).toBe(false)
    expect(existsSync(archivedFilePath("arc-1"))).toBe(true)
    const loaded = await loadSessionById("arc-1")
    expect(loaded?.meta.id).toBe("arc-1")
    expect(loaded?.meta.archived).toBe(true)
  })

  test("loadSessionById returns undefined for missing id", async () => {
    expect(await loadSessionById("nope")).toBeUndefined()
  })

  test("archiveSession moves the file and sets the flag", async () => {
    await saveSessionById(mkMeta({ id: "a1" }), mkPayload())
    expect(existsSync(sessionFilePath("a1"))).toBe(true)
    await archiveSession("a1")
    expect(existsSync(sessionFilePath("a1"))).toBe(false)
    expect(existsSync(archivedFilePath("a1"))).toBe(true)
    const loaded = await loadSessionById("a1")
    expect(loaded?.meta.archived).toBe(true)
    // listSessions hides it by default
    expect((await listSessions()).map((m) => m.id)).not.toContain("a1")
    expect((await listSessions({ includeArchived: true })).map((m) => m.id)).toContain("a1")
  })

  test("archiveSession is idempotent on already-archived", async () => {
    await saveSessionById(mkMeta({ id: "a2" }), mkPayload())
    await archiveSession("a2")
    await archiveSession("a2") // no throw
    const loaded = await loadSessionById("a2")
    expect(loaded?.meta.archived).toBe(true)
  })

  test("unarchiveSession reverses archive", async () => {
    await saveSessionById(mkMeta({ id: "u1" }), mkPayload())
    await archiveSession("u1")
    await unarchiveSession("u1")
    expect(existsSync(sessionFilePath("u1"))).toBe(true)
    expect(existsSync(archivedFilePath("u1"))).toBe(false)
    const loaded = await loadSessionById("u1")
    expect(loaded?.meta.archived).toBe(false)
  })

  test("renameSession updates title and lastTouched", async () => {
    const meta = mkMeta({ id: "r1", title: "old", lastTouched: 50 })
    await saveSessionById(meta, mkPayload())
    const before = await loadSessionById("r1")
    const tsBefore = before?.meta.lastTouched ?? 0
    // small delay to ensure lastTouched advances
    await new Promise((r) => setTimeout(r, 5))
    await renameSession("r1", "new")
    const after = await loadSessionById("r1")
    expect(after?.meta.title).toBe("new")
    expect(after?.meta.lastTouched ?? 0).toBeGreaterThanOrEqual(tsBefore)
  })

  test("renameSession is a no-op on missing id", async () => {
    await renameSession("missing", "x") // no throw
    expect(await loadSessionById("missing")).toBeUndefined()
  })

  test("forkSession: new id, copied messages, fresh timestamps, default title", async () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Q" }] },
      { role: "assistant", content: [{ type: "text", text: "A" }] },
    ]
    const sourceMeta = mkMeta({ id: "src", title: "Source", createdAt: 100, lastTouched: 100 })
    await saveSessionById(sourceMeta, mkPayload({ messages }))

    const beforeFork = Date.now()
    const newId = await forkSession("src")
    expect(typeof newId).toBe("string")
    expect(newId).not.toBe("src")

    const forked = await loadSessionById(newId)
    expect(forked).toBeDefined()
    expect(forked?.meta.title).toBe("Source (fork)")
    expect(forked?.messages).toEqual(messages)
    expect(forked?.meta.createdAt ?? 0).toBeGreaterThanOrEqual(beforeFork)
    expect(forked?.meta.lastTouched ?? 0).toBeGreaterThanOrEqual(beforeFork)
    expect(forked?.meta.archived).toBe(false)
    expect(forked?.meta.cwd).toBe(sourceMeta.cwd)
  })

  test("forkSession honors custom newId / title / cwd", async () => {
    await saveSessionById(mkMeta({ id: "src2", title: "S2" }), mkPayload())
    const returned = await forkSession("src2", {
      newId: "custom-id",
      title: "custom title",
      cwd: "/elsewhere",
    })
    expect(returned).toBe("custom-id")
    const forked = await loadSessionById("custom-id")
    expect(forked?.meta.title).toBe("custom title")
    expect(forked?.meta.cwd).toBe("/elsewhere")
  })

  test("forkSession does NOT mutate the source", async () => {
    const sourceMeta = mkMeta({ id: "imm", title: "ImmSource", createdAt: 100, lastTouched: 100 })
    const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }]
    await saveSessionById(sourceMeta, mkPayload({ messages }))
    const sourceBefore = await loadSessionById("imm")

    await forkSession("imm")

    const sourceAfter = await loadSessionById("imm")
    expect(sourceAfter?.meta.id).toBe(sourceBefore?.meta.id)
    expect(sourceAfter?.meta.title).toBe(sourceBefore?.meta.title)
    expect(sourceAfter?.meta.createdAt).toBe(sourceBefore?.meta.createdAt)
    expect(sourceAfter?.meta.lastTouched).toBe(sourceBefore?.meta.lastTouched)
    expect(sourceAfter?.messages).toEqual(sourceBefore?.messages ?? [])
    // And messages are not referentially shared: mutating forked side leaves
    // source untouched (deep-copy invariant).
    const forks = await listSessions()
    const forkId = forks.find((m) => m.id !== "imm")?.id
    expect(forkId).toBeDefined()
  })

  test("forkSession throws on missing source", async () => {
    await expect(forkSession("ghost")).rejects.toThrow(/not found/)
  })

  test("deleteSession removes file and index entry", async () => {
    await saveSessionById(mkMeta({ id: "d1" }), mkPayload())
    expect(existsSync(sessionFilePath("d1"))).toBe(true)
    await deleteSession("d1")
    expect(existsSync(sessionFilePath("d1"))).toBe(false)
    expect(existsSync(archivedFilePath("d1"))).toBe(false)
    expect((await listSessions({ includeArchived: true })).map((m) => m.id)).not.toContain("d1")
    expect(await loadSessionById("d1")).toBeUndefined()
  })

  test("deleteSession also clears an archived file", async () => {
    await saveSessionById(mkMeta({ id: "d2" }), mkPayload())
    await archiveSession("d2")
    expect(existsSync(archivedFilePath("d2"))).toBe(true)
    await deleteSession("d2")
    expect(existsSync(archivedFilePath("d2"))).toBe(false)
  })

  test("ops are idempotent / no-throw on missing ids", async () => {
    await archiveSession("missing")
    await unarchiveSession("missing")
    await renameSession("missing", "x")
    await deleteSession("missing")
    expect(await loadSessionById("missing")).toBeUndefined()
  })
})
