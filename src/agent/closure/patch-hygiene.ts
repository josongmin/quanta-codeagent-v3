/**
 * T-401 — deterministic PatchHygieneReport over the final cumulative diff.
 * EXACT diff facts only (no semantic-width "vibe" judgments). v1 denies exactly
 * one thing: stray ADDED files not on the sanctioned allowlist (the #16642
 * `.Z`/`.br` class). Everything else (owner-outside, file count) is telemetry.
 */

export interface PatchHygieneReport {
  patchFileCount: number
  addedFiles: string[]
  filesOutsideOwner: string[]
  strayAddedFiles: string[]
  violation: boolean
}

export const HYGIENE_ALLOWLIST: readonly string[] = ["reproduce_issue.py"]

const JUNK_EXT = /\.(Z|br|orig|rej|bak|swp|tmp)$/i
const JUNK_NAME = /(^|\/)test\.html\./

/**
 * Canonicalize a path for owner-membership comparison so a cosmetic skew
 * (a/ b/ diff prefix, leading `./`, `\` separators, trailing `/`) between an
 * `ownerFiles` string and a `parseDiff`-captured `a/(\S+)` path never makes a
 * legitimately-owned file look out-of-owner. Path-preserving (unlike basename,
 * which the allowlist uses) so `pkg/foo.py` ≠ `other/foo.py`.
 */
const canonPath = (p: string): string =>
  p
    .replace(/\\/g, "/") // normalize separators
    .replace(/^[ab]\//, "") // strip a/ or b/ diff prefix
    .replace(/^(?:\.\/)+/, "") // strip leading ./ (repeated)
    .replace(/\/+$/, "") // trim trailing slash(es)

const basename = (p: string): string => p.slice(p.lastIndexOf("/") + 1)

interface FileBlock {
  file: string
  added: boolean
}

const parseDiff = (diff: string): FileBlock[] => {
  const blocks: FileBlock[] = []
  const parts = diff.split(/^diff --git /m).slice(1)
  for (const part of parts) {
    const m = part.match(/^a\/(\S+) b\/\S+/)
    if (!m) continue
    const file = m[1] as string
    const added = /^new file mode /m.test(part)
    blocks.push({ file, added })
  }
  return blocks
}

export const buildPatchHygiene = (
  diff: string,
  opts: { ownerFiles?: readonly string[]; allowlist?: readonly string[] } = {},
): PatchHygieneReport => {
  const allow = new Set((opts.allowlist ?? HYGIENE_ALLOWLIST).map(basename))
  // Owner membership is compared canonically on BOTH sides (SSOT canonPath) so a
  // cosmetic prefix/separator skew never falsely reports an owned file outside.
  const owner = new Set((opts.ownerFiles ?? []).map(canonPath))
  const blocks = parseDiff(diff)
  const files = [...new Set(blocks.map((b) => b.file))]
  const addedFiles = [...new Set(blocks.filter((b) => b.added).map((b) => b.file))]
  const strayAddedFiles = addedFiles.filter((f) => {
    if (allow.has(basename(f))) return false
    return JUNK_EXT.test(f) || JUNK_NAME.test(f)
  })
  const filesOutsideOwner =
    owner.size === 0 ? [] : [...new Set(files.map(canonPath))].filter((f) => !owner.has(f))
  return {
    patchFileCount: files.length,
    addedFiles,
    filesOutsideOwner,
    strayAddedFiles,
    violation: strayAddedFiles.length > 0,
  }
}
