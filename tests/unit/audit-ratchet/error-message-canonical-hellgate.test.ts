/**
 * R2 audit-H ratchet — canonical errMessage invariant.
 *
 * Two adversarial invariants pinned here:
 *
 *  1. NO `(e as Error).message` (or `err`/`error` variants) under src/.
 *     The unsafe-cast pattern silently returns `undefined` when a non-Error
 *     is thrown (number, string, plain object, null) — same hole that
 *     spawned this audit round. Every site must route through the canonical
 *     `errMessage` helper from `@/shared`, which is well-defined for
 *     every throw shape.
 *
 *  2. NO file-local `const errMessage = …` declarations under src/.
 *     Five such shadows had drifted into 5 different policies (one returned
 *     the literal "unknown"; two `JSON.stringify`d non-Errors; two were
 *     byte-identical to canonical but still duplicated the contract). The
 *     project policy is the SINGLE `errMessage` exported from `@/shared`.
 *
 * A small in-flight allowlist accommodates files the user is actively
 * editing on a parallel branch — they migrate at their own pace. Every
 * other site MUST be canonical. New growth fails the ratchet.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { extname, join, relative } from "node:path"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")
const SRC_DIR = join(REPO_ROOT, "src")

/**
 * User-in-flight files exempt from the canonical-errMessage policy for
 * this round (R2 audit-H). The user owns these on a parallel branch and
 * will migrate them when their slice lands. New files MUST NOT be added.
 */
const ALLOWED_UNSAFE_CAST_SITES = new Set<string>([
  "runner/assemble/search-index-backend.ts",
  "apps/cli/internal.ts",
])

/** No shadow `errMessage` definitions are permitted anywhere under src/. */
const ALLOWED_SHADOW_DEFINITION_SITES = new Set<string>()

// Expanded R3 audit: catches all `(IDENT as Error)?.message` (any var name,
// optional chaining). Prior `(?:e|err|error)` missed `parseErr`/`ioErr`/etc.
const UNSAFE_CAST_PATTERN = /\([a-zA-Z_$][\w$]* as Error\)\??\.message\b/
const SHADOW_DEF_PATTERN = /^\s*const errMessage = /

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

const isCommentLine = (line: string): boolean => {
  const trimmed = line.trim()
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")
}

interface Match {
  readonly relPath: string
  readonly lineNo: number
  readonly line: string
}

const scanForUnsafeCasts = (): readonly Match[] => {
  const matches: Match[] = []
  for (const file of walkTsFiles(SRC_DIR)) {
    const relPath = relative(SRC_DIR, file).replaceAll("\\", "/")
    const text = readFileSync(file, "utf8")
    const lines = text.split("\n")
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ""
      if (isCommentLine(line)) continue
      if (UNSAFE_CAST_PATTERN.test(line)) {
        matches.push({ relPath, lineNo: i + 1, line: line.trim() })
      }
    }
  }
  return matches
}

const scanForShadowDefinitions = (): readonly Match[] => {
  const matches: Match[] = []
  for (const file of walkTsFiles(SRC_DIR)) {
    const relPath = relative(SRC_DIR, file).replaceAll("\\", "/")
    const text = readFileSync(file, "utf8")
    const lines = text.split("\n")
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ""
      if (isCommentLine(line)) continue
      if (SHADOW_DEF_PATTERN.test(line)) {
        matches.push({ relPath, lineNo: i + 1, line: line.trim() })
      }
    }
  }
  return matches
}

describe("error-message canonical ratchet (R2 audit-H)", () => {
  test("no `(e as Error).message` outside the in-flight allowlist", { timeout: 30_000 }, () => {
    const all = scanForUnsafeCasts()
    const unexpected = all
      .filter((m) => !ALLOWED_UNSAFE_CAST_SITES.has(m.relPath))
      .sort((a, b) => a.relPath.localeCompare(b.relPath))

    if (unexpected.length > 0) {
      throw new Error(
        [
          "Unsafe `(e as Error).message` cast detected under src/.",
          "Use the canonical `errMessage` from `@/shared`:",
          '  import { errMessage } from "@/shared"',
          "  errMessage(e) // defined for every throw shape",
          "",
          "Unexpected hits:",
          ...unexpected.map((m) => `- ${m.relPath}:${m.lineNo}  ${m.line}`),
        ].join("\n"),
      )
    }

    expect(unexpected).toEqual([])
  })

  test("in-flight allowlist sites still own their unsafe casts (no false-positive cleanup)", { timeout: 30_000 }, () => {
    // Every entry in the allowlist MUST still have at least one hit. If the
    // user has migrated a site already, the allowlist entry must be removed
    // in the same change to keep the ratchet honest.
    const byPath = new Map<string, number>()
    for (const m of scanForUnsafeCasts()) {
      byPath.set(m.relPath, (byPath.get(m.relPath) ?? 0) + 1)
    }
    const allowlistedButGone = [...ALLOWED_UNSAFE_CAST_SITES].filter((path) => !byPath.has(path))
    expect(allowlistedButGone).toEqual([])
  })

  test("no file-local `const errMessage = …` shadow declarations", { timeout: 30_000 }, () => {
    const all = scanForShadowDefinitions()
    const unexpected = all
      .filter((m) => !ALLOWED_SHADOW_DEFINITION_SITES.has(m.relPath))
      .sort((a, b) => a.relPath.localeCompare(b.relPath))

    if (unexpected.length > 0) {
      throw new Error(
        [
          "File-local `const errMessage = …` shadow detected under src/.",
          "There is exactly ONE canonical `errMessage` — it lives in `@/shared`.",
          "Import it instead of re-defining a local copy with drifting policy.",
          "",
          "Unexpected shadows:",
          ...unexpected.map((m) => `- ${m.relPath}:${m.lineNo}  ${m.line}`),
        ].join("\n"),
      )
    }

    expect(unexpected).toEqual([])
  })
})
