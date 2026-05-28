/**
 * ADR-0391 — Semantic index real-embedder wiring + sqlite delta persist.
 *
 * Hellgate-style adversarial battery proving:
 *   A. Embedder selection (byte-identical default-OFF + real embedder opt-in)
 *   B. sqlite persist backend (default in-memory + opt-in roundtrip)
 *
 * The default path (no `QUANTA_EMBED_PROVIDER`, no `QUANTA_INDEX_PERSIST`)
 * MUST stay byte-identical to the legacy `hashEmbed` + in-memory wire.
 */
import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import type { IndexerFileChunk } from "@/retrieval"
import {
  buildSemanticBackend,
  hashEmbed,
  isPersistOn,
  selectIndexEmbedder,
} from "@/runner/assemble/search-index-backend"

const chunk = (path: string, text: string, start = 1, end = 5): IndexerFileChunk => ({
  path,
  startLine: start,
  endLine: end,
  text,
  mtime: 0,
  sha: "0",
})

// ──────────────────────────────────────────────────────────────────────────
// A. Embedder selection
// ──────────────────────────────────────────────────────────────────────────

describe("selectIndexEmbedder — embedder selection", () => {
  test("A1. no QUANTA_EMBED_PROVIDER ⇒ hashEmbed (byte-identical)", async () => {
    const embed = selectIndexEmbedder({})
    const got = await embed("hello world")
    const want = hashEmbed("hello world")
    expect(got).toEqual([...want])
  })

  test("A2. unknown provider ⇒ hashEmbed fallback (byte-identical)", async () => {
    const embed = selectIndexEmbedder({ QUANTA_EMBED_PROVIDER: "not-a-real-provider" })
    const got = await embed("alpha beta")
    expect(got).toEqual([...hashEmbed("alpha beta")])
  })

  test("A3. headless provider ⇒ real embedder (NOT hashEmbed)", async () => {
    const embed = selectIndexEmbedder({ QUANTA_EMBED_PROVIDER: "headless" })
    const got = await embed("alpha beta")
    // Headless stub is dim-1536; hashEmbed is dim-64. Distinct shapes prove the
    // real embedder path was taken.
    expect(got.length).toBe(1536)
    expect(got.length).not.toBe(hashEmbed("alpha beta").length)
  })

  test("A4. real embedder is deterministic per input", async () => {
    const embed = selectIndexEmbedder({ QUANTA_EMBED_PROVIDER: "headless" })
    const a = await embed("same text")
    const b = await embed("same text")
    expect(a).toEqual([...b])
  })

  test("A5. real embedder failure (missing api key) ⇒ hashEmbed fallback", async () => {
    // openai with no OPENAI_API_KEY ⇒ embed() returns err(missing-api-key);
    // selector must fall back to hashEmbed, never throw.
    const embed = selectIndexEmbedder({ QUANTA_EMBED_PROVIDER: "openai" })
    const got = await embed("needs key")
    expect(got).toEqual([...hashEmbed("needs key")])
  })

  test("A6. empty real-embedder output ⇒ hashEmbed fallback", async () => {
    const embed = selectIndexEmbedder(
      { QUANTA_EMBED_PROVIDER: "headless" },
      // inject an embedder factory that yields an ok-but-empty vectors array
      () => ({
        async embed() {
          return { ok: true as const, value: { vectors: [], modelTag: "stub" } }
        },
        async capabilities() {
          return { dim: 0, maxInputBytes: 0, batchSize: 0, modelTag: "stub" }
        },
      }),
    )
    const got = await embed("xyz")
    expect(got).toEqual([...hashEmbed("xyz")])
  })

  test("A7. throwing real embedder ⇒ hashEmbed fallback (no leak)", async () => {
    const embed = selectIndexEmbedder({ QUANTA_EMBED_PROVIDER: "headless" }, () => ({
      async embed(): Promise<never> {
        throw new Error("vendor blew up")
      },
      async capabilities() {
        return { dim: 0, maxInputBytes: 0, batchSize: 0, modelTag: "x" }
      },
    }))
    const got = await embed("boom")
    expect(got).toEqual([...hashEmbed("boom")])
  })
})

