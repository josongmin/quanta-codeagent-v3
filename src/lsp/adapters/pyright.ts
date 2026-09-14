import { existsSync } from "node:fs"
import { join } from "node:path"
import { LspClient, type LspClientOptions } from "./base"

export interface PyrightAdapterOptions extends LspClientOptions {
  /** SEC-2 — allow pyright's `pythonPath` to be resolved from the workspace's
   *  OWN `.venv`/`venv`. Pyright EXECUTES that interpreter, so a cloned repo's
   *  `.venv/bin/python` is arbitrary code execution. Default `false` (a system
   *  interpreter, which is the user's own, is used instead — safe, and still a
   *  real `pythonPath` so pyright does not hang). The bench sandbox, which builds
   *  its own trusted venv, opts in. */
  allowWorkspaceInterpreter?: boolean
}

const DEFAULT_COMMAND = ["pyright-langserver", "--stdio"]
// jun-19 MEASURED: `textDocument/references` is INTRACTABLE on large repos — it
// timed out on sympy-17630 at BOTH 15s AND 60s (full-remote, gpt-5.5). So the
// references-grounding gap is NOT fixable by a higher timeout (band-aid) NOR by
// pyright config (`indexing:true` also measured-no). Cross-ref grounding needs a
// PRECOMPUTED non-semantic index (tree-sitter/ripgrep, repo-size-independent),
// not pyright. Timeout kept at 15s (60s only stalls the agent before the same
// timeout). `definition` (point-query) is fine — it returns fast and is unaffected.
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000

/** Resolve the Python interpreter pyright should use for `workspaceFolders`
 *  mode. WITHOUT a `pythonPath`, pyright cannot set up the workspace's import
 *  environment and silently HANGS every request (definition/references time
 *  out forever — even on a 3-line file). Prefer the task's own venv (the bench
 *  sandbox creates one), then a PATH interpreter, then the bare name so pyright
 *  can still try its own discovery. */
export const resolvePythonInterpreter = (
  cwd: string,
  allowWorkspaceInterpreter = false,
): string => {
  // SEC-2: a workspace-relative interpreter is repo-controlled — pyright executes
  // it. Only consult the repo's own venv when the workspace is explicitly trusted
  // (bench sandbox); otherwise use the user's own system interpreter, which is a
  // real `pythonPath` (no hang) but never repo-supplied code.
  if (allowWorkspaceInterpreter) {
    for (const rel of [
      ".venv/bin/python",
      ".venv/bin/python3",
      "venv/bin/python",
      "venv/bin/python3",
    ]) {
      const p = join(cwd, rel)
      if (existsSync(p)) return p
    }
  }
  return Bun.which("python3") ?? Bun.which("python") ?? "python3"
}

/** The settings pyright pulls via `workspace/configuration`. cwd-aware: the
 *  repo root must be on the import path (`extraPaths` + `autoSearchPaths`) so a
 *  project-local package (`import django`) resolves cross-file, and a real
 *  `pythonPath` must be present or pyright hangs (see above). */
const buildWorkspaceConfiguration = (
  cwd: string,
  allowWorkspaceInterpreter: boolean,
): Record<string, unknown> => {
  const pythonPath = resolvePythonInterpreter(cwd, allowWorkspaceInterpreter)
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
  const allowWorkspaceInterpreter = options.allowWorkspaceInterpreter ?? false
  return {
    ...options,
    cwd,
    requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    workspaceFolders: options.workspaceFolders ?? [cwd],
    workspaceConfiguration:
      options.workspaceConfiguration ?? buildWorkspaceConfiguration(cwd, allowWorkspaceInterpreter),
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
