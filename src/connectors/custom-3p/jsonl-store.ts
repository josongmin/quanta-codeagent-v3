/**
 * Custom 3P Setup — JSONL persistence wrapper (ADR-0245).
 *
 * Wraps an `InMemoryCustom3pRegistry` and persists the snapshot to
 * `~/.quanta/connectors/custom-3p.jsonl` (or caller-injected path) on
 * every mutation.
 *
 * File-mode contract: file `0o600`, parent dir `0o700` (owner-only;
 * secret-bearing rows in `auth = "apiKey"` case can be stored
 * downstream).
 *
 * Snapshot format: one JSONL line per provider in the JSON object
 *   `{ "spec": {...}, "state": "draft" | "configured" | "healthy" | "failing" }`
 *
 * Why snapshot, not append-only: append-only would leak stale rows on
 * update/remove. Explicit write-snapshot is the honest contract.
 *
 * Single-flight in-process; no inter-process lock (caller's contract,
 * matches ADR statement).
 */

import { chmod, mkdir, readFile } from "node:fs/promises"
import { dirname } from "node:path"
import writeFileAtomic from "write-file-atomic"
import { createInMemoryCustom3pRegistry } from "./in-memory-registry"
import type { Custom3pRegistry, HealthProbe } from "./port"
import { Custom3pError, type LifecycleState, type ProviderId, type ProviderSpec } from "./types"

export interface JsonlRegistryConfig {
  /** Absolute path to the JSONL file. Parent dir is created on demand. */
  readonly path: string
  /** Shared health-probe injected into the inner in-memory registry. */
  readonly healthProbe: HealthProbe
  /** File mode for the JSONL file. Default `0o600`. Override only for tests. */
  readonly fileMode?: number
  /** Dir mode for the parent directory. Default `0o700`. Override only for tests. */
  readonly dirMode?: number
}

interface PersistedRow {
  readonly spec: ProviderSpec
  readonly state: LifecycleState
}

const isLifecycleState = (x: unknown): x is LifecycleState =>
  x === "draft" || x === "configured" || x === "healthy" || x === "failing"

const parseRow = (line: string): PersistedRow | undefined => {
  try {
    const parsed = JSON.parse(line) as unknown
    if (typeof parsed !== "object" || parsed === null) return undefined
    const row = parsed as { spec?: unknown; state?: unknown }
    if (typeof row.spec !== "object" || row.spec === null) return undefined
    if (!isLifecycleState(row.state)) return undefined
    const spec = row.spec as Partial<ProviderSpec>
    if (typeof spec.id !== "string") return undefined
    if (typeof spec.displayName !== "string") return undefined
    if (spec.kind !== "mcp" && spec.kind !== "llm") return undefined
    if (typeof spec.endpoint !== "string") return undefined
    if (spec.auth !== "oauth" && spec.auth !== "apiKey" && spec.auth !== "none") return undefined
    return { spec: spec as ProviderSpec, state: row.state }
  } catch {
    return undefined
  }
}

export const createJsonlCustom3pRegistry = (config: JsonlRegistryConfig): Custom3pRegistry => {
  const fileMode = config.fileMode ?? 0o600
  const dirMode = config.dirMode ?? 0o700

  const inner = createInMemoryCustom3pRegistry({ healthProbe: config.healthProbe })
  let loaded = false

  const ensureDir = async (): Promise<void> => {
    await mkdir(dirname(config.path), { recursive: true, mode: dirMode })
    // mkdir{recursive:true} does NOT chmod existing dirs. Force the mode
    // so we honor the contract even when the dir pre-exists.
    try {
      await chmod(dirname(config.path), dirMode)
    } catch (err) {
      throw new Custom3pError("store-write-failed", `chmod dir failed: ${dirname(config.path)}`, {
        cause: err,
      })
    }
  }

  const loadOnce = async (): Promise<void> => {
    if (loaded) return
    loaded = true
    let raw: string
    try {
      raw = await readFile(config.path, "utf-8")
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === "ENOENT") return
      throw new Custom3pError("store-write-failed", `read failed: ${config.path}`, { cause: err })
    }
    const specs: ProviderSpec[] = []
    const states = new Map<ProviderId, LifecycleState>()
    for (const line of raw.split("\n")) {
      if (line.length === 0) continue
      const row = parseRow(line)
      if (row === undefined) continue
      specs.push(row.spec)
      states.set(row.spec.id, row.state)
    }
    inner._seed(specs, states)
  }

  const persist = async (): Promise<void> => {
    await ensureDir()
    const { specs, lifecycles } = inner._snapshot()
    const lines: string[] = []
    for (const spec of specs) {
      const state = lifecycles.get(spec.id) ?? "draft"
      const row: PersistedRow = { spec, state }
      lines.push(JSON.stringify(row))
    }
    const body = lines.length === 0 ? "" : `${lines.join("\n")}\n`
    try {
      // Atomic full-file rewrite (T11 / L9 H8): `write-file-atomic` writes to
      // a temp sibling, fsyncs it, then `rename`s into place — so the
      // authoritative snapshot is either the COMPLETE old set or the COMPLETE
      // new set, never a truncated partial line after a crash mid-write. The
      // `mode` option seals the temp at `0o600` BEFORE the rename, so the
      // secret-bearing `apiKey` rows are never momentarily world-readable
      // (the prior raw `writeFile`+`chmod` left a widening window). On a
      // failed write the helper cleans up its own temp, leaving no garbage
      // sibling.
      await writeFileAtomic(config.path, body, { mode: fileMode, fsync: true })
      // `write-file-atomic` honors `mode` only on the freshly-created temp.
      // Force chmod so an EXISTING file that survived a prior wide-mode write
      // is tightened back to the contract (idempotent for the common case).
      await chmod(config.path, fileMode)
    } catch (err) {
      throw new Custom3pError("store-write-failed", `write failed: ${config.path}`, { cause: err })
    }
  }

  return {
    register: async (spec) => {
      await loadOnce()
      await inner.register(spec)
      await persist()
    },
    update: async (id, patch) => {
      await loadOnce()
      await inner.update(id, patch)
      await persist()
    },
    remove: async (id) => {
      await loadOnce()
      await inner.remove(id)
      await persist()
    },
    health: async (id) => {
      await loadOnce()
      const result = await inner.health(id)
      await persist()
      return result
    },
    list: async () => {
      await loadOnce()
      return inner.list()
    },
    lifecycle: async (id) => {
      await loadOnce()
      return inner.lifecycle(id)
    },
  }
}
