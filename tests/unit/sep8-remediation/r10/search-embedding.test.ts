import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { IndexerFileChunk } from "@/retrieval"
import {
  bindPersistedEmbeddingNamespace,
  bindPersistedEmbeddingSpace,
  buildSemanticBackend,
  EMBEDDING_REMOTE_OWNER_TABLE,
  EmbeddingSpaceError,
  embeddingSpaceNamespace,
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
    expect(embeddingSpaceNamespace("docs", a)).not.toBe(embeddingSpaceNamespace("docs", b))
    expect(embeddingSpaceNamespace("docs", a)).toBe(embeddingSpaceNamespace("docs", a))
    expect(embeddingSpaceNamespace("repo-a", a)).not.toBe(embeddingSpaceNamespace("repo-b", a))
  })

  test("remote namespace mapping detects collision/remap instead of relabeling", () => {
    const db = new Database(":memory:")
    const namespace = embeddingSpaceNamespace("docs", HASH_EMBEDDING_SPACE)
    expect(bindPersistedEmbeddingNamespace(db as never, namespace, HASH_EMBEDDING_SPACE).kind).toBe(
      "ok",
    )
    const other = { ...HASH_EMBEDDING_SPACE, revision: "2" }
    expect(bindPersistedEmbeddingNamespace(db as never, namespace, other).kind).toBe("mismatch")
  })

  test("Qdrant composition uses the embedding namespace and requires durable manifest ownership", async () => {
    const calls: string[] = []
    const env = {
      QUANTA_VECTOR_STORE: "qdrant",
      QUANTA_QDRANT_COLLECTION: "docs",
      QUANTA_EMBED_PROVIDER: "headless",
    } as const
    const resolved = resolveIndexEmbedder(env)
    const namespace = embeddingSpaceNamespace("docs", await resolved.space())
    const unowned = buildSemanticBackend(env, resolved.embed, {
      resolvedEmbedder: resolved,
      storeDeps: {
        qdrant: {
          fetchImpl: async (url) => {
            calls.push(url)
            return new Response(JSON.stringify({ result: { status: "ok" } }))
          },
        },
      },
    })
    expect(unowned.state).toBe("failed")
    await expect(unowned.upsert.upsert(chunk("a.ts", "alpha"))).rejects.toThrow(
      "requires QUANTA_INDEX_DB_PATH",
    )
    expect(calls).toEqual([])

    const owned = buildSemanticBackend(env, resolved.embed, {
      manifestDb: new Database(":memory:"),
      resolvedEmbedder: resolved,
      storeDeps: {
        qdrant: {
          fetchImpl: async (url) => {
            calls.push(url)
            return new Response(JSON.stringify({ result: { status: "ok" } }))
          },
        },
      },
    })
    await owned.upsert.upsert(chunk("a.ts", "alpha"))
    expect(calls).toEqual([`http://localhost:6333/collections/${namespace}/points`])
  })

  test("untyped store deps cannot override the authoritative physical namespace", async () => {
    const calls: string[] = []
    const env = {
      QUANTA_VECTOR_STORE: "qdrant",
      QUANTA_QDRANT_COLLECTION: "docs",
      QUANTA_EMBED_PROVIDER: "headless",
    } as const
    const resolved = resolveIndexEmbedder(env)
    const namespace = embeddingSpaceNamespace("docs", await resolved.space())
    const backend = buildSemanticBackend(env, resolved.embed, {
      manifestDb: new Database(":memory:"),
      resolvedEmbedder: resolved,
      storeDeps: {
        qdrant: {
          collection: "hostile-override",
          baseURL: "http://hostile.invalid",
          fetchImpl: async (url: string) => {
            calls.push(url)
            return new Response(JSON.stringify({ result: { status: "ok" } }))
          },
        } as never,
      },
    })

    await backend.upsert.upsert(chunk("a.ts", "alpha"))

    expect(calls).toEqual([`http://localhost:6333/collections/${namespace}/points`])
  })

  test("manifest ownership is isolated across endpoint and provider rotation", async () => {
    const db = new Database(":memory:")
    const firstCalls: string[] = []
    const envA = {
      QUANTA_VECTOR_STORE: "qdrant",
      QUANTA_QDRANT_COLLECTION: "docs",
      QUANTA_QDRANT_BASE_URL: "http://cluster-a/",
      QUANTA_EMBED_PROVIDER: "headless",
    } as const
    const resolvedA = resolveIndexEmbedder(envA)
    const first = buildSemanticBackend(envA, resolvedA.embed, {
      manifestDb: db,
      resolvedEmbedder: resolvedA,
      storeDeps: {
        qdrant: {
          fetchImpl: async (url) => {
            firstCalls.push(url)
            return new Response(JSON.stringify({ result: { status: "ok" } }))
          },
        },
      },
    })
    await first.upsert.upsert(chunk("owned.ts", "alpha"))

    const rotatedCalls: string[] = []
    const envB = { ...envA, QUANTA_QDRANT_BASE_URL: "http://cluster-b" } as const
    const resolvedB = resolveIndexEmbedder(envB)
    const rotated = buildSemanticBackend(envB, resolvedB.embed, {
      manifestDb: db,
      resolvedEmbedder: resolvedB,
      storeDeps: {
        qdrant: {
          fetchImpl: async (url) => {
            rotatedCalls.push(url)
            return new Response(JSON.stringify({ result: { status: "ok" } }))
          },
        },
      },
    })
    await rotated.upsert.delete("owned.ts")

    const lanceCalls: string[] = []
    const lanceEnv = {
      QUANTA_VECTOR_STORE: "lance",
      QUANTA_LANCE_BASE_URL: "http://cluster-a",
      QUANTA_LANCE_TABLE: "docs",
      QUANTA_EMBED_PROVIDER: "headless",
    } as const
    const lanceResolved = resolveIndexEmbedder(lanceEnv)
    const lance = buildSemanticBackend(lanceEnv, lanceResolved.embed, {
      manifestDb: db,
      resolvedEmbedder: lanceResolved,
      storeDeps: {
        lance: {
          fetchImpl: async (url) => {
            lanceCalls.push(url)
            return new Response(JSON.stringify({ ok: true }))
          },
        },
      },
    })
    await lance.upsert.delete("owned.ts")

    expect(firstCalls).toHaveLength(1)
    expect(rotatedCalls).toEqual([])
    expect(lanceCalls).toEqual([])
  })

  test("remote owner sidecar persists only a redacted endpoint fingerprint", async () => {
    const db = new Database(":memory:")
    const env = {
      QUANTA_VECTOR_STORE: "qdrant",
      QUANTA_QDRANT_COLLECTION: "docs",
      QUANTA_QDRANT_BASE_URL:
        "http://operator:super-secret@cluster.example/api/?token=query-secret#fragment-secret",
      QUANTA_EMBED_PROVIDER: "headless",
    } as const
    const resolved = resolveIndexEmbedder(env)
    const backend = buildSemanticBackend(env, resolved.embed, {
      manifestDb: db,
      resolvedEmbedder: resolved,
      storeDeps: { qdrant: { fetchImpl: async () => new Response("{}") } },
    })

    expect((await backend.readiness).kind).toBe("ready")
    await backend.upsert.upsert(chunk("tenant.ts", "alpha"))
    const otherTenantCalls: string[] = []
    const otherTenantEnv = {
      ...env,
      QUANTA_QDRANT_BASE_URL:
        "http://operator:other-secret@cluster.example/api/?token=query-secret#fragment-secret",
    } as const
    const otherTenantResolved = resolveIndexEmbedder(otherTenantEnv)
    const otherTenant = buildSemanticBackend(otherTenantEnv, otherTenantResolved.embed, {
      manifestDb: db,
      resolvedEmbedder: otherTenantResolved,
      storeDeps: {
        qdrant: {
          fetchImpl: async (url) => {
            otherTenantCalls.push(url)
            return new Response("{}")
          },
        },
      },
    })
    await otherTenant.upsert.delete("tenant.ts")

    const persisted = db.query(`SELECT * FROM ${EMBEDDING_REMOTE_OWNER_TABLE}`).all()
    const serialized = JSON.stringify(persisted)
    expect(persisted).toHaveLength(2)
    expect(otherTenantCalls).toEqual([])
    expect(serialized).toContain("qep_")
    expect(serialized).not.toContain("operator")
    expect(serialized).not.toContain("super-secret")
    expect(serialized).not.toContain("other-secret")
    expect(serialized).not.toContain("query-secret")
    expect(serialized).not.toContain("fragment-secret")
    expect(serialized).not.toContain("cluster.example")
  })

  test("pending manifest intent survives a crash after remote write and remains cleanable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "r10-manifest-crash-"))
    const dbPath = join(dir, "manifest.sqlite")
    try {
      const firstDb = new Database(dbPath)
      const env = {
        QUANTA_VECTOR_STORE: "qdrant",
        QUANTA_QDRANT_COLLECTION: "docs",
        QUANTA_EMBED_PROVIDER: "headless",
      } as const
      const resolved = resolveIndexEmbedder(env)
      const first = buildSemanticBackend(env, resolved.embed, {
        manifestDb: firstDb,
        resolvedEmbedder: resolved,
        storeDeps: {
          qdrant: {
            fetchImpl: async () => {
              // Simulate process death after the remote service accepted the
              // write but before the local owner can mark it committed.
              firstDb.close()
              return new Response(JSON.stringify({ result: { status: "ok" } }))
            },
          },
        },
      })
      await expect(first.upsert.upsert(chunk("crash.ts", "alpha"))).rejects.toThrow()

      const cleanupCalls: string[] = []
      const secondDb = new Database(dbPath)
      try {
        const second = buildSemanticBackend(env, resolved.embed, {
          manifestDb: secondDb,
          resolvedEmbedder: resolved,
          storeDeps: {
            qdrant: {
              fetchImpl: async (url) => {
                cleanupCalls.push(url)
                return new Response(JSON.stringify({ result: { status: "ok" } }))
              },
            },
          },
        })
        await second.upsert.delete("crash.ts")
      } finally {
        secondDb.close()
      }
      expect(cleanupCalls).toHaveLength(1)
      expect(cleanupCalls[0]).toEndWith("/points/delete")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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

  test("explicit remote store without manifest ownership does not start a retry loop", () => {
    const dir = mkdtempSync(join(tmpdir(), "r10-pipe-"))
    try {
      const wired = buildSearchPipelineFromEnv(
        {
          QUANTA_INDEX: "on",
          QUANTA_VECTOR_STORE: "qdrant",
          QUANTA_QDRANT_COLLECTION: "docs",
          QUANTA_EMBED_PROVIDER: "headless",
          QUANTA_INDEX_INTERVAL_MS: "1",
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
