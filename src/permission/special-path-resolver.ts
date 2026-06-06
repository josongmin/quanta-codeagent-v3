/**
 * Special path resolver (ADR-0135).
 *
 * Expands a {@link SpecialPathKind} to an absolute filesystem path, using
 * injected ports for OS / cwd / git information. Closed-port discipline —
 * NO direct `process.cwd()` / `os.tmpdir()` calls; the composition root wires
 * concrete adapters. Tests inject fakes for full determinism.
 *
 * The resolver is the single source of truth for "what does `tmpdir` mean on
 * this OS". A bug here is detected by the unit suite (8 kinds × 2 OSes).
 *
 * Slice rules: pure facade — `@/shared` types + `node:` stdlib only via the
 * port adapters. The ports themselves carry the IO.
 */

import { sep } from "node:path"
import type { SpecialPathKind } from "./permission-profile"

/** Operating system family. Win32 is the only one whose root is non-"/". */
export type OsFamily = "darwin" | "linux" | "win32" | "other"

/** Injected OS port. The composition root wraps `node:os` / `node:process`;
 *  tests pass a frozen literal. */
export interface OsPort {
  /** OS family (`process.platform` narrowed to our enum). */
  family(): OsFamily
  /** Per-user temp directory (`os.tmpdir()`). MUST return an absolute path. */
  tmpdir(): string
}

/** Injected cwd / project root port. `projectRoot` is the repo root (Git's
 *  toplevel) when available; falls back to `cwd()`. Both MUST be absolute. */
export interface CwdPort {
  cwd(): string
  projectRoot(): string
}

/** OPTIONAL git port — exposes `gitDir` (`<repo>/.git`). When absent the
 *  resolver falls back to `<projectRoot>/.git`. */
export interface GitPort {
  /** Absolute path to `.git` directory (or `git-dir` value for worktrees). */
  gitDir(): string | undefined
}

/** Resolution inputs. All ports are required except `git`. */
export interface ResolveSpecialPathOpts {
  readonly os: OsPort
  readonly cwd: CwdPort
  readonly git?: GitPort
}

/* ------------------------------------------------------------------------- */
/* Default port adapters (composition-root convenience)                       */
/* ------------------------------------------------------------------------- */

/** Build a default {@link OsPort} backed by `node:os` + `node:process`. NOT
 *  for use inside `@/permission` itself (would break the leaf rule); apps
 *  call this at wire-up. */
export const defaultOsPort = (proc: {
  platform: NodeJS.Platform
  tmpdir: () => string
}): OsPort => ({
  family: () => {
    if (proc.platform === "darwin") return "darwin"
    if (proc.platform === "linux") return "linux"
    if (proc.platform === "win32") return "win32"
    return "other"
  },
  tmpdir: () => proc.tmpdir(),
})

/** Build a default {@link CwdPort} from a `getCwd` callback + an explicit
 *  `projectRoot`. */
export const defaultCwdPort = (getCwd: () => string, projectRoot: string): CwdPort => ({
  cwd: () => getCwd(),
  projectRoot: () => projectRoot,
})

/* ------------------------------------------------------------------------- */
/* Resolver                                                                   */
/* ------------------------------------------------------------------------- */

/** Per-{@link OsFamily} root. Win32 callers SHOULD wrap and read the system
 *  drive letter — this default uses `C:\` as a sane fallback. */
const rootFor = (family: OsFamily): string => (family === "win32" ? `C:${sep}` : "/")

/** Per-{@link OsFamily} `/tmp` analog. On macOS / Linux this is the literal
 *  `/tmp`; on Windows we fall back to {@link OsPort.tmpdir}. The reason
 *  `slash_tmp` and `tmpdir` are distinct kinds is that on macOS they DIFFER
 *  (tmpdir is `/var/folders/...` while `/tmp` is a real shared dir). */
const slashTmpFor = (osPort: OsPort): string => {
  const f = osPort.family()
  if (f === "darwin" || f === "linux") return "/tmp"
  // Win32 has no `/tmp` — fall through to per-user temp so the resolver still
  // produces *some* absolute path (a closed-port test catches drift).
  return osPort.tmpdir()
}

/** "tmp" — the platform's idiomatic short-lived path. macOS prefers
 *  `os.tmpdir()` (sandboxed user-private); Linux prefers `/tmp` (shared by
 *  convention); Windows uses `os.tmpdir()`. */
const tmpFor = (osPort: OsPort): string => {
  const f = osPort.family()
  if (f === "linux") return "/tmp"
  return osPort.tmpdir() // darwin / win32 / other
}

