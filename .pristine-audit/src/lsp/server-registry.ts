import { extname } from "node:path"

export const PYRIGHT_LANGSERVER_BIN = "pyright-langserver"
export const TYPESCRIPT_LANGUAGE_SERVER_BIN = "typescript-language-server"
export const RUST_ANALYZER_BIN = "rust-analyzer"
export const GOPLS_BIN = "gopls"
export const CLANGD_BIN = "clangd"

export interface LspServerRegistryEntry {
  readonly bin: string
  readonly exts: readonly string[]
}

// SSOT for extension→language-server routing. Keep pure/lightweight so callers
// like remote bench preflight can import it without pulling the full agent/LSP
// adapter graph into cold-process rails.
export const LSP_SERVER_REGISTRY: ReadonlyArray<LspServerRegistryEntry> = [
  { bin: PYRIGHT_LANGSERVER_BIN, exts: [".py", ".pyi"] },
  {
    bin: TYPESCRIPT_LANGUAGE_SERVER_BIN,
    exts: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
  },
  { bin: RUST_ANALYZER_BIN, exts: [".rs"] },
  { bin: GOPLS_BIN, exts: [".go"] },
  { bin: CLANGD_BIN, exts: [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx", ".h", ".c"] },
] as const

const EXTENSION_TO_SERVER_BIN = new Map<string, string>()
for (const entry of LSP_SERVER_REGISTRY) {
  for (const ext of entry.exts) {
    EXTENSION_TO_SERVER_BIN.set(ext.toLowerCase(), entry.bin)
  }
}

export const lspServerBinForExtension = (ext: string): string | null =>
  EXTENSION_TO_SERVER_BIN.get(ext.toLowerCase()) ?? null

export const lspServerBinForFile = (filePath: string): string | null =>
  lspServerBinForExtension(extname(filePath))

export const lspExtensionToServerBin = (): ReadonlyMap<string, string> =>
  new Map(EXTENSION_TO_SERVER_BIN)

/** The distinct language-server binaries the registry knows about (dedup'd,
 *  stable order). The server-present resource gate iterates this. */
export const LSP_SERVER_BINS: readonly string[] = LSP_SERVER_REGISTRY.map((e) => e.bin)

/** Is ANY known language-server binary resolvable on PATH? The pure core of the
 *  "server-present" resource gate that decides whether the CLI surfaces the
 *  read-only LSP-nav tools by default (mirrors the browser tools self-gating on
 *  a chrome binary). `resolveBin` is injected (the CLI passes `Bun.which`-backed
 *  resolution) so this stays a pure, lightweight leaf with no runtime coupling. */
export const anyLspServerOnPath = (resolveBin: (bin: string) => boolean): boolean =>
  LSP_SERVER_BINS.some((bin) => resolveBin(bin))
