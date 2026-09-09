import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { InMemoryStore } from "../../src/memory/adapters/in-memory"
import { SqliteStore } from "../../src/memory/adapters/sqlite"
import { InvalidMemoryPatchError } from "../../src/memory/patch"
import type { PersistentStorePort } from "../../src/memory/ports"
import { EMBED_DIM, type MemoryEntry, type MemoryPatch } from "../../src/memory/types"

// `exactOptionalPropertyTypes` must reject required mutable fields explicitly
// cleared by an untyped caller. Embedding is the one deliberate clear command.
// @ts-expect-error text cannot be cleared
const INVALID_TEXT_CLEAR: MemoryPatch = { text: undefined }
const VALID_EMBEDDING_CLEAR: MemoryPatch = { embedding: undefined }
void INVALID_TEXT_CLEAR
void VALID_EMBEDDING_CLEAR

/**
 * Deterministic length-1536 embedding whose every component is exactly
 * Float32-representable (`Math.fround`), so a serialize -> Float32 BLOB ->
 * deserialize roundtrip is bit-exact.
 */
const makeEmbedding = (seed: number): number[] =>
  Array.from({ length: EMBED_DIM }, (_, i) => Math.fround(Math.sin((i + seed) * 0.01)))

const fullEntry = (over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id: "e1",
  kind: "fact",
  tier: "episodic",
  text: "the sky is blue",
  tags: ["color", "sky"],
  importance: 0.8,
  createdAt: 1_000,
  updatedAt: 2_000,
  accessCount: 3,
  lastAccessedAt: 1_500,
  embedding: makeEmbedding(1),
  sessionId: "sess-a",
  ...over,
})

const adapters: ReadonlyArray<readonly [string, () => PersistentStorePort]> = [
  ["InMemoryStore", () => new InMemoryStore()],
  ["SqliteStore", () => new SqliteStore(":memory:")],
]

for (const [name, make] of adapters) {
  describe(`PersistentStorePort conformance: ${name}`, () => {
    test("save + get roundtrip with all fields incl. length-1536 embedding", async () => {
      const store = make()
      const entry = fullEntry()
      await store.save(entry)
      const got = await store.get("e1")
      expect(got).toBeDefined()
      expect(got?.id).toBe("e1")
      expect(got?.kind).toBe("fact")
      expect(got?.tier).toBe("episodic")
      expect(got?.text).toBe("the sky is blue")
      expect(got?.tags).toEqual(["color", "sky"])
      expect(got?.importance).toBe(0.8)
      expect(got?.createdAt).toBe(1_000)
      expect(got?.updatedAt).toBe(2_000)
      expect(got?.accessCount).toBe(3)
      expect(got?.lastAccessedAt).toBe(1_500)
      expect(got?.sessionId).toBe("sess-a")
      expect(got?.embedding).toBeDefined()
      expect(got?.embedding?.length).toBe(EMBED_DIM)
    })

    test("embedding survives serialize -> deserialize roundtrip (Float32)", async () => {
      const store = make()
      const emb = makeEmbedding(7)
      await store.save(fullEntry({ id: "e-emb", embedding: emb }))
      const got = await store.get("e-emb")
      // Float32 precision: values rounded to 1e-3 survive exactly.
      expect(got?.embedding).toEqual(emb)
    })

    test("get returns undefined for unknown id", async () => {
      const store = make()
      expect(await store.get("nope")).toBeUndefined()
    })

    test("save rejects empty id", async () => {
      const store = make()
      await expect(store.save(fullEntry({ id: "" }))).rejects.toThrow("MemoryEntry.id is required")
    })

    test("normalize defaults applied for a minimal entry", async () => {
      const store = make()
      const minimal: MemoryEntry = {
        id: "min",
        kind: "fact",
        text: "minimal",
        tags: [],
        createdAt: 5_000,
      }
      await store.save(minimal)
      const got = await store.get("min")
      expect(got?.tier).toBe("semantic")
      expect(got?.importance).toBe(0.5)
      expect(got?.updatedAt).toBe(5_000)
      expect(got?.accessCount).toBe(0)
      expect(got?.embedding).toBeUndefined()
    })

    test("update merges patch and bumps updatedAt", async () => {
      const store = make()
      await store.save(fullEntry({ updatedAt: 2_000 }))
      const before = Date.now()
      await store.update("e1", { text: "the sky is grey", importance: 0.1 })
      const got = await store.get("e1")
      expect(got?.text).toBe("the sky is grey")
      expect(got?.importance).toBe(0.1)
      // Untouched fields preserved.
      expect(got?.tags).toEqual(["color", "sky"])
      expect(got?.kind).toBe("fact")
      expect(got?.updatedAt).toBeGreaterThanOrEqual(before)
      expect(got?.updatedAt).toBeGreaterThan(2_000)
    })

    test("update is a no-op for unknown id", async () => {
      const store = make()
      await store.update("ghost", { text: "x" })
      expect(await store.get("ghost")).toBeUndefined()
    })

    test("update rejects immutable and required-field clears without changing the row", async () => {
      const store = make()
      await store.save(fullEntry())
      const before = await store.get("e1")
      const hostilePatches = [
        { id: undefined },
        { createdAt: undefined },
        { updatedAt: undefined },
        { kind: undefined },
        { text: undefined },
        { tags: undefined },
      ]
      for (const patch of hostilePatches) {
        await expect(store.update("e1", patch as unknown as MemoryPatch)).rejects.toBeInstanceOf(
          InvalidMemoryPatchError,
        )
        expect(await store.get("e1")).toEqual(before)
      }
    })

    test("embedding clear is explicit and adapter-identical", async () => {
      const store = make()
      await store.save(fullEntry())
      await store.update("e1", { embedding: undefined })
      const got = await store.get("e1")
      expect(got?.id).toBe("e1")
      expect(got?.kind).toBe("fact")
      expect(got?.text).toBe("the sky is blue")
      expect(got?.tags).toEqual(["color", "sky"])
      expect(got?.createdAt).toBe(1_000)
      expect(got?.embedding).toBeUndefined()
    })

    test("delete removes; no-op for unknown id", async () => {
      const store = make()
      await store.save(fullEntry())
      await store.delete("e1")
      expect(await store.get("e1")).toBeUndefined()
      await store.delete("e1") // no throw
    })

    test("all() includes superseded entries", async () => {
      const store = make()
      await store.save(fullEntry({ id: "a", createdAt: 1 }))
      await store.save(fullEntry({ id: "b", createdAt: 2, supersededBy: "a" }))
      const all = await store.all()
      expect(all.map((e) => e.id).sort()).toEqual(["a", "b"])
      const b = all.find((e) => e.id === "b")
      expect(b?.supersededBy).toBe("a")
    })

    test("save upserts by id", async () => {
      const store = make()
      await store.save(fullEntry({ id: "u", text: "v1" }))
      await store.save(fullEntry({ id: "u", text: "v2" }))
      const all = await store.all()
      expect(all.filter((e) => e.id === "u").length).toBe(1)
      expect((await store.get("u"))?.text).toBe("v2")
    })

    test("external mutation cannot corrupt the store", async () => {
      const store = make()
      const emb = makeEmbedding(2)
      const e = fullEntry({ id: "iso", embedding: emb, tags: ["t"] })
      await store.save(e)
      e.tags.push("MUTATED")
      e.embedding?.splice(0, 10)
      const got = await store.get("iso")
      expect(got?.tags).toEqual(["t"])
      expect(got?.embedding?.length).toBe(EMBED_DIM)
      // Mutating the returned copy must not affect a second read.
      got?.tags.push("MUTATED2")
      const got2 = await store.get("iso")
      expect(got2?.tags).toEqual(["t"])
    })

    test("recall delegates to ranking (ordering + filters)", async () => {
      const store = make()
      const now = Date.now()
      await store.save(
        fullEntry({
          id: "old",
          text: "alpha topic",
          tags: ["x"],
          createdAt: now - 40 * 24 * 60 * 60 * 1000,
        }),
      )
      await store.save(
        fullEntry({
          id: "fresh-tagmatch",
          text: "alpha topic",
          tags: ["x", "y"],
          createdAt: now,
        }),
      )
      const res = await store.recall({ text: "alpha", tags: ["y"] })
      // Tag overlap + freshness should rank the fresh tagged entry first.
      expect(res[0]?.id).toBe("fresh-tagmatch")
      // kind prefilter exercised (sqlite path) — non-matching kind dropped.
      await store.save(fullEntry({ id: "pref", kind: "preference", text: "alpha" }))
      const factsOnly = await store.recall({ kinds: ["fact"], text: "alpha" })
      expect(factsOnly.every((e) => e.kind === "fact")).toBe(true)
    })

    test("recall returns normalized clones (mutation-safe)", async () => {
      const store = make()
      await store.save(fullEntry({ id: "r1", tags: ["a"] }))
      const res = await store.recall({})
      res[0]?.tags.push("HACK")
      const again = await store.recall({})
      expect(again.find((e) => e.id === "r1")?.tags).toEqual(["a"])
    })
  })
}

