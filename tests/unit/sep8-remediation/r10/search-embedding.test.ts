import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { IndexerFileChunk } from "@/retrieval"
import {
  bindPersistedEmbeddingSpace,
  buildSemanticBackend,
  EmbeddingSpaceError,
  embeddingSpacesEqual,
  HASH_EMBEDDING_SPACE,
  hashEmbed,
  resolveIndexEmbedder,
  SemanticBackendUnavailableError,
} from "@/runner/assemble/search-index-backend"
import {
  buildSearchPipelineFromEnv,
  clearSearchPipelineWireForTests,
} from "@/runner/assemble/search-pipeline"

const chunk = (path: string, text: string): IndexerFileChunk => ({
  path,
  startLine: 1,
  endLine: 2,
  text,
  mtime: 1,
  sha: "0",
})

describe("E-SEARCH-01 typed unavailable", () => {
  test("invalid explicit store is unavailable, not a no-hit", async () => {
    const backend = buildSemanticBackend({ QUANTA_VECTOR_STORE: "nope" }, async () => [1, 0])
    expect(backend.state).toBe("failed")
    expect((await backend.readiness).kind).toBe("unavailable")
    await expect(backend.port.query([1, 0], 3)).rejects.toBeInstanceOf(
      SemanticBackendUnavailableError,
    )
    const ready = buildSemanticBackend({}, async () => [1, 0])
    expect(await ready.port.query([1, 0], 3)).toEqual([])
  })
})

describe("E-EMBED-01 embedding space", () => {
  test("hash namespace is distinct from a provider space", async () => {
    const hash = resolveIndexEmbedder({})
    const provider = resolveIndexEmbedder({ QUANTA_EMBED_PROVIDER: "headless" })
    expect(embeddingSpacesEqual(await hash.space(), HASH_EMBEDDING_SPACE)).toBe(true)
    expect(embeddingSpacesEqual(await hash.space(), await provider.space())).toBe(false)
  })

  test("32,769-byte input against a 1536d cap fails typed, not hash", async () => {
    const embed = resolveIndexEmbedder({ QUANTA_EMBED_PROVIDER: "headless" }, () => ({
      async embed() {
        return { ok: false as const, error: { kind: "network", detail: "down" } }
      },
      async capabilities() {
        return {
          dim: 1536,
          maxInputBytes: 8192,
          batchSize: 1,
          modelTag: "openai:text-embedding-3-small",
        }
      },
    }))
    const huge = "x".repeat(32_769)
    await expect(embed.embed(huge)).rejects.toBeInstanceOf(EmbeddingSpaceError)
    try {
      await embed.embed(huge)
    } catch (e) {
      expect((e as EmbeddingSpaceError).kind).toBe("input-too-large")
    }
  })

  test("same-dimension different model identities are not equal", async () => {
    const a = {
      model: "openai:text-embedding-3-small",
      revision: "1",
      dimensions: 1536,
      normalization: "l2" as const,
    }
    const b = {
      model: "legacy:hash-embed",
      revision: "1",
      dimensions: 1536,
      normalization: "l2" as const,
    }
    expect(embeddingSpacesEqual(a, b)).toBe(false)
  })

  test("query/index dimension mismatch throws instead of Math.min truncation", async () => {
    const backend = buildSemanticBackend({}, async () => hashEmbed("alpha"))
    await backend.upsert.upsert(chunk("a.ts", "alpha"))
    await expect(backend.port.query(new Array(1536).fill(0), 3)).rejects.toBeInstanceOf(
      EmbeddingSpaceError,
    )
  })

  test("provider failure does not return hash vectors", async () => {
    const embed = resolveIndexEmbedder({ QUANTA_EMBED_PROVIDER: "headless" }, () => ({
      async embed() {
        return { ok: false as const, error: { kind: "network", detail: "x" } }
      },
      async capabilities() {
        return { dim: 1536, maxInputBytes: 1_000_000, batchSize: 1, modelTag: "p" }
      },
    }))
    await expect(embed.embed("hi")).rejects.toBeInstanceOf(EmbeddingSpaceError)
  })

  test("persisted space mismatch refuses and keeps original rows", async () => {
    const db = new Database(":memory:")
    const hash = resolveIndexEmbedder({})
    const first = buildSemanticBackend({ QUANTA_INDEX_PERSIST: "on" }, hash.embed, {
      db: db as never,
      resolvedEmbedder: hash,
    })
    await first.upsert.upsert(chunk("a.ts", "alpha"))
    const hits = await first.port.query(hashEmbed("alpha"), 1)
    expect(hits).toHaveLength(1)
    const other = resolveIndexEmbedder({ QUANTA_EMBED_PROVIDER: "headless" })
    const second = buildSemanticBackend({ QUANTA_INDEX_PERSIST: "on" }, other.embed, {
      db: db as never,
      resolvedEmbedder: other,
    })
    const ready = await second.readiness
    expect(ready.kind).toBe("unavailable")
    await expect(second.port.query(await other.embed("alpha"), 1)).rejects.toBeInstanceOf(
      SemanticBackendUnavailableError,
    )
    expect(await first.port.query(hashEmbed("alpha"), 1)).toHaveLength(1)
  })

  test("unlabeled persisted vectors refuse mix and are not deleted", async () => {
    const db = new Database(":memory:")
    db.exec(
      `CREATE TABLE search_index_vss (
         id TEXT PRIMARY KEY,
         vector BLOB NOT NULL,
         metadata TEXT
       ) WITHOUT ROWID`,
    )
    db.query(`INSERT INTO search_index_vss (id, vector, metadata) VALUES (?, ?, ?)`).run(
      "keep-me",
      new Uint8Array(16),
      null,
    )
    const hash = resolveIndexEmbedder({})
    const backend = buildSemanticBackend({ QUANTA_INDEX_PERSIST: "on" }, hash.embed, {
      db: db as never,
      resolvedEmbedder: hash,
    })
    expect((await backend.readiness).kind).toBe("unavailable")
    const n = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM search_index_vss`).get()
    expect(n?.n).toBe(1)
    const bind = bindPersistedEmbeddingSpace(db as never, "search_index_vss", HASH_EMBEDDING_SPACE)
    expect(bind.kind).toBe("unknown")
  })
})

describe("E-SEARCH-01.4 search pipeline typed failure", () => {
  afterEach(() => {
    clearSearchPipelineWireForTests()
  })

  test("explicit invalid store does not start a silent indexer", () => {
    const dir = mkdtempSync(join(tmpdir(), "r10-pipe-"))
    try {
      const wired = buildSearchPipelineFromEnv(
        {
          QUANTA_INDEX: "on",
          QUANTA_VECTOR_STORE: "nope",
          QUANTA_INDEX_INTERVAL_MS: "1000000",
        },
        dir,
      )
      expect(wired?.indexer).toBeNull()
      expect(wired?.intervalHandle).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
