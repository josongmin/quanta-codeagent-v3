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
 *
 * COMPOSITION BARREL — the implementation is split by responsibility (SRP) into
 * cohesive sibling modules under `./lsp-bridge/`; this file re-exports the full
 * public surface so every existing `@/agent/lsp-bridge` import keeps working:
 *   - `servers.ts`      per-language `ServerSpec` roster + `specFor` / `uriToPath`
 *   - `availability.ts` `<bin> --version` per-process probe cache
 *   - `warm-pool.ts`    pyright warm-workspace pool, prewarm, strict-ready proof
 *   - `diagnostics.ts`  the `diagnostics` tool provider + edit-hook wiring
 *   - `nav.ts`          nav provider + the keystone `evidenceLspStatic` port
 *   - `tools.ts`        rename/code-action/format/signature ports + nav tool list
 */

export { lspExtensionToLanguage } from "./lsp-bridge/servers"
export {
  __hasCachedLspAvailabilityForTest,
  __isLspAvailableForTest,
  __resetLspAvailabilityCacheForTest,
  __setLspAvailabilityOverrideForTest,
  lspBinaryAvailable,
} from "./lsp-bridge/availability"
export {
  __findPyrightImportProbeForTest,
  __resetSharedPyrightSessionsForTest,
  __setPyrightClientFactoryForTest,
  __setPyrightWarmupTimingForTest,
  evictLspWorkspaces,
  prewarmLspWorkspace,
  proveStrictLspReady,
  resolvePrewarmAnchor,
  startBackgroundLspPrewarm,
} from "./lsp-bridge/warm-pool"
export {
  attachLspDiagnosticsHookIfEnabled,
  lspDefaultEditTools,
  lspDiagnosticsProvider,
  lspDiagnosticsTool,
} from "./lsp-bridge/diagnostics"
export { evidenceLspStatic, lspNavProvider } from "./lsp-bridge/nav"
export { lspNavCheapToolList, lspNavToolList } from "./lsp-bridge/tools"
