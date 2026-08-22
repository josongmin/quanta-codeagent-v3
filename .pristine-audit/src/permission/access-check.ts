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

import { isAbsolute, relative, resolve, sep } from "node:path"
import isPathInside from "is-path-inside"
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

/**
 * Canonical path normalization + root-containment primitive (T08 — May-31
 * bugbash, audit L8 H3). ONE helper — the SAME `is-path-inside` containment
 * primitive is reused by the DXT entry resolver (`plugin-isolation/dxt-loader`
 * `resolveEntrySafe`) so there is a single source of truth for "is `candidate`
 * within `root`" across permission checks AND plugin-path resolution.
 *
 * The prior implementation prefix-matched the RAW byte strings. That fails
 * OPEN against lexical traversal: a candidate `/repo/../etc/passwd`
 * byte-prefix-matches the allow-root `/repo/` and was granted, even though the
 * resolved path escapes the root entirely. We now `resolve()` BOTH sides first
 * (collapsing `.`/`..` and producing absolute paths) and then ask the mature
 * `is-path-inside` library whether the resolved candidate is the root itself
 * or strictly under it.
 *
 * Fail-closed posture: a relative entry/candidate that cannot be made absolute,
 * or any normalization that lands the candidate outside the root, returns
 * `false` (deny) — never an implicit allow. Symlink-target escape is still the
 * OS-sandbox layer's job (this is a lexical guard); but lexical `..` traversal
 * — the cheap, no-FS escape — is now closed here.
 */
export const containsPath = (entryPath: string, candidate: string): boolean => {
  // Both sides MUST be absolute for a meaningful containment decision. A
  // relative input is ambiguous (resolved against cwd) — refuse rather than
  // guess, so an allow-root only ever covers a concretely-rooted candidate.
  if (!isAbsolute(entryPath) || !isAbsolute(candidate)) return false
  const root = resolve(entryPath)
  const target = resolve(candidate)
  if (root === target) return true
  // Defense-in-depth: even though `is-path-inside` resolves internally, assert
  // the post-resolution relation does NOT begin with a `..` segment.
  const rel = relative(root, target)
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return false
  }
  return isPathInside(target, root)
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
    if (!containsPath(resolved.path, candidate)) continue
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
