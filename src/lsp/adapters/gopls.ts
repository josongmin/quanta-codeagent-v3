import { LspClient, type LspClientOptions } from "./base"

export type GoplsAdapterOptions = LspClientOptions

// gopls speaks LSP over stdio by default (its default subcommand is `serve`,
// which communicates over stdin/stdout) — no `--stdio` flag, like rust-analyzer.
// It is workspace-oriented: root it at the Go module directory.
const DEFAULT_COMMAND = ["gopls"]

/** A real LSP client for gopls (the Go language server) over stdio. All
 *  mechanics live in {@link LspClient}; gopls only contributes its launcher and
 *  the fact that every file it sees is Go. */
export class GoplsAdapter extends LspClient {
  constructor(options: GoplsAdapterOptions = {}) {
    super({ defaultCommand: DEFAULT_COMMAND, languageIdFor: () => "go" }, options)
  }
}
