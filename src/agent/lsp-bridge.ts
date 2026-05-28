import { extname } from "node:path"
import {
  DefaultRenameApplyAdapter,
  type LspClient,
  PyrightAdapter,
  type RenameWorkspaceEdit,
  TypescriptAdapter,
} from "@/lsp"
import { logger } from "@/shared"
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

/**
 * Single source of extension→server truth (OCP): adding a language is ONE
 * array entry, and both {@link specFor} and the `unavailableReason` closures
 * read from this table so the extension logic is never echoed in two places.
 * Extensions are matched case-insensitively (compared lowercase).
 */
const SERVERS: ReadonlyArray<{ exts: readonly string[]; spec: ServerSpec }> = [
  { exts: [".py", ".pyi"], spec: PYRIGHT },
  { exts: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"], spec: TYPESCRIPT },
]

/** Pick the server for a file by extension, or `null` if unsupported. */
const specFor = (filePath: string): ServerSpec | null => {
  const ext = extname(filePath).toLowerCase()
  return SERVERS.find((entry) => entry.exts.includes(ext))?.spec ?? null
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
      logger.warn("lsp: failed to start language server", { bin: spec.bin, error: String(e) })
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

/** ADR-0381 wiring helper — default edit-class tool → file-path extractor map.
 *  Quanta's `edit` and `write` tools take `file_path` in their input schema.
 *  `apply_patch` requires patch-body parsing and is intentionally out of
 *  scope (separate follow-up). */
export const lspDefaultEditTools = (): Map<string, (input: unknown) => string | null> => {
  const extractFilePath = (input: unknown): string | null => {
    if (typeof input !== "object" || input === null) return null
    const v = (input as Record<string, unknown>).file_path
    return typeof v === "string" && v.length > 0 ? v : null
  }
  return new Map([
    ["edit", extractFilePath],
    ["write", extractFilePath],
  ])
}

/** ADR-0381 composition wire — env-gated default-OFF attach.
 *  Returns the dispose handle when `QUANTA_LSP_DIAGNOSTICS_HOOK=1` AND the
 *  `AgentConfig` carries both seam slots (`hooks`, `subagentPendingPrompt`);
 *  otherwise returns `undefined` so the loop body is byte-identical. */
export const attachLspDiagnosticsHookIfEnabled = (
  cfg: AgentConfig,
): LspDiagnosticsHookHandle | undefined => {
  if (process.env.QUANTA_LSP_DIAGNOSTICS_HOOK !== "1") return undefined
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
  definition: (file, pos) => client.definition(file, pos),
  references: (file, pos, includeDeclaration) => client.references(file, pos, includeDeclaration),
  hover: (file, pos) => client.hover(file, pos),
  typeDefinition: (file, pos) => client.typeDefinition(file, pos),
  implementation: (file, pos) => client.implementation(file, pos),
  documentSymbol: (file) => client.documentSymbol(file),
  workspaceSymbol: (query) => client.workspaceSymbol(query),
  prepareRename: (file, pos) => client.prepareRename(file, pos),
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
  open: async (filePath, cwd): Promise<LspNavSession | null> => {
    const spec = specFor(filePath)
    if (!spec) return null
    if (!(await isAvailable(spec.bin))) return null
    const client = spec.create(cwd)
    try {
      await client.start()
    } catch (e) {
      logger.warn("lsp: failed to start language server (nav)", {
        bin: spec.bin,
        error: String(e),
      })
      await client.stop().catch(() => undefined)
      return null
    }
    return adaptToNavSession(client)
  },
})

/**
 * Build the LSP-backed nav tool set (8 tools — see `@/tool/lsp_nav` for the
 * inventory). The CLI appends these to the registry only when
 * `QUANTA_LSP_TOOLS=full` is set; with the knob unset the tool surface is
 * unchanged. Nothing here spawns a server until a tool is actually called.
 */
/* ------------------------------------------------------------------------- *
 * LSP rename (ADR-0380, S2) — the `lsp_rename_apply` mutating tool.
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
          error: String(e),
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
