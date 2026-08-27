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
import { FEATURES_DIR } from "../../tools/feature-catalog/paths"
import {
  computeReachability,
  computeSymbolReachability,
} from "../../tools/feature-catalog/reachability"

const r = await computeReachability()
const sym = await computeSymbolReachability()

/**
 * Anchored on the catalog module itself — the same SSOT the tooling uses.
 *
 * This was the bare literal `"tools/feature-catalog/features"`, the exact string
 * that made `fc validate --strict` report `0 feature(s), all evidence resolved`
 * and exit 0 from a foreign cwd. The tooling was fixed; this copy of the literal
 * in a TEST was not, and the paired control found it: 4 pass at the repo root,
 * 2 pass / 2 fail from a foreign working directory.
 */
const FEAT = FEATURES_DIR
const walkYaml = (d: string): string[] => {
  const out: string[] = []
  for (const n of readdirSync(d)) {
    const f = join(d, n)
    if (statSync(f).isDirectory()) out.push(...walkYaml(f))
    else if (f.endsWith(".yaml")) out.push(f)
  }
  return out
}
const srcEvidence = (s: string): string[] => {
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
  return out.filter((c) => c.startsWith("src/") && c.endsWith(".ts"))
}
const l4plus = (s: string): boolean => {
  const m = s.match(/^maturity:\s*(L\d)/m)?.[1]
  return m === "L4" || m === "L5"
}

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
    const offenders: string[] = []
    // Anti-vacuity: both ratchets below collect offenders and assert the list is
    // empty, so a walk that reads no YAML satisfies them for free.
    const yamls = walkYaml(FEAT)
    expect(yamls.length, "no feature YAML read — the ratchet below is vacuous").toBeGreaterThan(500)
    for (const y of yamls) {
      const s = readFileSync(y, "utf8")
      if (!l4plus(s)) continue
      const src = srcEvidence(s)
      if (src.length === 0) continue // tools/tests-only feature — not app-reachable by design
      if (!src.some((c) => r.reached.has(c))) {
        offenders.push(s.match(/^id:\s*(.+)$/m)?.[1]?.trim() ?? "?")
      }
    }
    expect(offenders).toEqual([])
  })

  test("REACH-04 RATCHET (symbol-level): no L4+ feature is entirely dead-API", () => {
    // A feature whose EVERY src file is unreachable OR dead-API (module loads via
    // a barrel re-export but no own export is named-imported and it self-registers
    // nothing) is an overclaim module reachability alone cannot catch — e.g. a
    // helper re-exported from a barrel but never called by any tool (git-budget).
    const isDead = (c: string): boolean => !r.reached.has(c) || sym.deadApi.has(c)
    const offenders: string[] = []
    // Anti-vacuity: both ratchets below collect offenders and assert the list is
    // empty, so a walk that reads no YAML satisfies them for free.
    const yamls = walkYaml(FEAT)
    expect(yamls.length, "no feature YAML read — the ratchet below is vacuous").toBeGreaterThan(500)
    for (const y of yamls) {
      const s = readFileSync(y, "utf8")
      if (!l4plus(s)) continue
      const src = srcEvidence(s)
      if (src.length === 0) continue
      if (src.every(isDead)) offenders.push(s.match(/^id:\s*(.+)$/m)?.[1]?.trim() ?? "?")
    }
    expect(offenders).toEqual([])
  })
})
