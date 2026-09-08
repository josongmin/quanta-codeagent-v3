import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { IndexerFileChunk } from "@/retrieval"
import {
  buildSemanticBackend,
  hashEmbed,
  resolveIndexEmbedder,
  SemanticBackendUnavailableError,
} from "@/runner/assemble/search-index-backend"

const chunk = (path: string, text: string): IndexerFileChunk => ({
  path,
  startLine: 1,
  endLine: 2,
  text,
  mtime: 1,
  sha: "0",
})

describe("R10 sqlite persist space (file-backed)", () => {
  const dir = mkdtempSync(join(tmpdir(), "r10-space-"))
  const dbPath = join(dir, "index.db")

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("reopening a file index with a different space refuses and keeps rows", async () => {
    const env = { QUANTA_INDEX_PERSIST: "on", QUANTA_INDEX_DB_PATH: dbPath }
    const hash = resolveIndexEmbedder({})
    const first = buildSemanticBackend(env, hash.embed, { resolvedEmbedder: hash })
    await first.upsert.upsert(chunk("a.ts", "alpha"))
    expect(await first.port.query(hashEmbed("alpha"), 1)).toHaveLength(1)

    const other = resolveIndexEmbedder({ QUANTA_EMBED_PROVIDER: "headless" })
    const second = buildSemanticBackend(env, other.embed, { resolvedEmbedder: other })
    expect((await second.readiness).kind).toBe("unavailable")
    await expect(second.port.query(await other.embed("alpha"), 1)).rejects.toBeInstanceOf(
      SemanticBackendUnavailableError,
    )

    const db = new Database(dbPath)
    const n = db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM search_index_vss`).get()
    expect(n?.n).toBe(1)
    db.close()
  })
})
