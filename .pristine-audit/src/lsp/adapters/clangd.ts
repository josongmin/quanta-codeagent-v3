import { LspClient, type LspClientOptions } from "./base"

export type ClangdAdapterOptions = LspClientOptions

// clangd speaks LSP over stdio by default (no `--stdio` flag, like rust-analyzer
// and gopls). It reads `compile_commands.json` (CMake `-DCMAKE_EXPORT_COMPILE_
// COMMANDS=ON`) for accurate cross-TU navigation; without it, single-file mode.
const DEFAULT_COMMAND = ["clangd"]

/** A real LSP client for clangd (C/C++/Objective-C) over stdio. All mechanics
 *  live in {@link LspClient}; clangd contributes its launcher and the C-family
 *  languageId by extension. */
export class ClangdAdapter extends LspClient {
  constructor(options: ClangdAdapterOptions = {}) {
    super(
      {
        defaultCommand: DEFAULT_COMMAND,
        languageIdFor: (file) => {
          const f = file.toLowerCase()
          if (f.endsWith(".c")) return "c"
          if (f.endsWith(".h")) return "c" // headers default to c (clangd infers C++ from content/CDB)
          return "cpp"
        },
      },
      options,
    )
  }
}
