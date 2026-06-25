import { extname } from "node:path"
import { fileURLToPath } from "node:url"
import type { CodeActionPort, FormatPort, SignatureHelpPort } from "@/lsp"
import {
  CLANGD_BIN,
  ClangdAdapter,
  DefaultCodeActionAdapter,
  DefaultFormatAdapter,
  DefaultRenameApplyAdapter,
  DefaultSignatureHelpAdapter,
  GOPLS_BIN,
  GoplsAdapter,
  type LspClient,
  LspRequestError,
  lspExtensionToServerBin,
  lspServerBinForFile,
  PYRIGHT_LANGSERVER_BIN,
  PyrightAdapter,
  type RenameWorkspaceEdit,
  RUST_ANALYZER_BIN,
  RustAnalyzerAdapter,
  TYPESCRIPT_LANGUAGE_SERVER_BIN,
  TypescriptAdapter,
} from "@/lsp"
import { defaultPpidWalkKiller } from "@/runtime"
import { errMessage, type LspGroundingReceipt, logger, runtimeConfig } from "@/shared"
import type { StaticEvidence as EvidenceStatic } from "@/tool"
import {
  lspNavTools as buildLspNavTools,
  type DiagnosticsProvider,
  type DiagnosticsSession,
  diagnosticsTool,
  isCheapLspNavTool,
  type LspNavProvider,
  type LspNavSession,
  lspCodeActionTool,
  lspFormatTool,
  lspRenameApplyTool,
  lspSignatureHelpTool,
  type RenameApplyPort,
  type Tool,
} from "@/tool"
import { sleep } from "./loop/sleep"
import { attachLspDiagnosticsHook, type LspDiagnosticsHookHandle } from "./lsp-diagnostics-hook"
import {
  isFatalSharedSessionError,
  SharedWorkspacePool,
  type WarmBackend,
} from "./lsp-workspace-pool"
import {
  type AnchorDirLister,
  nodeFsAnchorDirLister,
  synthesizeLspAnchors,
} from "./mention-injection"
import type { AgentConfig } from "./types"

/**
 * LSP → Tool bridge (mirrors `mcp-bridge.ts`; RFC §3.1 / §13).
 *
 * Rationale: `@/tool` may not import `@/lsp` (slice isolation, enforced by
 * biome). The agent slice is the assembler and is the only place allowed to
 * cross slices, so the adapter that turns the LSP client into the tool's
 * injected `DiagnosticsProvider` lives here — exactly analogous to how an MCP
 * tool becomes a `Tool` in `mcp-bridge.ts`.
 *
 * Default-OFF / degrade-gracefully ethos: if the right language server binary
 * is not installed, `open()` returns `null` and the tool emits a clean
 * explanatory `ok:false` result — it never throws, never hangs (the per-request
 * timeout in `LspClient` bounds every wait).
 */

/**
 * Per-language wiring. The launcher argv and `languageId` mapping are NOT
 * duplicated here — they are owned by `@/lsp`'s {@link PyrightAdapter} /
 * {@link TypescriptAdapter}. The only bridge-local datum is `bin`: the probe
 * needs to run the resolver with `--version` (not the adapter's `--stdio`
 * launch), and `unavailableReason` reports it.
 */
interface ServerSpec {
  /** Argv[0] probed with `--version` to decide availability. */
  bin: string
  /** Construct the real `@/lsp` client for this language, rooted at `cwd`. */
  create(cwd: string): LspClient
}

const lspProcessTreeKiller = defaultPpidWalkKiller()

const PYRIGHT: ServerSpec = {
  bin: PYRIGHT_LANGSERVER_BIN,
  create: (cwd) => new PyrightAdapter({ cwd, processTreeKiller: lspProcessTreeKiller }),
}
const TYPESCRIPT: ServerSpec = {
  bin: TYPESCRIPT_LANGUAGE_SERVER_BIN,
  create: (cwd) => new TypescriptAdapter({ cwd, processTreeKiller: lspProcessTreeKiller }),
}
const RUST_ANALYZER: ServerSpec = {
  bin: RUST_ANALYZER_BIN,
  create: (cwd) => new RustAnalyzerAdapter({ cwd, processTreeKiller: lspProcessTreeKiller }),
}
const GOPLS: ServerSpec = {
  bin: GOPLS_BIN,
  create: (cwd) => new GoplsAdapter({ cwd, processTreeKiller: lspProcessTreeKiller }),
}
const CLANGD: ServerSpec = {
  bin: CLANGD_BIN,
  create: (cwd) => new ClangdAdapter({ cwd, processTreeKiller: lspProcessTreeKiller }),
}

