/**
 * Structural ratchets installed after the 2026-05-29 3-round audit pass.
 *
 * Each test guards a CLASS of bug found in the audit, not a single instance:
 *
 *   G1 (F1-class)  — dead-wire prevention. The ADR-0409 post_compact wire
 *                    threads four artefacts through `src/agent/loop.ts`. A
 *                    refactor that removes any of them re-creates the
 *                    "compaction-visibility silently fires nothing" bug. We
 *                    grep the file for each marker.
 *
 *   G2 (F3-class)  — bounded-growth prevention. Every store under
 *                    `src/agent/<slice>/store.ts` MUST either expose a cap
 *                    constant / `maxRetained` opt OR opt out with an explicit
 *                    `// UNBOUNDED:` comment naming the reason. A new store
 *                    that ships without either fails this test.
 *
 *   G3 (F6-class)  — banner-drift prevention. Every literal anchor inside
 *                    `run-ledger-attribution/matchers.ts` (`startsWith("...")`
 *                    / `.test("...")`) MUST be discoverable as a literal in
 *                    the tool sources under `src/tool/` or `src/subagent/`.
 *                    A tool rename that doesn't propagate the matcher anchor
 *                    fails here, before it goes dark at runtime.
 *
 * These ratchets are read-only file scans — no runtime, no fixtures — so a CI
 * failure points directly at the missing protection. They cost ~10ms each.
 */

import { readdirSync, readFileSync } from "node:fs"
import { join, resolve as resolvePath } from "node:path"
import { describe, expect, test } from "bun:test"

const REPO_ROOT = resolvePath(__dirname, "..", "..")
const SRC_AGENT = join(REPO_ROOT, "src", "agent")
const TOOL_DIRS = [join(REPO_ROOT, "src", "tool"), join(REPO_ROOT, "src", "subagent")]

const readUtf8 = (path: string): string => readFileSync(path, "utf8")

// The 2026-06 loop decomposition split the monolithic `loop.ts` into a thin
// re-export shim + the `src/agent/loop/` slice. The wire markers these ratchets
// pin now live across those files, so read the WHOLE loop surface (shim + slice)
// — the invariant is "the loop threads these markers," not "in one file."
const readLoopSurface = (): string => {
  const parts = [readUtf8(join(SRC_AGENT, "loop.ts"))]
  const loopDir = join(SRC_AGENT, "loop")
  try {
    for (const f of readdirSync(loopDir).sort()) {
      if (f.endsWith(".ts")) parts.push(readUtf8(join(loopDir, f)))
    }
  } catch {
    // No loop/ dir (pre-decomposition tree) — the shim read alone is the surface.
  }
  return parts.join("\n")
}

// ─────────────────────────────────────────────────────────────────────────────
//  G1 — ADR-0409 post_compact wire markers in loop.ts (audit F1)
// ─────────────────────────────────────────────────────────────────────────────

