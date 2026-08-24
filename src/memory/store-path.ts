/**
 * ADR-0557 — durable long-term memory store path resolution.
 *
 * Pure path math + legacy detection for the `SqliteStore` the session factory
 * opens by default. No process state is read here: the caller supplies
 * `homeDir` / `cwd` (tests inject temp dirs; the real home is never touched
 * by a unit test) and, optionally, the `exists` probe.
 *
 * Layout:
 *   - DEFAULT  `<home>/.quanta/memory/memory.sqlite` — the same parent the
 *     session-memory (B) / consolidator (C) systems already write
 *     (`resolveMemoryDirPaths`, ADR-0068), so one home-scoped store with
 *     per-entry `appliesTo.cwd` routing meta is the whole design; no
 *     per-workspace store directory is needed.
 *   - LEGACY   `<cwd>/.quanta/memory.sqlite` — the pre-0557 cwd-relative
 *     default. When that file EXISTS and no explicit path was given, it keeps
 *     being used (user data is never moved or copied) and the resolution
 *     carries ONE notice naming both paths and the `mv` that migrates.
 */
import { existsSync } from "node:fs"
import * as path from "node:path"
import { resolveMemoryDirPaths } from "./consolidate/paths"

/** File name of the durable store inside `~/.quanta/memory/`. */
export const DURABLE_STORE_FILENAME = "memory.sqlite"

/** Pre-0557 cwd-relative default, kept verbatim for legacy detection. */
export const LEGACY_CWD_STORE_RELPATH = path.join(".quanta", "memory.sqlite")

/** `<home>/.quanta/memory/memory.sqlite`. Pure. */
export const defaultDurableStorePath = (homeDir: string): string =>
  path.join(resolveMemoryDirPaths(homeDir).root, DURABLE_STORE_FILENAME)

/** `<cwd>/.quanta/memory.sqlite` — where the old default lived. Pure. */
export const legacyCwdStorePath = (cwd: string): string => path.join(cwd, LEGACY_CWD_STORE_RELPATH)

/** Where the resolved path came from, in precedence order. */
export type StorePathSource = "explicit" | "legacy-cwd" | "home-default"

export interface StorePathResolution {
  /** The file the store should open. */
  readonly path: string
  readonly source: StorePathSource
  /** Present iff `source === "legacy-cwd"`: the one attributed line the
   *  surface should emit (names both paths + the migration command). */
  readonly legacyNotice?: string
}

export interface ResolveStorePathInput {
  /** Home directory (tests: a temp dir; prod: `os.homedir()`). */
  readonly homeDir: string
  /** Working directory the legacy relative default was resolved against. */
  readonly cwd: string
  /** `override.storePath ?? env.QUANTA_MEMORY_PATH` — wins outright when set. */
  readonly explicitPath?: string | undefined
  /** Injectable fs probe (default `existsSync`). */
  readonly exists?: ((p: string) => boolean) | undefined
}

/** Resolve the sqlite path: explicit > legacy cwd file (if it exists) > home
 *  default. Pure given `exists`. */
export const resolveStorePath = (input: ResolveStorePathInput): StorePathResolution => {
  if (input.explicitPath !== undefined && input.explicitPath !== "") {
    return { path: input.explicitPath, source: "explicit" }
  }
  const exists = input.exists ?? existsSync
  const legacy = legacyCwdStorePath(input.cwd)
  const home = defaultDurableStorePath(input.homeDir)
  if (exists(legacy)) {
    return {
      path: legacy,
      source: "legacy-cwd",
      legacyNotice:
        `memory store: using legacy cwd-scoped ${legacy}; the default is now ${home}. ` +
        `To migrate (with no quanta running): mkdir -p "${path.dirname(home)}" && mv "${legacy}" "${home}"`,
    }
  }
  return { path: home, source: "home-default" }
}
