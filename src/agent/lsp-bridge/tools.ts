import type { CodeActionPort, FormatPort, SignatureHelpPort } from "@/lsp"
import {
  DefaultCodeActionAdapter,
  DefaultFormatAdapter,
  DefaultRenameApplyAdapter,
  DefaultSignatureHelpAdapter,
  type LspClient,
  type RenameWorkspaceEdit,
} from "@/lsp"
import { errMessage, logger } from "@/shared"
import {
  assertWorkspaceEditJailed,
  lspNavTools as buildLspNavTools,
  isCheapLspNavTool,
  lspCodeActionTool,
  lspFormatTool,
  lspRenameApplyTool,
  lspSignatureHelpTool,
  type RenameApplyPort,
  type Tool,
} from "@/tool"
import { isAvailable } from "./availability"
import { lspNavProvider } from "./nav"
import { specFor, startLspClient, uriToPath } from "./servers"

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
      if (!(await startLspClient(client, spec.bin, "rename"))) return null
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
export const lspCodeActionPort = (getCwd: () => string): CodeActionPort => {
  return {
    resolveCodeActions: async (file, line, col, kind, signal) => {
      const spec = specFor(file)
      if (!spec) return null
      if (!(await isAvailable(spec.bin))) return null
      const client = spec.create(getCwd())
      if (!(await startLspClient(client, spec.bin, "code-action"))) return null
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
      //
      // FS-JAIL (aug-23) — same seam as `lsp_rename_apply`: every target URI
      // here was chosen by the LANGUAGE SERVER, and the `@/lsp` writer applies
      // it with no containment check. Guard FIRST — before server selection or
      // any process contact — so an out-of-workspace target can never reach
      // disk. All-or-nothing (throws `FsJailError`); a partial apply would
      // leave a half-applied refactor.
      assertWorkspaceEditJailed(edit, getCwd(), "lsp_code_action")
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
    if (!(await startLspClient(client, spec.bin, "format"))) return null
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
    if (!(await startLspClient(client, spec.bin, "signature-help"))) return null
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
