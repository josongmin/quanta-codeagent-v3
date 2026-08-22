import { resolve } from "node:path"
import isPathInside from "is-path-inside"
// The symlink-aware create-then-escape defense is the ONE shared core (jul-27
// DRY audit — was byte-duplicated here + in service.ts).
import { lexicalNormalize, realResolve } from "./canonicalize-core"
import { FsJailError } from "./service"

export interface FsJailLibOptions {
  readonly root: string
  readonly resolveSymlinks: boolean
}

export interface FsJailLib {
  isInside(target: string): Promise<boolean>
  assertInside(target: string): Promise<string>
}

const canonicalize = (path: string, resolveSymlinks: boolean): string => {
  const abs = lexicalNormalize(resolve(path))
  return resolveSymlinks ? realResolve(abs) : abs
}

/** §20.4 — reusable symlink-aware path canonicalization (absolute + `..`
 *  normalize + segment-by-segment symlink expansion, including not-yet-created
 *  components, bounded hops). `base` resolves a relative `path`. Exported so the
 *  FS-ownership gate shares the SAME create-then-escape-proof canonicalization
 *  the jail uses (so an owned/forbidden boundary can't be bypassed via symlink
 *  or `..`). Pure-ish (reads lstat/readlink only; never writes). */
export const canonicalizePath = (path: string, base?: string): string =>
  canonicalize(base !== undefined ? resolve(base, path) : path, true)

export const fsJailLib = (opts: FsJailLibOptions): FsJailLib => {
  const canonicalRoot = canonicalize(opts.root, opts.resolveSymlinks)

  const checkedTarget = (target: string): { absolute: string; canonical: string } => {
    const absolute = lexicalNormalize(resolve(target))
    const canonical = opts.resolveSymlinks ? realResolve(absolute) : absolute
    return { absolute, canonical }
  }

  return {
    async isInside(target: string): Promise<boolean> {
      const checked = checkedTarget(target)
      return isPathInside(checked.canonical, canonicalRoot)
    },
    async assertInside(target: string): Promise<string> {
      const checked = checkedTarget(target)
      if (!isPathInside(checked.canonical, canonicalRoot)) {
        throw new FsJailError(
          `Path escapes the fs-jail-lib root: "${checked.absolute}" is outside "${canonicalRoot}"`,
          { target: checked.absolute, root: canonicalRoot },
        )
      }
      return checked.absolute
    },
  }
}

export { FsJailError }
