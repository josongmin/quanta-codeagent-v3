/**
 * A5 ratchet — WHO may compute a price, held as an exact call-site census.
 *
 * The campaign's root defect was re-derivation: every surface that priced
 * tokens for itself eventually disagreed with the others. An IMPORT scan
 * cannot hold that line — importing `costUsd` proves nothing, and a scanner
 * watching imports goes blind the moment a call is deleted behind one. So
 * this ratchet counts CALL SITES (comment-stripped), per file, exactly:
 *
 *   - a NEW call site anywhere in src fails with the file's name;
 *   - a DELETED call in an enrolled file fails too (the census is exact, not
 *     a ceiling), so the scanner can never quietly stop seeing the corpus;
 *   - inside src/agent/loop/** the only sanctioned sites are emit-helpers.ts
 *     (the ONE place recorded usage is priced) and turn-iteration.ts's
 *     projectCostPreflight (prices a pre-send ESTIMATE — no usage exists yet
 *     to consume, so it is a projection, not a re-derivation).
 *
 * Enrolling a new file is a deliberate act: add it here WITH its reason, the
 * way every entry below carries one.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"

import { assertScanPopulation } from "../_shared/scan-population"
import { stripComments } from "../_shared/strip-comments"

const SRC_ROOT = resolve(__dirname, "../../../src")

/** Exact expected pricing-call count per file, with the sanction's reason. */
const SANCTIONED: Readonly<Record<string, { calls: number; reason: string }>> = {
  "observability/pricing.ts": { calls: 1, reason: "the costUsd wrapper delegating to priceUsage" },
  "observability/usage-accounting/price.ts": { calls: 0, reason: "the formula's own home" },
  "observability/cost-dashboard.ts": {
    calls: 1,
    reason: "record-less fallback for snapshots taken with no recorder wired",
  },
  "observability/work-metrics.ts": {
    calls: 1,
    reason: "derive fallback for record-less WorkMetrics builders",
  },
  "agent/loop/emit-helpers.ts": {
    calls: 1,
    reason: "THE runtime pricing site: one priced figure per usage event, shared by every sink",
  },
  "agent/loop/turn-iteration.ts": {
    calls: 1,
    reason:
      "projectCostPreflight prices a pre-send estimate (no usage exists yet) — projection, not re-derivation",
  },
  "agent/work-metrics-collector.ts": {
    calls: 1,
    reason: "bucket-derive fallback for direct callers that hand no recorded cost",
  },
  "agent/budget-ledger-cost.ts": {
    calls: 1,
    reason: "the ledger's delegation to the single formula (A4)",
  },
  "apps/probe/render.ts": { calls: 1, reason: "offline trajectory re-pricing (report tier)" },
  "apps/eval/synthetic/runner.ts": { calls: 1, reason: "offline eval accounting (report tier)" },
  "apps/eval/grounding/probe.ts": { calls: 1, reason: "offline eval accounting (report tier)" },
  "runner/batch/observe.ts": { calls: 1, reason: "offline batch accounting (report tier)" },
  "apps/bench/analyze/cost.ts": { calls: 3, reason: "offline bench analysis (report tier)" },
}

