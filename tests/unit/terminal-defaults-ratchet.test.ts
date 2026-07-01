import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { extname, join, relative } from "node:path"
import { scanConsoleCalls } from "./_arch/slice-boundary-scanner"

const REPO_ROOT = join(import.meta.dir, "..", "..")
const SRC_DIR = join(REPO_ROOT, "src")
const NON_APP_TERMINAL_DEFAULT_PATTERN = /\bprocess\.(?:stdin|stdout|stderr)\b|\bprocess\.exit\s*\(/
const CURRENT_TERMINAL_DEFAULT_DEBT_COUNT = 0

const ALLOWED_NON_APP_TERMINAL_DEFAULT_FILES = new Set<string>()

// ── Console ownership (companion invariant, same terminal-ownership rail) ──
// Raw `console.*` in non-app slices is the SAME class of terminal-ownership
// leak as `process.stdout` — a domain module owning a terminal instead of
// writing through the ADR-0303 injected `writeStderr` / structured logger sink.
// The per-slice `_arch` battery only covers the ~26 REGISTERED slices; this rail
// backstops EVERY non-app file so an unregistered slice cannot regress here.
// Detection reuses the slice scanner's AST-based `scanConsoleCalls` (the SAME
// detector the per-slice battery uses), which ignores string literals and
// comments natively — a `"console.log($A)"` inside a tool-description string or
// a commented-out call is NOT a hit.
//
// Currently-sanctioned raw-console files (each is a documented leaf-slice OPS
// sink that the corresponding `_arch` slice config already carries as a
// `consoleAllowFiles` carve-out — kept in sync here):
//   • `skill/discover.ts` — leaf slice cannot import a structured logger; the
//     two size-cap / unreadable warnings are the only sanctioned sink (see the
//     `skill` slice config's `consoleAllowFiles: ["discover.ts"]`).
const ALLOWED_NON_APP_CONSOLE_FILES = new Set<string>(["skill/discover.ts"])

const isCommentLine = (line: string): boolean => {
  const trimmed = line.trim()
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")
}

const isInsideQuotedString = (line: string, matchIndex: number): boolean => {
  let quote: '"' | "'" | "`" | null = null
  let escaped = false
  for (let i = 0; i < matchIndex; i++) {
    const ch = line[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === "\\") {
      escaped = true
      continue
    }
    if (quote === null) {
      if (ch === '"' || ch === "'" || ch === "`") quote = ch
      continue
    }
    if (ch === quote) quote = null
  }
  return quote !== null
}

const walkTsFiles = (dir: string): readonly string[] => {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) out.push(...walkTsFiles(full))
    else if (extname(name) === ".ts") out.push(full)
  }
  return out
}

interface Match {
  relPath: string
  lineNo: number
  line: string
}

const scanFile = (file: string): readonly Match[] => {
  const relPath = relative(SRC_DIR, file).replaceAll("\\", "/")
  if (relPath.startsWith("apps/")) return []
  const text = readFileSync(file, "utf8")
  const lines = text.split("\n")
  const matches: Match[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ""
    if (isCommentLine(line)) continue
    const hit = NON_APP_TERMINAL_DEFAULT_PATTERN.exec(line)
    if (hit === null) continue
    if (isInsideQuotedString(line, hit.index)) continue
    matches.push({ relPath, lineNo: i + 1, line: line.trim() })
  }
  return matches
}

const collectMatches = (): readonly Match[] => walkTsFiles(SRC_DIR).flatMap(scanFile)

// Console scan reuses the slice scanner's AST-based `scanConsoleCalls`, so
// string-literal mentions and commented-out calls are excluded natively (no
// fragile line/quote bookkeeping).
const scanConsoleFile = (file: string): readonly Match[] => {
  const relPath = relative(SRC_DIR, file).replaceAll("\\", "/")
  if (relPath.startsWith("apps/")) return []
  const text = readFileSync(file, "utf8")
  const lines = text.split("\n")
  return scanConsoleCalls(text).map(({ line, hit }) => ({
    relPath,
    lineNo: line,
    line: (lines[line - 1] ?? hit).trim(),
  }))
}

const collectConsoleMatches = (): readonly Match[] => walkTsFiles(SRC_DIR).flatMap(scanConsoleFile)

describe("terminal defaults ratchet", () => {
  test("no new non-app files own process stdio or process.exit", () => {
    const files = new Set(collectMatches().map((match) => match.relPath))
    const unexpected = [...files]
      .sort()
      .filter((relPath) => !ALLOWED_NON_APP_TERMINAL_DEFAULT_FILES.has(relPath))

    if (unexpected.length > 0) {
      throw new Error(
        [
          "New non-app terminal defaults detected under src/.",
          "Terminal ownership belongs to src/apps/**; inject a sink/input/exit port instead.",
          "",
          "Unexpected files:",
          ...unexpected.map((relPath) => `- ${relPath}`),
        ].join("\n"),
      )
    }

    expect(unexpected).toEqual([])
  })

  test("temporary non-app terminal-default debt ceiling does not grow", () => {
    expect(collectMatches().length).toBe(CURRENT_TERMINAL_DEFAULT_DEBT_COUNT)
  })

  test("no new non-app files call console.* (route through injected sink)", () => {
    const files = new Set(collectConsoleMatches().map((match) => match.relPath))
    const unexpected = [...files]
      .sort()
      .filter((relPath) => !ALLOWED_NON_APP_CONSOLE_FILES.has(relPath))

    if (unexpected.length > 0) {
      throw new Error(
        [
          "New non-app console.* usage detected under src/.",
          "Terminal ownership belongs to src/apps/**; route diagnostics through",
          "the ADR-0303 injected `writeStderr` sink or a structured logger instead.",
          "",
          "Unexpected files:",
          ...unexpected.map((relPath) => `- ${relPath}`),
        ].join("\n"),
      )
    }

    expect(unexpected).toEqual([])
  })

  test("non-app console debt ceiling does not grow (beyond the sanctioned allowlist)", () => {
    const unsanctioned = collectConsoleMatches().filter(
      (match) => !ALLOWED_NON_APP_CONSOLE_FILES.has(match.relPath),
    )
    expect(unsanctioned.length).toBe(0)
  })
})
