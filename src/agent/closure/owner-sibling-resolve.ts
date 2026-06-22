/**
 * WS2 — owner-sibling resolver. The deterministic feeder that fills
 * `FaultEvidenceInput.ownerResolved` (audit verdict C: previously NONE populated
 * it, so a parent/child override site never reached the candidate set and the
 * T-601 escalation gate was permanently starved).
 *
 * APPROACH — grep-based co-change (not LSP go-to-implementation). A real-pyright
 * smoke on django #14315 proved `implementation()` does NOT resolve Python method
 * overrides (pyright's go-to-implementation is abstract/protocol-centric), so the
 * LSP path was inert despite green mocks. Instead: for each top-K stage-1 owner
 * that DEFINES an issue symbol, find the OTHER files that define the SAME symbol
 * (`def <sym>` / `class <sym>`) — the sibling override sites. On #14315,
 * localizing `base/client.py` (which defines `settings_to_cmd_args_env`) surfaces
 * `postgresql/client.py` + the other backend clients that override it.
 *
 * BLIND: issue symbols + stage-1 ranking + repo SOURCE only (ripgrep over .py).
 * Never reads FAIL_TO_PASS / test_patch / grader report. BOUNDED: maxFiles ×
 * symbols, capped results. The definer lookup is injectable (`listDefiners`,
 * default = ripgrep) so the resolver is unit-testable without a working tree.
 */

import { spawnSync } from "node:child_process"

export interface OwnerSiblingArgs {
  /** Stage-1 ranked candidates (score-desc). Top `maxFiles` are probed. */
  readonly stage1Files: readonly { file: string; score: number }[]
  /** The issue/problem text. Anchors are the symbols a localized owner DEFINES
   *  that the issue actually MENTIONS (word-boundary) — so `runshell` in prose
   *  anchors even when `extractSymbols` (backtick-only) returns nothing. */
  readonly issueText: string
  /** Sandbox root — ripgrep search root + URI/path relativization. */
  readonly cwd: string
  /** Read a sandbox-relative source file; `null` when absent/unreadable. */
  readonly readSource: (relFile: string) => string | null
  readonly signal?: AbortSignal
  /** Max stage-1 files to probe (cost bound). Default 3. */
  readonly maxFiles?: number
  /** Cap on returned sibling rows (cost bound). Default 8. */
  readonly maxResults?: number
  /** DI: sandbox-relative files that DEFINE `symbol`. Default = ripgrep over the
   *  cwd. Injected by tests to run without a working tree. */
  readonly listDefiners?: (symbol: string) => readonly string[]
  /** Discrimination bound: an anchor symbol defined in MORE than this many files
   *  is treated as a ubiquitous common method (not a small override family) and is
   *  NOT expanded — including it would flood `ownerResolved` with noise at the top
   *  owner-resolve boost. NAMED + configurable on purpose (was a buried magic
   *  constant): the caller/knob owns the value and it is recorded, and crossing it
   *  fires {@link onTruncate} so the drop is VISIBLE and MEASURED, never silent.
   *  Final precision is the downstream typed static-witness layer's job (it
   *  re-derives override families from real class-inheritance), so this is a
   *  recall-side cost bound, not a correctness gate. Default
   *  {@link DEFAULT_MAX_SIBLING_DEFINERS}. */
  readonly maxSiblingDefiners?: number
  /** Telemetry: invoked once per anchor whose definer count EXCEEDS
   *  `maxSiblingDefiners`, so a truncated override family is attributable in logs
   *  instead of silently vanishing. `definerCount` is the TOTAL definers (incl.
   *  the owner); `cap` is the effective bound applied. */
  readonly onTruncate?: (event: { symbol: string; definerCount: number; cap: number }) => void
}

export interface OwnerSibling {
  readonly file: string
  readonly forSymbol: string
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * Default discrimination bound for {@link OwnerSiblingArgs.maxSiblingDefiners}.
 *
 * An anchor symbol defined in MORE than this many files is a ubiquitous common
 * method, not an override family, so we don't expand it (it would flood
 * `ownerResolved` with noise at the strongest owner-resolve boost). Real override
 * families — one method overridden across a class hierarchy — run from single
 * digits (≈6 django db-backend clients) up to a couple dozen for large plugin /
 * handler hierarchies; ubiquitous methods are far larger (`save` ~25, `get` ~38).
 * 24 admits genuine multi-site families (the previous 16 silently truncated a
 * real 17-member family to ZERO siblings — a multi-site false negative) while
 * still bounding clear floods.
 *
 * IMPORTANT: this is the DEFAULT for a NAMED, caller-overridable arg, not a buried
 * gate — when it truncates, {@link OwnerSiblingArgs.onTruncate} fires so the drop
 * is recorded. Definitive precision is the downstream typed static-witness layer
 * (`static-witness-adapter` re-derives override families from real `class X(Base)`
 * inheritance, NOT a file count), so this stays a recall-side cost bound.
 */
const DEFAULT_MAX_SIBLING_DEFINERS = 24

const DEF_RE = /^[ \t]*(?:async[ \t]+)?def[ \t]+(\w+)|^[ \t]*class[ \t]+(\w+)/gm

/**
 * Symbol names DEFINED in `source` (`def`/`async def`/`class`). Dunder names
 * (`__init__`, …) are excluded — they're ubiquitous and would over-expand.
 */
