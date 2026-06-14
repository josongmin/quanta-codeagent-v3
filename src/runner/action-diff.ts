/**
 * `@/runner/action-diff.ts` — surface-agnostic `(path, before, after)` extraction
 * for a previewable mutation `ToolAction` (T05 per-hunk accept/reject).
 *
 * HOISTED (jun-15) from `@/apps/cli/diff-preview.ts` so BOTH the CLI inline
 * surface AND the host out-of-band approval resolver (`@/host/runtime`, which may
 * not import `@/apps/cli` per the slice fence) consume the SAME extraction. The
 * pure hunk math lives one slice over in `@/runner/diff-ops` (`splitHunks` /
 * `applySelectedHunks`); this module turns an action into the before/after that
 * feed it. `@/apps/cli/diff-preview` re-exports `computeActionDiff` + the shared
 * input helpers for back-compat, so existing CLI importers are unaffected.
 *
 * Slice note: `@/runner` may import `@/permission` (ToolAction) — same as
 * `@/runner/assemble/*`. Pure + best-effort: every extractor returns `undefined`
 * (caller falls back to whole-call) rather than throwing.
 */

import { readFile } from "node:fs/promises"
import type { ToolAction } from "@/permission"
import { isBinary, resolveEnvCaps } from "./diff-ops"

/** Sentinel: file read but binary or over the byte cap (caller treats as
 *  non-previewable ⇒ whole-call). Distinct from `undefined` (missing file). */
export const BINARY_SENTINEL = "￿__BINARY_OR_OVERSIZE__￿"

export const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined

export const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)

export const defaultReadFile = (path: string): Promise<string> => readFile(path, "utf8")

/** Read a file, returning the content (textual + under cap), {@link BINARY_SENTINEL}
 *  (binary/oversize), or `undefined` (missing/unreadable ⇒ "new file"). */
