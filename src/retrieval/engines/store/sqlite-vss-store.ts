/**
 * SQLite VectorStore adapter — ADR-0261.
 *
 * Uses `bun:sqlite` (already a peer dep via src/memory/consolidate/store.ts).
 * Vectors are stored as Float32 little-endian BLOBs. Cosine is computed in
 * TypeScript on read (the VSS extension is NOT assumed to be loaded).
 *
 * Schema:
 *   CREATE TABLE IF NOT EXISTS vss_docs (
 *     id        TEXT PRIMARY KEY,
 *     vector    BLOB NOT NULL,
 *     metadata  TEXT             -- JSON of Record<string, string|number|boolean>
 *   ) WITHOUT ROWID;
 *
 * The `Database` instance is **injected** so tests can use `:memory:` and
 * production code can pass a file-backed handle.
 */
import { err, ok, type Result } from "@/shared"
import { makeHit, matchesFilter } from "./_filter"
import type { VectorStore } from "./port"
import type { Filter, StoreCapabilities, StoredDoc, StoredHit, StoreError } from "./types"

const DEFAULT_MAX_DIM = 4096

export interface SqliteDb {
  exec(sql: string): void
  query<R = unknown>(
    sql: string,
  ): {
    all(...params: unknown[]): R[]
    get(...params: unknown[]): R | null
    run(...params: unknown[]): { changes: number }
  }
}

export interface SqliteVssStoreOptions {
  readonly db: SqliteDb
  readonly tableName?: string
  readonly dim?: number
  readonly maxDim?: number
}

const serialize = (v: readonly number[]): Uint8Array => {
  const f = new Float32Array(v.length)
  for (let i = 0; i < v.length; i += 1) f[i] = v[i] as number
  return new Uint8Array(f.buffer, f.byteOffset, f.byteLength)
}

const deserialize = (b: Uint8Array): number[] => {
  const aligned = b.byteOffset % 4 === 0 ? b : new Uint8Array(b)
  const f = new Float32Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 4)
  return Array.from(f)
}

const cosine = (a: readonly number[], b: readonly number[]): number => {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] as number
    const y = b[i] as number
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) return 0
  const c = dot / (Math.sqrt(na) * Math.sqrt(nb))
  return Number.isFinite(c) ? c : 0
}

const parseMeta = (
  raw: string | null,
): Readonly<Record<string, string | number | boolean>> | undefined => {
  if (raw === null || raw === "") return undefined
  try {
    return JSON.parse(raw) as Readonly<Record<string, string | number | boolean>>
  } catch {
    return undefined
  }
}

export const createSqliteVssStore = (opts: SqliteVssStoreOptions): VectorStore => {
  const table = opts.tableName ?? "vss_docs"
  const maxDim = opts.maxDim ?? DEFAULT_MAX_DIM
  let dim: number | undefined = opts.dim

  opts.db.exec(
    `CREATE TABLE IF NOT EXISTS ${table} (
       id TEXT PRIMARY KEY,
       vector BLOB NOT NULL,
       metadata TEXT
     ) WITHOUT ROWID`,
  )

  const checkDim = (v: readonly number[]): StoreError | null => {
    if (dim === undefined) {
      if (v.length === 0 || v.length > maxDim) {
        return { kind: "dim-mismatch", expected: maxDim, got: v.length }
      }
      dim = v.length
      return null
    }
    if (v.length !== dim) return { kind: "dim-mismatch", expected: dim, got: v.length }
    return null
  }

  return {
    async upsert(input: readonly StoredDoc[]): Promise<Result<void, StoreError>> {
      for (const d of input) {
        const e = checkDim(d.vector)
        if (e !== null) return err(e)
      }
      const stmt = opts.db.query(
        `INSERT INTO ${table} (id, vector, metadata) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET vector = excluded.vector, metadata = excluded.metadata`,
      )
      for (const d of input) {
        const blob = serialize(d.vector)
        const meta = d.metadata === undefined ? null : JSON.stringify(d.metadata)
        stmt.run(d.id, blob, meta)
      }
      return ok(undefined)
    },
    async query(
      vec: readonly number[],
      k: number,
      filter?: Filter,
    ): Promise<Result<readonly StoredHit[], StoreError>> {
      if (dim !== undefined && vec.length !== dim) {
        return err({ kind: "dim-mismatch", expected: dim, got: vec.length })
      }
      if (k <= 0) return ok([])
      type Row = { id: string; vector: Uint8Array; metadata: string | null }
      const rows = opts.db.query<Row>(`SELECT id, vector, metadata FROM ${table}`).all()
      const out: StoredHit[] = []
      for (const r of rows) {
        const meta = parseMeta(r.metadata)
        if (!matchesFilter(meta, filter)) continue
        const stored = deserialize(r.vector)
        if (stored.length !== vec.length) continue
        out.push(makeHit(r.id, cosine(vec, stored), meta))
      }
      out.sort((a, b) => b.score - a.score)
      return ok(out.slice(0, k))
    },
    async delete(ids: readonly string[]): Promise<Result<void, StoreError>> {
      const stmtSel = opts.db.query<{ id: string }>(`SELECT id FROM ${table} WHERE id = ?`)
      for (const id of ids) {
        if (stmtSel.get(id) === null) return err({ kind: "not-found", id })
      }
      const stmtDel = opts.db.query(`DELETE FROM ${table} WHERE id = ?`)
      for (const id of ids) stmtDel.run(id)
      return ok(undefined)
    },
    capabilities(): StoreCapabilities {
      return { distMetric: "cosine", maxDim, persistent: true }
    },
  }
}
