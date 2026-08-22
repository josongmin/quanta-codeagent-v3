/**
 * Path + unified-diff utilities for the selection executor. Pure leaf module:
 * no dependency on other selection-* modules. `normalizeSelectionPath(s)` and
 * `filesFromPatch` are re-exported from `./selection-executor` (public surface);
 * the rest are internal helpers imported back by the executor + telemetry.
 */

import { isAbsolute, relative, sep } from "node:path"
import { filesFromUnifiedDiff } from "@/shared"

export const fwd = (s: string): string => s.split(sep).join("/").replace(/\\/g, "/")

export const relInsideSandbox = (path: string, sandbox: string | undefined): string | null => {
  if (!isAbsolute(path)) return path
  if (sandbox === undefined) return null
  const rel = relative(sandbox, path)
  return rel === "" || rel.startsWith("..") ? null : fwd(rel)
}

export const normalizePathParts = (path: string): string | null => {
  const parts: string[] = []
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") return null
    parts.push(part)
  }
  const out = parts.join("/")
  return out === "" || out === "dev/null" ? null : out
}

/** Canonical repo-relative path used by selection owners and candidate patches.
 *  Absolute paths are accepted only when they are inside the active sandbox. */
export const normalizeSelectionPath = (raw: string, sandbox: string | undefined): string | null => {
  let p = fwd(raw.trim().replace(/^["'`]+|["'`]+$/g, ""))
  if (p === "" || p === "/dev/null") return null
  const rel = relInsideSandbox(p, sandbox)
  if (rel === null) return null
  p = rel
  // Generic selection paths are repo-relative authorities, not raw git diff
  // headers. Stripping a leading `a/` or `b/` here would collapse real paths
  // like `a/pkg/file.py` onto `pkg/file.py`.
  p = p.replace(/^\.\//, "")
  return normalizePathParts(p)
}

export const normalizeSelectionPaths = (
  paths: readonly string[],
  sandbox: string | undefined,
): string[] => {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of paths) {
    const p = normalizeSelectionPath(raw, sandbox)
    if (p === null || seen.has(p)) continue
    seen.add(p)
    out.push(p)
  }
  return out
}

/** Repo-relative files a unified diff touches (its `+++ b/<f>` headers, plus
 *  `--- a/<f>` for pure deletions). Used for owner-coverage scoring. */
export const filesFromPatch = (patch: string): string[] => {
  const files = new Set<string>()
  for (const raw of filesFromUnifiedDiff(patch)) {
    const f = normalizeSelectionPath(raw, undefined)
    if (f !== null) files.add(f)
  }
  return [...files]
}

/** Normalize a diff to its `+++ b/` / `--- a/` FILE headers plus `+/-` CONTENT
 *  lines (dropping `@@` hunk-offset noise + context) so two patches dedup only
 *  when they make the SAME edit to the SAME file(s). Keeping the file headers is
 *  deliberate: the SAME content edit on DIFFERENT files is a DIFFERENT fix site
 *  (the diversity the executor exists to span) and must NOT collide. */
export const normalizePatch = (patch: string): string =>
  patch
    .split("\n")
    .filter((l) => /^[+-]/.test(l))
    .map((l) => l.trimEnd())
    .join("\n")
