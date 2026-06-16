import { existsSync } from "node:fs"
import { join } from "node:path"
import { LspClient, type LspClientOptions } from "./base"

export type PyrightAdapterOptions = LspClientOptions

const DEFAULT_COMMAND = ["pyright-langserver", "--stdio"]
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000

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
