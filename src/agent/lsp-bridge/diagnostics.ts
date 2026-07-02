import { extname } from "node:path"
import { errMessage, logger } from "@/shared"
import {
  type DiagnosticsProvider,
  type DiagnosticsSession,
  diagnosticsTool,
  type Tool,
} from "@/tool"
import {
  attachLspDiagnosticsHook,
  type LspDiagnosticsHookHandle,
} from "../lsp-diagnostics-hook"
import type { AgentConfig } from "../types"
import { isAvailable } from "./availability"
import { specFor } from "./servers"

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
