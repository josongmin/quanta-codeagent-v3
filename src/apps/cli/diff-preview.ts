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

/** Render a unified-style diff between `before` and `after`. No file
 *  header (caller prints one via {@link header}) — just the +/- body. */
export const renderUnified = (before: string, after: string, maxLines: number): string => {
  const a = before === "" ? [] : before.split("\n")
  const b = after === "" ? [] : after.split("\n")
  const ops = diffLines(a, b)
  const out: string[] = []
  for (const op of ops) {
    if (op.kind === "keep") out.push(`  ${op.line}`)
    else if (op.kind === "del") out.push(red(`- ${op.line}`))
    else out.push(green(`+ ${op.line}`))
  }
  return clip(out, maxLines)
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
