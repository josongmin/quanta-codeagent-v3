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
import { resolveMemoryDirPathsUnder } from "./consolidate/paths"

/** File name of the durable store inside `<quanta-home>/memory/`. */
export const DURABLE_STORE_FILENAME = "memory.sqlite"

/** Pre-0557 cwd-relative default, kept verbatim for legacy detection. */
export const LEGACY_CWD_STORE_RELPATH = path.join(".quanta", "memory.sqlite")

/**
 * `<quanta-home>/memory/memory.sqlite`. Pure.
 *
 * `quantaHome` is the QUANTA home root (`QUANTA_CONFIG_DIR ?? QUANTA_HOME ?? ~/.quanta`),
 * NOT an OS home. It used to be an OS home joined with `.quanta/memory`, which is why
 * memory was the one plane a relocated `QUANTA_HOME` did not move. Unset resolves to
 * `~/.quanta`, so the default path is unchanged.
 */
export const defaultDurableStorePath = (quantaHome: string): string =>
  path.join(resolveMemoryDirPathsUnder(quantaHome).root, DURABLE_STORE_FILENAME)

/** `<cwd>/.quanta/memory.sqlite` — where the old default lived. Pure. */
export const legacyCwdStorePath = (cwd: string): string => path.join(cwd, LEGACY_CWD_STORE_RELPATH)

/** Where the resolved path came from, in precedence order. */
export type StorePathSource = "explicit" | "legacy-cwd" | "home-default"

/** `<os-home>/.quanta/memory/memory.sqlite` — where the store lived before the memory
 *  plane started following `QUANTA_HOME`/`QUANTA_CONFIG_DIR`. Pure.
 *
 *  Identical to `defaultDurableStorePath(quantaHome)` whenever the home is NOT
 *  relocated, because the unset home resolves to `<os-home>/.quanta`. It differs only
 *  for an operator who set one of those vars — which is exactly the operator the
 *  relocation would otherwise orphan. */
export const preRelocationHomeStorePath = (osHomeDir: string): string =>
  path.join(osHomeDir, ".quanta", "memory", DURABLE_STORE_FILENAME)

export interface StorePathResolution {
  /** The file the store should open. */
  readonly path: string
  readonly source: StorePathSource
  /** Present when a LEGACY store exists that this resolution is not using, or is
   *  using instead of the home default: the one attributed line the surface should
   *  emit (names both paths + the migration command). */
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
  /**
   * The OS home, for the PRE-RELOCATION probe. Injected, never read here.
   *
   * Omit ⇒ no pre-relocation probe. Supplying it is what stops a relocated
   * `QUANTA_HOME`/`QUANTA_CONFIG_DIR` from silently orphaning an existing store:
   * without it, an operator with months of memory at `<os-home>/.quanta/memory/`
   * who has either var set gets a FRESH EMPTY store and no notice at all. Measured
   * before this existed — `source: "home-default"`, `legacyNotice: undefined`, and
   * the old path was never even probed.
   */
  readonly osHomeDir?: string | undefined
}

/** The migration command a notice prints. Moves the sqlite AND its side files.
 *
 *  `mv -n`, and an `if` rather than `&&` in the loop. Two measured defects in the
 *  first version:
 *
 *  - a bare `mv` OVERWROTE the destination. The pre-relocation notice re-fired on
 *    every launch, and launch 1 CREATES the destination — so from launch 2 onward the
 *    printed command replaced the new session's store with the old one. Real fixture:
 *    destination held `NEW-SESSION-DATA`, ran the command, destination became
 *    `OLD-MONTHS-OF-DATA`, no prompt, no backup. The same failure this helper was
 *    written to prevent, one level up.
 *  - `[ -e … ] && mv …` was the last element of the `&&` chain, so a clean shutdown
 *    with no side files made the whole command exit 1 with the migration COMPLETE.
 *    Measured exit=1 on the common case.
 *
 *  `-wal` and `-shm` were omitted for as long as this notice existed. An operator who
 *  followed it moved the database out from under an uncheckpointed write-ahead log and
 *  lost whatever had not been checkpointed — silent data loss, in the line written to
 *  prevent silent data loss. `mv` on a missing side file is a hard error, so each is
 *  guarded. */
const migrationCommand = (from: string, to: string): string =>
  `mkdir -p "${path.dirname(to)}" && mv -n "${from}" "${to}"` +
  ` && for s in -wal -shm; do if [ -e "${from}$s" ]; then mv -n "${from}$s" "${to}$s"; fi; done`

/** Resolve the sqlite path: explicit > legacy cwd file > pre-relocation home file >
 *  home default. Pure given `exists`. */
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
        `To migrate (with no quanta running): ${migrationCommand(legacy, home)}`,
    }
  }
  // PRE-RELOCATION: NOTICE ONLY, never a redirect.
  //
  // When the home has moved, an existing store at the pre-relocation path would
  // otherwise be silently orphaned — measured: `source: "home-default"`,
  // `legacyNotice: undefined`, and the old path never probed.
  //
  // The notice does NOT change `path`. Returning the old file instead was the first
  // shape of this fix and it is the split-brain again, inverted: a session whose
  // `QUANTA_HOME` says one place would secretly read another. Measured — it also broke
  // every suite that injects a scratch home, resolving ten of them to the developer's
  // real store. So the resolution stays under the home the operator asked for, and the
  // operator is TOLD what is at the old path and how to move it.
  //
  // Skipped when the paths coincide (an unset home), so the common case is silent.
  if (input.osHomeDir !== undefined && input.osHomeDir !== "") {
    const prior = preRelocationHomeStorePath(input.osHomeDir)
    // Only while the destination is still ABSENT. The notice recommends a `mv`, and a
    // `mv` is only the right answer when there is nothing to move onto: once this home
    // has its own store, the operator has TWO stores and moving one over the other
    // destroys the newer. Measured — without this the notice re-fired on every launch
    // (3 of 3) recommending a command that had become destructive.
    if (prior !== home && exists(prior) && !exists(home)) {
      return {
        path: home,
        source: "home-default",
        legacyNotice:
          `memory store: this session uses ${home}, but an existing store is at ${prior} ` +
          `(where memory lived before the plane followed QUANTA_HOME/QUANTA_CONFIG_DIR). ` +
          `It is NOT being read — set QUANTA_MEMORY_PATH to use it, or migrate ` +
          `(with no quanta running): ${migrationCommand(prior, home)}`,
      }
    }
  }
  return { path: home, source: "home-default" }
}
