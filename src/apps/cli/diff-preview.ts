/**
 * Inline unified-diff preview for write/edit/apply_patch/scripted_replace.
 *
 * Wired BEFORE the ad-hoc readline confirm prompt in `repl.ts` so the user
 * sees what they are approving instead of just a tool name. Default-ON via
 * `QUANTA_DIFF_PREVIEW=1` (TTY only); set `"0"` to revert to the byte-
 * identical plain-text confirm. The preview path is best-effort — any
 * failure (file missing, binary content, parser/regex throw) returns
 * `undefined` so the caller falls back to the legacy prompt without
 * surfacing a stack trace mid-turn.
 *
 * Layering:
 *   - This module lives in `apps/cli` because the ANSI helpers (`@/ui`) and
 *     the env knobs are CLI-surface concerns. The pure diff math
 *     (line-LCS) has no surface dependency and could be hoisted to
 *     `@/runner` in a separate PR (see the worktree task notes — explicitly
 *     out of scope here to keep this slice small).
 *   - Imports: `node:fs/promises` (file read), `@/permission` (ToolAction
 *     shape), `@/ui` (ANSI helpers). NO `@/agent`, NO `@/runner`, NO
 *     `@/tool` — the action's `input` is read structurally so the slice
 *     stays decoupled from the tool implementations.
 *
 * Inputs handled (snake_case keys match the actual tool zod schemas in
 * `src/tool/{write,edit,apply-patch,scripted-replace}`):
 *   - write             { path, content }                  → file diff
 *   - edit              { path, old_string, new_string }   → fragment diff
 *   - apply_patch       { patch }                          → patch passthrough
 *   - scripted_replace  { file, pattern, replacement,
 *                         isRegex?, count? }               → file diff
 */

import { readFile } from "node:fs/promises"
import type { ToolAction } from "@/permission"
// ADR-0440 — the pure line-LCS diff math + caps + binary probe now live in the
// surface-agnostic `@/runner/diff-ops` slice so the web-daemon canvas emitter
// consumes the SAME implementation (diff math runs once). This module keeps the
// ANSI serialization + file-reading concerns and re-exports the structured API.
import {
  type DiffOp,
  diffLines,
  diffOps as diffOpsCore,
  isBinary,
  resolveEnvCaps,
} from "@/runner/diff-ops"
import { cyan, dim, green, red } from "@/ui/ui-helpers"

export { resolveEnvCaps }

/** Whether the inline preview should be rendered at all. Default ON when
 *  stderr is a TTY; explicit `QUANTA_DIFF_PREVIEW=0` disables. Tests set
 *  `QUANTA_DIFF_PREVIEW=1` to force-on without needing a real TTY. */
export const diffPreviewEnabled = (): boolean => {
  const raw = process.env.QUANTA_DIFF_PREVIEW
  if (raw === "0") return false
  if (raw === "1") return true
  return process.stderr.isTTY === true
}

// ───────────────────────────────────────────────────────────────────────
// Public entry
// ───────────────────────────────────────────────────────────────────────

export interface RenderActionDiffOptions {
  /** Per-file content byte cap. Default 64 KiB. */
  readonly maxBytes?: number
  /** Visible diff-line cap. Default 200. */
  readonly maxLines?: number
  /** Injection seam for tests + non-fs sources. Defaults to `node:fs/promises#readFile`. */
  readonly readFile?: (path: string) => Promise<string>
}

/** Try to render a unified-diff preview for a tool action. Returns
 *  `undefined` when the tool has no file mutation we know how to preview,
 *  when the input shape doesn't match, or when any IO/parse step fails.
 *  Never throws — the confirm path remains usable. */
export const renderActionDiff = async (
  action: ToolAction,
  opts: RenderActionDiffOptions = {},
): Promise<string | undefined> => {
  const env = resolveEnvCaps()
  const maxBytes = opts.maxBytes ?? env.maxBytes
  const maxLines = opts.maxLines ?? env.maxLines
  const reader = opts.readFile ?? defaultReadFile
  try {
    switch (action.tool) {
      case "write":
        return await renderWrite(action.input, { maxBytes, maxLines, reader })
      case "edit":
        return renderEdit(action.input, { maxBytes })
      case "apply_patch":
        return renderApplyPatch(action.input, { maxLines })
      case "scripted_replace":
        return await renderScriptedReplace(action.input, { maxBytes, maxLines, reader })
      default:
        return undefined
    }
  } catch {
    // Best-effort preview — any unexpected throw collapses to the legacy
    // plain-text confirm (caller treats `undefined` as "no preview").
    return undefined
  }
}

