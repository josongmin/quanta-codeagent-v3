import { existsSync } from "node:fs"
import { join } from "node:path"
import { LspClient, type LspClientOptions } from "./base"

export type PyrightAdapterOptions = LspClientOptions

const DEFAULT_COMMAND = ["pyright-langserver", "--stdio"]
// jun-19 MEASUREMENT: raised 15s→60s to learn whether `textDocument/references`
// EVER returns on a large repo (sympy) or is intractable. If it returns within
// 60s → band-aid viable (and measure if grounding then recovers localization);
// if it still times out → references is intractable, needs a precomputed
// (tree-sitter/ripgrep) ref index, not pyright. REVERT to 15_000 after the probe.
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000

/** Resolve the Python interpreter pyright should use for `workspaceFolders`
 *  mode. WITHOUT a `pythonPath`, pyright cannot set up the workspace's import
 *  environment and silently HANGS every request (definition/references time
 *  out forever — even on a 3-line file). Prefer the task's own venv (the bench
 *  sandbox creates one), then a PATH interpreter, then the bare name so pyright
 *  can still try its own discovery. */
export const resolvePythonInterpreter = (cwd: string): string => {
  for (const rel of [
    ".venv/bin/python",
    ".venv/bin/python3",
    "venv/bin/python",
    "venv/bin/python3",
  ]) {
    const p = join(cwd, rel)
    if (existsSync(p)) return p
  }
  return Bun.which("python3") ?? Bun.which("python") ?? "python3"
}

/** The settings pyright pulls via `workspace/configuration`. cwd-aware: the
 *  repo root must be on the import path (`extraPaths` + `autoSearchPaths`) so a
 *  project-local package (`import django`) resolves cross-file, and a real
 *  `pythonPath` must be present or pyright hangs (see above). */
const buildWorkspaceConfiguration = (cwd: string): Record<string, unknown> => {
  const pythonPath = resolvePythonInterpreter(cwd)
  return {
    python: {
      pythonPath,
      defaultInterpreterPath: pythonPath,
      analysis: {
        diagnosticMode: "openFilesOnly",
        // jun-19 MEASURED: `indexing:true` does NOT fix the `textDocument/references`
        // 15s timeout on large repos (sympy-17630 still timed out with it ON).
        // `python.analysis.indexing` covers workspace-symbol / auto-import / installed
        // packages — NOT find-references, which must type-analyze every possibly-
        // referencing file on-demand (fundamentally slow on sympy under openFilesOnly).
        // → references-timeout fix is NOT a pyright config knob; it needs a precomputed
        //   AST/lexical ref index (tree-sitter/ripgrep) or a raised timeout. Kept OFF
        //   (indexing has a prewarm cost with zero references benefit).
        indexing: false,
        autoImportCompletions: false,
        autoSearchPaths: true,
        useLibraryCodeForTypes: true,
        extraPaths: [cwd],
      },
    },
  }
}

const withPyrightDefaults = (options: PyrightAdapterOptions): PyrightAdapterOptions => {
  const cwd = options.cwd ?? process.cwd()
  return {
    ...options,
    cwd,
    requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    workspaceFolders: options.workspaceFolders ?? [cwd],
    workspaceConfiguration: options.workspaceConfiguration ?? buildWorkspaceConfiguration(cwd),
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
