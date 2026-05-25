/**
 * Search pipeline env-driven wire (ADR-0277 + ADR-0278).
 *
 * Extracted helper for `buildSearchPipelineFromEnv` + supporting glue.
 * Lives in a separate file to keep `apps/agent/index.ts` lean.
 *
 * Default-OFF: returns null when QUANTA_INDEX/QUANTA_PIPELINE knobs absent.
 */

import { createDefaultIndexer } from "@/retrieval/indexer"
import type { FileChunk as IndexerFileChunk, CodebaseIndexer } from "@/retrieval/indexer"
import { semanticOnlyPipeline } from "@/retrieval/pipeline"
import type { SearchHit, SearchPipeline, SemanticIndex } from "@/retrieval/pipeline"
import { logger } from "@/shared"
import { searchCodebaseTool, type Tool } from "@/tool"

interface ChunkUpsertPort {
  upsert(chunk: IndexerFileChunk): void
  delete(path: string): void
}

interface WiredSearchPipeline {
  readonly pipeline: SearchPipeline
  readonly tool: Tool
  readonly indexer: CodebaseIndexer
  readonly intervalHandle: ReturnType<typeof setInterval> | null
}

let activeWire: WiredSearchPipeline | null = null
const DEFAULT_INTERVAL_MS = 5_000

const hashEmbed = (text: string, dim = 64): readonly number[] => {
  const out = new Float64Array(dim)
  const tokens = text.toLowerCase().split(/[^a-z0-9_]+/u).filter((t) => t.length > 0)
  for (const tok of tokens) {
    let h = 2166136261 >>> 0
    for (let i = 0; i < tok.length; i++) {
      h = Math.imul(h ^ tok.charCodeAt(i), 16777619) >>> 0
    }
    out[h % dim] = (out[h % dim] ?? 0) + 1
  }
  let norm = 0
  for (let i = 0; i < dim; i++) norm += (out[i] ?? 0) * (out[i] ?? 0)
  norm = Math.sqrt(norm) || 1
  const arr: number[] = new Array(dim)
  for (let i = 0; i < dim; i++) arr[i] = (out[i] ?? 0) / norm
  return arr
}

interface InMemoryIndex {
  readonly port: SemanticIndex
  readonly upsert: ChunkUpsertPort
}

const newInMemoryIndex = (): InMemoryIndex => {
  type Entry = { readonly vec: readonly number[]; readonly chunk: IndexerFileChunk }
  const store = new Map<string, Entry>()
  const chunkId = (c: IndexerFileChunk): string => `${c.path}:${c.startLine}-${c.endLine}`
  return {
    port: {
      async query(vec: readonly number[], k: number): Promise<readonly SearchHit[]> {
        const out: SearchHit[] = []
        for (const [id, { vec: v, chunk }] of store) {
          let dot = 0
          const len = Math.min(v.length, vec.length)
          for (let i = 0; i < len; i++) dot += (v[i] ?? 0) * (vec[i] ?? 0)
          out.push({
            id,
            score: dot,
            text: chunk.text,
            source: "semantic",
          })
        }
        return out.sort((a, b) => b.score - a.score).slice(0, k)
      },
    },
    upsert: {
      upsert(chunk: IndexerFileChunk): void {
        const id = chunkId(chunk)
        store.set(id, { vec: hashEmbed(chunk.text), chunk })
      },
      delete(path: string): void {
        for (const id of store.keys()) {
          if (id.startsWith(`${path}:`)) store.delete(id)
        }
      },
    },
  }
}

const noopSearchTool = (): Tool => ({
  name: "search_codebase",
  description: "(stub)",
  inputSchema: {} as never,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async *execute() {
    yield { type: "result", result: { ok: false, output: "no pipeline wired" } }
  },
})

const isOn = (v: string | undefined): boolean => v === "on"

export const buildSearchPipelineFromEnv = (
  env: NodeJS.ProcessEnv,
  cwd: string,
): WiredSearchPipeline | null => {
  const indexOn = isOn(env.QUANTA_INDEX)
  const pipelineOn = isOn(env.QUANTA_PIPELINE)
  if (!indexOn && !pipelineOn) return null
  if (indexOn && !pipelineOn) {
    const sem = newInMemoryIndex()
    const indexer = createDefaultIndexer({
      scanner: {
        root: cwd,
        ...(env.QUANTA_INDEX_GLOB !== undefined ? { glob: env.QUANTA_INDEX_GLOB } : {}),
      },
      upsert: sem.upsert,
    })
    return {
      pipeline: semanticOnlyPipeline({ sem: sem.port, embedder: { embed: async (t) => hashEmbed(t) } }),
      tool: noopSearchTool(),
      indexer,
      intervalHandle: null,
    }
  }
  if (!indexOn && pipelineOn) return null

  const sem = newInMemoryIndex()
  const indexer = createDefaultIndexer({
    scanner: {
      root: cwd,
      ...(env.QUANTA_INDEX_GLOB !== undefined ? { glob: env.QUANTA_INDEX_GLOB } : {}),
    },
    upsert: sem.upsert,
  })
  void indexer.scanInitial().then((r) => {
    if (!r.ok) logger.warn(`indexer scanInitial failed: ${r.error.kind}`)
  })
  const intervalMsRaw = env.QUANTA_INDEX_INTERVAL_MS
  const intervalMs =
    intervalMsRaw !== undefined && /^\d+$/.test(intervalMsRaw) ? Number(intervalMsRaw) : DEFAULT_INTERVAL_MS
  const intervalHandle = setInterval(() => {
    void indexer.scanDelta().then((r) => {
      if (!r.ok && r.error.kind !== "scan-in-progress") {
        logger.warn(`indexer scanDelta failed: ${r.error.kind}`)
      }
    })
  }, intervalMs)
  if (typeof intervalHandle === "object" && intervalHandle !== null && "unref" in intervalHandle) {
    ;(intervalHandle as { unref(): unknown }).unref()
  }
  const pipeline = semanticOnlyPipeline({
    sem: sem.port,
    embedder: { embed: async (t) => hashEmbed(t) },
  })
  const tool = searchCodebaseTool(pipeline) as Tool
  return { pipeline, tool, indexer, intervalHandle }
}

export const clearSearchPipelineWireForTests = (): void => {
  if (activeWire?.intervalHandle !== null && activeWire?.intervalHandle !== undefined) {
    clearInterval(activeWire.intervalHandle)
  }
  activeWire?.indexer.stop()
  activeWire = null
}
