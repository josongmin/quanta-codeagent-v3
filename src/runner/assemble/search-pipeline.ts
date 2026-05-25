/**
 * Search surface wire (ADR-0277 + ADR-0278).
 *
 * Productized composition root for repo search:
 *   - default generic search is lexical-only over the live workspace,
 *   - optional semantic/hybrid search turns on when `QUANTA_INDEX=on`,
 *   - `QUANTA_PIPELINE=none` is the explicit kill-switch,
 *   - the returned tool is the single `search_codebase` facade surfaces
 *     register into their tool registry.
 */

import { relative, sep } from "node:path"
import {
  createBunRipgrepSpawner,
  createDefaultIndexer,
  createRipgrepLexicalSearch,
  type CodebaseIndexer,
  type IndexerFileChunk,
} from "@/retrieval"
import type { SearchHit, SearchPipeline, SemanticIndex } from "@/retrieval/pipeline"
import { logger } from "@/shared"
import { searchCodebaseTool, type Tool } from "@/tool"
import { assemblePipeline, type PipelinePreset, type PipelineWireOverrides } from "./pipeline"

interface ChunkUpsertPort {
  upsert(chunk: IndexerFileChunk): void
  delete(path: string): void
}

export interface WiredSearchPipeline {
  readonly pipeline: SearchPipeline
  readonly tool: Tool
  readonly indexer: CodebaseIndexer | null
  readonly intervalHandle: ReturnType<typeof setInterval> | null
}

let activeWire: WiredSearchPipeline | null = null

const DEFAULT_INTERVAL_MS = 5_000
const DEFAULT_NO_INDEX_PRESET: PipelinePreset = "lexical-only"
const DEFAULT_INDEXED_PRESET: PipelinePreset = "parallel-rrf"
const SEMANTIC_PRESETS = new Set<PipelinePreset>([
  "semantic-only",
  "parallel-rrf",
  "semantic-then-rerank",
  "budget-aware",
])

const isOn = (v: string | undefined): boolean => v === "on"

const toPosix = (p: string): string => (sep === "/" ? p : p.split(sep).join("/"))

const relativizePath = (cwd: string, path: string): string => {
  if (path.length === 0) return path
  const rel = relative(cwd, path)
  if (rel === "") return toPosix(path)
  if (rel.startsWith("..")) return toPosix(path)
  return toPosix(rel)
}

const parseLineMeta = (v: string | undefined): number | undefined =>
  v !== undefined && /^\d+$/.test(v) ? Number(v) : undefined

const disposeWire = (wire: WiredSearchPipeline | null): void => {
  if (wire?.intervalHandle !== null && wire?.intervalHandle !== undefined) {
    clearInterval(wire.intervalHandle)
  }
  wire?.indexer?.stop()
}

const disposeIndexer = (
  indexer: CodebaseIndexer | null,
  intervalHandle: ReturnType<typeof setInterval> | null,
): void => {
  if (intervalHandle !== null && intervalHandle !== undefined) clearInterval(intervalHandle)
  indexer?.stop()
}

const rememberActiveWire = (wire: WiredSearchPipeline | null): WiredSearchPipeline | null => {
  if (activeWire !== null && activeWire !== wire) disposeWire(activeWire)
  activeWire = wire
  return wire
}

const hashEmbed = (text: string, dim = 64): readonly number[] => {
  const out = new Float64Array(dim)
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9_]+/u)
    .filter((t) => t.length > 0)
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
            metadata: {
              path: chunk.path,
              startLine: chunk.startLine,
              endLine: chunk.endLine,
            },
          })
        }
        return out.sort((a, b) => b.score - a.score).slice(0, k)
      },
    },
    upsert: {
      upsert(chunk: IndexerFileChunk): void {
        store.set(chunkId(chunk), { vec: hashEmbed(chunk.text), chunk })
      },
      delete(path: string): void {
        for (const id of store.keys()) {
          if (id.startsWith(`${path}:`)) store.delete(id)
        }
      },
    },
  }
}

const buildLexicalOverride = (cwd: string): NonNullable<PipelineWireOverrides["lex"]> => {
  const inner = createRipgrepLexicalSearch({
    root: cwd,
    spawner: createBunRipgrepSpawner(),
  })
  return {
    async search(query) {
      const r = await inner.query(query.text, query.k)
      if (!r.ok) {
        logger.warn(`search lexical query failed: ${r.error.kind}`)
        return []
      }
      return r.value.map((h) => {
        const path = relativizePath(cwd, h.id)
        const startLine = parseLineMeta(h.metadata?.startLine)
        const endLine = parseLineMeta(h.metadata?.endLine)
        return {
          id: path,
          score: h.score,
          text: h.text,
          source: "lexical" as const,
          metadata: {
            path,
            ...(startLine !== undefined ? { startLine } : {}),
            ...(endLine !== undefined ? { endLine } : {}),
          },
        }
      })
    },
  }
}

