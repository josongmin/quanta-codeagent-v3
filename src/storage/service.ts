import { realpathSync } from "node:fs"
import { stat } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { QuantaError } from "@/shared"
import type { FileInfo } from "./types"

/** Raised when a tool's filesystem access escapes its `ctx.cwd` jail root.
 *  Tools MUST catch this and surface `ok:false` — it is a hard stop, never a
 *  partial read/write. Mirrors the posture of `@/runtime`'s SandboxPolicyError
 *  but stays inside the storage slice (no cross-slice import). */
export class FsJailError extends QuantaError {
  constructor(message: string) {
    super("fs_jail", message)
  }
}

/** The FS jail is ON by default (secure-by-default). The documented escape
 *  hatch `QUANTA_FS_JAIL=off` disables it for power users / cross-repo work;
 *  when off, behavior is exactly the pre-jail behavior. Read at call time so
 *  tests can toggle it per-case. */
const jailDisabled = (): boolean => process.env.QUANTA_FS_JAIL === "off"

/** Normalize an absolute path to its canonical segment list (collapsing `.`
 *  and resolving `..` lexically). Returns the cleaned absolute path. */
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

/** True iff `child` is the jail root itself or strictly inside it. Compared on
 *  segment boundaries so `/jailX` cannot pass a `/jail` root. */
const isInside = (root: string, child: string): boolean => {
  if (child === root) return true
  const prefix = root === "/" ? "/" : `${root}/`
  return child.startsWith(prefix)
}

/** Resolve the realpath of the nearest EXISTING ancestor of `abs`, then
 *  re-append the not-yet-existing trailing segments. This makes a symlink in
 *  the existing portion unable to smuggle the final path outside the jail
 *  (the classic symlink-escape) while still supporting writes to a not-yet-
 *  created file. Falls back to the lexical path if nothing resolves
 *  (extremely unusual — `/` always exists). */
const realResolve = (abs: string): string => {
  const segs = abs.split("/").filter(Boolean)
  for (let i = segs.length; i >= 0; i--) {
    const candidate = `/${segs.slice(0, i).join("/")}`
    try {
      const real = realpathSync(candidate || "/")
      const tail = segs.slice(i)
      return tail.length > 0 ? lexicalNormalize(`${real}/${tail.join("/")}`) : real
    } catch {
      // This ancestor does not exist (or is not resolvable) — climb up.
    }
  }
  return lexicalNormalize(abs)
}

/** Enforce the jail: resolve `requested` against `baseDir`, lexically and via
 *  realpath of the existing parent, and reject any final path that lands
 *  outside the `baseDir` root. Throws {@link FsJailError} on escape. Only
 *  invoked when a tool explicitly passes its `ctx.cwd` as `baseDir`. */
const enforceJail = (requested: string, baseDir: string, abs: string): string => {
  if (jailDisabled()) return abs
  const root = realResolve(lexicalNormalize(resolve(baseDir)))
  const target = realResolve(lexicalNormalize(abs))
  if (!isInside(root, target)) {
    throw new FsJailError(
      `Path escapes the working-directory jail: "${requested}" resolves outside ${root}. ` +
        "Set QUANTA_FS_JAIL=off to allow cross-directory access.",
    )
  }
  return abs
}

/** Resolve a possibly-relative path against `baseDir` (default `process.cwd()`)
 *  to an absolute path. An absolute `path` is returned unchanged. Tool callers
 *  pass their session `ctx.cwd`; non-tool callers keep the cwd default.
 *
 *  FS JAIL (secure-by-default): when a tool explicitly passes a `baseDir`
 *  (its `ctx.cwd`), the resolved real path is confined to that jail root —
 *  `..` climbs, absolute paths landing outside, and symlink escapes are all
 *  rejected with {@link FsJailError}. No-baseDir callers (state.ts etc.) keep
 *  the exact pre-jail behavior for back-compat. `QUANTA_FS_JAIL=off` opts out. */
export const resolvePath = (path: string, baseDir?: string): string => {
  const abs = resolve(baseDir || process.cwd(), path)
  // The jail triggers EXACTLY when a tool passed an explicit, non-empty
  // baseDir. Absent/empty baseDir ⇒ legacy callers, behavior unchanged.
  if (baseDir !== undefined && baseDir !== "") return enforceJail(path, baseDir, abs)
  return abs
}

export const readFile = async (path: string, baseDir?: string): Promise<string> => {
  const file = Bun.file(resolvePath(path, baseDir))
  if (!(await file.exists())) throw new Error(`File not found: ${path}`)
  return file.text()
}

export const writeFile = async (path: string, content: string, baseDir?: string): Promise<void> => {
  const abs = resolvePath(path, baseDir)
  await Bun.write(abs, content)
}

export const statFile = async (path: string, baseDir?: string): Promise<FileInfo> => {
  const abs = resolvePath(path, baseDir)
  const s = await stat(abs)
  return { path: abs, size: s.size, isDirectory: s.isDirectory() }
}

export const fileExists = async (path: string, baseDir?: string): Promise<boolean> =>
  Bun.file(resolvePath(path, baseDir)).exists()

export const parentDir = (path: string, baseDir?: string): string =>
  dirname(resolvePath(path, baseDir))
