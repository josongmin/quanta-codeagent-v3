import { extname } from "node:path"
import { type LspClient, PyrightAdapter, TypescriptAdapter } from "@/lsp"
import { logger } from "@/shared"
import {
  type DiagnosticsProvider,
  type DiagnosticsSession,
  diagnosticsTool,
  type Tool,
} from "@/tool"

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

/** Pick the server for a file by extension, or `null` if unsupported. */
const specFor = (filePath: string): ServerSpec | null => {
  const ext = extname(filePath).toLowerCase()
  if (ext === ".py" || ext === ".pyi") return PYRIGHT
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return TYPESCRIPT
  return null
}

/** Probe whether a server binary is launchable. Cached per process so a single
 *  agent run does not re-spawn `--version` for every diagnostics call. */
const availabilityCache = new Map<string, boolean>()
const isAvailable = async (bin: string): Promise<boolean> => {
  const cached = availabilityCache.get(bin)
  if (cached !== undefined) return cached
  let ok = false
  try {
    const proc = Bun.spawn([bin, "--version"], { stdout: "pipe", stderr: "pipe" })
    const exit = await Promise.race([
      proc.exited,
      new Promise<number>((r) => setTimeout(() => r(-1), 5_000)),
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
    ok = exit !== -1
  } catch {
    ok = false
  }
  availabilityCache.set(bin, ok)
  return ok
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
