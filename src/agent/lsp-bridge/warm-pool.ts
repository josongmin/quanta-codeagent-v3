import type { LspClient } from "@/lsp"
import { errMessage, type LspGroundingReceipt, logger, runtimeConfig } from "@/shared"
import { sleep } from "../loop/sleep"
import {
  isFatalSharedSessionError,
  SharedWorkspacePool,
  type WarmBackend,
} from "../lsp-workspace-pool"
import {
  type AnchorDirLister,
  nodeFsAnchorDirLister,
  synthesizeLspAnchors,
} from "../mention-injection"
import { lspExtensionToLanguage, NEVER_ABORTED, PYRIGHT, type ServerSpec, specFor } from "./servers"

/** Idle-TTL (30 minutes) before an unreferenced pyright workspace is reaped
 *  (interactive cross-turn reuse window). Bench overrides lifetime via the
 *  terminal {@link evictLspWorkspaces}. Written as a flat literal (not
 *  `30 * 60_000`) so the magic-timeout scan's arithmetic-form false positive
 *  does not trip. */
const PYRIGHT_NAV_IDLE_TTL_MS = 1_800_000
/** Hard ceiling on simultaneously-live pyright servers across ALL cwds (DEFAULT-ON,
 *  jun-26 LSP-OOM fix). A bench run opens a DISTINCT sandbox cwd per instance; the
 *  per-instance evict reaps the matching cwd, but any miss (a verify-select
 *  candidate sandbox, or a cwd-mismatch) leaves a live pyright child for the full
 *  30-min idle-TTL window, so servers ACCUMULATE with instance count until the box
 *  OOMs (exit 137 — 12 instances OOM'd a 64GB box at concurrency 1 AND 2). The
 *  per-server heap cap (server-mem-budget) bounds each server's heap but NOT their
 *  count; this LRU cap bounds the count. Interactive CLI nav reuses ONE cwd across
 *  turns, so a cap of 2 keeps that workspace permanently warm (no prewarm
 *  regression) while flattening the bench accumulation curve. Flat literal — the
 *  magic-number scan tolerates small structural caps. */
const PYRIGHT_MAX_LIVE_WORKSPACES = 2
const PYRIGHT_READY_TIMEOUT_MS = 90_000
const PYRIGHT_READY_RETRY_MS = 1_000
const PYRIGHT_IMPORT_SCAN_LINE_CAP = 200

/** Factory for the pooled pyright client — overridable so tests can inject a
 *  scriptable fake instead of spawning a real `pyright-langserver`. */
type PyrightClientFactory = (cwd: string) => LspClient
let pyrightClientFactory: PyrightClientFactory = (cwd) => PYRIGHT.create(cwd)

/** TEST-ONLY: swap the pooled-client factory (pass null to restore the real one). */
export const __setPyrightClientFactoryForTest = (factory: PyrightClientFactory | null): void => {
  pyrightClientFactory = factory ?? ((cwd) => PYRIGHT.create(cwd))
}

/** TEST-ONLY: shrink the warm-up budget/retry so the exhaustion path is reachable
 *  in a unit test (the real 90s budget is impractical). null = production timing. */
let pyrightWarmupTimingForTest: { budgetMs: number; retryMs: number } | null = null
export const __setPyrightWarmupTimingForTest = (
  t: { budgetMs: number; retryMs: number } | null,
): void => {
  pyrightWarmupTimingForTest = t
}

const normalizeImportSymbol = (raw: string): string | null => {
  const trimmed = raw.replace(/[()]/g, "").trim()
  if (trimmed.length === 0 || trimmed === "*") return null
  const base = trimmed.split(/\s+as\s+/i)[0]?.trim() ?? ""
  return base.length > 0 ? base : null
}

/** Result of the import scan. `pos` = a probe position to poll `definition` on;
 *  `pos: null, truncated: false` = genuinely no import in the whole file (safe
 *  to treat as verified-ready, nothing to confirm); `pos: null, truncated:
 *  true` = the {@link PYRIGHT_IMPORT_SCAN_LINE_CAP} window was exhausted with
 *  more lines remaining and no probe found, so an import MAY live past the cap.
 *  Audit #21: the caller must NOT conflate the truncated case with the genuinely
 *  import-less case — a file whose imports sit past the cap (long license/
 *  docstring header) would otherwise be falsely marked warm-verified. */
interface ImportProbeScan {
  pos: { line: number; character: number } | null
  truncated: boolean
}

/** TEST-ONLY: expose the pure import-scan so a unit test can prove the cap
 *  conflation fix (audit #21) directly — `truncated` distinguishes a genuinely
 *  import-less file from one whose imports sit past the line cap, without a live
 *  pyright. NEVER called in production. */
export const __findPyrightImportProbeForTest = (source: string): ImportProbeScan =>
  findPyrightImportProbe(source)

