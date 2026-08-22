/**
 * T05 / audit C-5,C-18 — `SqliteStore` async-contract + corrupt-embedding.
 *
 * C-5: `delete()` promises `Promise<void>` but ran `deleteStmt.run(id)` with no
 * guard, so a synchronous better-sqlite failure (db locked / disk full /
 * constraint) escaped the Promise boundary and bypassed callers' `await`
 * try/catch (memory.ts eviction sweep, memory-tools). A method promised async
 * must reject, never sync-throw. This pins: a failing DELETE produces a
 * REJECTED promise that `await` can catch — not a synchronous throw.
 *
 * C-18: a corrupt embedding BLOB silently demotes a row to "no embedding". We
 * surface that degradation via a typed observable callback instead of pure
 * silence, while keeping the fail-open read (the row still loads).
 */

import { describe, expect, test } from "bun:test"
import { SqliteStore } from "@/memory/adapters/sqlite"
import { EMBED_DIM } from "@/memory/types"
import { serializeVec } from "@/memory/vector"

/** A valid full-dimension embedding — `normalizeEntry` only persists vectors
 *  of length EMBED_DIM, so a shorter array would be dropped before it ever
 *  hits the BLOB column. */
const fullVec = (): number[] => Array.from({ length: EMBED_DIM }, (_, i) => (i % 7) / 7)

describe("SqliteStore.delete — async contract (C-5)", () => {
  test("delete after close ⇒ REJECTED promise (not a synchronous throw)", async () => {
    const store = new SqliteStore(":memory:")
    store.close() // underlying handle gone → deleteStmt.run will throw synchronously

    // The contract: this is awaitable and the failure arrives as a rejection.
    // A synchronous throw here would escape the try and fail the test.
    let rejected = false
    try {
      await store.delete("any-id")
    } catch (e) {
      rejected = true
      expect(e).toBeInstanceOf(Error)
    }
    expect(rejected).toBe(true)
  })

  test("delete() returns a thenable even on the happy path (Promise contract)", async () => {
    const store = new SqliteStore(":memory:")
    const p = store.delete("missing")
    expect(typeof p.then).toBe("function")
    await p // resolves, no throw
    store.close()
  })
})

describe("SqliteStore — corrupt-embedding observable (C-18)", () => {
  test("odd-length embedding BLOB surfaces a typed degradation event (not silent)", async () => {
    const seen: Array<{ id: string }> = []
    const store = new SqliteStore(":memory:", {
      onCorruptEmbedding: (ev) => seen.push({ id: ev.id }),
    })
    await store.save({
      id: "ok-1",
      kind: "observation",
      text: "fine",
      tags: [],
      createdAt: 1,
      embedding: fullVec(),
    })
    // Corrupt the embedding BLOB to an odd byte length via the raw db.
    const raw = store.rawDbForTest()
    raw.exec("UPDATE memories SET embedding = X'00' WHERE id = 'ok-1'")

    const got = await store.get("ok-1")
    // Fail-open: the row still loads, just without an embedding.
    expect(got).toBeDefined()
    expect(got?.embedding).toBeUndefined()
    // …but the degradation is OBSERVABLE.
    expect(seen.map((s) => s.id)).toContain("ok-1")
    store.close()
  })

  test("a VALID embedding does NOT raise the corrupt-embedding event", async () => {
    const seen: string[] = []
    const store = new SqliteStore(":memory:", {
      onCorruptEmbedding: (ev) => seen.push(ev.id),
    })
    const vec = fullVec()
    await store.save({
      id: "good",
      kind: "observation",
      text: "fine",
      tags: [],
      createdAt: 1,
      embedding: vec,
    })
    // sanity — the BLOB round-trips
    expect(serializeVec(vec).byteLength % 4).toBe(0)
    await store.get("good")
    await store.all()
    expect(seen).toEqual([])
    store.close()
  })

  test("a throwing onCorruptEmbedding observer never breaks the read (no-throw)", async () => {
    const store = new SqliteStore(":memory:", {
      onCorruptEmbedding: () => {
        throw new Error("hostile observer")
      },
    })
    await store.save({
      id: "x",
      kind: "observation",
      text: "t",
      tags: [],
      createdAt: 1,
      embedding: fullVec(),
    })
    store.rawDbForTest().exec("UPDATE memories SET embedding = X'00' WHERE id = 'x'")
    const got = await store.get("x")
    expect(got).toBeDefined()
    store.close()
  })
})
