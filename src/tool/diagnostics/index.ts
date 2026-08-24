import { z } from "zod"
import { errMessage } from "@/shared"
import { FsJailError, resolveJailed } from "@/storage"
import type { CoreToolContext, Tool, ToolEvent } from "../types"

/**
 * `diagnostics` tool — surfaces language-server errors/warnings for one file.
 *
 * Slice isolation (RFC §3.1, enforced by biome): `@/tool` MUST NOT import
 * `@/lsp`. So this file owns no LSP knowledge; it talks to an injected
 * {@link DiagnosticsProvider}. The real provider that knows about pyright /
 * typescript-language-server is assembled in `src/agent/lsp-bridge.ts` (the
 * agent slice is the only assembler allowed to cross slices — exactly how
 * `mcp-bridge.ts` adapts MCP). This keeps the tool unit-testable with a fake
 * provider in the normal gate (no real server needed).
 */

/** One normalized diagnostic. Structurally compatible with `@/lsp`'s
 *  `Diagnostic` but declared here so the tool stays slice-isolated. */
export interface DiagnosticItem {
  severity: "error" | "warning" | "information" | "hint"
  message: string
  /** Zero-based LSP coordinates. */
  range: { start: { line: number; character: number } }
  source?: string
  code?: string
}

/** A short-lived language-server session for a single analysis. */
export interface DiagnosticsSession {
  diagnostics(filePath: string): Promise<DiagnosticItem[]>
  stop(): Promise<void>
}

/**
 * Resolves a session for a file, or `null` when no server can handle it
 * (unsupported extension, or the binary is not installed). Returning `null`
 * is how graceful degradation reaches the tool — it never throws/hangs.
 */
export interface DiagnosticsProvider {
  /** Human-readable reason used in the no-op result when `open` returns null. */
  unavailableReason(filePath: string): string
  open(filePath: string, cwd: string): Promise<DiagnosticsSession | null>
}

// R3 audit-M3 cap. PATH_MAX on Linux is 4096; macOS HFS+ caps individual
// components at 255 but allows long total paths; pyright/typescript-lsp both
// process the path as a single string. Bounding to PATH_MAX keeps the
// LSP-spawn surface within OS-native limits and rejects pathological inputs
// before they ever reach `resolveJailed`. min(1) blocks an empty string from
// reaching the jail (which would resolve to cwd).
const MAX_PATH_CHARS = 4096

const schema = z.object({
  path: z
    .string()
    .min(1)
    .max(MAX_PATH_CHARS)
    .describe("File to type-check / lint via its language server"),
})

type Input = z.infer<typeof schema>

const SEVERITY_RANK: Record<DiagnosticItem["severity"], number> = {
  error: 0,
  warning: 1,
  information: 2,
  hint: 3,
}

/** Format one diagnostic as `path:line:col severity message [source/code]`,
 *  converting zero-based LSP coords to 1-based display coords. */
const formatOne = (path: string, d: DiagnosticItem): string => {
  const line = d.range.start.line + 1
  const col = d.range.start.character + 1
  const tag = [d.source, d.code].filter(Boolean).join(" ")
  const suffix = tag ? ` [${tag}]` : ""
  return `${path}:${line}:${col} ${d.severity} ${d.message.replace(/\s+/g, " ").trim()}${suffix}`
}

/** Pure formatter (exported for unit tests): stable, severity-then-position
 *  ordered, with a one-line error/warning summary header. */
export const formatDiagnostics = (path: string, diags: DiagnosticItem[]): string => {
  if (diags.length === 0) return `${path}: no diagnostics`
  const sorted = [...diags].sort((a, b) => {
    const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    if (s !== 0) return s
    return a.range.start.line - b.range.start.line
  })
  const errors = diags.filter((d) => d.severity === "error").length
  const warnings = diags.filter((d) => d.severity === "warning").length
  const header = `${path}: ${errors} error(s), ${warnings} warning(s)`
  return [header, ...sorted.map((d) => formatOne(path, d))].join("\n")
}

/**
 * Default provider used by `defaultTools`: no server is wired, so every file
 * degrades to a clean no-op result. The CLI swaps in the real LSP-backed
 * provider via `src/agent/lsp-bridge.ts` when language servers are present.
 * This keeps `defaultTools` static and slice-isolated while still genuinely
 * registering the tool (RFC-faithful: the agent can always call it).
 */
export const nullDiagnosticsProvider: DiagnosticsProvider = {
  unavailableReason: () => "no language server configured",
  open: async () => null,
}

/**
 * Build the `diagnostics` tool around a provider. Conservative flags:
 * read-only (it only opens the document, never mutates) and NOT
 * concurrency-safe (each call drives a subprocess language server).
 */
export const diagnosticsTool = (provider: DiagnosticsProvider): Tool<Input> => ({
  name: "diagnostics",
  description:
    "Report language-server diagnostics (type errors, lint) for a single file. " +
    "Supports Python (pyright) and JS/TS (typescript-language-server). " +
    "Returns a clean message when no server is available — never fails the turn.",
  inputSchema: schema,
  isReadOnly: () => true,
  isConcurrencySafe: () => false,
  async *execute(input: Input, ctx: CoreToolContext): AsyncIterable<ToolEvent> {
    // S14: jail before opening — `path: "/etc/shadow"` would otherwise be
    // opened by the LSP. The branded JailedPath is the only path the LSP
    // provider may receive.
    let abs: string
    try {
      abs = resolveJailed(input.path, ctx.cwd)
    } catch (e) {
      if (e instanceof FsJailError) {
        yield { type: "result", result: { ok: false, output: e.message } }
        return
      }
      throw e
    }

    let session: DiagnosticsSession | null
    try {
      session = await provider.open(abs, ctx.cwd)
    } catch (e) {
      // Spawn/handshake failure must degrade gracefully, not crash the turn.
      yield {
        type: "result",
        result: { ok: false, output: `diagnostics unavailable: ${errMessage(e)}` },
      }
      return
    }

    if (!session) {
      yield {
        type: "result",
        result: {
          ok: false,
          output: `diagnostics unavailable: ${provider.unavailableReason(abs)}`,
        },
      }
      return
    }

    yield { type: "progress", message: `analyzing ${input.path}` }
    try {
      const diags = await session.diagnostics(abs)
      const hasError = diags.some((d) => d.severity === "error")
      yield {
        type: "result",
        result: { ok: !hasError, output: formatDiagnostics(input.path, diags) },
      }
    } catch (e) {
      yield {
        type: "result",
        result: { ok: false, output: `diagnostics failed: ${errMessage(e)}` },
      }
    } finally {
      await session.stop().catch(() => undefined)
    }
  },
})
