// V4A apply_patch — text → Patch AST.
//
// Pure, deterministic, line-by-line state machine. Any grammar violation
// throws `PatchParseError` with the 1-based line number — never silently
// repaired, never best-effort.
//
// Reference: [[codex-v4a-patch-grammar]] EBNF.

import {
  type Change,
  type Hunk,
  PATCH_LINE_PREFIX,
  PATCH_SENTINELS,
  type Patch,
  type PatchOp,
  PatchParseError,
} from "./types"

/**
 * Parser state — explicit so transitions are checked, not implied.
 * Names mirror the EBNF non-terminals.
 */
type State =
  | { kind: "outside" } // before `*** Begin Patch`
  | { kind: "top" } // between Begin Patch and End Patch, between file ops
  | { kind: "in_add"; path: string; lines: string[] }
  | { kind: "in_update"; path: string; moveTo?: string; hunks: Hunk[]; current: Hunk | undefined }
  | { kind: "done" } // after `*** End Patch`

/** Parse a V4A patch string into a `Patch` AST. Throws on any violation. */
export function parsePatch(text: string): Patch {
  // Spec uses LF terminators. We split on \n and tolerate a trailing CR per
  // line — but we do NOT trim arbitrary whitespace (significant for context).
  const rawLines = text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l))

  const ops: PatchOp[] = []
  let state: State = { kind: "outside" }

  for (let i = 0; i < rawLines.length; i++) {
    const lineNo = i + 1
    const line = rawLines[i]
    if (line === undefined) continue // unreachable per split semantics, makes TS happy

    // Trailing empty line after final \n is allowed if we're already done.
    if (line === "" && state.kind === "done" && i === rawLines.length - 1) continue

    state = step(state, line, lineNo, ops)
  }

  // Flush trailing in-progress states — anything other than `done` is an error.
  if (state.kind === "outside") {
    throw new PatchParseError(`Missing '${PATCH_SENTINELS.beginPatch}'`, 0)
  }
  if (state.kind !== "done") {
    throw new PatchParseError(`Missing '${PATCH_SENTINELS.endPatch}'`, rawLines.length)
  }

  return { ops }
}

/** Single state transition. Mutates `ops` only via explicit flushes. */
function step(state: State, line: string, lineNo: number, ops: PatchOp[]): State {
  switch (state.kind) {
    case "outside":
      if (line === PATCH_SENTINELS.beginPatch) return { kind: "top" }
      // Allow leading blank lines? Spec says first line is Begin Patch.
      // Be strict: anything else is an error.
      throw new PatchParseError(
        `Expected '${PATCH_SENTINELS.beginPatch}' as first line, got: ${truncate(line)}`,
        lineNo,
      )

    case "top":
      return stepTop(line, lineNo, ops)

    case "in_add":
      return stepInAdd(state, line, lineNo, ops)

    case "in_update":
      return stepInUpdate(state, line, lineNo, ops)

    case "done":
      // Only trailing empty line tolerated; handled by caller before reaching here.
      throw new PatchParseError(
        `Unexpected content after '${PATCH_SENTINELS.endPatch}': ${truncate(line)}`,
        lineNo,
      )
  }
}

/** Transitions from `top` state. */
function stepTop(line: string, lineNo: number, ops: PatchOp[]): State {
  if (line === PATCH_SENTINELS.endPatch) return { kind: "done" }

  const addPath = stripPrefix(line, PATCH_SENTINELS.addFile)
  if (addPath !== null) {
    requireNonEmpty(addPath, "Add File", lineNo)
    return { kind: "in_add", path: addPath, lines: [] }
  }

  const delPath = stripPrefix(line, PATCH_SENTINELS.deleteFile)
  if (delPath !== null) {
    requireNonEmpty(delPath, "Delete File", lineNo)
    ops.push({ kind: "delete", path: delPath })
    return { kind: "top" }
  }

  const updPath = stripPrefix(line, PATCH_SENTINELS.updateFile)
  if (updPath !== null) {
    requireNonEmpty(updPath, "Update File", lineNo)
    return { kind: "in_update", path: updPath, hunks: [], current: undefined }
  }

  throw new PatchParseError(
    `Expected file op or '${PATCH_SENTINELS.endPatch}', got: ${truncate(line)}`,
    lineNo,
  )
}

/** Transitions inside an Add File body. Lines must be `+`-prefixed until next op. */
function stepInAdd(
  state: Extract<State, { kind: "in_add" }>,
  line: string,
  lineNo: number,
  ops: PatchOp[],
): State {
  if (isOpBoundary(line)) {
    // Flush the Add op (even with zero lines — empty new file is valid).
    ops.push({ kind: "add", path: state.path, lines: state.lines })
    return stepTop(line, lineNo, ops)
  }

  if (!line.startsWith(PATCH_LINE_PREFIX.insert)) {
    throw new PatchParseError(
      `Add File body line must start with '${PATCH_LINE_PREFIX.insert}', got: ${truncate(line)}`,
      lineNo,
    )
  }
  state.lines.push(line.slice(PATCH_LINE_PREFIX.insert.length))
  return state
}

type UpdateState = Extract<State, { kind: "in_update" }>

