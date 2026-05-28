/**
 * ADR-0418 — Code-symbol mention resolver (`@FooBar`).
 *
 * Two underlying lookup strategies, both INJECTED as closed ports so the
 * mention slice stays decoupled from the concrete `@/agent/lsp-bridge`
 * and `@/runner/assemble/search-index-backend` engines (the slice-fence
 * allows those imports at the wire layer, but the resolver core only
 * depends on the narrow port shape):
 *
 *   - `SymbolLookupLspPort.findSymbol(name)` — LSP workspace-symbol query
 *     (wire over `lsp-bridge`).
 *   - `SymbolLookupSemanticPort.findSymbol(name)` — fallback semantic
 *     search (wire over `search-index-backend`). Used when LSP is
 *     unavailable / misses.
 *
 * Priority knob `priority` (default `auto`) picks the strategy:
 *
 *   - `auto`     — LSP first; on miss / throw / timeout fall back to
 *                  semantic. Final miss ⇒ `null`.
 *   - `lsp`      — LSP only. Miss / unavailable ⇒ `null`.
 *   - `semantic` — semantic only. Miss / unavailable ⇒ `null`.
 *
 * Timeout knob `timeoutMs` (default 5000) is applied PER STRATEGY (not
 * shared) — a hung LSP does not eat the semantic budget.
 *
 * NO-THROW: any port throw / reject / timeout returns `null` from that
 * strategy. The composite still answers `null` if no strategy succeeded.
 * `QUANTA_MENTION_SYMBOL_RESOLVER` / `QUANTA_MENTION_SYMBOL_TIMEOUT_MS`
 * map onto `priority` / `timeoutMs` at the wire.
 */

import type { MentionResolverResult } from "./resolver"

/** A single symbol match — minimal envelope so adapters (LSP, semantic
 *  search) can both project into it. */
export interface SymbolHit {
  /** File path, repo-relative or absolute (caller / renderer choice). */
  readonly path: string
  /** 1-indexed line number. */
  readonly line: number
  /** Optional snippet (signature / surrounding line). */
  readonly snippet?: string
}

/** LSP-backed lookup port. NO-THROW invariant: implementations SHOULD
 *  catch and return `null` / `[]`; the resolver also guards. */
export interface SymbolLookupLspPort {
  findSymbol(name: string): Promise<readonly SymbolHit[] | null>
}

/** Semantic-search-backed lookup port. Same NO-THROW contract. */
export interface SymbolLookupSemanticPort {
  findSymbol(name: string): Promise<readonly SymbolHit[] | null>
}

/** Resolver priority knob. */
export type SymbolResolverPriority = "auto" | "lsp" | "semantic"

/** Factory configuration. All knobs optional. */
export interface SymbolResolverConfig {
  /** LSP lookup port. Omit ⇒ LSP strategy is disabled. */
  readonly lsp?: SymbolLookupLspPort
  /** Semantic lookup port. Omit ⇒ semantic strategy is disabled. */
  readonly semantic?: SymbolLookupSemanticPort
  /** Strategy selector. Default `auto`. */
  readonly priority?: SymbolResolverPriority
  /** Per-strategy timeout in ms. Default 5000. `<= 0` ⇒ default. */
  readonly timeoutMs?: number
  /** Cap on the number of hits embedded in the body. Default 5. */
  readonly maxHits?: number
}

/** Per-strategy wall-clock cap. LSP `workspaceSymbol` and the vector probe
 *  both typically resolve well under a second; 5s leaves headroom for a
 *  cold-start language server + a GC pause without dragging the turn. Tune
 *  via the `timeoutMs` config field or the `QUANTA_MENTION_SYMBOL_TIMEOUT_MS`
 *  env knob — not a heuristic threshold, a wall-clock ceiling. */
const DEFAULT_TIMEOUT_MS = 5_000
/** Cap on hits RENDERED into the prompt body. DISTINCT from the upstream
 *  lookup caps (`symbol-lookup-lsp.DEFAULT_MAX_HITS` = LSP projection slice;
 *  `symbol-lookup-semantic.DEFAULT_TOP_K` = index probe size). Five keeps the
 *  injected context terse; tune via the `maxHits` config field. The two-layer
 *  cap design (upstream wide → renderer tight) is intentional, not the
 *  audit-flagged "DEFAULT_MAX_HITS inconsistency". */
