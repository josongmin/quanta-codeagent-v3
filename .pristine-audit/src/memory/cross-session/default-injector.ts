/**
 * ADR-0282 — `DefaultCrossSessionInjector`.
 *
 * Reads the injected `Stage1OutputsStore` and applies:
 *
 *   1. `list({selectedForPhase2: true, minUsage: 1})`
 *      — defense-in-depth; ADR-0281's promotion gate already enforces
 *        `minUsageCount >= 1`, but the injector enforces it too so
 *        broken-promoted entries can't slip through.
 *   2. drop entries whose `rolloutSummary` is non-string OR empty /
 *      whitespace-only (malformed entries from a future adapter).
 *   3. apply `kindFilter` if present (startsWith match on first
 *      whitespace-delimited token of `rolloutSummary`).
 *   4. sort by ascending `generatedAt` (oldest-first — deterministic
 *      and cache-stable when new entries arrive).
 *   5. greedy accumulate by UTF-8 byte length of `rolloutSummary`
 *      until the next candidate would overflow `maxBytes`; STOP
 *      (no skipping to try a smaller subsequent entry).
 *
 * Returns a frozen array. No mutation, no I/O beyond the underlying
 * sync store.
 */

import type { Stage1Entry, Stage1OutputsStore } from "../stage1-store"
import type { CrossSessionInjector } from "./port"
import type { InjectOpts } from "./types"

export interface DefaultCrossSessionInjectorOpts {
  readonly stage1Store: Stage1OutputsStore
}

export class DefaultCrossSessionInjector implements CrossSessionInjector {
  private readonly stage1Store: Stage1OutputsStore

  constructor(opts: DefaultCrossSessionInjectorOpts) {
    this.stage1Store = opts.stage1Store
  }

  selectForInject(opts: InjectOpts): readonly Stage1Entry[] {
    if (opts.maxBytes <= 0) return Object.freeze([] as Stage1Entry[])

    // Pull selected + min-usage subset. The underlying port returns
    // a frozen array — we work on a mutable copy for sort.
    const raw = this.stage1Store.list({ selectedForPhase2: true, minUsage: 1 })

    // Defensive filter — malformed entry shapes (non-string summary,
    // empty/whitespace-only) skipped silently.
    const valid = raw.filter((e) => isInjectable(e, opts.kindFilter))

    // Oldest-first by generatedAt. Stable sort isn't strictly
    // required; Array.prototype.sort is stable in modern V8.
    valid.sort((a, b) => a.generatedAt - b.generatedAt)

    // Greedy byte-cap accumulator.
    const out: Stage1Entry[] = []
    let used = 0
    for (const e of valid) {
      const bytes = utf8ByteLength(e.rolloutSummary)
      if (used + bytes > opts.maxBytes) break
      out.push(e)
      used += bytes
    }

    return Object.freeze(out)
  }
}

/** Returns whether a stage1 entry is eligible for inject. Encapsulates
 *  the malformed-shape skip + the kindFilter precedence so the host
 *  `selectForInject` stays under the biome cognitive-complexity cap. */
const isInjectable = (e: Stage1Entry, kindFilter: readonly string[] | undefined): boolean => {
  if (typeof e.rolloutSummary !== "string") return false
  if (e.rolloutSummary.trim() === "") return false
  if (kindFilter === undefined) return true
  // Empty filter array matches NOTHING (explicit hard NO).
  if (kindFilter.length === 0) return false
  return kindFilter.includes(firstToken(e.rolloutSummary))
}

// ── Local helpers ──────────────────────────────────────────────────────

/** Lazy TextEncoder — Bun + Node both ship a global, but we cache the
 *  instance so each `utf8ByteLength` call doesn't allocate. */
let _enc: TextEncoder | null = null
const utf8ByteLength = (s: string): number => {
  if (_enc === null) _enc = new TextEncoder()
  return _enc.encode(s).byteLength
}

/** First whitespace-delimited token of a string (empty when input has
 *  no non-whitespace content). Used by the kind filter. */
const firstToken = (s: string): string => {
  const m = s.match(/^\s*(\S+)/)
  return m && m[1] !== undefined ? m[1] : ""
}
