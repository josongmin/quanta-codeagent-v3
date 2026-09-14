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
import { envFileSourceOf } from "@/shared/env-files"

/**
 * Per-language wiring. The launcher argv and `languageId` mapping are NOT
 * duplicated here — they are owned by `@/lsp`'s {@link PyrightAdapter} /
 * {@link TypescriptAdapter}. The only bridge-local datum is `bin`: the probe
 * needs to run the resolver with `--version` (not the adapter's `--stdio`
 * launch), and `unavailableReason` reports it.
 */
export interface ServerSpec {
  /** Argv[0] probed with `--version` to decide availability. */
  bin: string
  /** Construct the real `@/lsp` client for this language, rooted at `cwd`. */
  create(cwd: string): LspClient
}

const lspProcessTreeKiller = defaultPpidWalkKiller()

// SEC-2 — a workspace-relative Python interpreter is repo-controlled and pyright
// EXECUTES it. Default-OFF: the interactive CLI on a cloned repo uses a system
// interpreter (safe). A trusted/bench context that legitimately needs the repo's
// own venv opts in with QUANTA_LSP_TRUST_WORKSPACE=1 — but consent counts ONLY
// from the REAL env. Round-1 audit CRITICAL fix: SEC-1 scrubs only the base-URL
// keys, so without this provenance check a cloned repo's `.env` could set
// QUANTA_LSP_TRUST_WORKSPACE=1 and self-arm the very RCE this guards (a poisoned
// `.venv/bin/python`). Mirrors the SEC-1 egress opt-in: `envFileSourceOf` returns
// a path iff a dotenv file supplied the value, so a dotenv-sourced opt-in is void.
const trustWorkspaceInterpreter = (): boolean =>
  process.env.QUANTA_LSP_TRUST_WORKSPACE === "1" &&
  envFileSourceOf("QUANTA_LSP_TRUST_WORKSPACE") === undefined

export const PYRIGHT: ServerSpec = {
  bin: PYRIGHT_LANGSERVER_BIN,
  create: (cwd) =>
    new PyrightAdapter({
      cwd,
      processTreeKiller: lspProcessTreeKiller,
      allowWorkspaceInterpreter: trustWorkspaceInterpreter(),
    }),
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