// ───────────────────────────────────────────────────────────────────────
// Per-tool branches
// ───────────────────────────────────────────────────────────────────────

interface FileCaps {
  maxBytes: number
  maxLines: number
  reader: (path: string) => Promise<string>
}

const renderWrite = async (input: unknown, caps: FileCaps): Promise<string | undefined> => {
  const i = asRecord(input)
  if (!i) return undefined
  const path = asString(i.path)
  const content = asString(i.content)
  if (path === undefined || content === undefined) return undefined
  if (isBinary(content) || content.length > caps.maxBytes) {
    return `${header(path)}\n${dim("[content too large or binary; preview skipped]")}`
  }
  const prev = await readOrEmpty(caps.reader, path, caps.maxBytes)
  if (prev === BINARY_SENTINEL) {
    return `${header(path)}\n${dim("[existing file is binary or oversize; preview skipped]")}`
  }
  const body = renderUnified(prev ?? "", content, caps.maxLines)
  return `${header(path, prev === undefined ? "new file" : undefined)}\n${body}`
}

const renderEdit = (input: unknown, caps: { maxBytes: number }): string | undefined => {
  const i = asRecord(input)
  if (!i) return undefined
  const path = asString(i.path)
  const oldS = asString(i.old_string)
  const newS = asString(i.new_string)
  if (path === undefined || oldS === undefined || newS === undefined) return undefined
  if (
    oldS.length > caps.maxBytes ||
    newS.length > caps.maxBytes ||
    isBinary(oldS) ||
    isBinary(newS)
  ) {
    return `${header(path)}\n${dim("[fragment too large or binary; preview skipped]")}`
  }
  // Edit replaces a fragment in place; we show the fragment swap directly
  // rather than synthesizing a full-file LCS diff (cheaper + clearer for
  // small replacements, which are the common case).
  const lines: string[] = [header(path)]
  for (const l of oldS.split("\n")) lines.push(red(`- ${l}`))
  for (const l of newS.split("\n")) lines.push(green(`+ ${l}`))
  return lines.join("\n")
}

const renderApplyPatch = (input: unknown, caps: { maxLines: number }): string | undefined => {
  const i = asRecord(input)
  if (!i) return undefined
  const patch = asString(i.patch)
  if (patch === undefined) return undefined
  // V4A patches use "*** Begin Patch" markers, NOT classic unified-diff
  // hunks. We still colorize +/- lines for legibility and surface the
  // file directive lines (`*** Update File: …`) in dim cyan so the user
  // can see what files are touched at a glance.
  const raw = patch.split("\n")
  const lines: string[] = [dim(cyan("── apply_patch (V4A) ──"))]
  for (const l of raw) {
    if (l.startsWith("*** ")) lines.push(dim(cyan(l)))
    else if (l.startsWith("+")) lines.push(green(l))
    else if (l.startsWith("-")) lines.push(red(l))
    else lines.push(l)
  }
  return clip(lines, caps.maxLines)
}

const renderScriptedReplace = async (
  input: unknown,
  caps: FileCaps,
): Promise<string | undefined> => {
  const i = asRecord(input)
  if (!i) return undefined
  const path = asString(i.file)
  const pattern = asString(i.pattern)
  const replacement = asString(i.replacement)
  if (path === undefined || pattern === undefined || replacement === undefined) return undefined
  const prev = await readOrEmpty(caps.reader, path, caps.maxBytes)
  if (prev === undefined) {
    // scripted_replace requires an existing file; surface that intent in
    // the preview so the user isn't surprised when the tool errors.
    return `${header(path)}\n${dim("[file not found; preview skipped]")}`
  }
  if (prev === BINARY_SENTINEL) {
    return `${header(path)}\n${dim("[existing file is binary or oversize; preview skipped]")}`
  }
  const isRegex = i.isRegex === true
  const count = typeof i.count === "number" && i.count > 0 ? i.count : Number.POSITIVE_INFINITY
  const next = applyScriptedReplace(prev, pattern, replacement, isRegex, count)
  if (next === undefined) {
    return `${header(path)}\n${dim("[invalid regex; preview skipped]")}`
  }
  if (next === prev) {
    return `${header(path)}\n${dim("[no matches; file unchanged]")}`
  }
  return `${header(path)}\n${renderUnified(prev, next, caps.maxLines)}`
}

