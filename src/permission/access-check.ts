/**
 * Access checker — 2-layer AND-conditioned file-system permission
 * (ADR-0135).
 *
 * Given a candidate path + access mode, returns `allow` ONLY when BOTH the
 * {@link PermissionProfile.fileSystem} AND the {@link FileSystemSandboxPolicy}
 * grant access. Either layer denying ⇒ denial (security strictness, see
 * ADR-0135 §Alternatives — OR was explicitly rejected).
 *
 * Single allow-list semantics per layer:
 *   - An entry's path must be a prefix of (or equal to) the candidate path.
 *   - For `write`, an entry with `access: "write"` is required.
 *   - For `read`,  an entry with `access: "read"` OR `"write"` suffices.
 *
 * Slice rules: pure. Special paths resolve via the injected
 * {@link CachedResolver}, which carries the OS / cwd / git ports. The
 * checker itself contains zero IO.
 */

import type {
  FileSystemAccess,
  FileSystemEntry,
  FileSystemPath,
  FileSystemSandboxPolicy,
  PermissionProfile,
} from "./permission-profile"
import type { CachedResolver } from "./special-path-resolver"

/** Result shape — the gate uses `allow` for routing and `reason` for
 *  surface messages / audit. `reason` is OPTIONAL on allow (silent OK). */
export interface AccessVerdict {
  readonly allow: boolean
  readonly reason?: string
}

const allowVerdict: AccessVerdict = Object.freeze({ allow: true })

/* ------------------------------------------------------------------------- */
/* Path matching                                                              */
/* ------------------------------------------------------------------------- */

/** A normalized entry — special paths already resolved to absolute strings. */
interface ResolvedEntry {
  readonly path: string
  readonly access: FileSystemAccess
}

/** True when `entryPath` is a path-prefix of (or equal to) `candidate`. The
 *  comparison is byte-literal — no realpath, no symlink follow (the OS
 *  sandbox layer covers symlink escape). A trailing separator on the entry
 *  is treated as "directory containing"; absent, the entry matches itself
 *  AND any path under it. */
const pathPrefixMatches = (entryPath: string, candidate: string): boolean => {
  if (entryPath === candidate) return true
  // Treat the entry as a directory boundary — `/repo` matches `/repo/x.ts`
  // but NOT `/repo2/x.ts`. We append a `/` (or `\` on Win32 — but `/` works
  // for the simple prefix case; Win32 callers normalize separators upstream).
  const boundary = entryPath.endsWith("/") || entryPath.endsWith("\\") ? entryPath : `${entryPath}/`
  if (candidate.startsWith(boundary)) return true
  // Also handle Win32 separator case explicitly when the entry didn't end
  // with one.
  if (!entryPath.endsWith("/") && !entryPath.endsWith("\\")) {
    if (candidate.startsWith(`${entryPath}\\`)) return true
  }
  return false
}

/** Resolve one {@link FileSystemPath} to an absolute string via the resolver. */
const resolvePath = (path: FileSystemPath, resolver: CachedResolver): string => {
  if (path.type === "special") return resolver.resolve(path.kind)
  return path.value
}

/** True when the access mode requested is covered by the entry's access. A
 *  `write`-typed entry covers `read` (POSIX-style superset). */
const coversAccess = (entry: ResolvedEntry, requested: FileSystemAccess): boolean => {
  if (entry.access === "write") return true
  return requested === "read"
}

/** True when ANY entry in `entries` matches the candidate path + access. */
const entriesAllow = (
  entries: ReadonlyArray<FileSystemEntry>,
  candidate: string,
  requested: FileSystemAccess,
  resolver: CachedResolver,
): boolean => {
  for (const e of entries) {
    const abs = resolvePath(e.path, resolver)
    const resolved: ResolvedEntry = { path: abs, access: e.access }
    if (!pathPrefixMatches(resolved.path, candidate)) continue
    if (!coversAccess(resolved, requested)) continue
    return true
  }
  return false
}

/* ------------------------------------------------------------------------- */
/* Public API                                                                 */
/* ------------------------------------------------------------------------- */

export interface CanAccessOpts {
  readonly profile: PermissionProfile
  readonly sandbox: FileSystemSandboxPolicy
  readonly resolver: CachedResolver
}

/** Strict 2-layer AND check. Returns `{allow: false}` with a categorical
 *  reason on either layer's denial; `{allow: true}` only when both layers
 *  contain at least one matching entry of sufficient access. */
export const canAccess = (
  path: string,
  op: FileSystemAccess,
  opts: CanAccessOpts,
): AccessVerdict => {
  const { profile, sandbox, resolver } = opts
  const layer1 = entriesAllow(profile.fileSystem.entries, path, op, resolver)
  if (!layer1) {
    return {
      allow: false,
      reason: `permission_profile.fileSystem denies ${op} on ${path}`,
    }
  }
  const layer2 = entriesAllow(sandbox.entries, path, op, resolver)
  if (!layer2) {
    return {
      allow: false,
      reason: `file_system_sandbox_policy denies ${op} on ${path}`,
    }
  }
  return allowVerdict
}