/** Transitions inside an Update File body. Each sub-case is delegated. */
function stepInUpdate(state: UpdateState, line: string, lineNo: number, ops: PatchOp[]): State {
  // 1) New file op or end of patch terminates the current update.
  if (isOpBoundary(line)) {
    flushUpdate(state, lineNo, ops)
    return stepTop(line, lineNo, ops)
  }

  // 2) `*** Move to:` directive.
  const moveDest = stripPrefix(line, PATCH_SENTINELS.moveTo)
  if (moveDest !== null) {
    handleMoveTo(state, moveDest, lineNo)
    return state
  }

  // 3) `*** End of File` marker.
  if (line === PATCH_SENTINELS.endOfFile) {
    handleEndOfFile(state, lineNo)
    return state
  }

  // 4) Hunk header `@@` or `@@ <ctx>`.
  if (isHunkHeader(line)) {
    openHunk(state, line)
    return state
  }

  // 5) Change line — must start with `+`, `-`, or ` `. Implicit single hunk if
  //    no header has been seen yet (spec: `change?` can follow Update File).
  if (state.current === undefined) {
    state.current = { changes: [], endOfFile: false }
  }
  state.current.changes.push(parseChangeLine(line, lineNo))
  return state
}

function handleMoveTo(state: UpdateState, dest: string, lineNo: number): void {
  if (state.moveTo !== undefined) {
    throw new PatchParseError(
      `Duplicate '${PATCH_SENTINELS.moveTo.trimEnd()}' in Update File`,
      lineNo,
    )
  }
  if (state.current !== undefined || state.hunks.length > 0) {
    throw new PatchParseError(
      `'${PATCH_SENTINELS.moveTo.trimEnd()}' must precede hunk content`,
      lineNo,
    )
  }
  requireNonEmpty(dest, "Move to", lineNo)
  state.moveTo = dest
}

function handleEndOfFile(state: UpdateState, lineNo: number): void {
  if (state.current === undefined) {
    throw new PatchParseError(
      `'${PATCH_SENTINELS.endOfFile}' without preceding hunk content`,
      lineNo,
    )
  }
  state.current.endOfFile = true
  state.hunks.push(state.current)
  state.current = undefined
}

function isHunkHeader(line: string): boolean {
  return line === PATCH_SENTINELS.hunkHeader || line.startsWith(`${PATCH_SENTINELS.hunkHeader} `)
}

function openHunk(state: UpdateState, line: string): void {
  if (state.current !== undefined) {
    // Close out previous hunk (no eof marker).
    state.hunks.push(state.current)
  }
  const header =
    line === PATCH_SENTINELS.hunkHeader
      ? undefined
      : line.slice(PATCH_SENTINELS.hunkHeader.length + 1) // strip "@@ "
  const hunk: Hunk = { changes: [], endOfFile: false }
  if (header !== undefined) hunk.contextHeader = header
  state.current = hunk
}

/** Flush a fully-parsed Update into `ops`. Validates that at least one hunk exists. */
function flushUpdate(
  state: Extract<State, { kind: "in_update" }>,
  lineNo: number,
  ops: PatchOp[],
): void {
  if (state.current !== undefined) {
    state.hunks.push(state.current)
    state.current = undefined
  }
  if (state.hunks.length === 0) {
    throw new PatchParseError(
      `Update File '${state.path}' has no hunks (Move-only updates not allowed without rename target ` +
        `OR rename without edits requires zero change lines — empty Update is rejected)`,
      lineNo,
    )
  }
  const op: PatchOp = { kind: "update", path: state.path, hunks: state.hunks }
  if (state.moveTo !== undefined) op.moveTo = state.moveTo
  ops.push(op)
}

/** Parse a single `+|-|<space>` change line. */
function parseChangeLine(line: string, lineNo: number): Change {
  // Empty line — treat as a single-space context line. The spec's
  // `change_line ::= ("+" | "-" | " ") /(.*)/` requires a prefix byte; an
  // entirely empty line in the patch text is ambiguous, but real diffs in
  // the wild often elide the trailing space. We treat "" as a context line
  // with empty content (deterministic rule, documented).
  if (line === "") return { kind: "context", line: "" }

  const head = line[0]
  const rest = line.slice(1)
  switch (head) {
    case PATCH_LINE_PREFIX.context:
      return { kind: "context", line: rest }
    case PATCH_LINE_PREFIX.delete:
      return { kind: "delete", line: rest }
    case PATCH_LINE_PREFIX.insert:
      return { kind: "insert", line: rest }
    default:
      throw new PatchParseError(
        `Change line must start with '+', '-', or ' '; got '${head}' in: ${truncate(line)}`,
        lineNo,
      )
  }
}

/** True iff `line` opens a new top-level op or ends the patch. */
function isOpBoundary(line: string): boolean {
  return (
    line === PATCH_SENTINELS.endPatch ||
    line.startsWith(PATCH_SENTINELS.addFile) ||
    line.startsWith(PATCH_SENTINELS.deleteFile) ||
    line.startsWith(PATCH_SENTINELS.updateFile)
  )
}

/** Return the suffix after `prefix` if `line` starts with it, else null. */
function stripPrefix(line: string, prefix: string): string | null {
  return line.startsWith(prefix) ? line.slice(prefix.length) : null
}

function requireNonEmpty(value: string, label: string, lineNo: number): void {
  if (value.length === 0) {
    throw new PatchParseError(`Empty path for '${label}'`, lineNo)
  }
}

function truncate(s: string): string {
  return s.length > 80 ? `${s.slice(0, 77)}...` : s
}
