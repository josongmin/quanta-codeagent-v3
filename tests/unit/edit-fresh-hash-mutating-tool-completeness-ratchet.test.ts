/** jul-13 RATCHET — every file-MUTATING tool must refresh the stale-read baseline.
 *
 *  WHY THIS EXISTS: the edit-fresh-hash baseline refresh (which lets a chained
 *  no-re-read edit survive the DEFAULT-ON mtime stale-read guard) is a PER-TOOL
 *  obligation. Two gaps — `notebook_edit` and `file_history_rewind` — shipped
 *  MISSING the refresh and were caught only by adversarial audit: a tool that
 *  writes a file advances its mtime, so a later `edit` to that file (whose
 *  guardWrite compares against the read-time baseline) is falsely `stale_read`
 *  unless the writing tool re-records the baseline. Unit tests pin the CURRENT
 *  tools; they cannot catch the NEXT mutating tool that forgets the refresh.
 *
 *  This ratchet closes that: it statically scans `src/tool/**` for every tool that
 *  writes a file and asserts each one references a fresh-hash baseline-refresh
 *  primitive (`refreshStaleReadBaseline` / `refreshApplyBaselines` /
 *  `recordFreshBaseline`) — OR is in an explicit REFRESH_EXEMPT allowlist with a
 *  documented reason. A new mutating tool that skips the refresh turns this RED at
 *  construction time (the OmO single-writer static-audit pattern).
 *
 *  RED-ON-INJECTION: deleting the refresh call from ANY covered tool's source
 *  flips this RED (that file no longer references a refresh primitive). */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const TOOL_ROOT = join(import.meta.dir, "..", "..", "src", "tool")

/** A source file "mutates a file" if it calls a real FS write on a path (the
 *  tool's own commit). We match the two write primitives every mutating tool
 *  uses. `.js` build artifacts + tests are excluded; so are the shared helper
 *  and the storage/patch infra (they IMPLEMENT writes, they are not tools). */
const WRITE_CALL = /\bwriteFileAtomic\s*\(|\.writeFile\s*\(/
// Require an actual CALL (identifier + open paren), NOT a bare import reference —
// otherwise a tool that `import`s the helper but never invokes it would pass
// vacuously (exactly the "declared but inert" failure mode this guards against).
const REFRESH_REF = /(refreshStaleReadBaseline|refreshApplyBaselines|recordFreshBaseline)\s*\(/

/** Tools that write a file but LEGITIMATELY do not need a baseline refresh, each
 *  with a documented reason. EMPTY today (all 6 file-mutating tools refresh).
 *  Add here ONLY with a reason a reviewer accepts (e.g. writes a file the model
 *  never edits). A stale entry (path no longer writes) also fails below. */
const REFRESH_EXEMPT: Readonly<Record<string, string>> = {}

/** Infra that implements writes but is NOT a tool commit path — excluded from the
 *  "mutating tool" set. Keep this tight; a real tool must never hide here. */
const NOT_A_TOOL = new Set<string>([
  "_shared/fresh-hash.ts", // the refresh helper itself
])

const listTsFiles = (dir: string): string[] => {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) {
      out.push(...listTsFiles(p))
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(p)
    }
  }
  return out
}

/** Relative-to-src/tool key for allowlist/reporting. */
const rel = (abs: string): string => abs.slice(TOOL_ROOT.length + 1)

describe("jul-13 edit-fresh-hash — mutating-tool completeness ratchet", () => {
  const files = listTsFiles(TOOL_ROOT)
  const writers = files.filter((f) => {
    const key = rel(f)
    if (NOT_A_TOOL.has(key)) return false
    return WRITE_CALL.test(readFileSync(f, "utf8"))
  })

  test("the scan actually finds the known file-mutating tools (anti-vacuum)", () => {
    const keys = writers.map(rel)
    // If the scan silently matched nothing (regex drift), the ratchet would be
    // vacuously green — pin the floor with the tools we KNOW mutate files.
    for (const known of [
      "edit/index.ts",
      "write/index.ts",
      "scripted-replace.ts",
      "apply-patch.ts",
      "notebook-edit/tool.ts",
      "file-history/tool.ts",
    ]) {
      expect(keys).toContain(known)
    }
    expect(writers.length).toBeGreaterThanOrEqual(6)
  })

  test("EVERY file-mutating tool refreshes the stale-read baseline (or is exempt with a reason)", () => {
    const uncovered: string[] = []
    for (const f of writers) {
      const key = rel(f)
      if (key in REFRESH_EXEMPT) continue
      if (!REFRESH_REF.test(readFileSync(f, "utf8"))) uncovered.push(key)
    }
    // A NEW mutating tool that forgot the refresh (or a covered tool whose refresh
    // call was reverted) lands here — the notebook_edit / file_history class of gap.
    expect(uncovered).toEqual([])
  })

  test("no stale REFRESH_EXEMPT entry (allowlisted path must still exist and still write)", () => {
    for (const [key, reason] of Object.entries(REFRESH_EXEMPT)) {
      const abs = join(TOOL_ROOT, key)
      let src = ""
      try {
        src = readFileSync(abs, "utf8")
      } catch {
        throw new Error(`REFRESH_EXEMPT has a dangling path "${key}" — remove it`)
      }
      expect(WRITE_CALL.test(src)).toBe(true) // still a writer, else exemption is stale
      expect(reason.length).toBeGreaterThan(10) // a real documented reason
    }
  })
})
