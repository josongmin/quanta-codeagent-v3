/**
 * Structural ratchets installed after the 2026-05-29 3-round audit pass.
 *
 * Each test guards a CLASS of bug found in the audit, not a single instance:
 *
 *   G1 (F1-class)  — dead-wire prevention. The ADR-0409 post_compact wire is
 *                    deliberately split across the event factory
 *                    (`loop-helpers.ts`), proactive producer
 *                    (`loop/compaction-wire.ts`), and reactive producer
 *                    (`loop/recovery-executor.ts`). A refactor that removes a
 *                    live call from any owner re-creates the
 *                    "compaction-visibility silently fires nothing" bug. The
 *                    behavioral rail is `compaction-emit-e2e.test.ts`; this
 *                    guard pins each producer's call structure.
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

import { describe, expect, test } from "bun:test"
import { type Dirent, readdirSync, readFileSync } from "node:fs"
import { join, resolve as resolvePath } from "node:path"

const REPO_ROOT = resolvePath(__dirname, "..", "..")
const SRC_AGENT = join(REPO_ROOT, "src", "agent")
const TOOL_DIRS = [join(REPO_ROOT, "src", "tool"), join(REPO_ROOT, "src", "subagent")]

const readUtf8 = (path: string): string => readFileSync(path, "utf8")

// ─────────────────────────────────────────────────────────────────────────────
//  G1 — ADR-0409 post_compact live owner contracts (audit F1)
// ─────────────────────────────────────────────────────────────────────────────

type PostCompactOwnerContract = {
  readonly owner: string
  readonly source: string
  readonly required: readonly [RegExp, string][]
}

const postCompactOwnerContracts = (): readonly PostCompactOwnerContract[] => [
  {
    owner: "event factory",
    source: readUtf8(join(SRC_AGENT, "loop-helpers.ts")),
    required: [
      [
        /export const buildPostCompactEmit\s*=\s*\([\s\S]*?if \(hooks === undefined\) return undefined/,
        "absent HookBus must preserve the no-op path",
      ],
      [
        /await hooks\.emit\s*\(\s*\{\s*type:\s*["']post_compact["'],\s*threadId,\s*provenance\s*}\s*\)/,
        "factory must emit the typed post_compact event",
      ],
    ],
  },
  {
    owner: "proactive producer",
    source: readUtf8(join(SRC_AGENT, "loop", "compaction-wire.ts")),
    required: [
      [
        /const postCompactEmit\s*=\s*buildPostCompactEmit\s*\(\s*config\.hooks,\s*config\.sessionId \?\? ["']["']\s*\)/,
        "proactive producer must build the event callback from the configured HookBus",
      ],
      [
        /postCompactEmit !== undefined \? \{ postCompactEmit \} : \{\}/,
        "proactive producer must pass the callback into compactIfNeeded",
      ],
      [
        /postCompactEmit !== undefined \|\| objectiveSetNextActions !== undefined[\s\S]{0,100}recoveryReason:\s*["']token_budget_exceeded["'] as const/,
        "proactive producer must preserve the recovery taxonomy when either advisory wire is active",
      ],
    ],
  },
  {
    owner: "reactive producer",
    source: readUtf8(join(SRC_AGENT, "loop", "recovery-executor.ts")),
    required: [
      [
        /const postCompactEmit\s*=\s*buildPostCompactEmit\s*\(\s*config\.hooks,\s*threadId\s*\)/,
        "reactive producer must build the event callback from the configured HookBus",
      ],
      [
        /if \(postCompactEmit !== undefined\)\s*\{\s*try\s*\{\s*await postCompactEmit\s*\(\s*provenance\s*\)/,
        "reactive producer must invoke the callback after a successful compaction",
      ],
      [
        /surfacePostCompactFailure\s*\(\s*session,\s*["']post_compact hook["'],\s*e\s*\)/,
        "reactive producer must surface a callback failure instead of silently swallowing it",
      ],
    ],
  },
]

const missingPostCompactRequirements = (contract: PostCompactOwnerContract): string[] =>
  contract.required
    .filter(([pattern]) => !pattern.test(contract.source))
    .map(([, reason]) => reason)

describe("audit ratchet — G1 post_compact live owner contracts (F1-class)", () => {
  test("each owner preserves its live post_compact call structure", () => {
    const contracts = postCompactOwnerContracts()
    // Anti-vacuum floor: this guard intentionally owns all three live seams.
    expect(contracts.length).toBe(3)
    const missing = contracts.flatMap((contract) =>
      missingPostCompactRequirements(contract).map((reason) => `  - ${contract.owner}: ${reason}`),
    )
    expect(missing).toEqual([])
  })

  test("the G1 scanner goes RED when a required live call is removed", () => {
    const contracts = postCompactOwnerContracts()
    const mutated = contracts.map((contract) => {
      const [pattern] = contract.required[0] ?? []
      if (pattern === undefined) throw new Error(`${contract.owner} has no mutation target`)
      return { ...contract, source: contract.source.replace(pattern, "/* removed by mutation */") }
    })
    for (const contract of mutated) {
      expect(missingPostCompactRequirements(contract).length).toBeGreaterThan(0)
    }
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

