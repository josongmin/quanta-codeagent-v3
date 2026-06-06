/**
 * file_history_rewind — per-file session snapshot store (Claude
 * `tengu_file_history_rewind_*` parity).
 *
 * Distinct from the workspace-wide shadow-ODB (`@/storage/shadow-odb`): that
 * primitive restores named paths from ONE anchor (`last-registered` /
 * `verified`). This store keeps a PER-FILE timeline — every `write`/`edit`
 * during the session records the file's NEW bytes as a fresh version, so the
 * agent can list the versions for a single path and restore any one of them.
 *
 * Slice posture (RFC §3.1): PURE leaf. Imports nothing but the standard lib —
 * no clock / RNG inside (the host injects `now()` so the core is
 * byte-deterministically testable; no `Date.now()` / `Math.random()` here).
 * NO-THROW: every method returns a value, never throws.
 *
 * BOUNDED (the pty/dedup-cap lesson) — on BOTH axes:
 *   - PER PATH: each path holds AT MOST `maxVersionsPerPath` versions AND
 *     `maxBytesPerPath` total bytes. On overflow the OLDEST version is evicted
 *     (ring), so a long session with thousands of writes to one file can never
 *     grow without bound.
 *   - ACROSS PATHS: the path map itself holds AT MOST `maxPaths` distinct paths.
 *     A session that writes/edits thousands of DISTINCT files (a big refactor, a
 *     codegen run, a `find … -exec edit`) evicts the LEAST-RECENTLY-RECORDED
 *     path whole when the cap trips — the per-path ring alone would NOT bound
 *     this (it caps each path, not the count of paths), so without this the map
 *     would grow unbounded (one `PathHistory` per file, holding its latest bytes
 *     forever). `record` is a TOUCH: recording bumps the path to most-recent, so
 *     the actively-edited files survive and a one-off write is the first evicted.
 *
 * DEFAULT-OFF: nothing constructs a store unless the host opts in
 * (`QUANTA_FILE_HISTORY`); an unset deployment never instantiates it, the
 * capture sink is absent (no recording) and the tool is not registered ⇒
 * byte-identical.
 */

/** One recorded version of a file's bytes. `version` is a per-path monotonic
 *  ordinal (1-indexed, never reused even after eviction) so the agent can name
 *  an exact prior state; `byteLength` is the UTF-8 size cached for the byte cap
 *  + the list view. */
export interface FileVersion {
  /** Per-path monotonic version ordinal (1-indexed). Never reused. */
  readonly version: number
  /** The file's full bytes AT this version (the content the write/edit set). */
  readonly content: string
  /** Injected-clock timestamp (ms) when the version was recorded. */
  readonly recordedAt: number
  /** UTF-8 byte length of `content` (cached; backs the byte cap + list view). */
  readonly byteLength: number
}

/** Bounds — the first two enforced per path (whichever trips first evicts the
 *  oldest version); `maxPaths` bounds the path MAP itself (LRU by record). */
export interface FileHistoryBounds {
  /** Max versions retained per path. Must be >= 1. */
  readonly maxVersionsPerPath: number
  /** Max total bytes retained per path (sum of version byteLengths). A single
   *  version larger than this is still kept (we never drop the only copy) but
   *  it evicts every older sibling. Must be >= 1. */
  readonly maxBytesPerPath: number
  /** Max number of DISTINCT paths retained. When recording a NEW path would
   *  exceed this, the LEAST-RECENTLY-RECORDED path is evicted whole (its entire
   *  timeline). Bounds total memory across files — without it the path map grows
   *  one entry per distinct file forever. Must be >= 1. OPTIONAL for source
   *  compatibility with bounds literals written before this field existed —
   *  absent ⇒ the store falls back to {@link DEFAULT_FILE_HISTORY_BOUNDS.maxPaths}
   *  (NEVER unbounded). */
  readonly maxPaths?: number
}

/** Default across-path cap (distinct files). Non-optional constant so the store
 *  has a guaranteed-`number` fallback even when a bounds literal omits
 *  `maxPaths`. */
export const DEFAULT_MAX_PATHS = 512

/** Default bounds — small enough that an idle session reclaims, large enough to
 *  hold a realistic edit chain on a source file. Overridable via the knob's
 *  optional suffix parse (see runtime-config). */
export const DEFAULT_FILE_HISTORY_BOUNDS: FileHistoryBounds = {
  maxVersionsPerPath: 20,
  // 4 MiB per path — a few dozen revisions of a large file, hundreds of a
  // normal source file.
  maxBytesPerPath: 4 * 1024 * 1024,
  // 512 distinct files — covers an active session's working set; a big refactor
  // or codegen run that touches more than this evicts the least-recently-touched
  // file's timeline rather than growing the map without bound.
  maxPaths: DEFAULT_MAX_PATHS,
}

/** The store port. Pure in-memory default below. NO-THROW. The capture sink
 *  (write/edit) calls `record`; the `file_history_rewind` tool calls
 *  `list` / `get`. Both share ONE per-session instance. */
