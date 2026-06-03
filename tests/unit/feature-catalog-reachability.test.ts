/**
 * Hellgate — fc reachability (code-grounded overclaim detector).
 *
 * Pins the import-graph reachability analyzer that gives the ground truth
 * `fc judge`'s self-declared axes cannot: a feature whose `evidence.code` src
 * files are unreachable from any production entrypoint is an overclaim at L4+.
 *
 *   REACH-01  entrypoints + a core module are REACHED
 *   REACH-02  reached ⊊ allFiles (some files genuinely unreachable; not all-or-nothing)
 *   REACH-03  RATCHET — every L4+ feature with src evidence.code is code-reachable
 *             (a new unreachable-L4+ feature = an overclaim = this fails)
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { computeReachability } from "../../tools/feature-catalog/reachability"

const r = await computeReachability()

describe("fc reachability — import-graph ground truth", () => {
  test("REACH-01: entrypoint + core modules are reached", () => {
    expect(r.reached.has("src/apps/cli/index.ts")).toBe(true)
    expect(r.reached.has("src/agent/loop.ts")).toBe(true)
    expect(r.reached.has("src/apps/cli/repl/surface-compose.ts")).toBe(true)
  })

  test("REACH-02: reached is a non-trivial strict subset of all files", () => {
    expect(r.reached.size).toBeGreaterThan(100)
    expect(r.reached.size).toBeLessThan(r.allFiles.size)
  })

  test("REACH-03 RATCHET: every L4+ feature's src evidence.code is reachable", () => {
    const FEAT = "tools/feature-catalog/features"
    const walk = (d: string): string[] => {
      const out: string[] = []
      for (const n of readdirSync(d)) {
        const f = join(d, n)
        if (statSync(f).isDirectory()) out.push(...walk(f))
        else if (f.endsWith(".yaml")) out.push(f)
      }
      return out
    }
    const codeBlock = (s: string): string[] => {
      const out: string[] = []
      let p = false
      for (const l of s.split("\n")) {
        if (/^ {2}code:/.test(l)) {
          p = true
          continue
        }
        if (p && /^ {4}- /.test(l)) out.push(l.trim().slice(2))
        else if (p && /^ {2}[a-z]/.test(l)) break
      }
      return out
    }
    const offenders: string[] = []
    for (const y of walk(FEAT)) {
      const s = readFileSync(y, "utf8")
      const id = s.match(/^id:\s*(.+)$/m)?.[1]?.trim() ?? "?"
      const mat = s.match(/^maturity:\s*(L\d)/m)?.[1]
      if (mat !== "L4" && mat !== "L5") continue
      const src = codeBlock(s).filter((c) => c.startsWith("src/") && c.endsWith(".ts"))
      if (src.length === 0) continue // tools/tests-only feature — not app-reachable by design
      if (!src.some((c) => r.reached.has(c))) offenders.push(id)
    }
    expect(offenders).toEqual([])
  })
})
