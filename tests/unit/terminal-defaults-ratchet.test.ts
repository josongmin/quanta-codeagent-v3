import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { extname, join, relative } from "node:path"

const REPO_ROOT = join(import.meta.dir, "..", "..")
const SRC_DIR = join(REPO_ROOT, "src")
const NON_APP_TERMINAL_DEFAULT_PATTERN = /\bprocess\.(?:stdin|stdout|stderr)\b|\bprocess\.exit\s*\(/
const CURRENT_TERMINAL_DEFAULT_DEBT_COUNT = 7

const ALLOWED_NON_APP_TERMINAL_DEFAULT_FILES = new Set([
  "agent/admissibility-gate.ts",
  "agent/git-directives/default-stdout-emitter.ts",
  "agent/hitl-tier-registry.ts",
  "agent/loop-helpers.ts",
  "memory/consolidate/store.ts",
  "ui/ui-helpers.ts",
])

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
          "",
          "Current documented temporary debt:",
          ...[...ALLOWED_NON_APP_TERMINAL_DEFAULT_FILES].sort().map((relPath) => `- ${relPath}`),
        ].join("\n"),
      )
    }

    expect(unexpected).toEqual([])
  })

  test("temporary non-app terminal-default debt ceiling does not grow", () => {
    expect(collectMatches().length).toBeLessThanOrEqual(CURRENT_TERMINAL_DEFAULT_DEBT_COUNT)
  })
})
