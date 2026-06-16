import { LspClient, type LspClientOptions } from "./base"

export type PyrightAdapterOptions = LspClientOptions

const DEFAULT_COMMAND = ["pyright-langserver", "--stdio"]
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const DEFAULT_WORKSPACE_CONFIGURATION = {
  python: {
    analysis: {
      diagnosticMode: "openFilesOnly",
      indexing: false,
      autoImportCompletions: false,
      autoSearchPaths: false,
      useLibraryCodeForTypes: true,
    },
  },
} as const

const withPyrightDefaults = (options: PyrightAdapterOptions): PyrightAdapterOptions => {
  const cwd = options.cwd ?? process.cwd()
  return {
    ...options,
    cwd,
    requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    workspaceFolders: options.workspaceFolders ?? [cwd],
    workspaceConfiguration: options.workspaceConfiguration ?? DEFAULT_WORKSPACE_CONFIGURATION,
  }
}

/** A real LSP client for Pyright over stdio. All mechanics live in
 *  {@link LspClient}; Pyright only contributes its launcher and the fact that
 *  every file it sees is Python. */
export class PyrightAdapter extends LspClient {
  constructor(options: PyrightAdapterOptions = {}) {
    super(
      { defaultCommand: DEFAULT_COMMAND, languageIdFor: () => "python" },
      withPyrightDefaults(options),
    )
  }
}