export const defsInSource = (source: string): string[] => {
  const out = new Set<string>()
  for (const m of source.matchAll(DEF_RE)) {
    const name = m[1] ?? m[2]
    if (name && !name.startsWith("__")) out.add(name)
  }
  return [...out]
}

/** Word-boundary mention (so `runshell` in prose anchors, but `env` doesn't
 *  match inside `environment`). */
const issueMentions = (issueText: string, symbol: string): boolean =>
  new RegExp(`\\b${escapeRe(symbol)}\\b`).test(issueText)

const relFromPath = (path: string, cwd: string): string => {
  const base = cwd.endsWith("/") ? cwd : `${cwd}/`
  return path.startsWith(base) ? path.slice(base.length) : path
}

/** Default definer lookup: ripgrep `def <sym>` / `class <sym>` over .py files. */
const ripgrepDefiners =
  (cwd: string, signal?: AbortSignal) =>
  (symbol: string): readonly string[] => {
    const sym = escapeRe(symbol)
    const pattern = `^\\s*(async\\s+)?def\\s+${sym}\\b|^\\s*class\\s+${sym}\\b`
    const res = spawnSync(
      "rg",
      ["-l", "--no-messages", "--type", "py", pattern, cwd],
      // status 1 = no match (fine). A timeout/spawn error returns [] (lossy but
      // acceptable: rg over a django tree is ~0.3s, far under the 8s cap).
      // `signal` lets the setup-window abort interrupt a blocking rg.
      { encoding: "utf8", timeout: 8_000, ...(signal !== undefined ? { signal } : {}) },
    )
    if (res.error || typeof res.stdout !== "string") return []
    return res.stdout
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((p) => relFromPath(p, cwd))
      .sort() // `rg -l` order is NONdeterministic (parallel traversal) — sort for
    // reproducible truncation/results run-to-run.
  }

/**
 * Resolve owner siblings for the closure session: the other files that define a
 * symbol the localized owner also defines (override co-change sites).
 */
export const resolveOwnerSiblings =
  () =>
  async (args: OwnerSiblingArgs): Promise<OwnerSibling[]> => {
    const maxFiles = args.maxFiles ?? 3
    const maxResults = args.maxResults ?? 8
    const maxSiblingDefiners = args.maxSiblingDefiners ?? DEFAULT_MAX_SIBLING_DEFINERS
    const definers = args.listDefiners ?? ripgrepDefiners(args.cwd, args.signal)
    const out: OwnerSibling[] = []
    const seen = new Set<string>()

    const stage1Top = args.stage1Files.slice(0, maxFiles)
    // Dedup against the FULL stage-1 list (not just the probed top-K): a sibling
    // that is itself a lower-ranked localized candidate must not be re-added (it
    // would double-count its stage-1 score AND the owner-resolve boost).
    const stage1Set = new Set(args.stage1Files.map((f) => f.file))

    // Collect one bucket of sibling candidates per (owner, anchor) — each bucket
    // sorted+deduped (deterministic). Then round-robin across buckets so one noisy
    // anchor can't starve the others, bounded by maxResults.
    const buckets: OwnerSibling[][] = []
    for (const sf of stage1Top) {
      if (args.signal?.aborted === true) break
      const source = args.readSource(sf.file)
      if (source === null) continue
      // Anchors = symbols this owner DEFINES that the issue text MENTIONS. Both
      // conditions matter: "defines" keeps it to the owner's surface, "mentions"
      // keeps it to what the bug is actually about (no over-expansion on every
      // method). This is why `extractSymbols` (backtick-only) being empty on
      // #14315 doesn't matter — `runshell` is in the prose and defined in base.
      const anchors = defsInSource(source).filter((sym) => issueMentions(args.issueText, sym))
      for (const sym of anchors) {
        const defs = [...new Set(definers(sym))].sort()
        // A symbol defined in MORE than `maxSiblingDefiners` files is
        // NON-DISCRIMINATING — a ubiquitous method (`save` ~25 django files,
        // `get` ~38), not an override family. Including it would flood
        // ownerResolved with noise at the top owner-resolve boost (+3, strongest),
        // outranking the real owner. This is an anchor-DISCRIMINATION (recall-side
        // cost) bound, distinct from `maxResults` (output size). It is a NAMED arg
        // (not a buried constant), and when it truncates we EMIT telemetry so a
        // dropped override family is attributable instead of silently vanishing.
        if (defs.length > maxSiblingDefiners) {
          args.onTruncate?.({ symbol: sym, definerCount: defs.length, cap: maxSiblingDefiners })
          continue
        }
        const bucket = defs
          // sibling only: not the owner itself, not an already-localized file.
          .filter((file) => file !== "" && file !== sf.file && !stage1Set.has(file))
          .map((file) => ({ file, forSymbol: sym }))
        if (bucket.length > 0) buckets.push(bucket)
      }
    }

    // Round-robin drain across buckets; dedup by file; bound by maxResults.
    let idx = 0
    while (out.length < maxResults && buckets.some((b) => b.length > 0)) {
      const bucket = buckets[idx % buckets.length]
      idx++
      const item = bucket?.shift()
      if (item === undefined || seen.has(item.file)) continue
      seen.add(item.file)
      out.push(item)
    }
    return out
  }
