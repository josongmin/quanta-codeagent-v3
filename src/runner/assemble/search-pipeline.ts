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
  type IndexError,
} from "@/retrieval"
import { createTreeSitterParser } from "@/retrieval/code-parser"
import type { SearchPipeline } from "@/retrieval/pipeline"
import {
  emitOperatorNotice,
  errMessage,
  gateOn,
  logger,
  type OperatorNotice,
  runtimeConfig,
} from "@/shared"
import { searchCodebaseTool, type Tool } from "@/tool"
import { assemblePipeline, type PipelinePreset, type PipelineWireOverrides } from "./pipeline"
import {
  buildSemanticBackend,
  type ChunkUpsertPort,
  HASH_EMBED_MODEL_TAG,
  resolveIndexEmbedder,
  type SearchIndexMetrics,
  type SemanticReconcileBatch,
} from "./search-index-backend"

/** Honesty repair (structural audit R-A-adversarial): `QUANTA_INDEX=on` with NO
 *  embedding provider/key silently resolves the 64-dim hash-BoW placeholder, so
 *  `search_codebase` advertises a semantic capability it does not have (paraphrase
 *  queries score near-zero yet return non-empty, non-semantic hits). The only
 *  prior signal was a metric label — nothing operator-facing. This pure helper
 *  maps the resolved provider label to a ONE-SHOT operator notice (or null for a
 *  real provider) so the placeholder is no longer a silent degradation. */
export const placeholderEmbedderNotice = (providerLabel: string): OperatorNotice | null =>
  providerLabel === HASH_EMBED_MODEL_TAG
    ? {
        severity: "warn",
        source: "search-index",
        message:
          "QUANTA_INDEX is on but no embedding provider is set — `search_codebase` runs a " +
          "NON-SEMANTIC placeholder (lexical-quality hash vectors), so paraphrase/synonym " +
          "queries will not match.",
        hint: "Set VOYAGE_API_KEY / OPENAI_API_KEY / COHERE_API_KEY (or QUANTA_EMBED_PROVIDER) for real semantic search.",
      }
    : null

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

type ScanResultLike =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: { readonly kind: IndexError["kind"] } }

export type TrackedScanOutcome =
  | { readonly kind: "queue"; readonly batch: SemanticReconcileBatch }
  | { readonly kind: "clear"; readonly errorKind: IndexError["kind"] }
  | { readonly kind: "noop" }

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

export const resolveTrackedScanOutcome = (
  tracked: Pick<TrackedSemanticUpsert, "takeBatch" | "clear">,
  scan: ScanResultLike,
): TrackedScanOutcome => {
  if (!scan.ok) {
    if (scan.error.kind === "scan-in-progress") return { kind: "noop" }
    tracked.clear()
    return { kind: "clear", errorKind: scan.error.kind }
  }
  const batch = tracked.takeBatch()
  return batch === null ? { kind: "noop" } : { kind: "queue", batch }
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
  // Honesty repair — surface the non-semantic placeholder ONCE (no-op for a real
  // provider or when no operator-notice sink is installed; @/shared bus is
  // no-throw). Emitted at index construction, not per query.
  const placeholderNotice = placeholderEmbedderNotice(resolvedEmbedder.providerLabel)
  if (placeholderNotice !== null) emitOperatorNotice(placeholderNotice)
  const sem = buildSemanticBackend(env, resolvedEmbedder.embed, {
    resolvedEmbedder,
    ...(metrics !== undefined ? { metrics } : {}),
  })
  const trackedUpsert = createTrackedSemanticUpsert(sem.upsert)
  // RFC jun-6 §26.1 — wire the syntax-aware (tree-sitter) chunker into the LIVE
  // index when `QUANTA_SYNTAX_CHUNK` is on. The scanner consults the parser only
  // under that knob (default-scanner gate); absent ⇒ no WASM, line-window
  // chunking, byte-identical. Lazy: `createTreeSitterParser` loads no grammar
  // until the first parse, so constructing it under the knob is cheap.
  const indexer = createDefaultIndexer({
    scanner: {
      root: cwd,
      ...(env.QUANTA_INDEX_GLOB !== undefined ? { glob: env.QUANTA_INDEX_GLOB } : {}),
    },
    upsert: trackedUpsert.upsert,
    ...(runtimeConfig().syntaxChunk ? { parser: createTreeSitterParser() } : {}),
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
  const handleScanResult = (phase: "scanInitial" | "scanDelta", scan: ScanResultLike): void => {
    const outcome = resolveTrackedScanOutcome(trackedUpsert, scan)
    if (outcome.kind === "queue") {
      queueReconcile(outcome.batch)
      return
    }
    if (outcome.kind === "clear") {
      logger.warn(`indexer ${phase} failed: ${outcome.errorKind}`)
    }
  }
  void indexer.scanInitial().then((r) => {
    handleScanResult("scanInitial", r)
  })
  const intervalMsRaw = env.QUANTA_INDEX_INTERVAL_MS
  const intervalMs =
    intervalMsRaw !== undefined && /^\d+$/.test(intervalMsRaw)
      ? Number(intervalMsRaw)
      : DEFAULT_INTERVAL_MS
  const intervalHandle = setInterval(() => {
    void indexer.scanDelta().then((r) => {
      handleScanResult("scanDelta", r)
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
  // Canonical SSOT vocab (gateOn: 1/on/true/yes) — matches the tool-surface
  // manifest's `env-flag` declaration for QUANTA_INDEX (was a strict `=== "on"`
  // that silently ignored `=1`, splitting brain with the manifest).
  const indexOn = gateOn(env, "QUANTA_INDEX")
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
