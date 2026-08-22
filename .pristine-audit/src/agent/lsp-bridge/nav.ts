import { extname } from "node:path"
import { type LspClient, LspRequestError } from "@/lsp"
import { errMessage, logger } from "@/shared"
import type { StaticEvidence as EvidenceStatic, LspNavProvider, LspNavSession } from "@/tool"
import { sleep } from "../loop/sleep"
import { isAvailable } from "./availability"
import { NEVER_ABORTED, specFor, uriToPath } from "./servers"
import { warmPools } from "./warm-pool"

/* ------------------------------------------------------------------------- *
 * LSP nav (definition/references/hover/symbol/rename-preview) — Codex
 * `may-20-codex-lsp.md` absorption (ADR-0015).
 *
 * Same provider/session/null-degrade ethos as the diagnostics path: we adapt
 * the live {@link LspClient} (which now implements the 8 nav RPCs added in
 * Wave B1) to the slice-isolated {@link LspNavSession} interface. The
 * structural compatibility of the LSP and nav-tool type families means the
 * adaptation is just a pass-through — every nav method delegates to the
 * matching `LspClient` method, and `stop()` shuts the server down.
 *
 * Default OFF: not added to `defaultTools`; the CLI registers these tools
 * only when `QUANTA_LSP_TOOLS=full` is set (next-step wiring). With the env
 * unset the tool surface is byte-identical to today.
 * --------------------------------------------------------------------------*/

/** Adapt a live {@link LspClient} to the slice-isolated {@link LspNavSession}.
 *  The two type families (`@/lsp` and `@/tool/lsp_nav`) are structurally
 *  identical (same `Pos`/`Range`/`Location`/`SymbolInfo`/`Hover`/`RenamePreview`
 *  shapes), so the adapter is a method-by-method forwarder. The client is
 *  the same one used for diagnostics — one server is shared across every nav
 *  call this session makes against the same file (didOpen is dedup'd in
 *  Wave B1's LspClient). */
const adaptToNavSession = (client: LspClient): LspNavSession => ({
  definition: (file, pos, signal) => client.definition(file, pos, signal),
  references: (file, pos, includeDeclaration, signal) =>
    client.references(file, pos, includeDeclaration, signal),
  hover: (file, pos, signal) => client.hover(file, pos, signal),
  typeDefinition: (file, pos, signal) => client.typeDefinition(file, pos, signal),
  implementation: (file, pos, signal) => client.implementation(file, pos, signal),
  documentSymbol: (file, signal) => client.documentSymbol(file, signal),
  workspaceSymbol: (query, signal) => client.workspaceSymbol(query, signal),
  prepareRename: (file, pos, signal) => client.prepareRename(file, pos, signal),
  incomingCalls: (file, pos, signal) => client.incomingCalls(file, pos, signal),
  outgoingCalls: (file, pos, signal) => client.outgoingCalls(file, pos, signal),
  stop: () => client.stop(),
})

/** The real nav provider: extension → server, with graceful unavailability.
 *  Reuses the same `specFor` + `isAvailable` machinery as diagnostics so a
 *  single per-process binary probe serves both surfaces. Pyright upgrades to
 *  one shared warm workspace session per cwd (idle-TTL pooled); the other
 *  servers keep the historical fresh-per-call behavior. */
export const lspNavProvider = (): LspNavProvider => ({
  unavailableReason: (filePath) => {
    const spec = specFor(filePath)
    return spec
      ? `${spec.bin} is not installed or not on PATH`
      : `no language server for ${extname(filePath) || "this file type"}`
  },
  open: async (filePath, cwd, signal): Promise<LspNavSession | null> => {
    const spec = specFor(filePath)
    if (!spec) return null
    if (!(await isAvailable(spec.bin))) return null
    // Warm-capable engines (pyright today) route through a shared, idle-TTL
    // pooled workspace per cwd; everything else stays fresh-per-call.
    const warmPool = warmPools.get(spec)
    if (warmPool) return warmPool.open(filePath, cwd, signal)
    const client = spec.create(cwd)
    try {
      await client.start(signal)
    } catch (e) {
      logger.warn("lsp: failed to start language server (nav)", {
        bin: spec.bin,
        error: errMessage(e),
      })
      await client.stop().catch(() => undefined)
      return null
    }
    return adaptToNavSession(client)
  },
})