const collectMatcherBannersFrom = (src: string): string[] => {
  const out = new Set<string>()
  // startsWith("...") and .test("...") (single arg, double-quoted literal).
  const re = /(?:startsWith|test)\s*\(\s*"((?:[^"\\]|\\.)+)"/g
  for (;;) {
    const m = re.exec(src)
    if (m === null) break
    const lit = m[1]
    if (typeof lit === "string" && lit.length > 0) out.add(lit)
  }
  return [...out]
}

const producerAnchor = (banner: string): string =>
  banner.startsWith("\\n") ? banner.slice("\\n".length) : banner

const missingMatcherBanners = (matcherSrc: string, toolSrc: string): string[] =>
  collectMatcherBannersFrom(matcherSrc).filter(
    (banner) => !toolSrc.includes(producerAnchor(banner)),
  )

const readDirSafe = (dir: string): Dirent<string>[] => {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

const readToolSource = (path: string, entry: Dirent<string>): string | undefined => {
  if (!entry.isFile() || !entry.name.endsWith(".ts")) return undefined
  if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".hellgate.test.ts")) return undefined
  try {
    return readUtf8(path)
  } catch {
    return undefined
  }
}

const skipToolDirectory = (name: string): boolean =>
  name === "__tests__" || name === "node_modules" || name.startsWith(".")

const collectAllToolSources = (): string => {
  const buf: string[] = []
  const pending = [...TOOL_DIRS]
  while (pending.length > 0) {
    const dir = pending.pop()
    if (dir === undefined) break
    for (const entry of readDirSafe(dir)) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (skipToolDirectory(entry.name)) continue
        pending.push(full)
        continue
      }
      const source = readToolSource(full, entry)
      if (source !== undefined) buf.push(source)
    }
  }
  return buf.join("\n")
}

describe("audit ratchet — G3 banner cross-source pinning (F6-class)", () => {
  test("every matcher banner literal appears in src/tool/** or src/subagent/**", () => {
    const matcherSrc = readUtf8(join(SRC_AGENT, "run-ledger-attribution", "matchers.ts"))
    const banners = collectMatcherBannersFrom(matcherSrc)
    expect(banners.length).toBeGreaterThan(0) // sanity: at least the audited 5
    const toolSrc = collectAllToolSources()
    const missing = missingMatcherBanners(matcherSrc, toolSrc)
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

  test("the scanner goes RED for a synthetic orphan matcher banner", () => {
    const syntheticMatcher = 'if (payload.startsWith("definitely-orphaned-banner:")) return null'
    expect(missingMatcherBanners(syntheticMatcher, "producer output has another banner")).toEqual([
      "definitely-orphaned-banner:",
    ])
  })
})