const CALL_RE = /\b(?:costUsd|priceUsage)\s*\(/g

/**
 * INDIRECTION guards (final-audit finding). The call census counts the two
 * names followed by `(` — which an adversarial audit defeated two ways
 * without tripping a single test:
 *
 *   import { costUsd as sneaky } from "@/observability"   // alias
 *   const p = costUsd                                     // bare reference
 *
 * Both re-derive prices under a name the census never sees. Aliasing the
 * pricing functions is banned outright (no sanctioned alias exists), and a
 * bare FUNCTION-VALUE reference is banned too. Field names, object keys and
 * property accesses spelled `costUsd` are not the function and stay legal;
 * property-access CALLS (`pricing.costUsd(...)`) already land in CALL_RE.
 */
const ALIAS_RE = /\b(?:costUsd|priceUsage)\s+as\s+\w+/g
const NAME_RE = /(?<![.\w$])(?:costUsd|priceUsage)\b/g

/** Is this bare-name occurrence one of the five LEGAL look-alikes? */
const isLegalBareName = (src: string, idx: number, matchLen: number): boolean => {
  const after = src.slice(idx + matchLen)
  if (/^\s*\(/.test(after)) return true // a CALL — the call census owns those
  if (/^\s*\??\s*:/.test(after)) return true // object key / field annotation
  const lineStart = src.lastIndexOf("\n", idx) + 1
  const nl = src.indexOf("\n", idx)
  const line = src.slice(lineStart, nl === -1 ? src.length : nl)
  if (/^\s*(?:import|export)\b/.test(line) || /\bfrom\s+["']/.test(line)) return true
  if (/\btypeof\s+(?:costUsd|priceUsage)\b/.test(line)) return true
  // Multi-line import/export SPECIFIER lines are exactly the bare name plus a
  // comma; anything else around the name is value smuggling.
  return /^\s*(?:type\s+)?(?:costUsd|priceUsage)\s*,?\s*$/.test(line)
}

const indirectionsOf = (src: string): string[] => {
  const out: string[] = []
  for (const m of src.matchAll(ALIAS_RE)) out.push(`alias: ${m[0]}`)
  for (const m of src.matchAll(NAME_RE)) {
    const idx = m.index ?? 0
    if (isLegalBareName(src, idx, m[0].length)) continue
    const lineStart = src.lastIndexOf("\n", idx) + 1
    const nl = src.indexOf("\n", idx)
    out.push(
      `bare ref: ${src
        .slice(lineStart, nl === -1 ? src.length : nl)
        .trim()
        .slice(0, 80)}`,
    )
  }
  return out
}

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(full)
  }
  return out
}

/**
 * The census, over a list the caller enumerated.
 *
 * The walk is materialised by the caller and NOT re-run here, so the reach the
 * floor is asserted on and the reach this census consumes are the same list.
 * A census that walks for itself can be pointed at a different tree than the one
 * the floor measured, and the two would never disagree out loud.
 */
const censusOf = (files: readonly string[]): Map<string, number> => {
  const found = new Map<string, number>()
  for (const file of files) {
    const src = stripComments(readFileSync(file, "utf8"))
    const n = [...src.matchAll(CALL_RE)].length
    if (n > 0) found.set(relative(SRC_ROOT, file), n)
  }
  return found
}

describe("A5 — pricing call-site census", () => {
  const sources = walk(SRC_ROOT)
  const found = censusOf(sources)

  test("ANTI-VACUITY: the scan reached the tree, and saw the runtime site", () => {
    // Two claims, and the first is not the second. A scan that returns nothing
    // satisfies every 'no new site' check below, and a named-site assertion only
    // proves ONE file was read — the reach floor is what says the rest of `src/`
    // was walked at all, and its number is measured and committed rather than
    // chosen here.
    assertScanPopulation(sources, SRC_ROOT, {
      id: "tests/unit/_arch/cost-pricing-callsite-ratchet.test.ts#SRC-ROOT",
      collectable: (n) => n.endsWith(".ts") && !n.endsWith(".d.ts"),
    })
    expect(found.get("agent/loop/emit-helpers.ts")).toBe(1)
    expect([...found.values()].reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(13)
  })

  test("no file prices outside the sanctioned census (name the offender)", () => {
    const offenders = [...found.entries()]
      .filter(([file, n]) => SANCTIONED[file]?.calls !== n)
      .map(([file, n]) => `${file}: ${n} call(s), sanctioned ${SANCTIONED[file]?.calls ?? 0}`)
    expect(offenders).toEqual([])
  })

  test("every enrolled file still carries EXACTLY its sanctioned calls", () => {
    // The census is exact in both directions: a deleted call in an enrolled
    // file is as loud as a new one elsewhere — otherwise the scan could rot.
    const drifted = Object.entries(SANCTIONED)
      .filter(([file, s]) => s.calls > 0 && found.get(file) !== s.calls)
      .map(([file, s]) => `${file}: expected ${s.calls}, found ${found.get(file) ?? 0}`)
    expect(drifted).toEqual([])
  })

  test("no alias and no bare reference can smuggle a pricing call past the census", () => {
    const offenders: string[] = []
    for (const file of sources) {
      for (const hit of indirectionsOf(stripComments(readFileSync(file, "utf8")))) {
        offenders.push(`${relative(SRC_ROOT, file)} — ${hit}`)
      }
    }
    expect(offenders).toEqual([])
  })

  test("SELF-TEST: the indirection scanner catches both evasion shapes", () => {
    // Anti-vacuum for the rule itself — the two literal shapes the final
    // audit used to walk straight past the call census.
    expect(indirectionsOf('import { costUsd as sneaky } from "@/observability"')).toHaveLength(1)
    expect(indirectionsOf("const p = costUsd\n")).toHaveLength(1)
    expect(indirectionsOf('import {\n  costUsd,\n} from "@/observability"')).toEqual([])
    expect(indirectionsOf("costUsd(model, a, b)")).toEqual([])
    expect(indirectionsOf("const t: typeof costUsd = impl")).toEqual([])
    expect(indirectionsOf("row.costUsd")).toEqual([])
    expect(indirectionsOf("costUsd: null,")).toEqual([])
  })

  test("inside src/agent/loop only the two sanctioned files price", () => {
    const loopOffenders = [...found.keys()].filter(
      (f) =>
        f.startsWith("agent/loop/") &&
        f !== "agent/loop/emit-helpers.ts" &&
        f !== "agent/loop/turn-iteration.ts",
    )
    expect(loopOffenders).toEqual([])
  })

  test("an import alone does not enroll a file (call scan, not import scan)", () => {
    // pricing.ts's own import lines and every consumer's `import { costUsd }`
    // must be invisible to the census — the regex demands a CALL.
    const importOnly = 'import { costUsd } from "@/observability"\nconst x = costUsd\n'
    expect([...stripComments(importOnly).matchAll(CALL_RE)].length).toBe(0)
  })
})
