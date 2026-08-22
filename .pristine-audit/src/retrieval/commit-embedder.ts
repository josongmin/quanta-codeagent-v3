/**
 * Commit-embedder — pull recent git commit notes and embed them so a query
 * like "why did we revert X" can recall the deciding commit by semantic
 * similarity to its message body, not just by author / date / sha.
 *
 * Architecture: closed ports.
 *   - {@link GitLogPort}: how to read commits (production: spawn `git log`;
 *     tests: hand-built array). The slice does NOT shell out itself.
 *   - {@link EmbeddingPort}: how to embed text. Reuses Axis D's generic port
 *     so the embedder vendor is the caller's choice (openai/voyage/...).
 *
 * Cache: in-process LRU keyed by `sha`. The same commit is never
 * re-embedded across queries within the same process. Deterministic
 * eviction (oldest insertion drops first).
 */
import type { EmbeddingPort } from "./embedding-port"

/** A git commit summary the embedder ingests. */
export interface CommitNote {
  readonly sha: string
  /** ISO 8601 author date, UTC. */
  readonly authorISO: string
  /** First line of the commit message. */
  readonly subject: string
  /** Remainder of the commit message (may be empty). */
  readonly body: string
}

/** A {@link CommitNote} paired with its embedding vector. */
export interface CommitNoteWithEmbedding extends CommitNote {
  readonly embedding: readonly number[]
}

/** Closed port — caller decides HOW to walk git history. */
export interface GitLogPort {
  log(opts: { limit: number; cwd: string }): Promise<readonly CommitNote[]>
}

export interface CommitEmbedderOptions {
  git: GitLogPort
  embed: EmbeddingPort
  /** Max entries to keep in the in-process LRU. Default 1024. */
  cacheMax?: number
}

/** Format a commit for embedding: `subject \n\n body` — same shape across
 *  invocations so the same sha always produces the same embedding given a
 *  deterministic embedder. */
const formatForEmbed = (n: CommitNote): string =>
  n.body.length === 0 ? n.subject : `${n.subject}\n\n${n.body}`

/** Simple insertion-order LRU. */
class CommitCache {
  private readonly map = new Map<string, readonly number[]>()
  constructor(private readonly max: number) {}

  get(sha: string): readonly number[] | undefined {
    const v = this.map.get(sha)
    if (v === undefined) return undefined
    // Touch — re-insert so it becomes "most recent".
    this.map.delete(sha)
    this.map.set(sha, v)
    return v
  }

  set(sha: string, v: readonly number[]): void {
    if (this.map.has(sha)) {
      this.map.delete(sha)
    }
    this.map.set(sha, v)
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.map.delete(oldest)
    }
  }

  size(): number {
    return this.map.size
  }
}

export interface CommitEmbedder {
  /** Embed recent commits — uses cache for any sha we've seen before. */
  recent(opts: {
    limit: number
    cwd: string
    signal?: AbortSignal
  }): Promise<readonly CommitNoteWithEmbedding[]>
  /** Current LRU size — observability. */
  cacheSize(): number
}

const DEFAULT_CACHE_MAX = 1024

/** Split commits into "have cached vector" (out) and "need to embed" (need). */
const splitByCache = (
  commits: readonly CommitNote[],
  cache: CommitCache,
): {
  out: (CommitNoteWithEmbedding | null)[]
  need: { idx: number; text: string }[]
} => {
  const out: (CommitNoteWithEmbedding | null)[] = []
  const need: { idx: number; text: string }[] = []
  for (let i = 0; i < commits.length; i++) {
    const c = commits[i]
    if (c === undefined) {
      out.push(null)
      continue
    }
    const hit = cache.get(c.sha)
    if (hit) {
      out.push({ ...c, embedding: hit })
    } else {
      out.push(null)
      need.push({ idx: i, text: formatForEmbed(c) })
    }
  }
  return { out, need }
}

/** Fold freshly-computed vectors back into `out` + the LRU cache. */
const writeBack = (
  need: readonly { idx: number; text: string }[],
  fresh: readonly (readonly number[])[],
  commits: readonly CommitNote[],
  out: (CommitNoteWithEmbedding | null)[],
  cache: CommitCache,
): void => {
  for (let j = 0; j < need.length; j++) {
    const slot = need[j]
    if (slot === undefined) continue
    const c = commits[slot.idx]
    if (c === undefined) continue
    const vec = fresh[j] ?? []
    cache.set(c.sha, vec)
    out[slot.idx] = { ...c, embedding: vec }
  }
}

export const createCommitEmbedder = (opts: CommitEmbedderOptions): CommitEmbedder => {
  const cache = new CommitCache(opts.cacheMax ?? DEFAULT_CACHE_MAX)
  return {
    async recent({ limit, cwd, signal }): Promise<readonly CommitNoteWithEmbedding[]> {
      const commits = await opts.git.log({ limit, cwd })
      if (commits.length === 0) return []
      const { out, need } = splitByCache(commits, cache)
      if (need.length > 0) {
        const fresh = await opts.embed.embed(
          need.map((n) => n.text),
          signal === undefined ? undefined : { signal },
        )
        writeBack(need, fresh, commits, out, cache)
      }
      const final: CommitNoteWithEmbedding[] = []
      for (const o of out) if (o !== null) final.push(o)
      return final
    },
    cacheSize(): number {
      return cache.size()
    },
  }
}
