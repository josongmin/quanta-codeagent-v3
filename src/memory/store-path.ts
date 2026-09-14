/**
 * ADR-0557 — durable long-term memory store path resolution.
 *
 * Path math + legacy detection for the `SqliteStore` the session factory opens by
 * default. No process state is read here: the caller supplies `homeDir` / `cwd` /
 * `osHomeDir` (tests inject temp dirs; the real home is never touched by a unit test)
 * and, optionally, the `exists` and `sameFile` probes (default: the filesystem).
 *
 * Layout:
 *   - DEFAULT  `<quanta home>/memory/memory.sqlite` (`~/.quanta/memory/…` when the
 *     home is not relocated) — the same parent the
 *     session-memory (B) / consolidator (C) systems already write
 *     (`resolveMemoryDirPaths`, ADR-0068), so one home-scoped store with
 *     per-entry `appliesTo.cwd` routing meta is the whole design; no
 *     per-workspace store directory is needed.
 *   - LEGACY   `<cwd>/.quanta/memory.sqlite` — the pre-0557 cwd-relative
 *     default. When that file EXISTS and no explicit path was given, it keeps
 *     being used (user data is never moved or copied) and the resolution
 *     carries ONE notice naming both paths and the `mv` that migrates.
 */
import { existsSync, statSync } from "node:fs"
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
  /** The QUANTA home root (tests: a temp dir; prod: `quantaHomeDirFrom(env)`, i.e.
   *  `QUANTA_CONFIG_DIR ?? QUANTA_HOME ?? ~/.quanta`) — not an OS home. */
  readonly homeDir: string
  /** Working directory the legacy relative default was resolved against. */
  readonly cwd: string
  /** `override.storePath ?? env.QUANTA_MEMORY_PATH` — wins outright when set. */
  readonly explicitPath?: string | undefined
  /** Injectable fs probe (default `existsSync`). */
  readonly exists?: ((p: string) => boolean) | undefined
  /** Injectable identity probe: do two EXISTING paths name one file? Default compares
   *  device and inode, so a symlinked home, the macOS `/var` ↔ `/private/var` alias
   *  and a case-only spelling on a case-insensitive volume all count as one store. */
  readonly sameFile?: ((a: string, b: string) => boolean) | undefined
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