describe("SqliteStore migration / persistence", () => {
  test("reopen on same path preserves rows and migrates legacy schema", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mem-adapter-"))
    const dbPath = join(dir, "mem.sqlite")
    try {
      // Simulate a legacy db: a bare table with only the old columns.
      const { Database } = await import("bun:sqlite")
      const legacy = new Database(dbPath)
      legacy.exec(`
        CREATE TABLE memories (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          text TEXT NOT NULL,
          tags TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          session_id TEXT
        )
      `)
      legacy
        .query(
          "INSERT INTO memories (id, kind, text, tags, created_at, session_id) VALUES (?,?,?,?,?,?)",
        )
        .run("legacy-1", "fact", "old row", JSON.stringify(["t"]), 123, "s1")
      legacy.close()

      // Opening a SqliteStore must migrate in the new columns and still read old rows.
      const store = new SqliteStore(dbPath)
      const legacyRow = await store.get("legacy-1")
      expect(legacyRow?.text).toBe("old row")
      expect(legacyRow?.tier).toBe("semantic") // normalized default
      expect(legacyRow?.importance).toBe(0.5)
      expect(legacyRow?.updatedAt).toBe(123) // defaults to createdAt
      expect(legacyRow?.accessCount).toBe(0)

      // Write a fully-featured row, close, reopen — still works.
      await store.save(fullEntry({ id: "new-1", embedding: makeEmbedding(3) }))
      store.close()

      const reopened = new SqliteStore(dbPath)
      const got = await reopened.get("new-1")
      expect(got?.embedding?.length).toBe(EMBED_DIM)
      expect((await reopened.get("legacy-1"))?.text).toBe("old row")
      reopened.close()

      // Constructing again on the same path stays idempotent (re-running the
      // CREATE TABLE IF NOT EXISTS + ALTER migration on an already-migrated db).
      const third = new SqliteStore(dbPath)
      expect((await third.all()).length).toBe(2)
      third.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
      expect(existsSync(dir)).toBe(false)
    }
  })
})