const DEFAULT_MAX_HITS = 5

/** Wrap a promise in a timeout. Resolves to `null` on timeout (NO-THROW).
 *  The internal `AbortSignal` lets the caller cancel a still-pending
 *  timer once the race is decided. */
const withTimeout = async <T>(
  p: Promise<T>,
  ms: number,
  signal: AbortSignal,
): Promise<T | null> => {
  if (ms <= 0) return null
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutP = new Promise<null>((resolve) => {
    const onAbort = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      resolve(null)
    }
    if (signal.aborted) return resolve(null)
    signal.addEventListener("abort", onAbort, { once: true })
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve(null)
    }, ms)
  })
  try {
    const winner = await Promise.race([p, timeoutP])
    if (timer !== undefined) clearTimeout(timer)
    return winner
  } catch {
    if (timer !== undefined) clearTimeout(timer)
    return null
  }
}

/** Render a hit list into the bodyText. Empty ⇒ "". */
const renderBody = (target: string, hits: readonly SymbolHit[], maxHits: number): string => {
  if (hits.length === 0) return ""
  const limited = hits.slice(0, maxHits)
  const lines: string[] = [`symbol: ${target}`, `hits: ${hits.length}`, "---"]
  for (const h of limited) {
    const snip = typeof h.snippet === "string" && h.snippet.length > 0 ? h.snippet : ""
    lines.push(snip.length > 0 ? `${h.path}:${h.line}\n${snip}` : `${h.path}:${h.line}`)
  }
  if (hits.length > limited.length) {
    lines.push(`…and ${hits.length - limited.length} more`)
  }
  return lines.join("\n")
}

/** Safe-invoke a port; map throw / reject / timeout to `null`. */
const safeLookup = async (
  port: { findSymbol(name: string): Promise<readonly SymbolHit[] | null> } | undefined,
  target: string,
  timeoutMs: number,
): Promise<readonly SymbolHit[] | null> => {
  if (port === undefined) return null
  const ac = new AbortController()
  try {
    // Wrap the call itself in `Promise.resolve().then(...)` so a port that
    // throws SYNCHRONOUSLY (before returning a promise) is still caught.
    const inner = Promise.resolve().then(() => port.findSymbol(target))
    const hits = await withTimeout(inner, timeoutMs, ac.signal)
    if (hits === null || !Array.isArray(hits)) return null
    return hits
  } catch {
    return null
  } finally {
    ac.abort()
  }
}

const clampTimeout = (raw: number | undefined): number =>
  typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS

const clampMaxHits = (raw: number | undefined): number =>
  typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_HITS

/**
 * Build the `resolveSymbol` method of a `MentionResolverPort`.
 *
 * @param cfg — optional knob overrides. Omitted ⇒ `auto` priority with
 *              both strategies disabled (every call returns `null`).
 */
export const createSymbolResolver = (
  cfg: SymbolResolverConfig = {},
): ((target: string) => Promise<MentionResolverResult | null>) => {
  const priority: SymbolResolverPriority = cfg.priority ?? "auto"
  const timeoutMs = clampTimeout(cfg.timeoutMs)
  const maxHits = clampMaxHits(cfg.maxHits)

  return async (target: string): Promise<MentionResolverResult | null> => {
    if (typeof target !== "string" || target.length === 0) return null

    let hits: readonly SymbolHit[] | null = null
    if (priority === "lsp") {
      hits = await safeLookup(cfg.lsp, target, timeoutMs)
    } else if (priority === "semantic") {
      hits = await safeLookup(cfg.semantic, target, timeoutMs)
    } else {
      // auto — LSP first, semantic fallback on miss / empty.
      hits = await safeLookup(cfg.lsp, target, timeoutMs)
      if (hits === null || hits.length === 0) {
        hits = await safeLookup(cfg.semantic, target, timeoutMs)
      }
    }
    if (hits === null || hits.length === 0) return null
    return { bodyText: renderBody(target, hits, maxHits) }
  }
}