const findPyrightImportProbe = (source: string): ImportProbeScan => {
  const lines = source.split(/\r?\n/)
  const scanned = Math.min(lines.length, PYRIGHT_IMPORT_SCAN_LINE_CAP)
  for (let i = 0; i < scanned; i++) {
    const line = lines[i] ?? ""
    const fromMatch = line.match(/^\s*from\s+[\w.]+\s+import\s+(.+)$/)
    const importMatch = line.match(/^\s*import\s+(.+)$/)
    const body = fromMatch?.[1] ?? importMatch?.[1]
    if (!body) continue
    for (const piece of body.split(",")) {
      const symbol = normalizeImportSymbol(piece)
      if (!symbol) continue
      const character = line.indexOf(symbol)
      if (character >= 0) return { pos: { line: i, character }, truncated: false }
    }
  }
  // No probe in the window. `truncated` distinguishes "scanned the whole file"
  // (genuinely import-less) from "hit the cap with lines left" (import may be
  // beyond it) so the readiness caller can refuse a false verified-ready.
  return { pos: null, truncated: lines.length > PYRIGHT_IMPORT_SCAN_LINE_CAP }
}

const readPyrightImportProbe = async (filePath: string): Promise<ImportProbeScan> => {
  try {
    return findPyrightImportProbe(await Bun.file(filePath).text())
  } catch {
    return { pos: null, truncated: false }
  }
}

/**
 * Pyright readiness probe — the ONE engine-specific bit of the warm path.
 * Primes the document, then (if the file has an import we can probe) polls
 * `definition` on that import symbol until pyright resolves it (server warm) or
 * the budget is exhausted. Returns true = verified-ready (no import to confirm,
 * or one resolved); false = exhausted without a resolve, OR the import scan was
 * truncated by the line cap with imports possibly beyond it (audit #21) — in
 * both `false` cases the pool must NOT mark the file prepared, so the next call
 * re-attempts instead of claiming warm-verified status on a maybe-cold server.
 * Re-throws FATAL transport errors so the pool aborts the warm; transient
 * "still indexing" failures are swallowed (keep polling).
 */
const ensurePyrightFileReady = async (
  client: LspClient,
  filePath: string,
  signal: AbortSignal | undefined,
): Promise<boolean> => {
  // Honor an already-aborted signal BEFORE priming a doc — a background prewarm
  // whose session ended must not boot/prime a server just to bail in the poll
  // loop below. The no-import fast-path (`scan.pos === null`) returns before
  // that loop, so without this check an aborted prewarm of an import-less anchor
  // would still fully prime a started server.
  if (signal?.aborted) throw new Error(`pyright warm-up aborted for ${filePath}`)
  await client.prime(filePath, signal)
  const scan = await readPyrightImportProbe(filePath)
  const probe = scan.pos
  // Genuinely import-less file ⇒ nothing to verify, verified-ready. But a scan
  // TRUNCATED by the line cap with no probe found (imports may live past it)
  // must NOT be marked verified-ready (audit #21) — return false so the pool
  // re-attempts instead of falsely claiming a warm-verified, maybe-cold server.
  if (probe === null) return !scan.truncated
  // Budget precedence: test override → `QUANTA_LSP_READY_TIMEOUT_MS` runtime knob
  // (raise it for slow-but-resolvable large repos; only this LSP path reads it) →
  // the hardcoded default. Default UNCHANGED (jun-23 LSP-03: no budget change
  // without receipt evidence — the knob lets the operator A/B it first).
  const budgetMs =
    pyrightWarmupTimingForTest?.budgetMs ??
    runtimeConfig().lspReadyTimeoutMs ??
    PYRIGHT_READY_TIMEOUT_MS
  const retryMs = pyrightWarmupTimingForTest?.retryMs ?? PYRIGHT_READY_RETRY_MS
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error(`pyright warm-up aborted for ${filePath}`)
    try {
      const defs = await client.definition(filePath, probe, signal)
      if (defs !== null && defs.length > 0) return true
    } catch (e) {
      if (isFatalSharedSessionError(e)) throw e
      // transient (still indexing) → keep polling
    }
    await sleep(retryMs, signal ?? NEVER_ABORTED)
  }
  logger.warn("lsp: pyright warm-up budget exhausted; keeping shared session alive", {
    file: filePath,
    timeoutMs: budgetMs,
  })
  return false
}

/** The pyright {@link WarmBackend} — the only engine-specific seam. Everything
 *  else (pool, refcount, idle-TTL, `startPromise` join, dedup, fatal teardown)
 *  is generic and lives in {@link SharedWorkspacePool}. Swapping pyright for
 *  basedpyright / a different engine is a new `WarmBackend` + one registry
 *  entry below — no change to the pool. */
const pyrightBackend: WarmBackend = {
  id: "pyright",
  supports: (filePath) => specFor(filePath) === PYRIGHT,
  createClient: (cwd) => pyrightClientFactory(cwd),
  ensureFileReady: (client, filePath, signal) => ensurePyrightFileReady(client, filePath, signal),
}

/** The single pyright warm pool (one workspace per cwd, idle-TTL pooled). */
const pyrightPool = new SharedWorkspacePool(pyrightBackend, {
  idleTtlMs: PYRIGHT_NAV_IDLE_TTL_MS,
  maxLiveBackends: PYRIGHT_MAX_LIVE_WORKSPACES,
})