export const readOrEmpty = async (
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

const replaceFirst = (source: string, find: string, repl: string): string => {
  const idx = source.indexOf(find)
  if (idx < 0) return source
  return source.slice(0, idx) + repl + source.slice(idx + find.length)
}

/** Apply a scripted_replace (literal or regex, capped count) — shared by the
 *  diff extractor below and the CLI render path. `undefined` ⇒ bad regex. */
export const applyScriptedReplace = (
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

/** The before/after pair behind a previewable mutation, for hunk decomposition
 *  + partial apply (`@/runner/hunk-apply`). `before` is the current file content
 *  ("" for a new file); `after` is the whole-call result the model proposed. */
export interface ActionDiff {
  readonly path: string
  readonly before: string
  readonly after: string
}

export interface ComputeActionDiffOptions {
  /** Per-file content byte cap. Default = env caps. */
  readonly maxBytes?: number
  /** Injection seam for tests + non-fs sources. Defaults to `node:fs/promises`. */
  readonly readFile?: (path: string) => Promise<string>
}

const diffForWrite = async (
  input: unknown,
  maxBytes: number,
  reader: (p: string) => Promise<string>,
): Promise<ActionDiff | undefined> => {
  const i = asRecord(input)
  if (!i) return undefined
  const path = asString(i.path)
  const content = asString(i.content)
  if (path === undefined || content === undefined) return undefined
  if (isBinary(content) || content.length > maxBytes) return undefined
  const prev = await readOrEmpty(reader, path, maxBytes)
  if (prev === BINARY_SENTINEL) return undefined
  const before = prev ?? ""
  if (before === content) return undefined // no change → nothing to select
  return { path, before, after: content }
}

const diffForEdit = async (
  input: unknown,
  maxBytes: number,
  reader: (p: string) => Promise<string>,
): Promise<ActionDiff | undefined> => {
  const i = asRecord(input)
  if (!i) return undefined
  const path = asString(i.path)
  const oldS = asString(i.old_string)
  const newS = asString(i.new_string)
  if (path === undefined || oldS === undefined || newS === undefined) return undefined
  // Fuzzy / line-ranges edits resolve their anchor DIFFERENTLY from a literal
  // `indexOf` swap (the edit tool scores candidates / restricts to a window). A
  // literal preview could then show — and a partial apply could write — hunks at
  // a DIFFERENT location than where the tool would act (e.g. `old_string` also
  // appears verbatim elsewhere). Refuse per-hunk for these variants ⇒ whole-call
  // fallback (the tool's own matcher decides). ONLY the exact literal tier is
  // safe to decompose because the preview's `after` then equals the tool's.
  if (i.fuzzy === true || i.line_ranges !== undefined) return undefined
  const before = await readOrEmpty(reader, path, maxBytes)
  if (before === undefined || before === BINARY_SENTINEL) return undefined
  if (!before.includes(oldS)) return undefined
  const replaceAll = i.replace_all === true
  // Uniqueness parity with the edit tool's exact tier: when `replace_all` is
  // unset, `old_string` MUST be unique — a non-unique match is `ambiguous` (the
  // tool errors, zero write). A literal `replaceFirst` preview would instead
  // silently apply the FIRST occurrence, so the previewed hunks (and any partial
  // apply) could diverge from what the tool does. Refuse ⇒ whole-call fallback
  // (the tool's own ambiguity error then surfaces). Empty `old_string` never
  // counts (split-count guard) and is already excluded by `includes` above.
  if (!replaceAll && oldS.length > 0 && before.split(oldS).length - 1 !== 1) return undefined
  const after = replaceAll ? before.split(oldS).join(newS) : replaceFirst(before, oldS, newS)
  if (after === before) return undefined
  if (after.length > maxBytes || isBinary(after)) return undefined
  return { path, before, after }
}

const diffForScriptedReplace = async (
  input: unknown,
  maxBytes: number,
  reader: (p: string) => Promise<string>,
): Promise<ActionDiff | undefined> => {
  const i = asRecord(input)
  if (!i) return undefined
  const path = asString(i.file)
  const pattern = asString(i.pattern)
  const replacement = asString(i.replacement)
  if (path === undefined || pattern === undefined || replacement === undefined) return undefined
  const before = await readOrEmpty(reader, path, maxBytes)
  if (before === undefined || before === BINARY_SENTINEL) return undefined
  const isRegex = i.isRegex === true
  const count = typeof i.count === "number" && i.count > 0 ? i.count : Number.POSITIVE_INFINITY
  const after = applyScriptedReplace(before, pattern, replacement, isRegex, count)
  if (after === undefined || after === before) return undefined
  if (after.length > maxBytes || isBinary(after)) return undefined
  return { path, before, after }
}

/**
 * Extract `(path, before, after)` for a previewable mutation so the approval
 * surface can decompose it into hunks and apply a SUBSET (T05).
 *
 * `undefined` (caller falls back to whole-call) when the tool is not single-file
 * content-previewable here (`apply_patch` V4A multi-file patches stay whole-call
 * — not reducible to one before/after without the patch applier), the input
 * shape doesn't match, the swap is a no-op, or any read fails. Never throws.
 */
export const computeActionDiff = async (
  action: ToolAction,
  opts: ComputeActionDiffOptions = {},
): Promise<ActionDiff | undefined> => {
  const env = resolveEnvCaps()
  const maxBytes = opts.maxBytes ?? env.maxBytes
  const reader = opts.readFile ?? defaultReadFile
  try {
    switch (action.tool) {
      case "write":
        return await diffForWrite(action.input, maxBytes, reader)
      case "edit":
        return await diffForEdit(action.input, maxBytes, reader)
      case "scripted_replace":
        return await diffForScriptedReplace(action.input, maxBytes, reader)
      default:
        // apply_patch + non-mutating tools → no single-file before/after.
        return undefined
    }
  } catch {
    return undefined
  }
}
