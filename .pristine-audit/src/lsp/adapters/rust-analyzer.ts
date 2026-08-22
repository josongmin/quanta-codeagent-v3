import { LspClient, type LspClientOptions } from "./base"

export type RustAnalyzerAdapterOptions = LspClientOptions

// rust-analyzer speaks LSP over stdio by default (no `--stdio` flag, unlike
// pyright/tsserver). It is project-oriented — root it at the cargo workspace.
const DEFAULT_COMMAND = ["rust-analyzer"]

/** A real LSP client for rust-analyzer over stdio. All mechanics live in
 *  {@link LspClient}; rust-analyzer only contributes its launcher and the fact
 *  that every file it sees is Rust. */
export class RustAnalyzerAdapter extends LspClient {
  constructor(options: RustAnalyzerAdapterOptions = {}) {
    super({ defaultCommand: DEFAULT_COMMAND, languageIdFor: () => "rust" }, options)
  }
}
