import { stat } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import type { FileInfo } from "./types"

/** Resolve a possibly-relative path against cwd to an absolute path. */
export const resolvePath = (path: string): string => resolve(process.cwd(), path)

export const readFile = async (path: string): Promise<string> => {
  const file = Bun.file(resolvePath(path))
  if (!(await file.exists())) throw new Error(`File not found: ${path}`)
  return file.text()
}

export const writeFile = async (path: string, content: string): Promise<void> => {
  const abs = resolvePath(path)
  await Bun.write(abs, content)
}

export const statFile = async (path: string): Promise<FileInfo> => {
  const abs = resolvePath(path)
  const s = await stat(abs)
  return { path: abs, size: s.size, isDirectory: s.isDirectory() }
}

export const fileExists = async (path: string): Promise<boolean> =>
  Bun.file(resolvePath(path)).exists()

export const parentDir = (path: string): string => dirname(resolvePath(path))
