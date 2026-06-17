/**
 * T-401 — deterministic PatchHygieneReport over the final cumulative diff.
 * EXACT diff facts only (no semantic-width "vibe" judgments). v1 denies exactly
 * one thing: stray ADDED files not on the sanctioned allowlist (the #16642
 * `.Z`/`.br` class). Everything else (owner-outside, file count) is telemetry.
 */

export interface PatchHygieneReport {
  /** Total distinct files the diff touches. */
  patchFileCount: number
  /** Files introduced by the diff (`new file mode`). */
  addedFiles: string[]
  /** Touched files not in the admitted owner set (telemetry; [] when owner unknown). */
  filesOutsideOwner: string[]
  /** Added files that are neither allowlisted nor plausible source (the deny set). */
  strayAddedFiles: string[]
  /** v1 deny: any stray added file present. */
  violation: boolean
}

/** Sanctioned generated files an agent may legitimately add. */
export const HYGIENE_ALLOWLIST: readonly string[] = ["reproduce_issue.py"]

/** Junk / build artifacts that must never be committed as a "fix". */
const JUNK_EXT = /\.(Z|br|orig|rej|bak|swp|tmp)$/i
const JUNK_NAME = /(^|\/)test\.html\./

const basename = (p: string): string => p.slice(p.lastIndexOf("/") + 1)

interface FileBlock {
  file: string
  added: boolean
}

/** Parse `diff --git` blocks into (file, added?) facts. Deterministic, pure. */
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
  const owner = new Set(opts.ownerFiles ?? [])
  const blocks = parseDiff(diff)
  const files = [...new Set(blocks.map((b) => b.file))]
  const addedFiles = [...new Set(blocks.filter((b) => b.added).map((b) => b.file))]

  const strayAddedFiles = addedFiles.filter((f) => {
    if (allow.has(basename(f))) return false
    return JUNK_EXT.test(f) || JUNK_NAME.test(f)
  })

  // owner-outside is telemetry; suppress when owner set is unknown (empty) to
  // avoid flagging every file as "outside".
  const filesOutsideOwner = owner.size === 0 ? [] : files.filter((f) => !owner.has(f))

  return {
    patchFileCount: files.length,
    addedFiles,
    filesOutsideOwner,
    strayAddedFiles,
    violation: strayAddedFiles.length > 0,
  }
}