/** Device + inode equality for two paths; a path that does not exist is nobody's twin. */
const sameFileOnDisk = (a: string, b: string): boolean => {
  const sa = statSync(a, { throwIfNoEntry: false })
  const sb = statSync(b, { throwIfNoEntry: false })
  return sa !== undefined && sb !== undefined && sa.dev === sb.dev && sa.ino === sb.ino
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

/**
 * The directory-level twin of {@link migrationCommand}, for the pre-relocation home.
 *
 * The memory plane is a DIRECTORY, not a file: the sqlite store and its `-wal`/`-shm`,
 * and the consolidator's `MEMORY.md`, `raw_memories.md`, `memory_summary.md` and
 * `stage1.sqlite`. Moving only the store (the first version) left the rest behind in
 * the old home while the consolidator read and wrote a fresh set under the new one.
 * So this moves `<old home>/memory` whole — the side files travel by construction —
 * and REFUSES if the destination exists, unless it is an EMPTY real directory (a
 * component that created it holds nothing), which it removes first.
 */
const memoryDirMigrationCommand = (fromDir: string, toDir: string): string => {
  const f = shq(fromDir)
  const t = shq(toDir)
  return (
    `( set -e; ` +
    `if [ -e ${t} ] || [ -L ${t} ]; then ` +
    `if [ -d ${t} ] && [ ! -L ${t} ] && [ -z "$(ls -A ${t})" ]; then rmdir ${t}; ` +
    `else echo 'memory migrate: '${t}' already exists; nothing moved' >&2; exit 1; fi; fi; ` +
    `mkdir -p ${shq(path.dirname(toDir))}; mv ${f} ${t} )`
  )
}

/** The files that make a memory directory "in use": the store and the consolidator's. A
 *  home counts as having memory if ANY is present — deciding by the sqlite alone
 *  orphaned a relocated home's `MEMORY.md` / stage-1 data whenever its store was absent
 *  (round-9 audit). */
const MEMORY_PLANE_FILES: readonly string[] = [
  DURABLE_STORE_FILENAME,
  "MEMORY.md",
  "raw_memories.md",
  "memory_summary.md",
  "stage1.sqlite",
]

const hasMemory = (dir: string, exists: (p: string) => boolean): boolean =>
  MEMORY_PLANE_FILES.some((f) => exists(path.join(dir, f)))

/** The notice for two memory DIRECTORIES that both hold memory. Names them and recommends
 *  nothing destructive. It must not recommend `QUANTA_MEMORY_PATH`: that moves the store
 *  alone, and the consolidator keeps using this home — the split `resolveMemoryHome`
 *  exists to prevent (round-9 audit: following the old advice split the plane again). */
const twoMemoryDirsNotice = (using: string, other: string): string =>
  `memory: TWO memory directories exist. This session uses ${using}; another is at ${other} ` +
  "(where memory lived before the plane followed QUANTA_HOME/QUANTA_CONFIG_DIR). They are not " +
  "merged and nothing will move either one. Pointing QUANTA_MEMORY_PATH at the other's store " +
  "would split it from its MEMORY.md and consolidation files; to switch, stop quanta and swap " +
  "the two directories."

/** The notice for two stores that BOTH exist. Names them; recommends nothing
 *  destructive, because which one holds the data the operator wants is not knowable
 *  here. */
const twoStoresNotice = (using: string, other: string, why: string): string =>
  `memory store: TWO stores exist. This session uses ${using}; another is at ${other} (${why}). ` +
  `They are not merged and nothing will move either one. To use the other, set ` +
  `QUANTA_MEMORY_PATH=${shq(other)}; once you no longer need it, remove it.`

/**
 * A legacy cwd store while memory still lives in the pre-relocation home: ONE notice, and
 * at most ONE command.
 *
 * It printed the store notice and the home notice, each with its own command, and the
 * outcome depended on which ran first (round-11 audit, run on real directories): the
 * directory move first, then the store move, recreated the old directory for the store
 * alone — an empty store under the new home and a "TWO memory directories" notice. With a
 * store in the old home too, it said "(the home default)" and recommended
 * `QUANTA_MEMORY_PATH=<old home store>`, which the directory move then took away.
 *
 * - No store in the old home: one command moves the legacy store into the old memory
 *   directory, then that directory to this home — the order is inside the command.
 * - A store there too: nothing moves the legacy store (a move would land on a store). The
 *   only command moves the old directory, and no advice names a path it moves.
 */
const legacyWithPriorHomeNotice = (
  legacy: string,
  priorStore: string,
  priorHome: string,
  currentHome: string,
  priorStoreExists: boolean,
): string => {
  const priorDir = resolveMemoryDirPathsUnder(priorHome).root
  const currentDir = resolveMemoryDirPathsUnder(currentHome).root
  const where =
    `memory lives in ${priorDir}, where it lived before the plane followed ` +
    `QUANTA_HOME/QUANTA_CONFIG_DIR; this home's memory directory would be ${currentDir}.`
  const moveDir = memoryDirMigrationCommand(priorDir, currentDir)
  if (!priorStoreExists) {
    return (
      `memory store: using legacy cwd-scoped ${legacy}; ${where} ` +
      `To migrate both, in order (with no quanta running): ` +
      `${migrationCommand(legacy, priorStore)} && ${moveDir}`
    )
  }
  return (
    `memory store: TWO stores exist. This session uses ${legacy}; another is at ${priorStore}. ` +
    `They are not merged and nothing will move either one. The cwd store takes precedence ` +
    `while it is there. ${where} To move that directory (with no quanta running): ${moveDir}`
  )
}

/** Where the memory plane's HOME came from. */ /** Where the memory plane's HOME came from. */
export type MemoryHomeSource = "home-default" | "pre-relocation-home"

export interface MemoryHomeResolution {
  /** The Quanta home whose `memory/` directory this session uses. */
  readonly home: string
  readonly source: MemoryHomeSource
  /** The one attributed line to emit, when there is something to say. */
  readonly notice?: string
}

export interface ResolveMemoryHomeInput {
  /** The Quanta home root (`QUANTA_CONFIG_DIR ?? QUANTA_HOME ?? ~/.quanta`). */
  readonly quantaHome: string
  /** The OS home, for the pre-relocation probe. Omit ⇒ no probe. */
  readonly osHomeDir?: string | undefined
  readonly exists?: ((p: string) => boolean) | undefined
  readonly sameFile?: ((a: string, b: string) => boolean) | undefined
}

/**
 * Which Quanta home the memory PLANE uses — the store and the consolidator together.
 *
 * ONE decision for the whole `memory/` directory. It used to be made for the sqlite file
 * alone (`resolveStorePath`), while `session-memory-auto` resolved the consolidator's
 * files from the relocated home unconditionally. So a relocated operator with existing
 * memory had the store read in place from the old home and `MEMORY.md` /
 * `raw_memories.md` / `memory_summary.md` / `stage1.sqlite` started fresh under the new
 * one, the old ones silently orphaned, and the migration command moved only the store
 * (round-8 audit). Both planes now call this.
 */
export const resolveMemoryHome = (input: ResolveMemoryHomeInput): MemoryHomeResolution => {
  const here: MemoryHomeResolution = { home: input.quantaHome, source: "home-default" }
  if (input.osHomeDir === undefined || input.osHomeDir === "") return here
  const exists = input.exists ?? existsSync
  const sameFile = input.sameFile ?? sameFileOnDisk
  const priorHome = path.join(input.osHomeDir, ".quanta")
  const priorDir = resolveMemoryDirPathsUnder(priorHome).root
  const currentDir = resolveMemoryDirPathsUnder(input.quantaHome).root
  // Skipped when the paths coincide (an unset home), so the common case is silent.
  if (priorDir === currentDir || !hasMemory(priorDir, exists)) return here
  if (hasMemory(currentDir, exists)) {
    if (sameFile(priorDir, currentDir)) return here
    return { ...here, notice: twoMemoryDirsNotice(currentDir, priorDir) }
  }
  // IN PLACE, the same answer the legacy-cwd store gets. The previous shape kept the
  // resolution under the relocated home and only PRINTED a notice — and opening that
  // path CREATED the destination on the very launch that printed it. So the notice
  // fired exactly once, and the command it recommended could only ever find a
  // destination already there. Reading the existing memory where it is creates no
  // second one: the notice repeats every launch until the operator migrates, and the
  // command stays valid until they do.
  return {
    home: priorHome,
    source: "pre-relocation-home",
    notice:
      `memory: using ${priorDir}, where memory lived before the plane followed ` +
      `QUANTA_HOME/QUANTA_CONFIG_DIR; this home's memory directory would be ${currentDir}. ` +
      `To migrate (with no quanta running): ${memoryDirMigrationCommand(priorDir, currentDir)}`,
  }
}

/** Resolve the sqlite path: explicit > legacy cwd file > pre-relocation home file >
 *  home default. Pure given `exists` and `sameFile`. */
export const resolveStorePath = (input: ResolveStorePathInput): StorePathResolution => {
  if (input.explicitPath !== undefined && input.explicitPath !== "") {
    return { path: input.explicitPath, source: "explicit" }
  }
  const exists = input.exists ?? existsSync
  // Two SPELLINGS of one file are one store. Comparing strings, a symlinked
  // QUANTA_HOME (a dotfiles layout) printed "TWO stores exist … once you no longer need
  // it, remove it" about the store the session was using — advice to delete the only
  // copy (round-8 audit, reproduced for a symlink, the /private/var alias and a
  // case-only difference).
  const sameFile = input.sameFile ?? sameFileOnDisk
  const legacy = legacyCwdStorePath(input.cwd)
  // The memory home is decided once for the whole plane, and the legacy store's migration
  // target is THAT home's store. It was `input.homeDir`'s: with consolidator files still in
  // the pre-relocation home, the printed `mv` put the store in the relocated home while
  // MEMORY.md and raw_memories.md stayed behind, and that home's notice never printed,
  // because this branch returned first (round-10 audit, run on real directories).
  const memory =
    input.osHomeDir === undefined || input.osHomeDir === ""
      ? { home: input.homeDir, source: "home-default" as const, notice: undefined }
      : resolveMemoryHome({
          quantaHome: input.homeDir,
          osHomeDir: input.osHomeDir,
          exists,
          sameFile,
        })
  const home = defaultDurableStorePath(memory.home)
  if (exists(legacy) && !(exists(home) && sameFile(legacy, home))) {
    // In place, as before: user data is never moved or copied.
    return {
      path: legacy,
      source: "legacy-cwd",
      legacyNotice:
        memory.source === "pre-relocation-home"
          ? legacyWithPriorHomeNotice(legacy, home, memory.home, input.homeDir, exists(home))
          : exists(home)
            ? twoStoresNotice(legacy, home, "the home default")
            : `memory store: using legacy cwd-scoped ${legacy}; the default is now ${home}. ` +
              `To migrate (with no quanta running): ${migrationCommand(legacy, home)}`,
    }
  }
  return {
    path: home,
    source: memory.source,
    ...(memory.notice !== undefined ? { legacyNotice: memory.notice } : {}),
  }
}