const applyScriptedReplace = (
  source: string,
  pattern: string,
  replacement: string,
  isRegex: boolean,
  count: number,
): string | undefined => {
  if (!isRegex) {
    if (count === Number.POSITIVE_INFINITY) return source.split(pattern).join(replacement)
    let out = source
    for (let i = 0; i < count; i++) {
      const idx = out.indexOf(pattern)
      if (idx < 0) break
      out = out.slice(0, idx) + replacement + out.slice(idx + pattern.length)
    }
    return out
  }
  let re: RegExp
  try {
    re = new RegExp(pattern, "g")
  } catch {
    return undefined
  }
  if (count === Number.POSITIVE_INFINITY) return source.replace(re, replacement)
  let i = 0
  const single = new RegExp(pattern)
  return source.replace(re, (m) => (i++ < count ? m.replace(single, replacement) : m))
}

// ───────────────────────────────────────────────────────────────────────
// Unified-diff renderer (line-level LCS, color-wrapped)
// ───────────────────────────────────────────────────────────────────────

/** Default number of unchanged context lines emitted on each side of a
 *  changed run, matching `git diff`'s `-U3` / `--unified=3` default
 *  (see `git diff --help`, "-U<n> / --unified=<n>", default 3). Used only
 *  by the hunk-aware render path ({@link renderUnified} with
 *  `{ hunks: true }`); the legacy simple path is unaffected. */
export const DEFAULT_CONTEXT_LINES = 3

/** Options for {@link renderUnified}. All default to the legacy
 *  byte-identical simple render (`+`/`-`/space prefixes, no gutters, no
 *  hunk headers). Setting `hunks: true` lights the richer unified-diff
 *  path (git-style `@@ -A,B +C,D @@` headers + old/new line-number
 *  gutters + context collapsing). */
export interface RenderUnifiedOptions {
  /** When true, emit git-style hunk headers + line-number gutters and
   *  collapse large all-unchanged gaps to `context` lines per side.
   *  Default false → legacy simple render (byte-identical). */
  readonly hunks?: boolean
  /** Context lines per side around each changed run (only when
   *  `hunks: true`). Default {@link DEFAULT_CONTEXT_LINES} (= 3, git's
   *  default). */
  readonly context?: number
}

/** Render a unified-style diff between `before` and `after`. No file
 *  header (caller prints one via {@link header}) — just the +/- body.
 *
 *  Default (no opts / `hunks` falsy) is the legacy simple render:
 *  `  keep` / `- del` / `+ add`, every op on its own coloured line, no
 *  gutters, no hunk headers — byte-identical to the pre-hunk renderer.
 *
 *  With `{ hunks: true }` the richer path runs: consecutive non-`keep`
 *  ops are grouped into hunks padded with `context` unchanged lines per
 *  side; each hunk gets a dim-cyan `@@ -oldStart,oldCount +newStart,
 *  newCount @@` header; every body line is prefixed with right-aligned
 *  old/new line-number gutters (see {@link renderHunks}). */
export const renderUnified = (
  before: string,
  after: string,
  maxLines: number,
  opts: RenderUnifiedOptions = {},
): string => {
  const a = before === "" ? [] : before.split("\n")
  const b = after === "" ? [] : after.split("\n")
  const ops = diffLines(a, b)
  if (opts.hunks) return renderHunks(ops, maxLines, opts.context ?? DEFAULT_CONTEXT_LINES)
  const out: string[] = []
  for (const op of ops) {
    if (op.kind === "keep") out.push(`  ${op.line}`)
    else if (op.kind === "del") out.push(red(`- ${op.line}`))
    else out.push(green(`+ ${op.line}`))
  }
  return clip(out, maxLines)
}

// ───────────────────────────────────────────────────────────────────────
// Hunk-aware render path (git-style @@ headers + line-number gutters)
// ───────────────────────────────────────────────────────────────────────

/** One op annotated with its 1-based old/new line numbers. `del` advances
 *  only the old side, `add` only the new side, `keep` both. A `0` means
 *  "no line on that side" (add → no old; del → no new) and renders as a
 *  blank gutter. */
