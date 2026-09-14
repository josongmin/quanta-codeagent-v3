/**
 * The one decision: may this process run code that a folder's contents control?
 *
 * Several things quanta starts are chosen by files that arrive with a clone:
 *  - language servers execute workspace code — pyright runs the workspace's `.venv`
 *    python, typescript-language-server loads the workspace's own tsserver, rust-analyzer
 *    runs `build.rs` (each measured with a marker file on the real servers, sep-14);
 *  - a project `.mcp.json` names the commands of stdio MCP servers;
 *  - a project plugin manifest names MCP servers;
 *  - a project grants overlay names tool permissions.
 * None of them asked. A read-only LSP tool ran workspace code in plan mode, and a
 * committed `.mcp.json` command ran at CLI startup.
 *
 * The decision is per folder and explicit, the shape VS Code's Workspace Trust and Claude
 * Code's folder trust share: a grant in `~/.quanta/trust.json` (the `TrustStore` the
 * central-config hooks already use), `QUANTA_TRUSTED_PATHS`, or the interactive CLI's
 * one-time question. A grant covers the folder's subfolders, as in both of those; the
 * NEAREST recorded decision wins, so an explicit untrust inside a trusted folder holds.
 * (The settings-layer merge keeps its own exact-path rule — a settings layer belongs to
 * one project root; code started inside a trusted checkout is still that checkout.)
 *
 * A composition root installs the authority for its process. With none installed every
 * folder is untrusted: a surface that forgets to decide fails closed and says why, instead
 * of running the folder's code.
 */

import { existsSync, realpathSync } from "node:fs"
import { dirname, isAbsolute } from "node:path"
import { canonicalizeProjectPath } from "@/config/trust-store"
import { errMessage, QuantaError } from "@/shared/errors"
import { logger } from "@/shared/logger"

export interface WorkspaceTrustAuthority {
  /** True when code chosen by `path`'s contents may run. */
  readonly isTrusted: (path: string) => boolean
}

/** Resolve symlinks when the path exists, then canonicalize. `undefined` for a path that
 *  cannot be canonicalized (relative, empty) — never trusted. */
const canonicalFolder = (path: string): string | undefined => {
  if (!isAbsolute(path)) return undefined
  let resolved = path
  if (existsSync(path)) {
    try {
      resolved = realpathSync(path)
    } catch (e) {
      // An unreadable component: judged by its spelling, which trusts nothing extra.
      logger.debug("workspace-trust: realpath failed", { path, error: errMessage(e) })
    }
  }
  return canonicalizeProjectPath(resolved)
}

export const UNTRUSTED_EVERYWHERE: WorkspaceTrustAuthority = { isTrusted: () => false }

/** An authority over recorded decisions: `true` trusts a folder and its subfolders,
 *  `false` is an explicit untrust. The nearest decision on the way up wins. */
export const folderDecisionsAuthority = (
  decisions: Iterable<readonly [string, boolean]>,
): WorkspaceTrustAuthority & { readonly grant: (path: string) => void } => {
  const byFolder = new Map<string, boolean>()
  const record = (path: string, trusted: boolean): void => {
    const key = canonicalFolder(path)
    if (key !== undefined) byFolder.set(key, trusted)
  }
  for (const [path, trusted] of decisions) record(path, trusted)
  return {
    isTrusted: (path) => {
      let dir = canonicalFolder(path)
      while (dir !== undefined) {
        const decision = byFolder.get(dir)
        if (decision !== undefined) return decision
        const parent = dirname(dir)
        dir = parent === dir ? undefined : parent
      }
      return false
    },
    grant: (path) => record(path, true),
  }
}

/** For a harness that creates every tree it works in and runs their code anyway (the
 *  bench: dataset checkouts in sandboxes it built, whose tests it executes). The call
 *  site says why. */
export const TRUST_EVERY_FOLDER: WorkspaceTrustAuthority = { isTrusted: () => true }

let installed: WorkspaceTrustAuthority = UNTRUSTED_EVERYWHERE

/** Install this process's authority. Returns a restore for tests and scoped hosts. */
export const installWorkspaceTrustAuthority = (
  authority: WorkspaceTrustAuthority,
): (() => void) => {
  const prior = installed
  installed = authority
  return () => {
    installed = prior
  }
}

export const isWorkspaceTrusted = (path: string): boolean => installed.isTrusted(path)

/** How a folder becomes trusted — the tail of every refusal. */
export const UNTRUSTED_WORKSPACE_HOW_TO =
  "Trust it at quanta's startup question, add it to QUANTA_TRUSTED_PATHS, or record it " +
  "in ~/.quanta/trust.json."

/** What a refused launch tells the model and the operator. */
export const untrustedWorkspaceMessage = (what: string, path: string): string =>
  `${what} was not started: it would run code from ${path}, which is not a trusted folder. ` +
  UNTRUSTED_WORKSPACE_HOW_TO

export class WorkspaceUntrustedError extends QuantaError {
  readonly path: string
  constructor(what: string, path: string) {
    super("workspace_untrusted", untrustedWorkspaceMessage(what, path))
    this.path = path
  }
}

export const assertWorkspaceTrusted = (what: string, path: string): void => {
  if (!isWorkspaceTrusted(path)) throw new WorkspaceUntrustedError(what, path)
}
