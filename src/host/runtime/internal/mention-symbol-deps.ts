/**
 * ADR-0422 follow-up — production `@symbol` mention dependency builder.
 *
 * Shared composition helper that turns a workspace `cwd` + `env` into the two
 * SymbolLookup ports the ADR-0418 `createSymbolResolver` consumes, so the
 * `buildDefaultMentionResolver` call sites (the unified-agent
 * `apps/agent/assemble.ts` AND the host-runtime `mention-wire.ts`) wire a REAL
 * `@symbol` resolver instead of the always-`null` placeholder the deliberate
 * hold left behind.
 *
 * This lives at the HOST composition root because it composes BOTH the
 * agent-slice `@/agent/lsp-bridge` engine AND the `@/runner/assemble`
 * semantic backend — a cross-slice composition the host/apps layer is
 * permitted to perform (library slices are not). The mention-resolver CORE and
 * its adapters stay import-clean of these engines.
 *
 * SYNCHRONOUS, LAZY: `assembleAgentConfig` / `installCliMentionInjector` are
 * synchronous, so this builder returns ports SYNCHRONOUSLY. The expensive work
 * — the deterministic anchor-synth fs walk and the semantic backend build —
 * runs LAZILY on the first `findSymbol` call (memoized for the port's lifetime),
 * riding the already-async `findSymbol` signature. So config assembly stays
 * synchronous and zero-cost when no `@symbol` is ever mentioned.
 *
 * LSP strategy (deterministic, NO heuristics):
 *   - `synthesizeLspAnchors` walks `cwd` breadth-first (entries sorted per
 *     directory) and returns the lexicographically-first source file of EACH
 *     language present, keyed by server binary (so `.ts`/`.tsx`/`.js` collapse
 *     to one anchor). The extension→language map is derived from the SINGLE
 *     lsp-bridge `SERVERS` table (`lspExtensionToLanguage`).
 *   - `createUnionLspSymbolLookup` fans `workspaceSymbol(name)` across every
 *     synthesized anchor and merges hits. A language server that is not
 *     installed ⇒ `open` returns `null` ⇒ that anchor contributes nothing
 *     (graceful). No supported file in the workspace ⇒ no anchors ⇒ the LSP
 *     port answers `null` for every lookup.
 *
 * Semantic strategy (the `auto` fallback):
 *   - `buildSemanticBackend(env, embed)` (ADR-0391) is the SAME in-memory /
 *     sqlite vector backend the search pipeline uses; `selectIndexEmbedder(env)`
 *     is the SAME embedder. `createSemanticSymbolLookup` embeds the symbol name
 *     and probes the index. An EMPTY index (nothing upserted) ⇒ `query` returns
 *     `[]` ⇒ the port answers `null` (graceful — never throws).
 *
 * NO-THROW: any failure (anchor walk rejects, backend build throws) degrades the
 * corresponding strategy to a port that answers `null`, never a throw.
 */

import { promises as fsp } from "node:fs"
import { lspExtensionToLanguage, lspNavProvider } from "@/agent/lsp-bridge"
import {
  type AnchorDirEntry,
  type AnchorDirLister,
  createSemanticSymbolLookup,
  createUnionLspSymbolLookup,
  type SymbolHit,
  type SymbolLookupLspPort,
  type SymbolLookupSemanticPort,
  synthesizeLspAnchors,
} from "@/agent/mention-injection"
import { logger } from "@/shared"
import type { LspNavProvider } from "@/tool"

/** Env bag this builder reads (semantic backend selection + the symbol knob). */
export type MentionSymbolDepsEnv = NodeJS.ProcessEnv

/** Hermetic test seams. Absent ⇒ the real production deps: the live
 *  `lspNavProvider()` (graceful-null without an installed server), the
 *  `node:fs` lister, and the real `@/runner` semantic backend. Tests inject a
 *  fake LSP provider (to prove anchors→union→hits with no real server) and/or
 *  a pre-built semantic lookup (to prove the `auto` fallback). */
export interface MentionSymbolDepsSeams {
  /** Replace the LSP nav provider used by the union lookup. */
  readonly lspProvider?: LspNavProvider
  /** Replace the anchor-synth directory lister (default = `node:fs`). */
  readonly lister?: AnchorDirLister
  /** Replace the lazily-built semantic lookup wholesale (skips the `@/runner`
   *  backend build — used to drive the `auto` fallback hermetically). */
  readonly semanticLookup?: SymbolLookupSemanticPort | null
}

/** Result: the two SymbolLookup ports, each present only when its strategy is
 *  applicable. With `QUANTA_MENTION_SYMBOL=off` BOTH are absent. */