interface NumberedOp {
  readonly kind: DiffOp["kind"]
  readonly line: string
  /** 1-based old-file line number, or 0 for `add` (blank old gutter). */
  readonly oldNo: number
  /** 1-based new-file line number, or 0 for `del` (blank new gutter). */
  readonly newNo: number
}

/** A contiguous hunk: an index range over the numbered-op array plus the
 *  derived `@@ -oldStart,oldCount +newStart,newCount @@` coordinates. */
interface Hunk {
  /** Inclusive start index into the numbered-op array. */
  readonly start: number
  /** Exclusive end index into the numbered-op array. */
  readonly end: number
  readonly oldStart: number
  readonly oldCount: number
  readonly newStart: number
  readonly newCount: number
}

/** Walk the ops once, assigning cumulative 1-based old/new line numbers.
 *  Invariant: after processing op i, `oldNo`/`newNo` carry the line number
 *  of the line THAT op occupies on its side (or 0 if it has none on that
 *  side). del→old++, add→new++, keep→both++. */
const numberOps = (ops: readonly DiffOp[]): NumberedOp[] => {
  const out: NumberedOp[] = []
  let oldLine = 0
  let newLine = 0
  for (const op of ops) {
    if (op.kind === "keep") {
      oldLine++
      newLine++
      out.push({ kind: "keep", line: op.line, oldNo: oldLine, newNo: newLine })
    } else if (op.kind === "del") {
      oldLine++
      out.push({ kind: "del", line: op.line, oldNo: oldLine, newNo: 0 })
    } else {
      newLine++
      out.push({ kind: "add", line: op.line, oldNo: 0, newNo: newLine })
    }
  }
  return out
}

/** Group numbered ops into hunks. A hunk spans the smallest index range
 *  that contains a changed run plus up to `context` unchanged ops on each
 *  side. Two changed runs separated by `<= 2*context` unchanged ops merge
 *  into one hunk (their context windows touch/overlap); a gap `> 2*context`
 *  splits them. An all-`keep` op list yields zero hunks. */
const groupHunks = (ops: readonly NumberedOp[], context: number): Hunk[] => {
  const changed: number[] = []
  for (let i = 0; i < ops.length; i++) if (ops[i]?.kind !== "keep") changed.push(i)
  if (changed.length === 0) return []

  // Merge changed indices whose context windows touch: a new hunk starts
  // when the gap between consecutive changed ops exceeds 2*context (the
  // count of unchanged ops that would otherwise sit between two separate
  // context windows). This is git's adjacent-hunk coalescing rule.
  const ranges: Array<{ first: number; last: number }> = []
  for (const idx of changed) {
    const tail = ranges[ranges.length - 1]
    if (tail !== undefined && idx - tail.last - 1 <= 2 * context) tail.last = idx
    else ranges.push({ first: idx, last: idx })
  }

  return ranges.map(({ first, last }) => {
    const start = Math.max(0, first - context)
    const end = Math.min(ops.length, last + 1 + context)
    return { start, end, ...spanCounts(ops, start, end) }
  })
}

/** Compute `@@` coordinates for an index span `[start,end)`. Starts are the
 *  first old/new line number present in the span; counts are how many lines
 *  the span covers on each side (keep counts both, del only old, add only
 *  new). Git's convention: a count of 0 pairs with start 0; a single-line
 *  side still reports its real 1-based start. */
const spanCounts = (
  ops: readonly NumberedOp[],
  start: number,
  end: number,
): { oldStart: number; oldCount: number; newStart: number; newCount: number } => {
  let oldStart = 0
  let newStart = 0
  let oldCount = 0
  let newCount = 0
  for (let i = start; i < end; i++) {
    const op = ops[i]
    if (op === undefined) continue
    if (op.oldNo > 0) {
      if (oldStart === 0) oldStart = op.oldNo
      oldCount++
    }
    if (op.newNo > 0) {
      if (newStart === 0) newStart = op.newNo
      newCount++
    }
  }
  return { oldStart, oldCount, newStart, newCount }
}

/** Render the hunk-aware body: a dim-cyan `@@ -A,B +C,D @@` header before
 *  each hunk, then each body line prefixed with right-aligned old/new
 *  line-number gutters and the `+`/`-`/space content marker. Gutter width
 *  is the max line-number digit-count across ALL emitted hunks so columns
 *  align file-wide. Returns the empty string when there are no hunks
 *  (all-unchanged diff). */
