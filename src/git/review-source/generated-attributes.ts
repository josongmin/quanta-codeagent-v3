/** RFC-02 B3 — generated-file filter, ATTRIBUTE-ONLY.
 *
 *  A path is excluded iff the REPOSITORY declares it generated via
 *  `.gitattributes linguist-generated` — the `set` or `true` state reported by
 *  `git check-attr`. This is the canonical static "the repo told us this file is
 *  generated" signal (the same attribute GitHub Linguist reads). There is NO
 *  filename, extension, path-shape, size, or content inference — that would be
 *  the forbidden answer-key/heuristic rule (`no-answer-key-regex-heuristics`).
 *
 *  Fail-closed: a check-attr PROCESS failure returns a typed failure so the
 *  caller can deny the requested filter explicitly, never a silent "show all" or
 *  "hide all". A per-path `unspecified` / `unset` / `false` / malformed / absent
 *  result RETAINS the file (only an explicit `set`/`true` ever hides one). */

import type { CheckAttrResult, GeneratedAttributePort } from "./ports"

/** The one attribute this filter honors. */
export const LINGUIST_GENERATED = "linguist-generated"

/** A file is "generated" only for these two declared states. */
const GENERATED_VALUES = new Set(["set", "true"])

/** Parse raw `git check-attr -z <attribute>` stdout into a `path → value` map.
 *  The `-z` format is a flat stream of NUL-terminated fields, three per path:
 *  `<path>\0<attribute>\0<value>\0`. NUL-splitting (never line-splitting) is
 *  what makes paths with spaces, tabs, and NEWLINES round-trip byte-exactly.
 *  A trailing incomplete triplet (malformed / truncated output) is ignored. */
export const parseCheckAttrZ = (stdout: string, attribute: string): Map<string, string> => {
  const fields = stdout.split("\0")
  const map = new Map<string, string>()
  // The stream ends with a trailing NUL ⇒ a trailing empty field; step in 3s and
  // stop when a full triplet is not available.
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const path = fields[i]
    const attr = fields[i + 1]
    const value = fields[i + 2]
    if (path === undefined || attr === undefined || value === undefined) continue
    if (attr === attribute) map.set(path, value)
  }
  return map
}

/** Partition paths into kept/excluded using an attribute map, preserving the
 *  INPUT order and byte-exact path identity. Excluded iff declared `set`/`true`. */
export const partitionGenerated = (
  paths: readonly string[],
  attrValues: ReadonlyMap<string, string>,
): { kept: string[]; excluded: string[] } => {
  const kept: string[] = []
  const excluded: string[] = []
  for (const path of paths) {
    const value = attrValues.get(path)
    if (value !== undefined && GENERATED_VALUES.has(value)) excluded.push(path)
    else kept.push(path)
  }
  return { kept, excluded }
}

export type GeneratedFilterResult =
  | { ok: true; kept: string[]; excluded: string[] }
  | { ok: false; message: string }

/** Query the injected port for `linguist-generated` over `paths` and partition
 *  them. Empty input ⇒ no port call. A process failure fails closed. */
export const applyGeneratedFilter = async (
  paths: readonly string[],
  port: GeneratedAttributePort,
): Promise<GeneratedFilterResult> => {
  if (paths.length === 0) return { ok: true, kept: [], excluded: [] }
  const res: CheckAttrResult = await port.checkAttr(LINGUIST_GENERATED, paths)
  if (!res.ok) return { ok: false, message: res.message }
  const map = parseCheckAttrZ(res.stdout, LINGUIST_GENERATED)
  return { ok: true, ...partitionGenerated(paths, map) }
}
