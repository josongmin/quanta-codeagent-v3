import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

const unquote = (v: string): string =>
  (v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))
    ? v.slice(1, -1)
    : v

/** Parse one `KEY=VALUE` line into a pair, or null for blanks/comments/invalid.
 *  A leading `export ` prefix (common when a `.env` doubles as a shell-source
 *  file) is stripped so `export FOO=bar` yields key `FOO`, not `export FOO`. */
const parseLine = (raw: string): [string, string] | null => {
  let line = raw.trim()
  if (line === "" || line.startsWith("#")) return null
  if (line.startsWith("export ")) line = line.slice("export ".length).trimStart()
  const eq = line.indexOf("=")
  if (eq <= 0) return null
  return [line.slice(0, eq).trim(), unquote(line.slice(eq + 1).trim())]
}

/* ------------------------------------------------------------------ */
/* provenance (ADR-0555)                                               */
/* ------------------------------------------------------------------ */

/** KEY → absolute path of the dotenv file that SUPPLIED it. A key that was
 *  already present in the real environment (first-wins) is never recorded, so
 *  "absent from this map" reads as "came from the real env". Values are NEVER
 *  stored here — only names and file paths — so the registry is safe to log. */
const provenance = new Map<string, string>()

/** Read-only view of the dotenv provenance registry (key → file path). */
export const envFileProvenance = (): ReadonlyMap<string, string> => provenance

/** The dotenv file that supplied `key`, or `undefined` when the value came from
 *  the real environment (or was never set). Consumers use this to attribute a
 *  credential's ORIGIN before arming anything that would egress with it. */
export const envFileSourceOf = (key: string): string | undefined => provenance.get(key)

/** Test seam — clear the provenance registry between cases. */
export const __resetEnvFileProvenanceForTest = (): void => {
  provenance.clear()
}

const loadOne = (path: string): void => {
  if (!existsSync(path)) return
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const pair = parseLine(raw)
    if (pair && process.env[pair[0]] === undefined) {
      process.env[pair[0]] = pair[1]
      provenance.set(pair[0], path)
    }
  }
}

/** Load `KEY=VALUE` files into process.env without overriding values already
 *  set in the real environment. Tiny by design — no dotenv dependency.
 *  Later files do NOT override earlier ones (first wins, like real env).
 *  Paths resolve against the LAUNCH `process.cwd()` (not `--cwd`); every key a
 *  file supplies is attributed to that file in {@link envFileProvenance}. */
export const loadEnvFiles = (files: string[]): void => {
  for (const file of files) loadOne(resolve(process.cwd(), file))
}