const SERVER_SPEC_BY_BIN = new Map<string, ServerSpec>([
  [PYRIGHT.bin, PYRIGHT],
  [TYPESCRIPT.bin, TYPESCRIPT],
  [RUST_ANALYZER.bin, RUST_ANALYZER],
  [GOPLS.bin, GOPLS],
  [CLANGD.bin, CLANGD],
])

/** Pick the server for a file by extension, or `null` if unsupported. */
const specFor = (filePath: string): ServerSpec | null => {
  const bin = lspServerBinForFile(filePath)
  return bin === null ? null : (SERVER_SPEC_BY_BIN.get(bin) ?? null)
}

/** Decode a `file://` URI from an LSP response into a filesystem path. Uses the
 *  same `fileURLToPath` as `@/lsp`'s {@link base.ts} so percent-encoding (a
 *  `%20` space, non-ASCII chars) is decoded instead of leaking into the path —
 *  a hand-rolled `replace(/^file:\/\//,"")` would yield the literal `%20`. Non
 *  `file:` URIs (and any malformed URI `fileURLToPath` rejects) fall back to the
 *  raw string so this never throws on these best-effort/null-degrade paths. */
const uriToPath = (uri: string): string => {
  try {
    return fileURLToPath(uri)
  } catch {
    return uri
  }
}

/**
 * ADR-0422 follow-up — lowercase extension → LANGUAGE KEY (the server binary,
 * which is the server identity). Built from the shared lightweight LSP server
 * registry so every caller (agent bridge, mention-injection, remote strict
 * preflight) sees the SAME extension collapse. The anchor synthesizer keys by
 * this value so a multi-extension language collapses to a single anchor (one
 * server, one session), never one anchor per extension. Frozen. */
export const lspExtensionToLanguage = (): ReadonlyMap<string, string> => {
  return lspExtensionToServerBin()
}

/** Probe whether a server binary is launchable. Cached per process so a single
 *  agent run does not re-spawn `--version` for every diagnostics call. */
/** Wall-clock budget for the `<bin> --version` availability probe. Set short
 *  because the probe blocks tool registration / agent startup; a missing or
 *  hung binary must NOT delay the whole session. */
const LSP_AVAILABILITY_TIMEOUT_MS = 5_000

// Cache the in-flight PROBE PROMISE, not the resolved bool. Concurrent
// `isAvailable(bin)` callers (multiple LSP-backed tools initializing at once)
// then share ONE `bin --version` subprocess instead of each racing a cache miss
// and spawning a duplicate. The probe never rejects (errors resolve to `false`),
// so a cached promise is always a settled, reusable result.
//
// Cache ONLY successes (audit #4): a `false` result is evicted once it settles
// so a single transient failure — the 5s race timeout firing under startup
// CPU/IO contention — does NOT permanently disable EVERY LSP surface
// process-wide. Without this, one flaky `bin --version` poisons the cache and
// every later `open()` short-circuits to null + reports "not installed" even
// though the binary IS installed (the recurring "LSP inert" footgun). A cached
// `true` stays permanent (the binary cannot un-install mid-process); concurrent
// callers still share the in-flight probe (it is evicted only AFTER it resolves
// false), so the dedup guarantee is preserved. Mirrors a reset-on-failure
// `once` memoizer.
const availabilityCache = new Map<string, Promise<boolean>>()
let availabilityOverrideForTest: ((bin: string) => boolean | Promise<boolean>) | null = null
const probeAvailable = async (bin: string): Promise<boolean> => {
  try {
    const proc = Bun.spawn([bin, "--version"], { stdout: "pipe", stderr: "pipe" })
    const exit = await Promise.race([
      proc.exited,
      new Promise<number>((r) => setTimeout(() => r(-1), LSP_AVAILABILITY_TIMEOUT_MS)),
    ])
    try {
      proc.kill()
    } catch {
      // already exited
    }
    // Reap the child after kill so no process handle is left dangling. The
    // await is post-kill so it resolves promptly; `.catch` keeps it defensive.
    await proc.exited.catch(() => undefined)
    // Non-zero `--version` still proves the binary resolves; -1 = our timeout.
    return exit !== -1
  } catch {
    return false
  }
}
const isAvailable = (bin: string): Promise<boolean> => {
  if (availabilityOverrideForTest !== null) {
    return Promise.resolve(availabilityOverrideForTest(bin))
  }
  const cached = availabilityCache.get(bin)
  if (cached !== undefined) return cached
  const probe = probeAvailable(bin).then((ok) => {
    // Evict a settled `false` so a transient miss is re-probed next call; a
    // `true` is left cached (permanent, the binary stays installed). The
    // in-flight promise is still shared by concurrent callers above — eviction
    // only happens after it resolves, so the dedup invariant holds.
    if (!ok && availabilityCache.get(bin) === probe) availabilityCache.delete(bin)
    return ok
  })
  availabilityCache.set(bin, probe)
  return probe
}

