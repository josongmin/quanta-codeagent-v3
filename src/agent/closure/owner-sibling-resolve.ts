/**
 * WS2 — LSP owner-sibling resolver. The deterministic feeder that fills
 * `FaultEvidenceInput.ownerResolved` (audit verdict C: previously NONE populated
 * it, so the parent/child override site never reached the candidate set and the
 * T-601 escalation gate was permanently starved).
 *
 * For each top-K stage-1 candidate file, for each bounded issue symbol, it
 * locates the symbol's definition site in the file's source and asks the language
 * server for:
 *   - `implementation(pos)` — concrete subclass OVERRIDES of the method (e.g.
 *     `BaseDatabaseClient.settings_to_cmd_args_env` → `postgresql/client.py`).
 *   - `definition(pos)`     — the PARENT declaration (child-localized → surface
 *     the parent so a single-site child edit isn't treated complete).
 * The resolved sibling files (never the originating file itself) become
 * `{file, forSymbol}` rows → `buildFaultEvidencePacket` boosts them with
 * `owner-resolve` provenance, which `decideOwnerAdmission` reads as an
 * `owner-family` (siblingCoverageExpected) and `decideEscalation` reads as a
 * corroborated strong owner.
 *
 * BLIND: issue symbols + stage-1 ranking + repo source + LSP only. Never reads
 * FAIL_TO_PASS / test_patch / grader report. BOUNDED: maxFiles × symbols, capped
 * results. PURE control flow with an injected `LspNavProvider` (default = real
 * pooled provider) so the resolver is unit-testable without a live server.
 */

import { lspNavProvider } from "@/agent/lsp-bridge"
import type { LspNavProvider } from "@/tool"

export interface OwnerSiblingArgs {
  /** Stage-1 ranked candidates (score-desc). Top `maxFiles` are probed. */
  readonly stage1Files: readonly { file: string; score: number }[]
  /** Bounded issue symbols (from the FaultEvidencePacket). */
  readonly issueSymbols: readonly string[]
  /** Sandbox root — used to relativize LSP `file://` URIs. */
  readonly cwd: string
  /** Read a sandbox-relative source file; `null` when absent/unreadable. */
  readonly readSource: (relFile: string) => string | null
  readonly signal?: AbortSignal
  /** Max stage-1 files to probe (cost bound). Default 3. */
  readonly maxFiles?: number
  /** Cap on returned sibling rows (cost bound). Default 8. */
  readonly maxResults?: number
}

export interface OwnerSibling {
  readonly file: string
  readonly forSymbol: string
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * 0-based `{line, character}` of the DEFINITION site of `symbol` in `source`
 * (a `def`/`async def`/`class` line). `null` when the symbol is not defined
 * here — we only resolve from a file that actually OWNS the symbol, so the LSP
 * position lands on a real declaration token.
 */
export const defSiteOf = (
  source: string,
  symbol: string,
): { line: number; character: number } | null => {
  const sym = escapeRe(symbol)
  const re = new RegExp(`^\\s*(?:async\\s+)?def\\s+${sym}\\b|^\\s*class\\s+${sym}\\b`)
  const lines = source.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i] ?? ""
    if (re.test(ln)) {
      const character = ln.indexOf(symbol)
      if (character >= 0) return { line: i, character }
    }
  }
  return null
}

const relFromUri = (uri: string, cwd: string): string => {
  const path = uri.replace(/^file:\/\//, "")
  const base = cwd.endsWith("/") ? cwd : `${cwd}/`
  return path.startsWith(base) ? path.slice(base.length) : path
}

/**
 * Resolve owner siblings for the closure session. Curried on the provider so the
 * production wiring passes the real pooled provider while tests inject a stub.
 */
export const resolveOwnerSiblings =
  (provider?: LspNavProvider) =>
  async (args: OwnerSiblingArgs): Promise<OwnerSibling[]> => {
    const prov = provider ?? lspNavProvider()
    const maxFiles = args.maxFiles ?? 3
    const maxResults = args.maxResults ?? 8
    const out: OwnerSibling[] = []
    const seen = new Set<string>()

    for (const sf of [...args.stage1Files].slice(0, maxFiles)) {
      if (out.length >= maxResults || args.signal?.aborted === true) break
      const source = args.readSource(sf.file)
      if (source === null) continue
      const session = await prov.open(sf.file, args.cwd, args.signal).catch(() => null)
      if (session === null) continue
      try {
        for (const sym of args.issueSymbols) {
          if (out.length >= maxResults) break
          const pos = defSiteOf(source, sym)
          if (pos === null) continue
          const impls = await session.implementation(sf.file, pos, args.signal).catch(() => null)
          const defs = await session.definition(sf.file, pos, args.signal).catch(() => null)
          for (const loc of [...(impls ?? []), ...(defs ?? [])]) {
            const rel = relFromUri(loc.uri, args.cwd)
            // sibling only — never the originating file (a self-hit is just the
            // declaration we started from, not a co-change site).
            if (rel === "" || rel === sf.file) continue
            const key = `${rel}|${sym}`
            if (seen.has(key)) continue
            seen.add(key)
            out.push({ file: rel, forSymbol: sym })
            if (out.length >= maxResults) break
          }
        }
      } finally {
        await session.stop().catch(() => undefined)
      }
    }
    return out
  }
