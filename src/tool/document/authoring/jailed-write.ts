/**
 * H14b — the FS-jail write chokepoint shared by `xlsx_write` + `docx_write`.
 *
 * Both authoring tools MUST land their bytes through ONE jailed path so a
 * malicious/relative path can never escape `ctx.cwd`. We reuse the canonical
 * {@link resolveJailed} chokepoint (same one `resolveJailedDoc` wraps for the
 * readers) — NOT a bespoke `path.resolve` + `startsWith`. The reader helper
 * (`resolveJailedDoc`) returns a plain string for `Bun.file`; here we need the
 * branded jailed path for a `Bun.write` of raw BYTES, so we call
 * `resolveJailed` directly with the same empty/NUL pre-checks.
 *
 * Versioned-sibling policy (NEVER silent overwrite): if the resolved target
 * already exists, we DO NOT clobber it. Instead we pick the first free
 * `name-vN.ext` sibling (`report.xlsx` → `report-v2.xlsx` → `report-v3.xlsx`).
 * This mirrors the "versioned sibling" discipline the spec calls for and keeps
 * an authoring tool from destroying a hand-edited prior artifact.
 *
 * Slice posture (RFC §3.1): imports ONLY `node:path` + `@/storage`. No
 * `@/agent`, no `@/permission`. The tools call this from their own execute().
 */

import { extname } from "node:path"
import { FsJailError, fileExists, resolveJailed } from "@/storage"

/** Outcome of resolving + version-bumping a target path. */
export type JailedTargetResult =
  | {
      readonly kind: "ok"
      readonly abs: string
      readonly finalRelative: string
      readonly bumped: boolean
    }
  | { readonly kind: "jail_error"; readonly message: string }

/** Insert a `-vN` suffix before the extension. `report.xlsx` → `report-v2.xlsx`. */
const versionedName = (relative: string, version: number): string => {
  const ext = extname(relative)
  const base = ext.length > 0 ? relative.slice(0, relative.length - ext.length) : relative
  return `${base}-v${version}${ext}`
}

/**
 * Resolve `rawPath` against `cwd` through the FS jail, then version-bump to the
 * first non-existent sibling so an existing file is NEVER overwritten.
 *
 * NO-THROW for the jail-escape case: a {@link FsJailError} (empty path, NUL
 * byte, traversal) is returned as `{kind:"jail_error"}` so the caller can yield
 * a typed `permission_denied`. Any OTHER error (none expected — `fileExists`
 * is non-throwing) bubbles.
 */
export const resolveVersionedJailedTarget = async (
  cwd: string,
  rawPath: string,
): Promise<JailedTargetResult> => {
  if (rawPath === "") return { kind: "jail_error", message: "empty path is not allowed" }
  if (rawPath.includes("\0")) {
    return { kind: "jail_error", message: "NUL byte in path is not allowed" }
  }
  let firstAbs: string
  try {
    firstAbs = resolveJailed(rawPath, cwd) as string
  } catch (e) {
    if (e instanceof FsJailError) return { kind: "jail_error", message: e.message }
    throw e
  }

  // If the first choice is free, use it as-is.
  if (!(await fileExists(firstAbs))) {
    return { kind: "ok", abs: firstAbs, finalRelative: rawPath, bumped: false }
  }

  // Otherwise pick the first free -vN sibling. Bounded to avoid an unbounded
  // loop on a pathological directory; 9_999 versions is far past any real use.
  for (let v = 2; v <= 9999; v++) {
    const candidate = versionedName(rawPath, v)
    let candidateAbs: string
    try {
      candidateAbs = resolveJailed(candidate, cwd) as string
    } catch (e) {
      if (e instanceof FsJailError) return { kind: "jail_error", message: e.message }
      throw e
    }
    if (!(await fileExists(candidateAbs))) {
      return { kind: "ok", abs: candidateAbs, finalRelative: candidate, bumped: true }
    }
  }
  return { kind: "jail_error", message: "could not find a free versioned sibling (9999 exist)" }
}

/** Write raw bytes to an already-jailed absolute path. `Bun.write` creates the
 *  parent dir and accepts a `Uint8Array` (binary). Kept here so the tools never
 *  touch `Bun.write` directly. */
export const writeJailedBytes = async (abs: string, bytes: Uint8Array): Promise<void> => {
  await Bun.write(abs, bytes)
}
