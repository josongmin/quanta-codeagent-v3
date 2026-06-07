import { lstatSync, readlinkSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import isPathInside from "is-path-inside"
import { FsJailError } from "./service"

export interface FsJailLibOptions {
  readonly root: string
  readonly resolveSymlinks: boolean
}

export interface FsJailLib {
  isInside(target: string): Promise<boolean>
  assertInside(target: string): Promise<string>
}

const lexicalNormalize = (abs: string): string => {
  const out: string[] = []
  for (const seg of abs.split("/")) {
    if (seg === "" || seg === ".") continue
    if (seg === "..") {
      out.pop()
      continue
    }
    out.push(seg)
  }
  return `/${out.join("/")}`
}

const MAX_SYMLINK_HOPS = 40

/** Symlink-aware canonicalization — see `service.ts#realResolve` for the full
 *  security rationale. Walks segment-by-segment from the root, expanding any
 *  symlink component (via `lstat`+`readlink`) EVEN WHEN ITS TARGET DOES NOT
 *  EXIST, so a dangling symlink to an out-of-jail location is surfaced to the
 *  containment check instead of being silently treated as a plain directory
 *  (the create-then-escape vector). Bounded by {@link MAX_SYMLINK_HOPS}. */
const realResolve = (abs: string): string => {
  let pending = abs.split("/").filter(Boolean)
  const resolved: string[] = []
  let hops = 0
  while (pending.length > 0) {
    const seg = pending.shift() as string
    if (seg === ".") continue
    if (seg === "..") {
      resolved.pop()
      continue
    }
    const current = `/${[...resolved, seg].join("/")}`
    let link: string | undefined
    try {
      if (lstatSync(current).isSymbolicLink()) link = readlinkSync(current)
    } catch {
      // Not-yet-created component — cannot be a symlink; append literally.
    }
    if (link === undefined) {
      resolved.push(seg)
      continue
    }
    if (++hops > MAX_SYMLINK_HOPS) return lexicalNormalize(abs)
    const prefix = isAbsolute(link) ? link : `/${[...resolved, link].join("/")}`
    resolved.length = 0
    pending = [...prefix.split("/").filter(Boolean), ...pending]
  }
  return `/${resolved.join("/")}`
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