/** Production-safe availability probe for one language-server binary. Shares
 *  the same per-process cache as the tool surfaces, so a bench preflight and
 *  the later tool/session open do not double-spawn `--version`. */
export const lspBinaryAvailable = (bin: string): Promise<boolean> => isAvailable(bin)

/** TEST-ONLY: clear the per-process availability cache. The cache is a module
 *  singleton (one `bin --version` per process by design — see above), so a test
 *  that probes a real binary leaks a cached `true` into a later test that
 *  overrides `PATH` to force a miss, making the suite order-dependent / flaky.
 *  Resetting in `beforeEach` restores per-test isolation. Mirrors the
 *  `__drain*ForTest` seams elsewhere; NEVER called in production. */
export const __resetLspAvailabilityCacheForTest = (): void => {
  availabilityCache.clear()
}

/** TEST-ONLY: override binary-availability answers so higher-level callers can
 *  drive strict fail-closed rails without depending on the host's installed
 *  language servers. null restores the real cached probe. */
export const __setLspAvailabilityOverrideForTest = (
  override: ((bin: string) => boolean | Promise<boolean>) | null,
): void => {
  availabilityOverrideForTest = override
  availabilityCache.clear()
}

/** TEST-ONLY: drive the cached availability probe for one binary so a unit test
 *  can prove the "cache only successes" contract (audit #4) — a first probe that
 *  resolves `false` (binary off `PATH`) must NOT poison a later probe once the
 *  binary is reachable. Mirrors the other `__*ForTest` seams; NEVER called in
 *  production. */
export const __isLspAvailableForTest = (bin: string): Promise<boolean> => lspBinaryAvailable(bin)

/** TEST-ONLY: report whether a binary currently has a cached availability entry.
 *  Lets a unit test prove that a settled `false` is EVICTED (cache miss) while a
 *  `true` is RETAINED (cache hit) — the core of the "cache only successes"
 *  contract (audit #4). NEVER called in production. */
export const __hasCachedLspAvailabilityForTest = (bin: string): boolean =>
  availabilityCache.has(bin)

/** Idle-TTL (30 minutes) before an unreferenced pyright workspace is reaped
 *  (interactive cross-turn reuse window). Bench overrides lifetime via the
 *  terminal {@link evictLspWorkspaces}. Written as a flat literal (not
 *  `30 * 60_000`) so the magic-timeout scan's arithmetic-form false positive
 *  does not trip. */
const PYRIGHT_NAV_IDLE_TTL_MS = 1_800_000
const PYRIGHT_READY_TIMEOUT_MS = 90_000
const PYRIGHT_READY_RETRY_MS = 1_000
const PYRIGHT_IMPORT_SCAN_LINE_CAP = 200
/** Fallback for abort-aware sleeps when no turn signal is threaded. */
const NEVER_ABORTED: AbortSignal = new AbortController().signal

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
const pyrightPool = new SharedWorkspacePool(pyrightBackend, { idleTtlMs: PYRIGHT_NAV_IDLE_TTL_MS })

/** Registry of warm-capable backends, keyed by {@link ServerSpec}. Adding a
 *  warm engine is ONE entry; the nav provider branches on "is there a warm pool
 *  for this spec?" instead of a hardcoded `spec === PYRIGHT`. */
const warmPools = new Map<ServerSpec, SharedWorkspacePool>([[PYRIGHT, pyrightPool]])

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