const joinUnder = (root: string, leaf: string): string => {
  if (root.endsWith(sep) || root.endsWith("/")) return `${root}${leaf}`
  return `${root}${sep}${leaf}`
}

/** Synchronous (kind, opts) → absolute path resolver. Pure — same inputs
 *  always yield the same output. The 8 special kinds (in
 *  {@link SpecialPathKind} order):
 *    - `root`       — `/` (POSIX) or `C:\` (Win32).
 *    - `project`    — the repo root (`CwdPort.projectRoot`).
 *    - `tmpdir`     — `OsPort.tmpdir()` (per-user, sandboxed on macOS).
 *    - `git`        — `<projectRoot>/.git` (or `GitPort.gitDir()` when set).
 *    - `agents`     — `<projectRoot>/.agents`.
 *    - `quanta`     — `<projectRoot>/.quanta`.
 *    - `slash_tmp`  — literal `/tmp` on POSIX, `tmpdir` on Win32.
 *    - `tmp`        — `/tmp` on Linux; `tmpdir` on macOS / Win32 / other.
 */
export const resolveSpecialPath = (kind: SpecialPathKind, opts: ResolveSpecialPathOpts): string => {
  const { os, cwd, git } = opts
  switch (kind) {
    case "root":
      return rootFor(os.family())
    case "project":
      return cwd.projectRoot()
    case "tmpdir":
      return os.tmpdir()
    case "git": {
      const dir = git?.gitDir()
      if (dir !== undefined && dir.length > 0) return dir
      return joinUnder(cwd.projectRoot(), ".git")
    }
    case "agents":
      return joinUnder(cwd.projectRoot(), ".agents")
    case "quanta":
      return joinUnder(cwd.projectRoot(), ".quanta")
    case "slash_tmp":
      return slashTmpFor(os)
    case "tmp":
      return tmpFor(os)
  }
}

/* ------------------------------------------------------------------------- */
/* Cached resolver (LRU)                                                      */
/* ------------------------------------------------------------------------- */

/** Caching wrapper — same `kind` resolves once per `(family, projectRoot,
 *  tmpdir, gitDir)` tuple. The access checker calls this on the hot path
 *  (every file access), so a 95%+ hit rate is the target. The cache is
 *  intentionally tiny (capacity 64) — the resolver inputs change rarely. */
export interface CachedResolver {
  /** Resolve `kind`, consulting the cache. */
  resolve(kind: SpecialPathKind): string
  /** Total resolutions seen (hit + miss). */
  totalCalls(): number
  /** Cache hits. */
  cacheHits(): number
  /** Drop all cached entries. Useful when the underlying ports change (e.g.
   *  cwd changes in tests). */
  clear(): void
}

const CACHE_CAPACITY = 64

export const createCachedResolver = (opts: ResolveSpecialPathOpts): CachedResolver => {
  // Cache key is `kind` PLUS the relevant resolver inputs so a port change
  // invalidates entries automatically. Cheap: we only stringify on miss.
  const cache = new Map<string, string>()
  let calls = 0
  let hits = 0

  const cacheKey = (kind: SpecialPathKind): string => {
    // Include every port input that the resolver actually reads — keeps the
    // cache correct even when the test reuses the same resolver across cwd
    // changes. Project root + tmpdir + git dir + os family cover the space.
    const family = opts.os.family()
    const tmp = opts.os.tmpdir()
    const proj = opts.cwd.projectRoot()
    const git = opts.git?.gitDir() ?? ""
    return `${kind}\x00${family}\x00${tmp}\x00${proj}\x00${git}`
  }

  const evictOldest = (): void => {
    // Map iteration is insertion order — pop the first entry to keep the
    // cache bounded (FIFO ≈ LRU for our access pattern: same 8 kinds churn).
    const first = cache.keys().next()
    if (!first.done) cache.delete(first.value)
  }

  return {
    resolve(kind) {
      calls++
      const k = cacheKey(kind)
      const hit = cache.get(k)
      if (hit !== undefined) {
        hits++
        // Refresh LRU order — re-insert at the tail.
        cache.delete(k)
        cache.set(k, hit)
        return hit
      }
      const v = resolveSpecialPath(kind, opts)
      if (cache.size >= CACHE_CAPACITY) evictOldest()
      cache.set(k, v)
      return v
    },
    totalCalls: () => calls,
    cacheHits: () => hits,
    clear: () => {
      cache.clear()
    },
  }
}
