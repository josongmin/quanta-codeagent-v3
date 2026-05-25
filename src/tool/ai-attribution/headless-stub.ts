/** ADR-0257 — deterministic headless stub for the AI-attribution search port.
 *
 *  Produces a fixed set of `AttributionMatch`es derived purely from a hash of
 *  the input snippet. NO network, NO randomness, NO time. Same snippet ⇒ same
 *  matches (HELL-AA-07). The stub also exercises every {@link License} arm
 *  (HELL-AA-08), produces both URL-present and URL-absent rows (HELL-AA-11),
 *  and respects `minSimilarity` / `maxResults` / `signal` (HELL-AA-04, -05,
 *  -14) through the same wrapper a real adapter would use.
 *
 *  Default-OFF byte-identical: nothing in `src/` constructs this stub by
 *  default — only the tool builder (caller-wired) and the hellgate test do.
 *
 *  Plane-clean: imports only `@/shared` + `./port` + `./types`. */

import { err, ok, type Result } from "@/shared"
import type { AIAttributionSearch, SearchPortOpts } from "./port"
import {
  type AttributionMatch,
  LICENSES,
  type License,
  type SearchError,
  SNIPPET_MAX_BYTES,
} from "./types"

/** FNV-1a 32-bit hash. Deterministic, fast, dependency-free. Used purely to
 *  seed the stub's deterministic match generation — NOT a cryptographic hash. */
const fnv1a = (s: string): number => {
  let h = 0x811c9dc5 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** Fixed 5 base matches — one per `License` arm. The base `similarity` is a
 *  decreasing ladder so the post-sort order is stable and the rendered output
 *  is byte-identical for the same snippet. */
interface BaseRow {
  readonly licenseIdx: number // index into LICENSES
  readonly baseSimilarity: number
  readonly sourceName: string
  readonly hasUrl: boolean
}

const BASE_ROWS: ReadonlyArray<BaseRow> = [
  { licenseIdx: 0, baseSimilarity: 0.95, sourceName: "github.com/example/mit-lib", hasUrl: true },
  {
    licenseIdx: 1,
    baseSimilarity: 0.82,
    sourceName: "github.com/example/apache-lib",
    hasUrl: true,
  },
  { licenseIdx: 2, baseSimilarity: 0.71, sourceName: "github.com/example/gpl-lib", hasUrl: true },
  {
    licenseIdx: 3,
    baseSimilarity: 0.55,
    sourceName: "internal-corpus/proprietary-snippet-A",
    hasUrl: false,
  },
  {
    licenseIdx: 4,
    baseSimilarity: 0.32,
    sourceName: "unattributed-corpus/blob-7f3a",
    hasUrl: false,
  },
]

/** Derive a per-snippet jitter in `[-0.03, +0.03]` from the hash so successive
 *  snippets produce slightly different scores while still respecting the
 *  similarity ladder (no two base rows can swap order). Bounded jitter avoids
 *  the score-clipping a larger range would force at the 0/1 edges. */
const jitter = (hash: number, idx: number): number => {
  const k = (hash >>> (idx * 3)) & 0x3f // 6 bits → [0, 63]
  return (k - 32) / 1000 // → [-0.032, 0.031]
}

/** Build the deterministic match list for `snippet`. Pure helper. */
const buildMatches = (snippet: string): AttributionMatch[] => {
  const h = fnv1a(snippet)
  const out: AttributionMatch[] = []
  for (let i = 0; i < BASE_ROWS.length; i++) {
    const row = BASE_ROWS[i]
    if (row === undefined) continue
    const license = LICENSES[row.licenseIdx] as License
    const raw = row.baseSimilarity + jitter(h, i)
    // Clamp into [0, 1]. The jitter is small enough that this rarely fires
    // but defensive — the port-side validator rejects out-of-range.
    const similarity = Math.max(0, Math.min(1, raw))
    // Suffix the source with the hash so the same snippet → same source,
    // different snippets → different source strings.
    const sourceSuffix = h.toString(16).padStart(8, "0")
    const source = `${row.sourceName}@${sourceSuffix}`
    const base = { source, license, similarity }
    out.push(row.hasUrl ? { ...base, url: `https://${source}` } : base)
  }
  return out
}

/** Byte-length the same way the tool input validator does (UTF-8 encoded). */
const byteLength = (s: string): number => new TextEncoder().encode(s).length

/** Build the deterministic adapter. The optional `failOnSnippet` factory option
 *  lets the hellgate exercise the `search-failed` arm without monkey-patching. */
export interface HeadlessStubOptions {
  /** When set and the snippet matches, the adapter returns
   *  `{ kind:"search-failed", cause }`. */
  readonly failOnSnippet?: { match: string; cause: string }
}

/** Factory — returns a {@link AIAttributionSearch} backed by the deterministic
 *  match generator above. The wrapper enforces the byte cap, empty-snippet
 *  guard, abort signal, and `minSimilarity` / `maxResults` filters identically
 *  to what a real adapter would have to do. */
export const headlessStub = (opts: HeadlessStubOptions = {}): AIAttributionSearch => ({
  async search(
    snippet: string,
    callOpts?: SearchPortOpts,
  ): Promise<Result<AttributionMatch[], SearchError>> {
    if (callOpts?.signal?.aborted === true) return err({ kind: "aborted" } satisfies SearchError)
    if (snippet.length === 0) return err({ kind: "empty-snippet" } satisfies SearchError)
    const sizeBytes = byteLength(snippet)
    if (sizeBytes > SNIPPET_MAX_BYTES) {
      return err({
        kind: "snippet-too-large",
        sizeBytes,
        maxBytes: SNIPPET_MAX_BYTES,
      } satisfies SearchError)
    }
    if (opts.failOnSnippet !== undefined && snippet === opts.failOnSnippet.match) {
      return err({
        kind: "search-failed",
        cause: opts.failOnSnippet.cause,
      } satisfies SearchError)
    }
    const matches = applyFilters(buildMatches(snippet), callOpts)
    return ok(matches)
  },
})

/** Apply `minSimilarity` (filter) + sort-desc + `maxResults` (cap). Sort key is
 *  `(similarity desc, source asc)` so equal-similarity rows are byte-stable. */
export const applyFilters = (
  matches: ReadonlyArray<AttributionMatch>,
  opts?: SearchPortOpts,
): AttributionMatch[] => {
  const min = opts?.minSimilarity ?? 0
  const filtered = matches.filter(
    (m) => m.similarity >= min && m.similarity >= 0 && m.similarity <= 1,
  )
  filtered.sort((a, b) =>
    b.similarity !== a.similarity ? b.similarity - a.similarity : a.source < b.source ? -1 : 1,
  )
  const cap = opts?.maxResults
  if (cap !== undefined && cap > 0 && filtered.length > cap) return filtered.slice(0, cap)
  return filtered
}
