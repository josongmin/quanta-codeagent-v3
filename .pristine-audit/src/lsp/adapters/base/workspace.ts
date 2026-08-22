import { basename } from "node:path"
import { pathToFileURL } from "node:url"
import type { WorkspaceFolder } from "./raw-types"

/** Resolve a dotted `workspace/configuration` section against the client's
 *  configured settings. Empty/absent section ⇒ the whole config object; a
 *  path that escapes a non-object (or is missing) ⇒ `null` per the LSP
 *  contract (server treats `null` as "unset"). */
export const resolveWorkspaceConfiguration = (
  config: Readonly<Record<string, unknown>>,
  section: string | undefined,
): unknown => {
  if (!section || section.length === 0) return config
  let cur: unknown = config
  for (const part of section.split(".")) {
    if (typeof cur !== "object" || cur === null || Array.isArray(cur)) return null
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur ?? null
}

/** Map a directory path to the LSP `WorkspaceFolder` shape. `name` is the
 *  basename, falling back to the full path when the dir has no basename. */
export const toWorkspaceFolder = (dir: string): WorkspaceFolder => {
  const name = basename(dir)
  return { uri: pathToFileURL(dir).href, name: name.length > 0 ? name : dir }
}
