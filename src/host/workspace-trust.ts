/**
 * Build and install this process's workspace-trust authority (`@/agent/workspace-trust`)
 * from the operator's recorded decisions.
 *
 * Inputs, all explicit — the cwd is never trusted for being the cwd:
 *  - `~/.quanta/trust.json`, the `TrustStore` file (under `QUANTA_HOME`);
 *  - `QUANTA_TRUSTED_PATHS`, a comma-separated list of absolute paths for headless and CI;
 *  - an interactive grant: when the folder is untrusted and the surface supplies `confirm`,
 *    the operator is asked once, and a yes is persisted to the trust file.
 *
 * The folder asked about and recorded is the git checkout the launch folder belongs to
 * (sep-14 U-1: "the realpath git root"), so a session started in a subfolder asks about,
 * and grants, the repository. Outside any checkout it is the launch folder. A grant of
 * the home folder is for this session only: persisted, it would trust every clone under
 * it forever.
 *
 * A read failure of the trust file is not a grant: the file's decisions are treated as
 * absent (untrusted), and the failure is reported through `warn`.
 */

import { existsSync } from "node:fs"
import { realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import {
  folderDecisionsAuthority,
  installWorkspaceTrustAuthority,
  type WorkspaceTrustAuthority,
} from "@/agent/workspace-trust"
import { canonicalizeTrustedPaths, type TrustPersistencePort, TrustStore } from "@/config"
import { errMessage, logger, quantaHomeDir } from "@/shared"
import { makeTrustPersistence } from "./trust-persist"

export type WorkspaceTrustSource = "trust-file" | "QUANTA_TRUSTED_PATHS" | "granted" | "none"

export interface ResolveWorkspaceTrustInput {
  /** The folder the session launches in — the one the operator may be asked about. */
  readonly cwd: string
  /** `QUANTA_TRUSTED_PATHS` as the runtime config read it (`runtimeConfig().trustedPaths`). */
  readonly trustedPaths: string | undefined
  /** Ask the operator whether to trust `folder`. Absent ⇒ never asked (headless). */
  readonly confirm?: (folder: string) => Promise<boolean>
  /** Test seam; defaults to `~/.quanta/trust.json` under `QUANTA_HOME`. */
  readonly persistence?: TrustPersistencePort
  readonly now?: () => number
  readonly warn?: (message: string) => void
  /** Test seam; defaults to `os.homedir()`. */
  readonly homeDir?: string
}

export interface ResolvedWorkspaceTrust {
  readonly authority: WorkspaceTrustAuthority
  /** The folder the decision is about: the launch folder's git checkout, or the launch
   *  folder outside one; symlinks resolved. */
  readonly folder: string
  readonly trusted: boolean
  readonly source: WorkspaceTrustSource
  /** A grant made now that was not written to the trust file (the home folder, or a
   *  failed write). */
  readonly sessionOnly: boolean
}

/** The git checkout `folder` belongs to — the nearest ancestor holding `.git` (a directory,
 *  or the file a worktree has) — or `folder` itself outside one. */
export const trustSubjectFolder = (folder: string): string => {
  for (let dir = folder; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir
    if (dirname(dir) === dir) return folder
  }
}

const realpathOrSpelling = async (path: string): Promise<string> =>
  realpath(path).catch((e: unknown) => {
    // A missing path is judged by its spelling.
    logger.debug("workspace-trust: realpath failed", { path, error: errMessage(e) })
    return path
  })

export const trustFilePath = (): string => join(quantaHomeDir(), "trust.json")

const loadStore = async (
  persistence: TrustPersistencePort,
  warn: (message: string) => void,
): Promise<TrustStore | undefined> => {
  try {
    return await TrustStore.load(persistence)
  } catch (e) {
    warn(`[quanta] trust file unreadable; treating every folder as untrusted: ${errMessage(e)}`)
    return undefined
  }
}

export const resolveWorkspaceTrust = async (
  input: ResolveWorkspaceTrustInput,
): Promise<ResolvedWorkspaceTrust> => {
  const warn = input.warn ?? (() => {})
  const folder = trustSubjectFolder(await realpathOrSpelling(input.cwd))
  const persistence = input.persistence ?? makeTrustPersistence(trustFilePath())
  const store = await loadStore(persistence, warn)
  const fromFile = store?.decisions() ?? []
  const fromEnv = [...canonicalizeTrustedPaths((input.trustedPaths ?? "").split(","))].map(
    (path) => [path, true] as const,
  )
  // The environment grants; it cannot revoke. File decisions go first so an env grant of
  // the same folder wins over a recorded untrust.
  const authority = folderDecisionsAuthority([...fromFile, ...fromEnv])
  if (authority.isTrusted(folder)) {
    const byEnv = folderDecisionsAuthority(fromEnv).isTrusted(folder)
    return {
      authority,
      folder,
      trusted: true,
      source: byEnv ? "QUANTA_TRUSTED_PATHS" : "trust-file",
      sessionOnly: false,
    }
  }
  if (input.confirm !== undefined && store !== undefined && (await input.confirm(folder))) {
    authority.grant(folder)
    const home = await realpathOrSpelling(input.homeDir ?? homedir())
    if (folder === home) {
      warn(`[quanta] ${folder} is your home folder: trusted for this session only, not saved.`)
      return { authority, folder, trusted: true, source: "granted", sessionOnly: true }
    }
    store.setTrusted(folder, (input.now ?? Date.now)())
    const saved = await store.flush().then(
      () => true,
      (e: unknown) => {
        warn(`[quanta] trust granted for this session only; saving it failed: ${errMessage(e)}`)
        return false
      },
    )
    return { authority, folder, trusted: true, source: "granted", sessionOnly: !saved }
  }
  return { authority, folder, trusted: false, source: "none", sessionOnly: false }
}

/** Resolve and install in one step, for composition roots. */
export const installResolvedWorkspaceTrust = async (
  input: ResolveWorkspaceTrustInput,
): Promise<ResolvedWorkspaceTrust> => {
  const resolved = await resolveWorkspaceTrust(input)
  installWorkspaceTrustAuthority(resolved.authority)
  return resolved
}