/** Registry of warm-capable backends, keyed by {@link ServerSpec}. Adding a
 *  warm engine is ONE entry; the nav provider branches on "is there a warm pool
 *  for this spec?" instead of a hardcoded `spec === PYRIGHT`. */
export const warmPools = new Map<ServerSpec, SharedWorkspacePool>([[PYRIGHT, pyrightPool]])

/** Background prewarm a warm-capable workspace for `anchorFile` under `cwd`.
 *  Fire-and-forget from session bootstrap: opens + immediately releases so the
 *  cwd entry stays warm (idle-TTL) and the first real LSP call hits a warm map.
 *  No-op when the anchor's language has no warm pool. */
export const prewarmLspWorkspace = async (
  anchorFile: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<void> => {
  const spec = specFor(anchorFile)
  if (!spec) return
  const pool = warmPools.get(spec)
  if (!pool) return
  await pool.prewarm(anchorFile, cwd, signal)
}

/** Production teardown of every warm workspace for `cwd` (bench session end —
 *  see `disposeSessionResources`). Engine-agnostic + idempotent; callers
 *  no-throw-wrap it. Without this a bench run leaks one language-server child
 *  per sandbox cwd for the whole idle-TTL window. */
export const evictLspWorkspaces = async (cwd: string): Promise<void> => {
  for (const pool of warmPools.values()) await pool.evict(cwd)
}

/**
 * Strict-admission READY proof (LSP-01). Given the task-relevant anchor file
 * (absolute, inside `cwd`) and its language, prove the workspace can actually
 * reach verified-ready — not merely that the binary is launchable.
 *
 * For a language with a warm pool (pyright today) this drives the SAME backend
 * readiness truth the real solve will use ({@link SharedWorkspacePool.proveReady}),
 * in the SAME sandbox, and surfaces the readiness boolean as a typed
 * {@link LspGroundingReceipt} — so a launchable-but-cold workspace yields
 * `ready_timeout` and a strict preset can fail closed on it. The opened entry is
 * kept warm (released, not evicted), so the subsequent solve reuses it.
 *
 * For a language with NO warm pool, no ready probe exists; this returns a
 * launch-stage `ok` receipt (the cheap binary preflight remains the only
 * authority) rather than inventing a divergent second readiness heuristic.
 * Never throws — the caller decides whether a non-`ok` outcome is fatal.
 */
export const proveStrictLspReady = async (
  filePath: string,
  cwd: string,
  language: string,
  signal?: AbortSignal,
): Promise<LspGroundingReceipt> => {
  const spec = specFor(filePath)
  const pool = spec ? warmPools.get(spec) : undefined
  if (!spec || !pool) {
    return {
      backend: spec?.bin ?? "",
      language,
      stage: "launch",
      outcome: "ok",
      file: filePath,
      reason: "no warm pool for language; launch proof is the only admission authority",
    }
  }
  return pool.proveReady(filePath, cwd, { language, ...(signal ? { signal } : {}) })
}

/** Resolve a deterministic anchor file under `cwd` whose language has a warm
 *  pool (Python/pyright today), or null when the workspace has none. Reuses the
 *  same breadth-first synthesizer the `@`-mention symbol lookup uses, then keeps
 *  the first anchor a warm backend supports. Anchor choice only affects the
 *  per-file didOpen — the expensive server boot + initial index it triggers is
 *  workspace-wide, so any supported file is a valid prewarm seed. */
export const resolvePrewarmAnchor = async (
  cwd: string,
  lister: AnchorDirLister = nodeFsAnchorDirLister,
): Promise<string | null> => {
  const anchors = await synthesizeLspAnchors({
    cwd,
    extensionToLanguage: lspExtensionToLanguage(),
    lister,
  })
  for (const anchor of anchors) {
    const spec = specFor(anchor.anchorFile)
    if (spec && warmPools.has(spec)) return anchor.anchorFile
  }
  return null
}

/** Session-start background warm of a warm-capable workspace under `cwd`.
 *  Resolves an anchor then fire-and-forgets the pool prewarm. NO-THROW: every
 *  failure (no anchor, fs error, server boot failure) is logged + swallowed so
 *  session start is never delayed or aborted by it. */
export const startBackgroundLspPrewarm = async (
  cwd: string,
  signal?: AbortSignal,
): Promise<void> => {
  try {
    const anchor = await resolvePrewarmAnchor(cwd)
    if (anchor === null) return
    await prewarmLspWorkspace(anchor, cwd, signal)
  } catch (e) {
    logger.debug("lsp: background prewarm skipped", { cwd, error: errMessage(e) })
  }
}

/** TEST-ONLY: tear down every pooled warm session so unit files cannot leak a
 *  warm daemon across cases or worker reuse. Kept under the historical name so
 *  the existing pool hellgate's `afterEach` continues to compile/pass. */
export const __resetSharedPyrightSessionsForTest = async (): Promise<void> => {
  for (const pool of warmPools.values()) await pool.disposeAll()
}
