import type { IndexerFileChunk } from "@/retrieval"
import type { SearchHit, SemanticIndex } from "@/retrieval/pipeline"
import {
  EmbeddingSpaceError,
  SemanticBackendUnavailableError,
  type SemanticReadiness,
} from "./errors"

interface SearchIndexMetrics {
  observe(name: string, value: number, labels?: Record<string, string>): void
}

type SemanticBackendState = "ready" | "degraded" | "failed"

interface ChunkUpsertPort {
  upsert(chunk: IndexerFileChunk): Promise<void> | void
  delete(path: string): Promise<void> | void
}

interface InMemoryBackend {
  readonly port: SemanticIndex
  readonly upsert: ChunkUpsertPort
  readonly state: SemanticBackendState
  readonly stateReason?: string
  readonly readiness: Promise<SemanticReadiness>
}

type IndexEmbed = (text: string) => Promise<readonly number[]>

type InMemoryEntry = { readonly vec: readonly number[]; readonly chunk: IndexerFileChunk }

const READY: SemanticReadiness = { kind: "ready" }

const chunkId = (c: IndexerFileChunk): string => `${c.path}:${c.startLine}-${c.endLine}`

const squaredNorm = (vec: readonly number[]): number => {
  let total = 0
  for (let i = 0; i < vec.length; i++) total += (vec[i] ?? 0) * (vec[i] ?? 0)
  return total
}

export const cosineSimilarity = (
  query: readonly number[],
  candidate: readonly number[],
): number => {
  if (query.length !== candidate.length) {
    throw new EmbeddingSpaceError(
      "mismatch",
      `embedding dimension mismatch: query=${query.length} index=${candidate.length}`,
    )
  }
  let dot = 0
  for (let i = 0; i < query.length; i++) dot += (query[i] ?? 0) * (candidate[i] ?? 0)
  const denominator = Math.sqrt(squaredNorm(query)) * Math.sqrt(squaredNorm(candidate))
  return denominator === 0 ? 0 : dot / denominator
}

const semanticHit = (id: string, score: number, chunk: IndexerFileChunk): SearchHit => ({
  id,
  score,
  text: chunk.text,
  source: "semantic",
  metadata: {
    path: chunk.path,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
  },
})

const rankedInMemoryHits = (
  store: ReadonlyMap<string, InMemoryEntry>,
  query: readonly number[],
  limit: number,
): SearchHit[] => {
  const hits: SearchHit[] = []
  for (const [id, { vec, chunk }] of store) {
    hits.push(semanticHit(id, cosineSimilarity(query, vec), chunk))
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit)
}

const nowOrDate = (nowMs: (() => number) | undefined): number => (nowMs ?? (() => Date.now()))()

const safeObserve = (
  metrics: SearchIndexMetrics | undefined,
  name: string,
  value: number,
  labels?: Record<string, string>,
): void => {
  if (metrics === undefined) return
  try {
    metrics.observe(name, value, labels)
  } catch {
    // Metrics are optional; a throwing recorder must not affect retrieval.
  }
}

const awaitReady = async (readiness: Promise<SemanticReadiness>): Promise<void> => {
  const r = await readiness
  if (r.kind === "unavailable") {
    throw new SemanticBackendUnavailableError(r.reason, r.phase)
  }
}

export const newInMemoryBackend = (
  embed: IndexEmbed,
  metrics?: SearchIndexMetrics,
  nowMs?: () => number,
  storeLabel = "legacy-in-memory",
  state: SemanticBackendState = "ready",
  stateReason?: string,
): InMemoryBackend => {
  const store = new Map<string, InMemoryEntry>()
  const readiness = Promise.resolve(READY)
  return {
    state,
    readiness,
    ...(stateReason !== undefined ? { stateReason } : {}),
    port: {
      async query(vec: readonly number[], k: number): Promise<readonly SearchHit[]> {
        await awaitReady(readiness)
        const t0 = nowOrDate(nowMs)
        const hits = rankedInMemoryHits(store, vec, k)
        safeObserve(metrics, "search.index.query.latency_ms", nowOrDate(nowMs) - t0, {
          store: storeLabel,
        })
        return hits
      },
    },
    upsert: {
      async upsert(chunk: IndexerFileChunk): Promise<void> {
        store.set(chunkId(chunk), { vec: await embed(chunk.text), chunk })
      },
      delete(path: string): void {
        for (const id of store.keys()) {
          if (id.startsWith(`${path}:`)) store.delete(id)
        }
      },
    },
  }
}
