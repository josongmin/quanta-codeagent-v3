import { realpathSync } from "node:fs"
import { resolve } from "node:path"
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

const realResolve = (abs: string): string => {
  const segs = abs.split("/").filter(Boolean)
  for (let i = segs.length; i >= 0; i--) {
    const candidate = `/${segs.slice(0, i).join("/")}`
    try {
      const real = realpathSync(candidate || "/")
      const tail = segs.slice(i)
      return tail.length > 0 ? lexicalNormalize(`${real}/${tail.join("/")}`) : real
    } catch {
      // climb until an ancestor resolves
    }
  }
  return lexicalNormalize(abs)
}

const canonicalize = (path: string, resolveSymlinks: boolean): string => {
  const abs = lexicalNormalize(resolve(path))
  return resolveSymlinks ? realResolve(abs) : abs
}

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
