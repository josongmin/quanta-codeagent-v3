import { extname } from "node:path"
import { type LspClient, LspRequestError } from "@/lsp"
import type { StaticEvidence as EvidenceStatic, LspNavProvider, LspNavSession } from "@/tool"
import { sleep } from "../loop/sleep"
import { assertWorkspaceTrusted } from "../workspace-trust"
import { isAvailable } from "./availability"
import { NEVER_ABORTED, specFor, startLspClient, uriToPath } from "./servers"
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
    if (warmPool) {
      // The pool starts its server behind its own error handling; ask first, so a refusal
      // reaches the tool as a reason rather than as "no session".
      assertWorkspaceTrusted(`Language server ${spec.bin}`, cwd)
      return warmPool.open(filePath, cwd, signal)
    }
    const client = spec.create(cwd)
    if (!(await startLspClient(client, spec.bin, "nav", signal))) return null
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
type EvidenceLocation = { uri: string; range: { start: { line: number } } }
type EvidenceScan = EvidenceStatic | "retry" | "fatal" | "none"

const isRetryableLspRequest = (error: unknown): boolean =>
  error instanceof LspRequestError && (error.code === -32801 || error.code === -32802)

const scanEvidenceLine = async (
  session: LspNavSession,
  file: string,
  line: number,
  signal: AbortSignal | undefined,
  toLoc: (location: EvidenceLocation) => { file: string; line: number },
): Promise<EvidenceScan> => {
  for (let character = 0; character < 80; character += 2) {
    if (isAborted(signal)) return "none"
    const position = { line, character }
    try {
      const hover = await session.hover(file, position, signal)
      if (hover === null) continue
      const definitions = await session.definition(file, position, signal).catch(() => null)
      const references = await session.references(file, position, false, signal).catch(() => null)
      return {
        definition_chain: (definitions ?? []).map(toLoc),
        references: (references ?? []).map(toLoc),
        type_info: hover.contents,
        diagnostics: [],
      }
    } catch (error) {
      if (!isRetryableLspRequest(error)) return "fatal"
    }
  }
  return "retry"
}

const findEvidenceBeforeDeadline = async (
  session: LspNavSession,
  file: string,
  line: number,
  budgetMs: number,
  now: () => number,
  signal: AbortSignal | undefined,
  toLoc: (location: EvidenceLocation) => { file: string; line: number },
): Promise<EvidenceStatic | null> => {
  const deadline = now() + budgetMs
  while (now() < deadline) {
    if (isAborted(signal)) return null
    const result = await scanEvidenceLine(session, file, line, signal, toLoc)
    if (typeof result === "object") return result
    if (result === "fatal" || isAborted(signal)) return null
    await sleep(EVIDENCE_LSP_RETRY_DELAY_MS, signal ?? NEVER_ABORTED)
  }
  return { definition_chain: [], references: [], type_info: null, diagnostics: [] }
}

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
    const toLoc = (location: EvidenceLocation): { file: string; line: number } => ({
      file: uriToPath(location.uri),
      line: location.range.start.line + 1,
    })
    try {
      return await findEvidenceBeforeDeadline(
        session,
        file,
        Math.max(0, line - 1), // LSP 0-based
        budgetMs,
        now,
        signal,
        toLoc,
      )
    } finally {
      await session.stop().catch(() => undefined)
    }
  }
