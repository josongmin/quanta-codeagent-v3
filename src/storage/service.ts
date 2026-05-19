import { stat } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import type { FileInfo } from "./types"

/** Resolve a possibly-relative path against `baseDir` (default `process.cwd()`)
 *  to an absolute path. An absolute `path` is returned unchanged. Tool callers
 *  pass their session `ctx.cwd`; non-tool callers keep the cwd default. */
export const resolvePath = (path: string, baseDir: string = process.cwd()): string =>
  resolve(baseDir || process.cwd(), path)

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
