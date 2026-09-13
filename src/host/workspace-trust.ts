/**
 * Build and install this process's workspace-trust authority (`@/agent/workspace-trust`)
 * from the operator's recorded decisions.
 *
 * Inputs, all explicit — the cwd is never trusted for being the cwd:
 *  - `~/.quanta/trust.json`, the `TrustStore` file (under `QUANTA_HOME`);
 *  - `QUANTA_TRUSTED_PATHS`, a comma-separated list for headless and CI hosts;
 *  - an interactive grant: when the launch folder is untrusted and the surface supplies
 *    `confirm`, the operator is asked once, and a yes is persisted to the trust file.
 *
 * A read failure of the trust file is not a grant: the file's decisions are treated as
 * absent (untrusted), and the failure is reported through `warn`.
 */

import { realpath } from "node:fs/promises"
import { join } from "node:path"
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
}

export interface ResolvedWorkspaceTrust {
  readonly authority: WorkspaceTrustAuthority
  /** The launch folder, symlinks resolved. */
  readonly folder: string
  readonly trusted: boolean
  readonly source: WorkspaceTrustSource
}

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
  const folder = await realpath(input.cwd).catch((e: unknown) => {
    // A missing cwd is judged by its spelling.
    logger.debug("workspace-trust: cwd realpath failed", { cwd: input.cwd, error: errMessage(e) })
    return input.cwd
  })
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
    }
  }
  if (input.confirm !== undefined && store !== undefined && (await input.confirm(folder))) {
    store.setTrusted(folder, (input.now ?? Date.now)())
    try {
      await store.flush()
    } catch (e) {
      warn(`[quanta] trust granted for this session only; saving it failed: ${errMessage(e)}`)
    }
    authority.grant(folder)
    return { authority, folder, trusted: true, source: "granted" }
  }
  return { authority, folder, trusted: false, source: "none" }
}

/** Resolve and install in one step, for composition roots. */
export const installResolvedWorkspaceTrust = async (
  input: ResolveWorkspaceTrustInput,
): Promise<ResolvedWorkspaceTrust> => {
  const resolved = await resolveWorkspaceTrust(input)
  installWorkspaceTrustAuthority(resolved.authority)
  return resolved
}
