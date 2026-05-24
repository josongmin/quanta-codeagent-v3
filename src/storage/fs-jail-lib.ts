/**
 * ADR-0192 — fs-jail containment check via `is-path-inside@4` (Sindre Sorhus,
 * 100K+ weekly downloads). SIBLING ADAPTER to {@link ./service.ts}'s self-impl
 * `isInside` + `lexicalNormalize` + `realResolve` pipeline. The existing
 * `service.ts` fs-jail stays byte-identical and remains the default; this
 * adapter exposes the SAME path-safety primitive backed by the battle-tested
 * lib for callers that want to share a single primitive across slices.
 *
 * The lib does ONE thing — segment-boundary containment check on already-
 * absolute paths — and explicitly does NOT resolve symlinks (its readme:
 * "should not use this as a security mechanism to guard against access to
 * certain places on the file system"). So we keep the domain-specific
 * pre-steps (lexical resolve + optional realpath) here, then delegate the
 * boundary check itself to `isPathInside`.
 *
 * Negative invariants:
 * - service.ts is NOT modified. Existing callers (resolveJailed / resolvePath
 *   / FileSystemPort) are byte-identical.
 * - This adapter has its own FsJailError class — narrower than the service-
 *   level QuantaError-derived one so callers wiring this primitive in
 *   isolation do not pull in the @/shared QuantaError ladder.
 */

import { realpath } from "node:fs/promises"
import path from "node:path"
import isPathInside from "is-path-inside"

export interface FsJailLibOpts {
  /** The jail root. All `isInside` / `assertInside` targets are validated
   *  against this directory. Resolved lexically via `path.resolve` once on
   *  every call (cheap), then optionally realpath'd. */
  readonly root: string
  /** Whether to realpath `target` before the containment check. Default `true`
   *  — matches the existing `service.ts` fs-jail posture (symlinks inside
   *  the jail must dereference to verify they stay inside). Set `false` for
   *  lexical-only checks (faster; vulnerable to symlink escape — caller's
   *  responsibility to know the target is not a symlink). */
  readonly resolveSymlinks?: boolean
}

export interface FsJailLib {
  /** Returns `true` iff `target` resolves inside `root` after lexical
   *  resolution and (when `resolveSymlinks` is on) realpath. Returns `false`
   *  when `target === root` (the lib treats a path as NOT inside itself —
   *  documented behavior; mirrors `path.relative("/a", "/a") === ""`). */
  isInside(target: string): Promise<boolean>
  /** Returns the safe absolute path on success or throws {@link FsJailError}
   *  on escape. The returned path is the post-realpath canonical path when
   *  `resolveSymlinks` is on (so callers can spawn/open it directly), else
   *  the lexical `path.resolve` output. */
  assertInside(target: string): Promise<string>
}

/** Thrown by {@link FsJailLib.assertInside} when `target` is not inside
 *  `root`. Carries both endpoints so the caller can log a precise diagnostic
 *  without re-constructing them. Separate from service.ts's `FsJailError`
 *  (which extends `QuantaError`) — this one is plain `Error` so callers can
 *  use the adapter without the `@/shared` runtime-config / QuantaError chain. */
export class FsJailError extends Error {
  constructor(
    public readonly target: string,
    public readonly root: string,
  ) {
    super(`Path escape: ${target} is not inside ${root}`)
    this.name = "FsJailError"
  }
}

/**
 * Construct an {@link FsJailLib} bound to `opts.root`.
 *
 * Pipeline per call:
 *  1. `path.resolve(opts.root)` → absolute root (relative roots resolved
 *     against `process.cwd()`).
 *  2. `path.resolve(target)` → absolute target (same).
 *  3. If `resolveSymlinks` (default `true`): `await realpath(absTarget)`. On
 *     ENOENT/EACCES the call falls back to the lexical path — matches
 *     service.ts's `realResolve` posture for not-yet-existing files.
 *  4. `isPathInside(absTarget, absRoot)` → boolean (segment-boundary check,
 *     handles `/rootfoo` vs `/root` correctly).
 *
 * The root is NOT realpath'd. `path.resolve` alone suffices because the lib's
 * `path.relative(absRoot, absTarget)` comparison normalizes both endpoints
 * lexically; realpath-ing the root would be an extra syscall per call with no
 * security gain (an attacker controlling the root path has already won).
 */
export const fsJailLib = (opts: FsJailLibOpts): FsJailLib => {
  const absRoot = path.resolve(opts.root)
  const resolveSyms = opts.resolveSymlinks !== false

  const canonical = async (target: string): Promise<string> => {
    const absTarget = path.resolve(target)
    if (!resolveSyms) return absTarget
    try {
      return await realpath(absTarget)
    } catch {
      // Target does not exist yet (writes to new files) or is unresolvable.
      // Fall through to the lexical path — service.ts's realResolve has the
      // same posture (climb to the nearest existing ancestor; here the lib
      // does the segment-boundary check on the lexical path, which is fine
      // because `path.resolve` already collapsed `.`/`..`).
      return absTarget
    }
  }

  return {
    async isInside(target: string): Promise<boolean> {
      const absTarget = await canonical(target)
      return isPathInside(absTarget, absRoot)
    },
    async assertInside(target: string): Promise<string> {
      const absTarget = await canonical(target)
      if (!isPathInside(absTarget, absRoot)) {
        throw new FsJailError(target, absRoot)
      }
      return absTarget
    },
  }
}
