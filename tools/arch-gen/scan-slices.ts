/**
 * tools/arch-gen/scan-slices.ts — slice barrel walker.
 *
 * For each `src/<slice>/index.ts`:
 *   - First doc-comment block becomes the purpose.
 *   - Top-level `export {} from "./..."` / `export <Name>` names enumerate
 *     the public surface.
 *   - `ADR-NNNN` mentions inside the doc-comment become adrReferences.
 *   - Matching `tests/unit/<slice>-*hellgate.test.ts` (or close variants)
 *     becomes testFile.
 *
 * Plane-clean: `node:fs/promises` + `node:path` + the shared export reader. No
 * `@/*`.
 *
 * Export extraction is NOT done here — it lives in `tools/shared/ts-exports.ts`
 * so there is one answer to "what does this file export". The regex that used
 * to live here stripped block comments first, so the LINE comment at
 * `src/tool/index.ts:383` containing `resources/*` opened a phantom block that
 * ate 12,016 characters and 237 export names before the regex ever ran.
 */
import { readdir, readFile, stat } from "node:fs/promises"
import path from "node:path"

import { extractExportedSymbols } from "../shared/ts-exports"

export interface SliceSummary {
  readonly slicePath: string
  readonly purpose: string
  readonly publicExports: ReadonlyArray<string>
  readonly testFile?: string
  readonly adrReferences: ReadonlyArray<string>
}

const NO_DESCRIPTION = "(no description)"

const DOC_COMMENT_RE = /^\s*\/\*\*([\s\S]*?)\*\//
const LINE_COMMENT_BLOCK_RE = /^(?:\s*\/\/[^\n]*\n)+/
const ADR_REF_RE = /ADR-?(\d{3,4})/g

/**
 * Extract the first doc-comment OR contiguous `//`-line-comment block from
 * the start of an `index.ts`. Returns "" if neither exists.
 */
export const extractPurpose = (source: string): string => {
  const trimmed = source.replace(/^﻿/, "")
  const docMatch = DOC_COMMENT_RE.exec(trimmed)
  if (docMatch?.[1]) {
    const body = docMatch[1]
    // Strip leading `*` per line + flatten paragraphs.
    const lines = body
      .split("\n")
      .map((l) => l.replace(/^\s*\*\s?/, "").trim())
      .filter((l) => l.length > 0)
    if (lines.length === 0) return ""
    return joinSummary(lines)
  }
  const lineMatch = LINE_COMMENT_BLOCK_RE.exec(trimmed)
  if (lineMatch?.[0]) {
    const lines = lineMatch[0]
      .split("\n")
      .map((l) => l.replace(/^\s*\/\/\s?/, "").trim())
      .filter((l) => l.length > 0)
    if (lines.length === 0) return ""
    return joinSummary(lines)
  }
  return ""
}

/** First paragraph only, single-line joined, capped at 240 chars. */
const joinSummary = (lines: ReadonlyArray<string>): string => {
  const paragraph: string[] = []
  for (const l of lines) {
    if (l.length === 0) break
    paragraph.push(l)
  }
  const joined = paragraph.join(" ").replace(/\s+/g, " ").trim()
  return joined.length > 240 ? `${joined.slice(0, 237)}...` : joined
}

/**
 * Top-level exports of a barrel `index.ts`, sorted.
 *
 * Delegates to the shared AST reader — see `tools/shared/ts-exports.ts` for why
 * this must not be a regex.
 */
export const extractExports = (source: string): ReadonlyArray<string> =>
  [...extractExportedSymbols(source)].sort((a, b) => a.localeCompare(b))

/** Extract ADR-NNNN references from a doc-comment / index.ts header. */
export const extractAdrReferences = (source: string): ReadonlyArray<string> => {
  // Only the first 2000 chars: the header doc-comment area.
  const head = source.slice(0, 2000)
  const out = new Set<string>()
  for (const m of head.matchAll(ADR_REF_RE)) {
    const n = m[1]
    if (n) out.add(n.padStart(4, "0"))
  }
  return [...out].sort((a, b) => a.localeCompare(b))
}

/** Locate a hellgate test file matching this slice, if any. */
const findTestFile = (
  slice: string,
  testFiles: ReadonlyArray<string>,
  testsDir: string,
): string | undefined => {
  // Preferred: exact `<slice>-*hellgate.test.ts`. Slice may contain `-` (e.g.
  // `plugin-isolation`) — strip to flat candidates.
  const candidates = [
    new RegExp(`^${escapeRe(slice)}-.*hellgate\\.test\\.ts$`),
    new RegExp(`^${escapeRe(slice)}\\.hellgate\\.test\\.ts$`),
    new RegExp(`^${escapeRe(slice)}-hellgate\\.test\\.ts$`),
  ]
  for (const re of candidates) {
    const hit = testFiles.find((f) => re.test(f))
    if (hit) return path.join(testsDir, hit)
  }
  return undefined
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const DEFAULT_SRC = "src"
const DEFAULT_TESTS = "tests/unit"

export interface ScanSlicesOpts {
  readonly rootSrc?: string
  readonly testsDir?: string
}

const resolveAbsPath = (p: string | undefined, fallback: string): string => {
  const v = p ?? fallback
  return path.isAbsolute(v) ? v : path.resolve(v)
}

const safeReaddir = async (abs: string): Promise<ReadonlyArray<string>> => {
  try {
    return await readdir(abs)
  } catch {
    return []
  }
}

const buildSliceSummary = async (
  slice: string,
  rootSrc: string,
  testFiles: ReadonlyArray<string>,
  testsDir: string,
): Promise<SliceSummary | null> => {
  const sliceAbs = path.join(rootSrc, slice)
  try {
    const st = await stat(sliceAbs)
    if (!st.isDirectory()) return null
  } catch {
    return null
  }
  let text: string
  try {
    text = await readFile(path.join(sliceAbs, "index.ts"), "utf8")
  } catch {
    return null
  }
  const testFile = findTestFile(slice, testFiles, testsDir)
  return {
    slicePath: `src/${slice}`,
    purpose: extractPurpose(text) || NO_DESCRIPTION,
    publicExports: extractExports(text),
    adrReferences: extractAdrReferences(text),
    ...(testFile === undefined ? {} : { testFile }),
  }
}

export const scanSlices = async (
  opts: ScanSlicesOpts = {},
): Promise<ReadonlyArray<SliceSummary>> => {
  const rootSrc = resolveAbsPath(opts.rootSrc, DEFAULT_SRC)
  const testsDir = resolveAbsPath(opts.testsDir, DEFAULT_TESTS)
  const sliceNames = await safeReaddir(rootSrc)
  const testFiles = await safeReaddir(testsDir)

  const out: SliceSummary[] = []
  for (const slice of sliceNames) {
    if (slice.startsWith(".")) continue
    const summary = await buildSliceSummary(slice, rootSrc, testFiles, testsDir)
    if (summary !== null) out.push(summary)
  }
  return out.sort((a, b) => a.slicePath.localeCompare(b.slicePath))
}