export interface MentionSymbolDeps {
  readonly lsp?: SymbolLookupLspPort
  readonly semantic?: SymbolLookupSemanticPort
}

/** A `node:fs`-backed {@link AnchorDirLister}. `withFileTypes` gives the
 *  file/dir discriminator without a per-entry `stat`. The synthesizer swallows
 *  readDir rejections so a transient fs error skips a subtree, not the run. */
const nodeFsAnchorDirLister: AnchorDirLister = {
  readDir: async (dir: string): Promise<readonly AnchorDirEntry[]> => {
    const dirents = await fsp.readdir(dir, { withFileTypes: true })
    return dirents.map((d) => ({ name: d.name, isDirectory: d.isDirectory() }))
  },
}

/** Memoize an async factory so the underlying lookup is built at most once per
 *  port lifetime (the first `findSymbol`), regardless of concurrent calls. */
const once = <T>(factory: () => Promise<T>): (() => Promise<T>) => {
  let cached: Promise<T> | undefined
  return () => {
    if (cached === undefined) cached = factory()
    return cached
  }
}

/** Build the concrete union-LSP lookup for `cwd`. `null` when no supported
 *  source file exists OR on any failure (NO-THROW). */
const buildLspLookup = async (
  cwd: string,
  seams: MentionSymbolDepsSeams,
): Promise<SymbolLookupLspPort | null> => {
  try {
    const anchors = await synthesizeLspAnchors({
      cwd,
      extensionToLanguage: lspExtensionToLanguage(),
      lister: seams.lister ?? nodeFsAnchorDirLister,
    })
    if (anchors.length === 0) return null
    return createUnionLspSymbolLookup({
      provider: seams.lspProvider ?? lspNavProvider(),
      cwd,
      anchorFiles: anchors.map((a) => a.anchorFile),
    })
  } catch (e) {
    logger.warn(`mention @symbol: LSP anchor synthesis failed (${(e as Error).message}); skipping.`)
    return null
  }
}

/** Build the concrete semantic lookup from the search backend. `null` on any
 *  failure (NO-THROW); an EMPTY index is NOT a failure. */
const buildSemanticLookup = async (
  env: MentionSymbolDepsEnv,
  seams: MentionSymbolDepsSeams,
): Promise<SymbolLookupSemanticPort | null> => {
  if (seams.semanticLookup !== undefined) return seams.semanticLookup
  try {
    // Dynamic import keeps the `@/runner` cross-slice edge at the composition
    // root and out of any static agent-slice graph.
    const { buildSemanticBackend, selectIndexEmbedder } = await import(
      "@/runner/assemble/search-index-backend"
    )
    const embed = selectIndexEmbedder(env)
    const backend = buildSemanticBackend(env, embed)
    return createSemanticSymbolLookup({ index: backend.port, embed })
  } catch (e) {
    logger.warn(
      `mention @symbol: semantic backend build failed (${(e as Error).message}); skipping.`,
    )
    return null
  }
}

/** Wrap a lazily-built lookup behind a synchronous port whose `findSymbol`
 *  triggers (memoized) construction on first use. A `null` build ⇒ the port
 *  permanently answers `null` (strategy effectively absent, NO-THROW). */
const lazyLookupPort = (
  build: () => Promise<SymbolLookupLspPort | SymbolLookupSemanticPort | null>,
): { findSymbol(name: string): Promise<readonly SymbolHit[] | null> } => {
  const get = once(build)
  return {
    findSymbol: async (name: string): Promise<readonly SymbolHit[] | null> => {
      try {
        const lookup = await get()
        if (lookup === null) return null
        return await lookup.findSymbol(name)
      } catch {
        return null
      }
    },
  }
}

/**
 * Build the production `@symbol` SymbolLookup deps for a workspace.
 *
 * `QUANTA_MENTION_SYMBOL=off` short-circuits to `{}` (no ports — the resolver
 * omits `@symbol` entirely, byte-identical to the legacy path). The per-kind
 * knob is ALSO honoured downstream by `buildDefaultMentionResolver`, so this
 * early return is purely an optimization (no lazy ports created at all).
 *
 * @param cwd — workspace root.
 * @param env — env source (semantic backend selection + the symbol knob).
 * @param seams — hermetic test overrides (absent ⇒ real production deps).
 */
export const buildMentionSymbolDeps = (
  cwd: string,
  env: MentionSymbolDepsEnv,
  seams: MentionSymbolDepsSeams = {},
): MentionSymbolDeps => {
  if (env.QUANTA_MENTION_SYMBOL === "off") return {}
  return {
    lsp: lazyLookupPort(() => buildLspLookup(cwd, seams)),
    semantic: lazyLookupPort(() => buildSemanticLookup(env, seams)),
  }
}
