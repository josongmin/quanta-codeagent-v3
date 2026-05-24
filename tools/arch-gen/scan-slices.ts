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
 * Pure: only depends on `node:fs/promises` + `node:path`. No `@/*`.
 */
import { readdir, readFile, stat } from "node:fs/promises"
import path from "node:path"

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

const EXPORT_NAMED_RE = /^export\s+(?:type\s+)?\{([^}]+)\}(?:\s+from\s+["'][^"']+["'])?/gm
const EXPORT_SINGLE_RE =
  /^export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function|class|type|interface|enum|namespace)\s+([A-Za-z_$][\w$]*)/gm
const EXPORT_STAR_AS_RE = /^export\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from/gm

/**
 * Parse top-level exports from a barrel `index.ts`.
 *
 * Catches:
 *   `export { a, b as c } from "./..."`
 *   `export type { Foo, Bar } from "./..."`
 *   `export const FOO = ...`
 *   `export function bar() ...`
 *   `export * as ns from "./..."`
 */
export const extractExports = (source: string): ReadonlyArray<string> => {
  const out = new Set<string>()
  // Strip block comments to avoid false positives.
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "")

  for (const m of stripped.matchAll(EXPORT_NAMED_RE)) {
    const inner = m[1]
    if (!inner) continue
    for (const part of inner.split(",")) {
      const name = part
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)
        .pop()
        ?.trim()
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) out.add(name)
    }
  }
  for (const m of stripped.matchAll(EXPORT_SINGLE_RE)) {
    if (m[1]) out.add(m[1])
  }
  for (const m of stripped.matchAll(EXPORT_STAR_AS_RE)) {
    if (m[1]) out.add(m[1])
  }
  return [...out].sort((a, b) => a.localeCompare(b))
}

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

export const scanSlices = async (opts: ScanSlicesOpts = {}): Promise<ReadonlyArray<SliceSummary>> => {
  const rootSrc = path.isAbsolute(opts.rootSrc ?? DEFAULT_SRC)
    ? (opts.rootSrc ?? DEFAULT_SRC)
    : path.resolve(opts.rootSrc ?? DEFAULT_SRC)
  const testsDir = path.isAbsolute(opts.testsDir ?? DEFAULT_TESTS)
    ? (opts.testsDir ?? DEFAULT_TESTS)
    : path.resolve(opts.testsDir ?? DEFAULT_TESTS)

  let sliceNames: ReadonlyArray<string>
  try {
    sliceNames = await readdir(rootSrc)
  } catch {
    return []
  }
  let testFiles: ReadonlyArray<string>
  try {
    testFiles = await readdir(testsDir)
  } catch {
    testFiles = []
  }

  const out: SliceSummary[] = []
  for (const slice of sliceNames) {
    if (slice.startsWith(".")) continue
    const sliceAbs = path.join(rootSrc, slice)
    let s
    try {
      s = await stat(sliceAbs)
    } catch {
      continue
    }
    if (!s.isDirectory()) continue
    const indexPath = path.join(sliceAbs, "index.ts")
    let text: string
    try {
      text = await readFile(indexPath, "utf8")
    } catch {
      // Slice without barrel — skip (apps/* doesn't have index.ts; that's intentional).
      continue
    }

    const purpose = extractPurpose(text) || NO_DESCRIPTION
    const publicExports = extractExports(text)
    const adrReferences = extractAdrReferences(text)
    const testFile = findTestFile(slice, testFiles, testsDir)

    out.push({
      slicePath: `src/${slice}`,
      purpose,
      publicExports,
      adrReferences,
      ...(testFile === undefined ? {} : { testFile }),
    })
  }

  return out.sort((a, b) => a.slicePath.localeCompare(b.slicePath))
}
