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
  type CodebaseIndexer,
  createBunRipgrepSpawner,
  createDefaultIndexer,
  createRipgrepLexicalSearch,
} from "@/retrieval"
import type { SearchPipeline } from "@/retrieval/pipeline"
import { errMessage, logger } from "@/shared"
import { searchCodebaseTool, type Tool } from "@/tool"
import { assemblePipeline, type PipelinePreset, type PipelineWireOverrides } from "./pipeline"
import {
  type ChunkUpsertPort,
  buildSemanticBackend,
  resolveIndexEmbedder,
  type SemanticReconcileBatch,
  type SearchIndexMetrics,
} from "./search-index-backend"

export interface WiredSearchPipeline {
  readonly pipeline: SearchPipeline
  readonly tool: Tool
  readonly indexer: CodebaseIndexer | null
  readonly intervalHandle: ReturnType<typeof setInterval> | null
  /**
   * Tear down THIS wire's owned resources (delta-scan `setInterval` + indexer)
   * (L5 M-11). Session teardown calls this so a long-lived session does not
   * leak a scanning interval; idempotent (a second call is a no-op). Before
   * this seam, the interval was only cleared when the global singleton was
   * replaced by a NEW pipeline — never on session close.
   */
  dispose(): void
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

const trackedChunkId = (path: string, startLine: number, endLine: number): string =>
  `${path}:${startLine}-${endLine}`

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

export interface TrackedSemanticUpsert {
  readonly upsert: ChunkUpsertPort
  takeBatch(): SemanticReconcileBatch | null
  clear(): void
}

export const createTrackedSemanticUpsert = (inner: ChunkUpsertPort): TrackedSemanticUpsert => {
  const changedPaths = new Map<string, string[]>()
  const deletedPaths = new Set<string>()
  return {
    upsert: {
      async upsert(chunk) {
        await inner.upsert(chunk)
        deletedPaths.delete(chunk.path)
        const ids = changedPaths.get(chunk.path) ?? []
        ids.push(trackedChunkId(chunk.path, chunk.startLine, chunk.endLine))
        changedPaths.set(chunk.path, ids)
      },
      async delete(path) {
        await inner.delete(path)
        changedPaths.delete(path)
        deletedPaths.add(path)
      },
    },
    takeBatch() {
      if (changedPaths.size === 0 && deletedPaths.size === 0) return null
      const batch: SemanticReconcileBatch = {
        changedPaths: new Map(
          [...changedPaths].map(([path, ids]) => [path, [...ids] as readonly string[]]),
        ),
        deletedPaths: [...deletedPaths],
      }
      changedPaths.clear()
      deletedPaths.clear()
      return batch
    },
    clear() {
      changedPaths.clear()
      deletedPaths.clear()
    },
  }
}

const startIndexer = (
  env: NodeJS.ProcessEnv,
  cwd: string,
  metrics?: SearchIndexMetrics,
): {
  readonly sem: NonNullable<PipelineWireOverrides["sem"]>
  readonly embedder: NonNullable<PipelineWireOverrides["embedder"]>
  readonly indexer: CodebaseIndexer
  readonly intervalHandle: ReturnType<typeof setInterval> | null
} => {
  // The SAME embed function backs both upsert vectors and the pipeline query
  // embedder — otherwise stored and query vectors come from different models.
  // Default-OFF: with no `QUANTA_EMBED_PROVIDER` this IS the legacy hashEmbed.
  const resolvedEmbedder = resolveIndexEmbedder(env, undefined, {
    ...(metrics !== undefined ? { metrics } : {}),
  })
  const sem = buildSemanticBackend(env, resolvedEmbedder.embed, {
    resolvedEmbedder,
    ...(metrics !== undefined ? { metrics } : {}),
  })
  const trackedUpsert = createTrackedSemanticUpsert(sem.upsert)
  const indexer = createDefaultIndexer({
    scanner: {
      root: cwd,
      ...(env.QUANTA_INDEX_GLOB !== undefined ? { glob: env.QUANTA_INDEX_GLOB } : {}),
    },
    upsert: trackedUpsert.upsert,
  })
  let reconcile = Promise.resolve()
  const queueReconcile = (batch: SemanticReconcileBatch): void => {
    if (sem.reconcileChanges === undefined) return
    reconcile = reconcile
      .catch(() => undefined)
      .then(async () => {
        try {
          // Reconcile only the paths touched in the completed scan batch. This
          // avoids the old full-corpus replay on every successful delta tick.
          await sem.reconcileChanges?.(batch)
        } catch (e) {
          logger.warn(`search index reconcile failed: ${errMessage(e)}`)
        }
      })
  }
  void indexer.scanInitial().then((r) => {
    if (!r.ok) {
      trackedUpsert.clear()
      logger.warn(`indexer scanInitial failed: ${r.error.kind}`)
      return
    }
    const batch = trackedUpsert.takeBatch()
    if (batch !== null) queueReconcile(batch)
  })
  const intervalMsRaw = env.QUANTA_INDEX_INTERVAL_MS
  const intervalMs =
    intervalMsRaw !== undefined && /^\d+$/.test(intervalMsRaw)
      ? Number(intervalMsRaw)
      : DEFAULT_INTERVAL_MS
  const intervalHandle = setInterval(() => {
    void indexer.scanDelta().then((r) => {
      if (!r.ok && r.error.kind !== "scan-in-progress") {
        trackedUpsert.clear()
        logger.warn(`indexer scanDelta failed: ${r.error.kind}`)
        return
      }
      if (!r.ok) return
      const batch = trackedUpsert.takeBatch()
      if (batch !== null) queueReconcile(batch)
    })
  }, intervalMs)
  if (typeof intervalHandle === "object" && intervalHandle !== null && "unref" in intervalHandle) {
    ;(intervalHandle as { unref(): unknown }).unref()
  }
  return {
    sem: sem.port,
    embedder: { embed: async (text: string) => resolvedEmbedder.embed(text) },
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
  metrics?: SearchIndexMetrics,
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
      const semantic = startIndexer(env, cwd, metrics)
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

  let disposed = false
  const wire: WiredSearchPipeline = {
    pipeline,
    tool: searchCodebaseTool(pipeline) as Tool,
    indexer,
    intervalHandle,
    dispose: () => {
      if (disposed) return
      disposed = true
      disposeIndexer(indexer, intervalHandle)
      if (activeWire === wire) activeWire = null
    },
  }
  return rememberActiveWire(wire)
}

export const clearSearchPipelineWireForTests = (): void => {
  disposeWire(activeWire)
  activeWire = null
}

/**
 * Production teardown (L5 M-11): dispose the currently-active search wire's
 * owned resources (delta-scan `setInterval` + indexer). Idempotent + a no-op
 * when no pipeline is active. The CLI session loop registers this on its close
 * stack so a long-lived session does not leak a scanning interval; before this
 * the interval was cleared only when a NEW pipeline replaced the singleton.
 */
export const disposeActiveSearchPipeline = (): void => {
  activeWire?.dispose()
}
