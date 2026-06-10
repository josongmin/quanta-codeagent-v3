import { extname } from "node:path"
import {
  DefaultRenameApplyAdapter,
  GoplsAdapter,
  type LspClient,
  LspRequestError,
  PyrightAdapter,
  type RenameWorkspaceEdit,
  RustAnalyzerAdapter,
  TypescriptAdapter,
} from "@/lsp"
import { errMessage, logger } from "@/shared"
import type { StaticEvidence as EvidenceStatic } from "@/tool"
import {
  lspNavTools as buildLspNavTools,
  type DiagnosticsProvider,
  type DiagnosticsSession,
  diagnosticsTool,
  type LspNavProvider,
  type LspNavSession,
  lspRenameApplyTool,
  type RenameApplyPort,
  type Tool,
} from "@/tool"
import { sleep } from "./loop/sleep"
import { attachLspDiagnosticsHook, type LspDiagnosticsHookHandle } from "./lsp-diagnostics-hook"
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

const PYRIGHT: ServerSpec = {
  bin: "pyright-langserver",
  create: (cwd) => new PyrightAdapter({ cwd }),
}
const TYPESCRIPT: ServerSpec = {
  bin: "typescript-language-server",
  create: (cwd) => new TypescriptAdapter({ cwd }),
}
const RUST_ANALYZER: ServerSpec = {
  bin: "rust-analyzer",
  create: (cwd) => new RustAnalyzerAdapter({ cwd }),
}
const GOPLS: ServerSpec = {
  bin: "gopls",
  create: (cwd) => new GoplsAdapter({ cwd }),
}

/**
 * Single source of extension→server truth (OCP): adding a language is ONE
 * array entry, and both {@link specFor} and the `unavailableReason` closures
 * read from this table so the extension logic is never echoed in two places.
 * Extensions are matched case-insensitively (compared lowercase).
 */
const SERVERS: ReadonlyArray<{ exts: readonly string[]; spec: ServerSpec }> = [
  { exts: [".py", ".pyi"], spec: PYRIGHT },
  { exts: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"], spec: TYPESCRIPT },
  { exts: [".rs"], spec: RUST_ANALYZER },
  { exts: [".go"], spec: GOPLS },
]

/** Pick the server for a file by extension, or `null` if unsupported. */
const specFor = (filePath: string): ServerSpec | null => {
  const ext = extname(filePath).toLowerCase()
  return SERVERS.find((entry) => entry.exts.includes(ext))?.spec ?? null
}

/**
 * ADR-0422 follow-up — lowercase extension → LANGUAGE KEY (the server binary,
 * which is the server identity). Built from the SAME {@link SERVERS} table so
 * the extensions a single server handles (typescript: `.ts`/`.tsx`/`.js`/…)
 * all map to ONE key. The anchor synthesizer keys by this value so a
 * multi-extension language collapses to a single anchor (one server, one
 * session), never one anchor per extension. Frozen. */
export const lspExtensionToLanguage = (): ReadonlyMap<string, string> => {
  const map = new Map<string, string>()
  for (const entry of SERVERS) {
    for (const ext of entry.exts) map.set(ext.toLowerCase(), entry.spec.bin)
  }
  return map
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
const availabilityCache = new Map<string, Promise<boolean>>()
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
  const cached = availabilityCache.get(bin)
  if (cached !== undefined) return cached
  const probe = probeAvailable(bin)
  availabilityCache.set(bin, probe)
  return probe
}

/** TEST-ONLY: clear the per-process availability cache. The cache is a module
 *  singleton (one `bin --version` per process by design — see above), so a test
 *  that probes a real binary leaks a cached `true` into a later test that
 *  overrides `PATH` to force a miss, making the suite order-dependent / flaky.
 *  Resetting in `beforeEach` restores per-test isolation. Mirrors the
 *  `__drain*ForTest` seams elsewhere; NEVER called in production. */
export const __resetLspAvailabilityCacheForTest = (): void => {
  availabilityCache.clear()
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
 *  Mirrors {@link lspDiagnosticsProvider} exactly — reuses the same
 *  `specFor` + `isAvailable` machinery so a single per-process binary probe
 *  serves both diagnostics and nav. */
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
 * server / no symbol / abort ⇒ null, never a crash. A fresh server is spawned
 * per call (acceptable for an opt-in, always-confirm tool).
 */
/** Delay between column-scan sweeps while the server is still indexing. */
const EVIDENCE_LSP_RETRY_DELAY_MS = 500
/** Fallback for the abort-aware {@link sleep} when no turn signal is threaded. */
const NEVER_ABORTED: AbortSignal = new AbortController().signal
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
    const toLoc = (l: { uri: string; range: { start: { line: number } } }): { file: string; line: number } => ({
      file: l.uri.replace(/^file:\/\//, ""),
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

/**
 * Build the LSP-backed nav tool set (8 read-only nav tools + 1 mutating
 * `lsp_rename_apply` = 9). The CLI appends these to the registry only when
 * `QUANTA_LSP_TOOLS=full` is set; with the knob unset the tool surface is
 * unchanged (default-OFF, byte-identical). Nothing here spawns a server until
 * a tool is actually called.
 */
export const lspNavToolList = (): Tool[] => [
  ...buildLspNavTools(lspNavProvider()),
  lspRenameApplyTool(lspRenameApplyPort(process.cwd())) as Tool,
]