/**
 * Keystone enrichment — the PRODUCTION `lspStatic` port for `collect_evidence`.
 * Given a failure site (absolute file + 1-based line), open the right language
 * server via {@link lspNavProvider} and harvest the static context: hover
 * (type_info), definition (definition_chain), references — fused into the
 * Evidence Packet's `static` section. This is what turns the keystone's static
 * section from test-local to LIVE.
 *
 * Test runners report only a LINE (no column), so we scan columns on the line
 * for the first symbol the server answers about. rust-analyzer (and others)
 * emit `ContentModified` (-32801) / `ServerCancelled` (-32802) while indexing —
 * classified by the TYPED {@link LspRequestError} code (never by error text:
 * rust-analyzer's real -32801 message does not say "content modified") and
 * treated as "retry", within a budget. The turn `AbortSignal` is threaded from
 * the tool ctx — an aborted turn bails promptly instead of riding out the
 * budget's retry sleeps against a live LSP child.
 * Best-effort + NEVER-throws (the builder also `safe()`-wraps it): a missing
 * server / no symbol / abort ⇒ null, never a crash. Session lifetime is owned
 * by the provider: pyright may reuse a warm pooled workspace, other servers
 * stay fresh-per-call.
 */
/** Delay between column-scan sweeps while the server is still indexing. */
const EVIDENCE_LSP_RETRY_DELAY_MS = 500
/** Re-reads `aborted` on every call — a plain inline check would be narrowed
 *  to `false` by TS after the first test, but awaits can flip it mid-loop. */
const isAborted = (signal?: AbortSignal): boolean => signal?.aborted === true
export const evidenceLspStatic =
  (budgetMs = 20_000, provider?: LspNavProvider, now: () => number = Date.now) =>
  async (
    file: string,
    line: number,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<EvidenceStatic | null> => {
    const session = await (provider ?? lspNavProvider()).open(file, cwd, signal)
    if (session === null) return null
    const toLoc = (l: {
      uri: string
      range: { start: { line: number } }
    }): { file: string; line: number } => ({
      file: uriToPath(l.uri),
      line: l.range.start.line + 1,
    })
    try {
      const ln = Math.max(0, line - 1) // LSP 0-based
      const deadline = now() + budgetMs
      while (now() < deadline) {
        if (isAborted(signal)) return null
        for (let ch = 0; ch < 80; ch += 2) {
          if (isAborted(signal)) return null
          const pos = { line: ln, character: ch }
          try {
            const hov = await session.hover(file, pos, signal)
            if (hov !== null) {
              const defs = await session.definition(file, pos, signal).catch(() => null)
              const refs = await session.references(file, pos, false, signal).catch(() => null)
              return {
                definition_chain: (defs ?? []).map(toLoc),
                references: (refs ?? []).map(toLoc),
                type_info: hov.contents,
                diagnostics: [],
              }
            }
          } catch (e) {
            // TYPED classification (jun-10 audit #23): ContentModified (-32801) /
            // ServerCancelled (-32802) during indexing ⇒ retry; anything else ⇒
            // give up. Never `String(e)` text-matching — rust-analyzer's real
            // -32801 message never contains "content modified".
            const retryable =
              e instanceof LspRequestError && (e.code === -32801 || e.code === -32802)
            if (!retryable) return null
          }
        }
        await sleep(EVIDENCE_LSP_RETRY_DELAY_MS, signal ?? NEVER_ABORTED)
      }
      return { definition_chain: [], references: [], type_info: null, diagnostics: [] }
    } finally {
      await session.stop().catch(() => undefined)
    }
  }