/** The real provider: extension → server, with graceful unavailability. */
export const lspDiagnosticsProvider = (): DiagnosticsProvider => ({
  unavailableReason: (filePath) => {
    const spec = specFor(filePath)
    return spec
      ? `${spec.bin} is not installed or not on PATH`
      : `no language server for ${extname(filePath) || "this file type"}`
  },
  open: async (filePath, cwd): Promise<DiagnosticsSession | null> => {
    const spec = specFor(filePath)
    if (!spec) return null
    if (!(await isAvailable(spec.bin))) return null
    const client = spec.create(cwd)
    try {
      await client.start()
    } catch (e) {
      logger.warn("lsp: failed to start language server", { bin: spec.bin, error: errMessage(e) })
      await client.stop().catch(() => undefined)
      return null
    }
    return client
  },
})

/**
 * Build the LSP-backed `diagnostics` tool. The CLI substitutes this for the
 * null-provider one in `defaultTools` (same merge path MCP tools use). Nothing
 * here spawns a server until the tool is actually called.
 */
export const lspDiagnosticsTool = (): Tool => diagnosticsTool(lspDiagnosticsProvider()) as Tool

/** ADR-0405 wiring helper — default edit-class tool → file-path extractor map.
 *  `edit` / `write` take `file_path` in their input schema; `apply_patch`
 *  takes a V4A patch body — the first `*** Update File:` / `*** Add File:`
 *  op header gives the path that should get diagnostics. `Delete` (no file
 *  left to diagnose) and `Move` (requires the `*** Move to:` line) are
 *  intentionally skipped — separate follow-up if a real need surfaces. */
export const lspDefaultEditTools = (): Map<string, (input: unknown) => string | null> => {
  const extractFilePath = (input: unknown): string | null => {
    if (typeof input !== "object" || input === null) return null
    const v = (input as Record<string, unknown>).file_path
    return typeof v === "string" && v.length > 0 ? v : null
  }
  const extractApplyPatchPath = (input: unknown): string | null => {
    if (typeof input !== "object" || input === null) return null
    const patch = (input as Record<string, unknown>).patch
    if (typeof patch !== "string") return null
    const m = patch.match(/^\*\*\* (?:Update|Add) File: (.+)$/m)
    return m?.[1]?.trim() ?? null
  }
  return new Map<string, (input: unknown) => string | null>([
    ["edit", extractFilePath],
    ["write", extractFilePath],
    ["apply_patch", extractApplyPatchPath],
  ])
}

/** ADR-0405 composition wire — config-gated default-OFF attach.
 *  Returns the dispose handle when `cfg.lspDiagnosticsHookEnabled` is true AND
 *  the `AgentConfig` carries both seam slots (`hooks`, `subagentPendingPrompt`);
 *  otherwise returns `undefined` so the loop body is byte-identical. The gate is
 *  env-derived (`QUANTA_LSP_DIAGNOSTICS_HOOK`) at the composition root — this
 *  slice takes a plain boolean and never reads `process.env`. */
export const attachLspDiagnosticsHookIfEnabled = (
  cfg: AgentConfig,
): LspDiagnosticsHookHandle | undefined => {
  if (cfg.lspDiagnosticsHookEnabled !== true) return undefined
  if (cfg.hooks === undefined) return undefined
  if (cfg.subagentPendingPrompt === undefined) return undefined
  return attachLspDiagnosticsHook({
    hooks: cfg.hooks,
    push: cfg.subagentPendingPrompt,
    editTools: lspDefaultEditTools(),
    open: (filePath, cwd) => lspDiagnosticsProvider().open(filePath, cwd),
    cwd: cfg.cwd,
  })
}

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

/**
 * Build the LSP-backed nav tool set (8 tools — see `@/tool/lsp_nav` for the
 * inventory). The CLI appends these to the registry only when
 * `QUANTA_LSP_TOOLS=full` is set; with the knob unset the tool surface is
 * unchanged. Nothing here spawns a server until a tool is actually called.
 */
