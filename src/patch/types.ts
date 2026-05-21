// V4A apply_patch — type definitions.
//
// Reference: [[codex-v4a-patch-grammar]] (full EBNF).
// All grammar tokens are derived directly from that spec; magic strings live
// only here.

/** Literal sentinels from the V4A grammar (spec §EBNF). Single source of truth. */
export const PATCH_SENTINELS = {
  beginPatch: "*** Begin Patch",
  endPatch: "*** End Patch",
  addFile: "*** Add File: ",
  deleteFile: "*** Delete File: ",
  updateFile: "*** Update File: ",
  moveTo: "*** Move to: ",
  hunkHeader: "@@", // hunk anchor; "@@" alone or "@@ <context>"
  endOfFile: "*** End of File",
} as const

/** Line-level prefixes inside hunks / Add-File bodies (spec §change_line / §add_line). */
export const PATCH_LINE_PREFIX = {
  context: " ", // unchanged context
  delete: "-", // removed line
  insert: "+", // added line
} as const

/** One semantic line inside an Update hunk. */
export type Change =
  | { kind: "context"; line: string }
  | { kind: "delete"; line: string }
  | { kind: "insert"; line: string }

/** One hunk inside an Update File op. */
export interface Hunk {
  /** Optional anchor string from `@@ <header>` line. `undefined` means hunk had no header. */
  contextHeader?: string
  /** Sequential changes inside this hunk. */
  changes: Change[]
  /** True iff `*** End of File` marker followed this hunk. Forces EOF anchor. */
  endOfFile: boolean
}

/** Discriminated union of file-level patch ops. */
export type PatchOp =
  | { kind: "add"; path: string; lines: string[] }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; moveTo?: string; hunks: Hunk[] }

/** Parsed V4A patch — AST root. */
export interface Patch {
  ops: PatchOp[]
}

/** Side-effect summary returned by `applyPatch`. */
export interface ApplyResult {
  filesAdded: string[]
  filesDeleted: string[]
  filesUpdated: string[]
  /** [from, to] pairs for renames. `from` also implies content edit was applied atomically. */
  filesMoved: Array<[string, string]>
}

/**
 * Injected port for filesystem side-effects. Keeps `applier` pure-functional
 * w.r.t. the host filesystem so it can be unit-tested in-memory.
 */
export interface FileSystemPort {
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  deleteFile(path: string): Promise<void>
  renameFile(from: string, to: string): Promise<void>
  exists(path: string): Promise<boolean>
}

/** Thrown by `parsePatch` on any grammar violation. Never swallowed. */
export class PatchParseError extends Error {
  public readonly lineNumber: number
  constructor(message: string, lineNumber: number) {
    super(`Patch parse error at line ${lineNumber}: ${message}`)
    this.name = "PatchParseError"
    this.lineNumber = lineNumber
  }
}

/** Thrown by `applyPatch` on a non-anchor apply failure (ambiguous ctx, missing file, etc.). */
export class PatchApplyError extends Error {
  public readonly path: string
  public readonly hunkIndex: number | undefined
  constructor(message: string, path: string, hunkIndex?: number) {
    const suffix = hunkIndex !== undefined ? ` (hunk ${hunkIndex})` : ""
    super(`Patch apply error on ${path}${suffix}: ${message}`)
    this.name = "PatchApplyError"
    this.path = path
    this.hunkIndex = hunkIndex
  }
}

/**
 * Thrown when the hunk's context (context + delete lines) cannot be located
 * in the target file even after the deterministic fuzzy pass. Distinct from
 * `PatchApplyError` so callers can surface a "regenerate patch with fresh
 * context" message specifically.
 */
export class PatchAnchorNotFoundError extends Error {
  public readonly path: string
  public readonly hunkIndex: number
  constructor(path: string, hunkIndex: number, detail: string) {
    super(`Patch anchor not found in ${path} (hunk ${hunkIndex}): ${detail}`)
    this.name = "PatchAnchorNotFoundError"
    this.path = path
    this.hunkIndex = hunkIndex
  }
}