// ──────────────────────────────────────────────────────────────────────────
// B. Backend selection / sqlite persist
// ──────────────────────────────────────────────────────────────────────────

describe("isPersistOn — knob gate", () => {
  test("B0. default off", () => {
    expect(isPersistOn({})).toBe(false)
    expect(isPersistOn({ QUANTA_INDEX_PERSIST: "off" })).toBe(false)
    expect(isPersistOn({ QUANTA_INDEX_PERSIST: "1" })).toBe(false)
    expect(isPersistOn({ QUANTA_INDEX_PERSIST: "on" })).toBe(true)
  })
})

describe("buildSemanticBackend — in-memory default", () => {
  test("B1. no persist knob ⇒ in-memory backend, upsert+query roundtrip", async () => {
    const embed = hashEmbed
    const backend = buildSemanticBackend({}, async (t) => embed(t))
    await backend.upsert.upsert(chunk("a.ts", "alpha function token"))
    await backend.upsert.upsert(chunk("b.ts", "beta gamma delta"))
    const hits = await backend.port.query(embed("alpha function token"), 1)
    expect(hits.length).toBe(1)
    expect(hits[0]?.metadata?.path).toBe("a.ts")
  })

  test("B2. in-memory delete removes a path's chunks", async () => {
    const backend = buildSemanticBackend({}, async (t) => hashEmbed(t))
    await backend.upsert.upsert(chunk("a.ts", "alpha token here"))
    await backend.upsert.delete("a.ts")
    const hits = await backend.port.query(hashEmbed("alpha token here"), 5)
    expect(hits.length).toBe(0)
  })
})

describe("buildSemanticBackend — sqlite persist", () => {
  test("B3. persist on ⇒ vectors survive across a fresh backend on the same db", async () => {
    const db = new Database(":memory:")
    const env = { QUANTA_INDEX_PERSIST: "on" } as const
    const make = () => buildSemanticBackend(env, async (t) => hashEmbed(t), db)

    const a = make()
    await a.upsert.upsert(chunk("svc.ts", "semantic index persistence roundtrip"))

    // Fresh backend over the SAME db handle ⇒ must read the persisted vector.
    const b = make()
    const hits = await b.port.query(hashEmbed("semantic index persistence roundtrip"), 1)
    expect(hits.length).toBe(1)
    expect(hits[0]?.metadata?.path).toBe("svc.ts")
  })

  test("B4. persist delete removes the row", async () => {
    const db = new Database(":memory:")
    const backend = buildSemanticBackend(
      { QUANTA_INDEX_PERSIST: "on" },
      async (t) => hashEmbed(t),
      db,
    )
    await backend.upsert.upsert(chunk("d.ts", "delete me please"))
    await backend.upsert.delete("d.ts")
    const hits = await backend.port.query(hashEmbed("delete me please"), 5)
    expect(hits.length).toBe(0)
  })

  test("B5. persist query returns chunk metadata (path/lines) and is top-k bounded", async () => {
    const db = new Database(":memory:")
    const backend = buildSemanticBackend(
      { QUANTA_INDEX_PERSIST: "on" },
      async (t) => hashEmbed(t),
      db,
    )
    await backend.upsert.upsert(chunk("one.ts", "first chunk text", 10, 20))
    await backend.upsert.upsert(chunk("two.ts", "second chunk text", 30, 40))
    await backend.upsert.upsert(chunk("three.ts", "third chunk text", 50, 60))
    const hits = await backend.port.query(hashEmbed("first chunk text"), 2)
    expect(hits.length).toBe(2)
    const top = hits[0]
    expect(top?.metadata?.path).toBe("one.ts")
    expect(top?.metadata?.startLine).toBe(10)
    expect(top?.metadata?.endLine).toBe(20)
    expect(top?.source).toBe("semantic")
  })
})
