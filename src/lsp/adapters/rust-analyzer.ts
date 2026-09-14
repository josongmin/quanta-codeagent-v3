import { LspClient, type LspClientOptions } from "./base"

export type RustAnalyzerAdapterOptions = LspClientOptions

// rust-analyzer speaks LSP over stdio by default (no `--stdio` flag, unlike
// pyright/tsserver). It is project-oriented — root it at the cargo workspace.
const DEFAULT_COMMAND = ["rust-analyzer"]

/**
 * SEC-2 — rust-analyzer's UPSTREAM DEFAULTS run repo-controlled code while merely
 * analysing a Rust project: build scripts (`build.rs`) and procedural macros are
 * compiled and executed, and `checkOnSave` shells out to `cargo check`. On an
 * untrusted cloned repo that is arbitrary code execution outside the sandbox.
 * This config, returned for the server's `rust-analyzer` `workspace/configuration`
 * section (the base resolves dotted sections against this object), disables all
 * three execution vectors.
 *
 * NOTE (honesty): runtime-UNVERIFIED — no rust-analyzer is installed in this
 * environment to prove the server honours it end-to-end. The shape follows the
 * documented `rust-analyzer.*` settings; the test asserts the config STRUCTURE,
 * not prevented execution. Treated as defense-in-depth config, not a proven gate.
 */
export const buildRustAnalyzerHardening = (): Record<string, unknown> => ({
  "rust-analyzer": {
    cargo: { buildScripts: { enable: false }, runBuildScripts: false },
    procMacro: { enable: false, attributes: { enable: false } },
    checkOnSave: false,
    check: { command: "" },
  },
})

/** A real LSP client for rust-analyzer over stdio. All mechanics live in
 *  {@link LspClient}; rust-analyzer only contributes its launcher and the fact
 *  that every file it sees is Rust. */
export class RustAnalyzerAdapter extends LspClient {
  constructor(options: RustAnalyzerAdapterOptions = {}) {
    super(
      { defaultCommand: DEFAULT_COMMAND, languageIdFor: () => "rust" },
      {
        ...options,
        // SEC-2 hardening is the DEFAULT; a caller may still override with an
        // explicit `workspaceConfiguration` (e.g. a trusted bench sandbox).
        workspaceConfiguration: options.workspaceConfiguration ?? buildRustAnalyzerHardening(),
      },
    )
  }
}