/* ------------------------------------------------------------------------- *
 * LSP rename (ADR-0404, S2) — the `lsp_rename_apply` mutating tool.
 *
 * Sibling of the read-only nav tools: issues `textDocument/rename` then APPLIES
 * the resulting workspace edit via the 2-phase atomic commit
 * (`LspClient.applyWorkspaceEdit`, ADR-0152). DESTRUCTIVE + always-confirm HITL
 * (owned by the tool factory in `@/tool/lsp_nav/rename-apply.ts`).
 *
 * The tool consumes a `RenameApplyPort` (compute THEN apply, two calls). Both
 * calls must hit the SAME opened server so the edit applies against the state
 * the rename was computed from — so the port is STATEFUL: `computeRename` opens
 * + holds the client; if it yields no edit (null / empty) the client is stopped
 * immediately (the tool will NOT call `applyEdit`); `applyEdit` reuses the held
 * client and stops it in a `finally`. The tool is `isConcurrencySafe:false`, so
 * calls are serialized and a single held slot can never race. Default-OFF:
 * appended to `lspNavToolList()` (same `QUANTA_LSP_TOOLS=full` gate as nav).
 * --------------------------------------------------------------------------*/

/** Stateful `RenameApplyPort` over `specFor` + a per-invocation `LspClient`.
 *  Each `computeRename` opens a fresh client (the rename targets the file's
 *  language server); the matching `applyEdit` reuses and stops it. */
const lspRenameApplyPort = (cwd: string): RenameApplyPort => {
  let held: LspClient | null = null
  const stopHeld = async (): Promise<void> => {
    const c = held
    held = null
    if (c) await c.stop().catch(() => undefined)
  }
  const adapter = (client: LspClient): DefaultRenameApplyAdapter =>
    new DefaultRenameApplyAdapter(client)
  return {
    computeRename: async (file, line, col, newName, signal) => {
      const spec = specFor(file)
      if (!spec) return null
      if (!(await isAvailable(spec.bin))) return null
      // A held client from a prior aborted call must not leak.
      await stopHeld()
      const client = spec.create(cwd)
      try {
        await client.start()
      } catch (e) {
        logger.warn("lsp: failed to start language server (rename)", {
          bin: spec.bin,
          error: errMessage(e),
        })
        await client.stop().catch(() => undefined)
        return null
      }
      held = client
      let edit: RenameWorkspaceEdit | null
      try {
        edit = await adapter(client).computeRename(file, line, col, newName, signal)
      } catch (e) {
        await stopHeld()
        throw e
      }
      // No edit ⇒ the tool short-circuits and never calls `applyEdit`, so stop
      // the held client now to avoid a leaked server.
      if (edit === null || edit.changes.length === 0) await stopHeld()
      return edit
    },
    applyEdit: async (edit, signal) => {
      const client = held
      if (!client) throw new Error("lsp_rename_apply: applyEdit called before computeRename")
      try {
        await adapter(client).applyEdit(edit, signal)
      } finally {
        await stopHeld()
      }
    },
  }
}

/** Best-effort stop helper — logs at debug level if stop throws (clean
 *  degrade on a broken pipe, already-stopped server, etc.). */
const stopClient = (client: LspClient, label: string): Promise<void> =>
  client
    .stop()
    .catch((e: unknown) => logger.debug(`lsp: stop failed (${label})`, { error: errMessage(e) }))

/** Stateless `CodeActionPort` — opens a fresh `LspClient` per call, uses
 *  it, then closes it. `lsp_code_action` is read-only (enumeration only)
 *  but the adapter also wires `applyEdit` for future apply tools. */
const lspCodeActionPort = (getCwd: () => string): CodeActionPort => {
  return {
    resolveCodeActions: async (file, line, col, kind, signal) => {
      const spec = specFor(file)
      if (!spec) return null
      if (!(await isAvailable(spec.bin))) return null
      const client = spec.create(getCwd())
      try {
        await client.start()
      } catch (e) {
        logger.warn("lsp: failed to start language server (code-action)", {
          bin: spec.bin,
          error: errMessage(e),
        })
        await stopClient(client, "code-action/start-fail")
        return null
      }
      try {
        return await new DefaultCodeActionAdapter(client).resolveCodeActions(
          file,
          line,
          col,
          kind,
          signal,
        )
      } finally {
        await stopClient(client, "code-action")
      }
    },
    applyEdit: async (edit, signal) => {
      // applyEdit is not used by lsp_code_action (enumeration only) but the
      // port contract requires it. A dedicated apply tool can reuse this port.
      if (edit.changes.length === 0) return
      // Pick the first file's spec to open a server for the apply.
      const firstUri = edit.changes[0]?.uri
      if (!firstUri) return
      const file = uriToPath(firstUri)
      const spec = specFor(file)
      if (!spec) throw new Error(`lsp_code_action: no server for ${file}`)
      if (!(await isAvailable(spec.bin))) return
      const client = spec.create(getCwd())
      try {
        await client.start()
        await new DefaultCodeActionAdapter(client).applyEdit(edit, signal)
      } finally {
        await stopClient(client, "code-action/apply")
      }
    },
  }
}

