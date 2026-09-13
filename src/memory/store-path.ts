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
export type StorePathSource = "explicit" | "legacy-cwd" | "pre-relocation-home" | "home-default"

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

/** POSIX single-quote a path: the only quoting in which the shell expands nothing. */
const shq = (p: string): string => `'${p.replaceAll("'", "'\\''")}'`

/**
 * The migration command a notice prints. Moves the sqlite AND its side files, and
 * REFUSES rather than skips.
 *
 * Four versions, four measured defects, each worth keeping in view:
 *
 *  1. `-wal`/`-shm` omitted: moving the database out from under an uncheckpointed
 *     write-ahead log lost whatever had not been checkpointed.
 *  2. a bare `mv` OVERWROTE the destination: destination `NEW-SESSION-DATA` became
 *     `OLD-MONTHS-OF-DATA`, no prompt.
 *  3. `mv -n` fixed the overwrite and made the command SILENT: `-n` exits 0 when it
 *     skips. The launch that printed the pre-relocation notice then CREATED the
 *     destination, so an operator who quit and ran the command got exit 0, the old
 *     store left where it was, and a new store holding one row — an orphan reported as
 *     success. And because `-n` skipped only the database, the old `-wal`/`-shm` still
 *     moved next to the NEW file: measured with real SQLite, the new store went from
 *     5 rows to 50 OLD rows and the old store to 0, `integrity_check` ok, exit 0.
 *  4. paths were interpolated inside DOUBLE quotes, where the shell still expands
 *     `$(…)`, backticks and `$VAR`. A legacy cwd directory named `$(touch PWNED)`
 *     created `PWNED` when the notice was pasted.
 *
 * Now: everything is single-quoted; the whole thing runs in a subshell so a refusal
 * cannot close the operator's interactive shell; it refuses with a message and a
 * non-zero exit if the destination or either side file already exists; and then it
 * moves with plain `mv`, so any failure is a failure.
 */
const migrationCommand = (from: string, to: string): string => {
  const f = shq(from)
  const t = shq(to)
  return (
    `( set -e; ` +
    `for s in '' -wal -shm; do if [ -e ${t}"$s" ]; then ` +
    `echo 'memory migrate: '${t}"$s"' already exists; nothing moved' >&2; exit 1; fi; done; ` +
    `mkdir -p ${shq(path.dirname(to))}; mv ${f} ${t}; ` +
    `for s in -wal -shm; do if [ -e ${f}"$s" ]; then mv ${f}"$s" ${t}"$s"; fi; done )`
  )
}

/** The notice for two stores that BOTH exist. Names them; recommends nothing
 *  destructive, because which one holds the data the operator wants is not knowable
 *  here. */
const twoStoresNotice = (using: string, other: string, why: string): string =>
  `memory store: TWO stores exist. This session uses ${using}; another is at ${other} (${why}). ` +
  `They are not merged and nothing will move either one. To use the other, set ` +
  `QUANTA_MEMORY_PATH=${shq(other)}; once you no longer need it, remove it.`

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
    // In place, as before: user data is never moved or copied. But the migration
    // command is offered ONLY while the destination is absent — if the home store
    // exists too, a move would at best skip and at worst carry the legacy WAL onto it.
    return {
      path: legacy,
      source: "legacy-cwd",
      legacyNotice: exists(home)
        ? twoStoresNotice(legacy, home, "the home default")
        : `memory store: using legacy cwd-scoped ${legacy}; the default is now ${home}. ` +
          `To migrate (with no quanta running): ${migrationCommand(legacy, home)}`,
    }
  }
  if (input.osHomeDir === undefined || input.osHomeDir === "") {
    return { path: home, source: "home-default" }
  }
  const prior = preRelocationHomeStorePath(input.osHomeDir)
  // Skipped when the paths coincide (an unset home), so the common case is silent.
  if (prior === home || !exists(prior)) return { path: home, source: "home-default" }
  if (exists(home)) {
    return {
      path: home,
      source: "home-default",
      legacyNotice: twoStoresNotice(
        home,
        prior,
        "where memory lived before the plane followed QUANTA_HOME/QUANTA_CONFIG_DIR",
      ),
    }
  }
  // IN PLACE, the same answer the legacy-cwd store gets. The previous shape kept the
  // resolution under the relocated home and only PRINTED a notice — and opening that
  // path CREATED the destination on the very launch that printed it. So the notice
  // fired exactly once, and the command it recommended could only ever find a
  // destination already there. Reading the existing store where it is creates no
  // second store: the notice repeats every launch until the operator migrates, and
  // the command stays valid until they do.
  return {
    path: prior,
    source: "pre-relocation-home",
    legacyNotice:
      `memory store: using ${prior}, where memory lived before the plane followed ` +
      `QUANTA_HOME/QUANTA_CONFIG_DIR; this home's store would be ${home}. ` +
      `To migrate (with no quanta running): ${migrationCommand(prior, home)}`,
  }
}