export interface FileHistoryStore {
  /** Record `content` as a NEW version for `key` (a normalized absolute path).
   *  Mints + returns the version. Evicts oldest siblings to honour the bounds.
   *  Recording the SAME bytes as the current head is still a no-op-free new
   *  version — the caller (write/edit) only records on a real mutation, and a
   *  redundant identical version is harmless + bounded. */
  record(key: string, content: string): FileVersion
  /** Versions for `key`, OLDEST-first (ascending `version`). Empty when the
   *  path has no history. Immutable snapshot. */
  list(key: string): readonly FileVersion[]
  /** The version with ordinal `version` for `key`, or undefined when absent
   *  (unknown path, or that ordinal was evicted / never existed). */
  get(key: string, version: number): FileVersion | undefined
  /** All keys that have at least one version, in LRU-touch order (oldest-
   *  recorded first, most-recently-recorded last — a `record` moves its path to
   *  the end). */
  keys(): readonly string[]
}

export interface FileHistoryStoreOptions {
  /** Injected clock — the ONLY time source (no `Date.now()` in the core). */
  readonly now: () => number
  /** Per-path bounds. Defaults to {@link DEFAULT_FILE_HISTORY_BOUNDS}. */
  readonly bounds?: FileHistoryBounds
}

interface PathHistory {
  /** Oldest-first ring of retained versions. */
  versions: FileVersion[]
  /** Monotonic version counter — NEVER decremented, so an ordinal is stable
   *  even after the version it named was evicted (`get` then returns
   *  undefined, never a different file's bytes). */
  nextVersion: number
}

/**
 * In-memory {@link FileHistoryStore}. One instance per session. A `Map` keyed
 * by normalized absolute path; iteration (and `keys()`) is insertion-ordered.
 */
export const createFileHistoryStore = (opts: FileHistoryStoreOptions): FileHistoryStore => {
  const bounds = opts.bounds ?? DEFAULT_FILE_HISTORY_BOUNDS
  // Defensive lower clamp — a host that fat-fingers a 0/negative cap must not
  // produce an always-empty (or infinite-loop) ring. Pure, no throw.
  const maxVersions = Math.max(1, Math.floor(bounds.maxVersionsPerPath))
  const maxBytes = Math.max(1, Math.floor(bounds.maxBytesPerPath))
  // `maxPaths` may be absent on a host that constructed a bounds literal before
  // the field existed — fall back to the default so an older caller still gets
  // the across-path bound (a missing/0/negative cap must not mean "unbounded").
  const rawMaxPaths = bounds.maxPaths
  const maxPaths = Math.max(
    1,
    Math.floor(
      rawMaxPaths !== undefined && Number.isFinite(rawMaxPaths) ? rawMaxPaths : DEFAULT_MAX_PATHS,
    ),
  )
  // Insertion-ordered: the FIRST key is the least-recently-recorded (LRU). A
  // `record` deletes+re-inserts its key so an active path moves to the back;
  // eviction drops from the front.
  const store = new Map<string, PathHistory>()

  /** Evict oldest versions until BOTH caps hold. Always keeps >= 1 version
   *  (we never drop the only copy — even an over-cap single version is kept so
   *  a restore target always exists). */
  const enforceBounds = (hist: PathHistory): void => {
    while (hist.versions.length > maxVersions) {
      hist.versions.shift()
    }
    let total = hist.versions.reduce((sum, v) => sum + v.byteLength, 0)
    while (hist.versions.length > 1 && total > maxBytes) {
      const evicted = hist.versions.shift()
      if (evicted !== undefined) total -= evicted.byteLength
    }
  }

  return {
    record(key, content) {
      let hist = store.get(key)
      if (hist === undefined) {
        hist = { versions: [], nextVersion: 1 }
      } else {
        // Touch: re-insert so this path moves to the MRU end (delete+set, since a
        // Map.set on an existing key does NOT change iteration order).
        store.delete(key)
      }
      store.set(key, hist)
      // Across-path LRU: evicting AFTER the set keeps the just-recorded path even
      // if it is brand-new (it is now at the MRU end; the front is dropped).
      while (store.size > maxPaths) {
        const oldest = store.keys().next().value
        if (oldest === undefined || oldest === key) break
        store.delete(oldest)
      }
      const version: FileVersion = {
        version: hist.nextVersion,
        content,
        recordedAt: opts.now(),
        byteLength: Buffer.byteLength(content, "utf8"),
      }
      hist.nextVersion += 1
      hist.versions.push(version)
      enforceBounds(hist)
      return version
    },
    list(key) {
      const hist = store.get(key)
      if (hist === undefined) return []
      return [...hist.versions]
    },
    get(key, version) {
      const hist = store.get(key)
      if (hist === undefined) return undefined
      return hist.versions.find((v) => v.version === version)
    },
    keys() {
      return [...store.keys()]
    },
  }
}