/** Stateless `FormatPort` — opens a fresh `LspClient` per call, uses it,
 *  then closes it. Safe: formatting is read-only at the port level (edits
 *  are surfaced, not applied). */
const lspFormatPort = (getCwd: () => string): FormatPort => ({
  format: async (file, range, signal) => {
    const spec = specFor(file)
    if (!spec) return null
    if (!(await isAvailable(spec.bin))) return null
    const client = spec.create(getCwd())
    try {
      await client.start()
    } catch (e) {
      logger.warn("lsp: failed to start language server (format)", {
        bin: spec.bin,
        error: errMessage(e),
      })
      await stopClient(client, "format/start-fail")
      return null
    }
    try {
      return await new DefaultFormatAdapter(client).format(file, range, signal)
    } finally {
      await stopClient(client, "format")
    }
  },
})

/** Stateless `SignatureHelpPort` — opens a fresh `LspClient` per call,
 *  uses it, then closes it. Read-only, concurrency-safe. */
const lspSignatureHelpPort = (getCwd: () => string): SignatureHelpPort => ({
  signatureHelp: async (file, line, col, signal) => {
    const spec = specFor(file)
    if (!spec) return null
    if (!(await isAvailable(spec.bin))) return null
    const client = spec.create(getCwd())
    try {
      await client.start()
    } catch (e) {
      logger.warn("lsp: failed to start language server (signature-help)", {
        bin: spec.bin,
        error: errMessage(e),
      })
      await stopClient(client, "signature-help/start-fail")
      return null
    }
    try {
      return await new DefaultSignatureHelpAdapter(client).signatureHelp(file, line, col, signal)
    } finally {
      await stopClient(client, "signature-help")
    }
  },
})

/**
 * Build the LSP-backed nav tool set (10 read-only nav tools + 1 mutating
 * `lsp_rename_apply` + 1 `lsp_code_action` + 1 `lsp_format` + 1
 * `lsp_signature_help` = 14). The CLI appends these to the registry only when
 * `QUANTA_LSP_TOOLS=full` is set; with the knob unset the tool surface is
 * unchanged (default-OFF, byte-identical). Nothing here spawns a server until
 * a tool is actually called.
 */
export const lspNavToolList = (getCwd: () => string = () => process.cwd()): Tool[] => [
  ...buildLspNavTools(lspNavProvider()),
  lspRenameApplyTool(lspRenameApplyPort(getCwd())) as Tool,
  lspCodeActionTool(lspCodeActionPort(getCwd)) as Tool,
  lspFormatTool(lspFormatPort(getCwd)) as Tool,
  lspSignatureHelpTool(lspSignatureHelpPort(getCwd)) as Tool,
]

/**
 * jun-26 (REPORT-jun26-tool-impl-vs-frontier §4.5) — the CHEAP tier of
 * {@link lspNavToolList}: the read-only nav members that are repo-size-
 * independent (index-backed point queries, single-file outline, indexed
 * symbol lookup, two-hop call-hierarchy, plus code_action / format /
 * signature_help). Excludes (a) the MUTATING `lsp_rename_apply` (never auto-on)
 * and (b) the two MEASURED-intractable members `lsp_references` /
 * `lsp_implementation` ({@link LSP_NAV_EXPENSIVE_TOOL_NAMES}), which stay opt-in
 * / timeout-fenced via the full `lspNavToolList`. Surfaces register THIS list
 * default-ON to expose the above-frontier nav moat without re-introducing the
 * references-timeout regression.
 */
export const lspNavCheapToolList = (getCwd: () => string = () => process.cwd()): Tool[] =>
  lspNavToolList(getCwd).filter((t) => t.isReadOnly() && isCheapLspNavTool(t.name))