const startIndexer = (
  env: NodeJS.ProcessEnv,
  cwd: string,
): {
  readonly sem: NonNullable<PipelineWireOverrides["sem"]>
  readonly embedder: NonNullable<PipelineWireOverrides["embedder"]>
  readonly indexer: CodebaseIndexer
  readonly intervalHandle: ReturnType<typeof setInterval> | null
} => {
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
    intervalMsRaw !== undefined && /^\d+$/.test(intervalMsRaw)
      ? Number(intervalMsRaw)
      : DEFAULT_INTERVAL_MS
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
  return {
    sem: sem.port,
    embedder: { embed: async (text: string) => hashEmbed(text) },
    indexer,
    intervalHandle,
  }
}

const fallbackPreset = (indexOn: boolean): PipelinePreset =>
  indexOn ? DEFAULT_INDEXED_PRESET : DEFAULT_NO_INDEX_PRESET

const buildRequestedPreset = (
  env: NodeJS.ProcessEnv,
  indexOn: boolean,
): { readonly preset: PipelinePreset | "none"; readonly explicit: boolean } => {
  const raw = env.QUANTA_PIPELINE
  if (raw === "none") return { preset: "none", explicit: true }
  if (raw === undefined || raw === "") return { preset: fallbackPreset(indexOn), explicit: false }
  return { preset: raw as PipelinePreset, explicit: true }
}

const lexicalOnlyPipeline = (
  env: NodeJS.ProcessEnv,
  lex: NonNullable<PipelineWireOverrides["lex"]>,
): SearchPipeline | null =>
  assemblePipeline({ ...env, QUANTA_PIPELINE: DEFAULT_NO_INDEX_PRESET }, { lex })

export const buildSearchPipelineFromEnv = (
  env: NodeJS.ProcessEnv,
  cwd: string,
): WiredSearchPipeline | null => {
  const indexOn = isOn(env.QUANTA_INDEX)
  const { preset, explicit } = buildRequestedPreset(env, indexOn)
  if (preset === "none") return rememberActiveWire(null)

  const lex = buildLexicalOverride(cwd)
  let overrides: PipelineWireOverrides = { lex }
  let indexer: CodebaseIndexer | null = null
  let intervalHandle: ReturnType<typeof setInterval> | null = null
  let effectivePreset = preset

  if (SEMANTIC_PRESETS.has(preset)) {
    if (!indexOn) {
      logger.warn(
        `search wire: preset "${preset}" requested without QUANTA_INDEX=on; ` +
          `falling back to ${DEFAULT_NO_INDEX_PRESET}.`,
      )
      effectivePreset = DEFAULT_NO_INDEX_PRESET
    } else {
      const semantic = startIndexer(env, cwd)
      overrides = {
        ...overrides,
        sem: semantic.sem,
        embedder: semantic.embedder,
      }
      indexer = semantic.indexer
      intervalHandle = semantic.intervalHandle
    }
  }

  let pipeline = assemblePipeline({ ...env, QUANTA_PIPELINE: effectivePreset }, overrides)
  if (pipeline === null) {
    if (explicit) {
      logger.warn(
        `search wire: preset "${env.QUANTA_PIPELINE ?? effectivePreset}" unavailable; ` +
          `falling back to ${DEFAULT_NO_INDEX_PRESET}.`,
      )
    }
    pipeline = lexicalOnlyPipeline(env, lex)
    if (pipeline === null) {
      disposeIndexer(indexer, intervalHandle)
      return rememberActiveWire(null)
    }
    effectivePreset = DEFAULT_NO_INDEX_PRESET
    if (indexer !== null) {
      disposeIndexer(indexer, intervalHandle)
      indexer = null
      intervalHandle = null
    }
  }

  const wire: WiredSearchPipeline = {
    pipeline,
    tool: searchCodebaseTool(pipeline) as Tool,
    indexer,
    intervalHandle,
  }
  return rememberActiveWire(wire)
}

export const clearSearchPipelineWireForTests = (): void => {
  disposeWire(activeWire)
  activeWire = null
}
