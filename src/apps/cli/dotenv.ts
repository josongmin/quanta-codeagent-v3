import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

const unquote = (v: string): string =>
  (v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))
    ? v.slice(1, -1)
    : v

/** Parse one `KEY=VALUE` line into a pair, or null for blanks/comments/invalid. */
const parseLine = (raw: string): [string, string] | null => {
  const line = raw.trim()
  if (line === "" || line.startsWith("#")) return null
  const eq = line.indexOf("=")
  if (eq <= 0) return null
  return [line.slice(0, eq).trim(), unquote(line.slice(eq + 1).trim())]
}

const loadOne = (path: string): void => {
  if (!existsSync(path)) return
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const pair = parseLine(raw)
    if (pair && process.env[pair[0]] === undefined) process.env[pair[0]] = pair[1]
  }
}

/** Load `KEY=VALUE` files into process.env without overriding values already
 *  set in the real environment. Tiny by design — no dotenv dependency.
 *  Later files do NOT override earlier ones (first wins, like real env). */
export const loadEnvFiles = (files: string[]): void => {
  for (const file of files) loadOne(resolve(process.cwd(), file))
}
