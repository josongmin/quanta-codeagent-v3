import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  indexFilePath,
  listSessions,
  removeFromIndex,
  type SessionMeta,
  upsertMeta,
} from "@/session"

const mkMeta = (overrides: Partial<SessionMeta> = {}): SessionMeta => ({
  id: overrides.id ?? "s-1",
  title: overrides.title ?? "untitled",
  cwd: overrides.cwd ?? "/tmp",
  createdAt: overrides.createdAt ?? 1_000,
  lastTouched: overrides.lastTouched ?? 1_000,
  archived: overrides.archived ?? false,
})

describe("session index-store", () => {
  let dir: string
  let envSnapshot: NodeJS.ProcessEnv

  beforeEach(() => {
    envSnapshot = { ...process.env }
    dir = mkdtempSync(join(tmpdir(), "session-index-"))
    process.env.QUANTA_SESSIONS_DIR = dir
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) delete process.env[key]
    }
    Object.assign(process.env, envSnapshot)
  })

  test("upsertMeta + listSessions roundtrip", async () => {
    const m = mkMeta({ id: "a", title: "alpha", lastTouched: 100 })
    await upsertMeta(m)
    const list = await listSessions()
    expect(list).toHaveLength(1)
    expect(list[0]).toEqual(m)
  })

  test("upsertMeta is idempotent on same id (latest wins)", async () => {
    await upsertMeta(mkMeta({ id: "a", title: "first", lastTouched: 100 }))
    await upsertMeta(mkMeta({ id: "a", title: "second", lastTouched: 200 }))
    const list = await listSessions()
    expect(list).toHaveLength(1)
    expect(list[0]?.title).toBe("second")
    expect(list[0]?.lastTouched).toBe(200)
  })

  test("listSessions sorted by lastTouched DESC", async () => {
    await upsertMeta(mkMeta({ id: "a", lastTouched: 100 }))
    await upsertMeta(mkMeta({ id: "b", lastTouched: 300 }))
    await upsertMeta(mkMeta({ id: "c", lastTouched: 200 }))
    const list = await listSessions()
    expect(list.map((m) => m.id)).toEqual(["b", "c", "a"])
  })

  test("listSessions filters archived by default; includeArchived returns all", async () => {
    await upsertMeta(mkMeta({ id: "a", lastTouched: 100, archived: false }))
    await upsertMeta(mkMeta({ id: "b", lastTouched: 200, archived: true }))
    const active = await listSessions()
    expect(active.map((m) => m.id)).toEqual(["a"])
    const all = await listSessions({ includeArchived: true })
    expect(all.map((m) => m.id)).toEqual(["b", "a"])
  })

  test("removeFromIndex removes the row", async () => {
    await upsertMeta(mkMeta({ id: "a" }))
    await upsertMeta(mkMeta({ id: "b", lastTouched: 50 }))
    await removeFromIndex("a")
    const list = await listSessions()
    expect(list.map((m) => m.id)).toEqual(["b"])
  })

  test("removeFromIndex is a no-op when id is absent", async () => {
    await upsertMeta(mkMeta({ id: "a" }))
    await removeFromIndex("not-there")
    const list = await listSessions()
    expect(list.map((m) => m.id)).toEqual(["a"])
  })

  test("corrupt lines in index.jsonl are skipped silently", async () => {
    const good = mkMeta({ id: "good", lastTouched: 500 })
    const path = indexFilePath()
    const body = [
      JSON.stringify(good),
      "{ not valid json",
      JSON.stringify({ id: "shape-bad" }), // missing fields
      "",
    ].join("\n")
    writeFileSync(path, body)
    const list = await listSessions()
    expect(list).toHaveLength(1)
    expect(list[0]?.id).toBe("good")
  })

  test("empty / missing index → empty list", async () => {
    const empty = await listSessions()
    expect(empty).toEqual([])
    writeFileSync(indexFilePath(), "")
    const stillEmpty = await listSessions()
    expect(stillEmpty).toEqual([])
  })

  test("partial-shape lines (wrong-type field) are skipped by validator", async () => {
    // Audit Round 3 §C: a line whose `archived` field is a STRING ("true")
    // instead of a boolean must be rejected by the shape validator, not
    // coerced. Otherwise a malformed index could surface a session whose
    // archived flag is unreliable. The good row alongside it MUST be kept.
    const good = mkMeta({ id: "good-shape", lastTouched: 700 })
    const bad = {
      id: "bad-shape",
      title: "B",
      cwd: "/tmp",
      createdAt: 100,
      lastTouched: 100,
      // intentionally a string, not a boolean
      archived: "true",
    }
    writeFileSync(indexFilePath(), `${[JSON.stringify(good), JSON.stringify(bad)].join("\n")}\n`)
    const list = await listSessions({ includeArchived: true })
    expect(list.map((m) => m.id)).toEqual(["good-shape"])
  })

  test("upsert + remove + upsert cycle keeps the file consistent", async () => {
    await upsertMeta(mkMeta({ id: "a", lastTouched: 100 }))
    await upsertMeta(mkMeta({ id: "b", lastTouched: 200 }))
    await removeFromIndex("a")
    await upsertMeta(mkMeta({ id: "c", lastTouched: 300 }))
    const list = await listSessions()
    expect(list.map((m) => m.id)).toEqual(["c", "b"])
  })
})
