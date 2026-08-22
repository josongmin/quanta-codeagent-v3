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

/** Per-op observation kind for V4A apply-patch telemetry. Carries ONLY the
 *  categorical op type and the fuzzy-match tier that resolved a hunk —
 *  NEVER the patch text, file content, hunk lines, or anchor strings. Used by
 *  the tool layer to emit `quanta.patch.op` + `quanta.patch.fuzzy_match_tier`
 *  through the canonical span sink without coupling `@/patch` to observability. */
export type PatchObservation =
  | {
      /** ADR-0028 op category emitted to `quanta.patch.op`. `"move"` is the
       *  rename-edit variant of an `update` op (`moveTo` present); split here
       *  so dashboards can count renames distinctly from in-place updates. */
      readonly op: "add" | "delete" | "update" | "move"
    }
  | {
      /** Hunk landed; the tier is the strictest match that succeeded. */
      readonly op: "update" | "move"
      /** ADR-0028 fuzzy-match tier emitted to `quanta.patch.fuzzy_match_tier`. */
      readonly fuzzyMatchTier: "exact" | "whitespace" | "fuzzy"
    }

/** Optional sink for per-op patch observations. Default-OFF (callers may omit
 *  the argument; the applier then makes zero calls). Throws from the observer
 *  are caught + swallowed by the applier so a telemetry bug NEVER changes
 *  apply semantics. */
export type PatchObserver = (event: PatchObservation) => void

/**
 * Injected tracing seam for the V4A applier (closed-port DI). The applier is a
 * pure leaf and MUST NOT reach into the cross-cutting `@/observability` slice
 * at runtime; instead the composition root passes an adapter that maps each
 * {@link PatchObservation} onto the canonical `quanta.patch.*` OTel keys.
 *
 * Default-OFF: an ABSENT port is a no-op — the applier makes ZERO trace calls,
 * byte-identical to running with no telemetry. This mirrors the `@/storage`
 * `PatchFileSystemPort` posture: behaviour is fully determined by the injected
 * ports, never by an ambient global.
 *
 * Security invariant (enforced by the adapter, contract-documented here): the
 * port receives ONLY the categorical {@link PatchObservation} (op + fuzzy
 * tier) — NEVER patch text, file content, hunk lines, anchor strings, or
 * paths. A throw from `recordPatchOp` MUST be swallowed by the applier so a
 * telemetry defect can never change apply semantics.
 */
export interface PatchTracePort {
  /** Record one categorical per-op observation. No-throw contract; the applier
   *  also defensively swallows any throw. */
  recordPatchOp(event: PatchObservation): void
}

/**
 * Patch-specific FS port (read/write/delete/rename/exists). The general FS port
 * is `@/storage`'s `FileSystemPort` — DIFFERENT shape, different name on purpose.
 *
 * Injected port for filesystem side-effects. Keeps `applier` pure-functional
 * w.r.t. the host filesystem so it can be unit-tested in-memory.
 */
export interface PatchFileSystemPort {
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
