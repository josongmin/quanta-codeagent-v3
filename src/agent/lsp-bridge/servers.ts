import { fileURLToPath } from "node:url"
import {
  CLANGD_BIN,
  ClangdAdapter,
  GOPLS_BIN,
  GoplsAdapter,
  type LspClient,
  lspExtensionToServerBin,
  lspServerBinForFile,
  PYRIGHT_LANGSERVER_BIN,
  PyrightAdapter,
  RUST_ANALYZER_BIN,
  RustAnalyzerAdapter,
  TYPESCRIPT_LANGUAGE_SERVER_BIN,
  TypescriptAdapter,
} from "@/lsp"
import { defaultPpidWalkKiller } from "@/runtime"
import { errMessage, logger } from "@/shared"
import {
  assertWorkspaceTrusted,
  isWorkspaceTrusted,
  WorkspaceUntrustedError,
} from "../workspace-trust"

/**
 * Per-language wiring. The launcher argv and `languageId` mapping are NOT
 * duplicated here — they are owned by `@/lsp`'s {@link PyrightAdapter} /
 * {@link TypescriptAdapter}. The only bridge-local datum is `bin`: the probe
 * needs to run the resolver with `--version` (not the adapter's `--stdio`
 * launch), and `unavailableReason` reports it.
 *
 * `create` is the ONLY way the agent constructs a language server (a census test holds
 * every `new *Adapter(` in `src/` to this file), and every client it returns checks
 * workspace trust at the spawn: a server executes code from its workspace, so it starts
 * only when `trustRoot` (default: the server's own `cwd`) is a trusted folder. A caller
 * whose `cwd` is a scratch copy passes the folder the copy came from.
 */
export interface ServerSpec {
  /** Argv[0] probed with `--version` to decide availability. */
  bin: string
  /** Construct the real `@/lsp` client for this language, rooted at `cwd`. */
  create(cwd: string, trustRoot?: string): LspClient
}

const lspProcessTreeKiller = defaultPpidWalkKiller()

const gated = (bin: string, cwd: string, trustRoot: string | undefined) => ({
  cwd,
  processTreeKiller: lspProcessTreeKiller,
  beforeSpawn: () => assertWorkspaceTrusted(`Language server ${bin}`, trustRoot ?? cwd),
})

export const PYRIGHT: ServerSpec = {
  bin: PYRIGHT_LANGSERVER_BIN,
  // SEC-2: pyright EXECUTES its `pythonPath`, so a repo-relative `.venv/bin/python`
  // is arbitrary code execution. The trust authority (ADR-0559) is the ONLY consent:
  // an untrusted folder never spawns a server at all (`beforeSpawn`), and a folder the
  // operator trusted (sep-14 U-5: "trusted folders as today — the repo's venv
  // interpreter") is exactly where using its own venv is intended. No separate env
  // knob — that would be an orphan gate the trust authority already subsumes.
  create: (cwd, trustRoot) =>
    new PyrightAdapter({
      ...gated(PYRIGHT_LANGSERVER_BIN, cwd, trustRoot),
      allowWorkspaceInterpreter: isWorkspaceTrusted(trustRoot ?? cwd),
    }),
}
export const TYPESCRIPT: ServerSpec = {
  bin: TYPESCRIPT_LANGUAGE_SERVER_BIN,
  create: (cwd, trustRoot) =>
    new TypescriptAdapter(gated(TYPESCRIPT_LANGUAGE_SERVER_BIN, cwd, trustRoot)),
}
const RUST_ANALYZER: ServerSpec = {
  bin: RUST_ANALYZER_BIN,
  create: (cwd, trustRoot) => new RustAnalyzerAdapter(gated(RUST_ANALYZER_BIN, cwd, trustRoot)),
}
const GOPLS: ServerSpec = {
  bin: GOPLS_BIN,
  create: (cwd, trustRoot) => new GoplsAdapter(gated(GOPLS_BIN, cwd, trustRoot)),
}
const CLANGD: ServerSpec = {
  bin: CLANGD_BIN,
  create: (cwd, trustRoot) => new ClangdAdapter(gated(CLANGD_BIN, cwd, trustRoot)),
}

const SERVER_SPEC_BY_BIN = new Map<string, ServerSpec>([
  [PYRIGHT.bin, PYRIGHT],
  [TYPESCRIPT.bin, TYPESCRIPT],
  [RUST_ANALYZER.bin, RUST_ANALYZER],
  [GOPLS.bin, GOPLS],
  [CLANGD.bin, CLANGD],
])

/** Start `client`, or stop it and answer `false` when it could not start. A workspace-trust
 *  refusal is not "could not start": it is rethrown, so the tool tells the model and the
 *  operator why, instead of reporting that no language server exists. */
export const startLspClient = async (
  client: LspClient,
  bin: string,
  label: string,
  signal?: AbortSignal,
): Promise<boolean> => {
  try {
    await client.start(signal)
    return true
  } catch (e) {
    await client.stop().catch(() => undefined)
    if (e instanceof WorkspaceUntrustedError) throw e
    logger.warn(`lsp: failed to start language server (${label})`, { bin, error: errMessage(e) })
    return false
  }
}

/** Pick the server for a file by extension, or `null` if unsupported. */
export const specFor = (filePath: string): ServerSpec | null => {
  const bin = lspServerBinForFile(filePath)
  return bin === null ? null : (SERVER_SPEC_BY_BIN.get(bin) ?? null)
}

/** Decode a `file://` URI from an LSP response into a filesystem path. Uses the
 *  same `fileURLToPath` as `@/lsp`'s {@link base.ts} so percent-encoding (a
 *  `%20` space, non-ASCII chars) is decoded instead of leaking into the path —
 *  a hand-rolled `replace(/^file:\/\//,"")` would yield the literal `%20`. Non
 *  `file:` URIs (and any malformed URI `fileURLToPath` rejects) fall back to the
 *  raw string so this never throws on these best-effort/null-degrade paths. */
export const uriToPath = (uri: string): string => {
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

/** Fallback for abort-aware sleeps when no turn signal is threaded. */
export const NEVER_ABORTED: AbortSignal = new AbortController().signal