describe("audit ratchet — G1 post_compact wire-presence (F1-class)", () => {
  test("loop.ts threads all four post_compact wire markers", () => {
    const loopTs = readLoopSurface()
    // Each marker corresponds to one part of the ADR-0409 wire. A refactor
    // that removes any of them resurrects the dead-emit bug F1 fixed.
    const requiredMarkers: ReadonlyArray<readonly [string, string]> = [
      ["buildPostCompactEmit(", "proactive site must call the helper"],
      ['type: "post_compact"', "reactive site must emit the typed event"],
      ["recoveryReason:", "compactIfNeeded input must carry the taxonomy"],
      ["objectiveSetNextActions", "Objective bridge must be wired"],
    ]
    const missing = requiredMarkers.filter(([m]) => !loopTs.includes(m))
    if (missing.length > 0) {
      const detail = missing.map(([m, why]) => `  - "${m}"  (${why})`).join("\n")
      throw new Error(`loop.ts is missing required post_compact wire markers:\n${detail}`)
    }
    expect(missing.length).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
//  G2 — every src/agent/*/store.ts is bounded (cap) OR explicitly opt-out
// ─────────────────────────────────────────────────────────────────────────────

const collectStoreFiles = (): string[] => {
  const out: string[] = []
  const entries = readdirSync(SRC_AGENT, { withFileTypes: true })
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const storePath = join(SRC_AGENT, e.name, "store.ts")
    try {
      readFileSync(storePath)
      out.push(storePath)
    } catch {
      // no store in this slice — skip
    }
  }
  return out
}

const isBounded = (source: string): boolean => {
  // Recognised bounded-growth markers (any one suffices):
  //  - maxRetained opt
  //  - MAX_…/DEFAULT_MAX_RETAINED constants
  //  - LRU eviction callsite
  //  - explicit opt-out comment "UNBOUNDED: …"
  return (
    source.includes("maxRetained") ||
    /MAX_[A-Z_]+\s*=/.test(source) ||
    source.includes("DEFAULT_MAX_RETAINED") ||
    source.includes("evictIfOverCap") ||
    source.includes("UNBOUNDED:")
  )
}

describe("audit ratchet — G2 bounded-growth (F3-class)", () => {
  test("every src/agent/<slice>/store.ts is bounded OR carries an explicit UNBOUNDED: opt-out", () => {
    const stores = collectStoreFiles()
    expect(stores.length).toBeGreaterThan(0) // sanity: at least the audited 5
    const unbounded = stores
      .map((p) => ({ path: p, ok: isBounded(readUtf8(p)) }))
      .filter((r) => !r.ok)
    if (unbounded.length > 0) {
      const detail = unbounded
        .map(
          (r) =>
            `  - ${r.path.replace(`${REPO_ROOT}/`, "")}\n` +
            "      Add maxRetained / MAX_*/evictIfOverCap, OR add the comment\n" +
            '      "// UNBOUNDED: <reason>" naming the intentional opt-out.',
        )
        .join("\n")
      throw new Error(
        `Bounded-growth ratchet (audit F3-class) — these stores grow without a cap:\n${detail}`,
      )
    }
    expect(unbounded.length).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
//  G3 — every matcher banner literal exists in a tool source (audit F6)
// ─────────────────────────────────────────────────────────────────────────────

const collectMatcherBanners = (): string[] => {
  const src = readUtf8(join(SRC_AGENT, "run-ledger-attribution", "matchers.ts"))
  const out = new Set<string>()
  // startsWith("...") and .test("...") (single arg, double-quoted literal).
  const re = /(?:startsWith|test)\s*\(\s*"((?:[^"\\]|\\.)+)"/g
  let m: RegExpExecArray | null = null
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(src)) !== null) {
    const lit = m[1]
    if (typeof lit === "string" && lit.length > 0) out.add(lit)
  }
  return [...out]
}

const collectAllToolSources = (): string => {
  const buf: string[] = []
  const walk = (dir: string): void => {
    let entries: ReturnType<typeof readdirSync>
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        // skip test dirs + node_modules-style sub-trees if any
        if (e.name === "__tests__" || e.name === "node_modules" || e.name.startsWith(".")) continue
        walk(full)
        continue
      }
      if (!e.isFile()) continue
      if (!e.name.endsWith(".ts")) continue
      if (e.name.endsWith(".test.ts") || e.name.endsWith(".hellgate.test.ts")) continue
      try {
        buf.push(readUtf8(full))
      } catch {
        // unreadable file — skip
      }
    }
  }
  for (const d of TOOL_DIRS) walk(d)
  return buf.join("\n")
}

describe("audit ratchet — G3 banner cross-source pinning (F6-class)", () => {
  test("every matcher banner literal appears in src/tool/** or src/subagent/**", () => {
    const banners = collectMatcherBanners()
    expect(banners.length).toBeGreaterThan(0) // sanity: at least the audited 5
    const toolSrc = collectAllToolSources()
    const missing = banners.filter((b) => !toolSrc.includes(b))
    if (missing.length > 0) {
      const detail = missing.map((b) => `  - "${b}"`).join("\n")
      throw new Error(
        "Banner-drift ratchet (audit F6-class) — these matcher anchors do NOT\n" +
          "appear anywhere in src/tool/** or src/subagent/**:\n" +
          `${detail}\n\n` +
          "Either the tool source was renamed without updating matchers.ts,\n" +
          "or the matcher anchor is orphaned. Fix both sides verbatim or remove.",
      )
    }
    expect(missing.length).toBe(0)
  })
})