const renderHunks = (ops: readonly DiffOp[], maxLines: number, context: number): string => {
  const numbered = numberOps(ops)
  const hunks = groupHunks(numbered, context)
  if (hunks.length === 0) return ""
  const w = gutterWidth(numbered, hunks)
  const out: string[] = []
  for (const h of hunks) {
    out.push(dim(cyan(`@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@`)))
    for (let i = h.start; i < h.end; i++) {
      const op = numbered[i]
      if (op !== undefined) out.push(gutterLine(op, w))
    }
  }
  return clip(out, maxLines)
}

/** Gutter column width = digit-count of the widest line number actually
 *  rendered across every hunk body, so the old/new columns line up
 *  file-wide even on >=1000-line files (≥1 so a single-line file still
 *  reserves one column). */
const gutterWidth = (numbered: readonly NumberedOp[], hunks: readonly Hunk[]): number => {
  let maxNo = 1
  for (const h of hunks)
    for (let i = h.start; i < h.end; i++) {
      const op = numbered[i]
      if (op === undefined) continue
      if (op.oldNo > maxNo) maxNo = op.oldNo
      if (op.newNo > maxNo) maxNo = op.newNo
    }
  return String(maxNo).length
}

/** Format one numbered op as `<oldGutter> <newGutter> <marker><line>` with
 *  the two gutters right-aligned to width `w` (blank when that side has no
 *  line: add → blank old, del → blank new). Colour matches the simple
 *  path: del red, add green, keep uncoloured. */
const gutterLine = (op: NumberedOp, w: number): string => {
  const oldG = op.oldNo > 0 ? String(op.oldNo).padStart(w) : " ".repeat(w)
  const newG = op.newNo > 0 ? String(op.newNo).padStart(w) : " ".repeat(w)
  const gutter = `${oldG} ${newG} `
  if (op.kind === "keep") return `${gutter}  ${op.line}`
  if (op.kind === "del") return red(`${gutter}- ${op.line}`)
  return green(`${gutter}+ ${op.line}`)
}

/** ADR-0440 — re-export the structured diff API so non-CLI surfaces
 *  (web/Tauri via `@/runner/diff-ops`) and existing CLI tests both reach it
 *  through this module. `diffOps` returns the line-level LCS ops BEFORE ANSI
 *  serialization; the legacy ANSI path ({@link renderUnified}) is byte-identical
 *  (it still calls the SAME `diffLines`). `DiffOp` type re-exported for callers. */
export type { DiffOp }
export const diffOps = diffOpsCore

/** ADR-0440 — NUL-byte binary probe, exported so the canvas emitter applies the
 *  SAME binary detection the CLI preview uses (single source of truth). */
export const isBinaryContent = (s: string): boolean => isBinary(s)

// ───────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────

const header = (path: string, note?: string): string =>
  dim(cyan(`── ${path}${note ? ` (${note})` : ""} ──`))

const clip = (lines: readonly string[], maxLines: number): string => {
  if (lines.length <= maxLines) return lines.join("\n")
  const more = lines.length - maxLines
  return `${lines.slice(0, maxLines).join("\n")}\n${dim(`… (${more} more line${more === 1 ? "" : "s"})`)}`
}

/** Sentinel returned by {@link readOrEmpty} when the file exists but is
 *  binary or over the byte cap. Distinct from `undefined` (= file absent)
 *  so the caller can render a "new file" header vs a "binary/oversize"
 *  skip. The literal uses U+FFFF, a noncharacter that cannot collide with
 *  real text-file content. */
const BINARY_SENTINEL = "￿__BINARY_OR_OVERSIZE__￿"

/** Read a file, returning:
 *   - the content string when readable + textual + under cap
 *   - {@link BINARY_SENTINEL} when readable but binary or over cap
 *   - `undefined` when missing / unreadable (caller renders "new file")  */
const readOrEmpty = async (
  reader: (path: string) => Promise<string>,
  path: string,
  maxBytes: number,
): Promise<string | undefined> => {
  try {
    const s = await reader(path)
    if (isBinary(s) || s.length > maxBytes) return BINARY_SENTINEL
    return s
  } catch {
    return undefined
  }
}

const defaultReadFile = (path: string): Promise<string> => readFile(path, "utf8")

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" ? (v as Record<string, unknown>) : undefined

const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)
