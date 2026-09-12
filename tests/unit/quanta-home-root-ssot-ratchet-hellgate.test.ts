/**
 * QUANTA-HOME ROOT SSOT ratchet (jun-15 config-dir split-brain fix).
 *
 * Quanta's on-disk home root must be resolved through ONE SSOT —
 * `quantaHomeDir()` in `@/shared` (`QUANTA_CONFIG_DIR ?? QUANTA_HOME ??
 * ~/.quanta`). The bug this locks: ~a dozen subsystems hard-coded
 * `join(homedir(), ".quanta", …)` and honored NEITHER root override, so a user
 * who set `QUANTA_CONFIG_DIR`/`QUANTA_HOME` got a SPLIT-BRAIN home (config in
 * one place, sticky-model/scheduler/sessions/grants/caches in another).
 *
 * RULE: a raw `join(homedir(), ".quanta", …)` may appear ONLY in files that
 * legitimately COMPUTE a root (the resolver itself) or own a distinct,
 * intentional override seam (composition-root `QUANTA_CONFIG_DIR` readers, the
 * `QUANTA_PREFS_HOME` test-isolation seam, the web-daemon `QUANTA_WEB_DB_DIR`
 * override, the bench `QUANTA_HOME` persistent-default). Everything else MUST
 * derive from `quantaHomeDir()`. A NEW raw site fails this ratchet → route it
 * through `quantaHomeDir()` (or, if it genuinely owns a new root seam, add it
 * to ALLOWLIST with a reason).
 *
 * This is the forcing function that prevents the split-brain from re-growing.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import ts from "typescript"
import { assertScanPopulation } from "./_shared/scan-population"

const SRC = join(import.meta.dir, "..", "..", "src")

/** Raw "Quanta home" hard-code: `homedir()` immediately followed by `".quanta"`
 *  as a path segment. Matches the leak we are forbidding; does NOT match
 *  `quantaHomeDir()` (no `homedir()` token) or unrelated `homedir()` uses
 *  (`.codex`, `.config`, …). */
const RAW = /homedir\(\)\s*,\s*"\.quanta"/

/** Files allowed to keep a raw `homedir(), ".quanta"` — each either COMPUTES the
 *  root or owns a distinct, documented override seam. Path is repo-relative. */
const ALLOWLIST: ReadonlyMap<string, string> = new Map([
  ["src/shared/quanta-home.ts", "THE resolver — the one place the root literal lives"],
  [
    "src/memory/store-path.ts",
    "`preRelocationHomeStorePath` — the OS-home-scoped path is the POINT: it is where the memory store lived before the plane followed QUANTA_HOME, probed so a relocated home does not silently orphan an existing store. Notice-only, never a redirect. This entry exists because the widened detector correctly found it.",
  ],
  [
    "src/runner/batch/corpus/paths.ts",
    "bench: honors the unified root (CONFIG_DIR ?? HOME) but keeps its OWN macOS Library / ~/.quanta default (NOT quantaHomeDir's ~/.quanta) so /tmp-reaping persistence holds",
  ],
  [
    "src/auth/chatgpt-oauth/paths.ts",
    "QUANTA_PREFS_HOME surface-prefs + test-isolation seam (distinct override domain, like CODEX_HOME)",
  ],
])

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    const s = statSync(p)
    if (s.isDirectory()) {
      if (entry === "__tests__") continue
      yield* walk(p)
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts") && !entry.endsWith(".test.ts")) {
      yield p
    }
  }
}

const isComment = (l: string): boolean => {
  const t = l.trimStart()
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
}

/** Files (repo-relative, `src/…`) with a NON-comment raw home hard-code. */
const scanRawHomeSites = (srcRoot: string): string[] => {
  const hits: string[] = []
  for (const file of walk(srcRoot)) {
    const src = readFileSync(file, "utf8")
    // Fast reject: skip the per-line comment scan unless the file matches at all.
    if (!RAW.test(src)) continue
    const hasRaw = src.split("\n").some((line) => !isComment(line) && RAW.test(line))
    if (hasRaw) hits.push(`src/${file.slice(srcRoot.length + 1)}`)
  }
  return hits
}

const calleeName = (n: ts.CallExpression): string => {
  if (ts.isPropertyAccessExpression(n.expression)) return n.expression.name.text
  if (ts.isIdentifier(n.expression)) return n.expression.text
  return ""
}

/** The root literal, or a path that STARTS at it (`.quanta/memory`, `.quanta/x`). */
const isRootLiteral = (t: string): boolean => t === ".quanta" || t.startsWith(".quanta/")

/** File-local `const X = ".quanta…"` bindings, so `join(home, SUB)` resolves.
 *
 *  This is the exact shape the ORIGINAL defect had:
 *  `const QUANTA_MEMORY_SUBDIR = ".quanta/memory"` joined onto a parameter NAMED
 *  `homedir` that shadowed the import. Measured against the pre-fix `paths.ts`: the
 *  first version of this detector matched ZERO — both because the fast-reject tested
 *  for `".quanta"` with a closing quote and because the predicate required the second
 *  argument to BE `".quanta"`. The commit that added it claimed to close the
 *  const-hoisted evasion and closed only the shape it injected as a mutant. */
const rootAliases = (sf: ts.SourceFile): Set<string> => {
  const out = new Set<string>()
  const visit = (n: ts.Node): void => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer !== undefined &&
      ts.isStringLiteralLike(n.initializer) &&
      isRootLiteral(n.initializer.text)
    ) {
      out.add(n.name.text)
    }
    ts.forEachChild(n, visit)
  }
  ts.forEachChild(sf, visit)
  return out
}

/** `join|resolve(<something mentioning "home">, <the root literal or an alias>, …)`. */
const isHomeJoinedRoot = (n: ts.Node, sf: ts.SourceFile, aliases: ReadonlySet<string>): boolean => {
  if (!ts.isCallExpression(n) || n.arguments.length < 2) return false
  const name = calleeName(n)
  if (name !== "join" && name !== "resolve") return false
  const second = n.arguments[1] as ts.Expression
  const isRoot = ts.isStringLiteralLike(second)
    ? isRootLiteral(second.text)
    : ts.isIdentifier(second) && aliases.has(second.text)
  if (!isRoot) return false
  return /home/i.test((n.arguments[0] as ts.Expression).getText(sf))
}

const homeJoinedRootSites = (): string[] => {
  const out: string[] = []
  for (const file of walk(SRC)) {
    const text = readFileSync(file, "utf8")
    // No closing quote: `".quanta/memory"` must reach the parser too.
    if (!text.includes('".quanta')) continue
    const rel = `src/${file.slice(SRC.length + 1)}`
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)
    const aliases = rootAliases(sf)
    const visit = (n: ts.Node): void => {
      if (isHomeJoinedRoot(n, sf, aliases)) {
        out.push(`${rel}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`)
      }
      ts.forEachChild(n, visit)
    }
    ts.forEachChild(sf, visit)
  }
  return out.sort()
}

describe("quanta home root SSOT ratchet", () => {
  test("ANTI-VACUITY: the walk reaches a real, populated `src/` tree", () => {
    // An empty walk and a clean tree produce the same verdict here: no
    // un-owned home-root reads. A count alone would not do — losing one subtree
    // leaves it high while the offending directory goes unscanned.
    assertScanPopulation([...walk(SRC)], SRC, {
      id: "tests/unit/quanta-home-root-ssot-ratchet-hellgate.test.ts#SRC",
      collectable: (n) => n.endsWith(".ts") && !n.endsWith(".d.ts") && !n.endsWith(".test.ts"),
    })
  })

  test('no NEW raw `homedir(), ".quanta"` outside the allowlist', () => {
    const sites = scanRawHomeSites(SRC)
    const offenders = sites.filter((f) => !ALLOWLIST.has(f))
    if (offenders.length > 0) {
      throw new Error(
        `${offenders.length} raw \`join(homedir(), ".quanta", …)\` site(s) bypassing the ` +
          `quantaHomeDir() SSOT (split-brain home risk). Route through ` +
          `\`import { quantaHomeDir } from "@/shared"\`:\n${offenders.map((o) => `  ${o}`).join("\n")}`,
      )
    }
    expect(offenders).toEqual([])
  })

  /** ONE allowlist, TWO detectors — an entry is alive if EITHER census finds it.
   *
   *  This checked only the raw-adjacency census, so adding an entry for a file the
   *  SECOND detector finds (`join(<home-param>, ".quanta", …)`, no `homedir()` token)
   *  reported it as dead. The allowlist grants both scanners, so both decide liveness. */
  test("allowlist has no dead entries (every allowlisted file still has a site)", () => {
    const raw = new Set(scanRawHomeSites(SRC))
    const joined = new Set(homeJoinedRootSites().map((x) => x.split(":")[0] as string))
    const dead = [...ALLOWLIST.keys()].filter((f) => !raw.has(f) && !joined.has(f))
    // A dead entry means the file was migrated/removed — prune it so the
    // allowlist can't silently grant future raw sites in that file.
    expect(dead).toEqual([])
  })

  /**
   * SECOND DETECTOR — the root literal joined onto ANY home-ish value.
   *
   * `RAW` only matches `homedir()` IMMEDIATELY followed by `".quanta"`. Two shapes
   * evade it, and both were live:
   *
   *  - the literal hoisted into a const: `memory/consolidate/paths.ts` had
   *    `const QUANTA_MEMORY_SUBDIR = ".quanta/memory"` and joined it onto a parameter
   *    NAMED `homedir` that shadowed the import. Proven: rewriting it to the raw
   *    spelling made this file go red instantly, so the plane had been a real
   *    split-brain site the whole time and invisible. Measured consequence — with
   *    `QUANTA_HOME` relocated, sessions and knobs moved and the memory store did not.
   *  - a home passed in as a PARAMETER: `join(homeDir, ".quanta", …)` has no
   *    `homedir()` token at all.
   *
   * This arm censuses `join(<home-ish>, ".quanta", …)` by AST and pins the count. The
   * home-ish test is whether the first argument's source text mentions "home" — not an
   * arbitrary threshold but the actual signal that separates the HOME root from the
   * legitimately project-scoped `join(cwd, ".quanta", …)` / `join(projectRoot, …)`
   * sites, of which there are 11. A shape it fails to recognise UNDER-reports.
   *
   * Measured: 18 home-ish sites, 15 outside the allowlist. My first hand probe said 13
   * — its output was truncated by a `tail`, and the number I would have written into
   * the ceiling was wrong by two. The ceiling is the test's own census.
   *
   * The ceiling is the measured population, not zero. Each remaining site takes a
   * home from its caller and may or may not be getting a QUANTA home — deciding that
   * needs the call graph per plane, which is a burn-down, not a sweep. What this
   * forbids is a NEW one.
   */
  const HOME_JOIN_CEILING = 15

  test(`home-joined root literals stay <= ${HOME_JOIN_CEILING} (burn-down only)`, () => {
    const sites = homeJoinedRootSites().filter((s) => !ALLOWLIST.has(s.split(":")[0] as string))
    // biome-ignore lint/suspicious/noConsole: ratchet visibility for reviewers
    console.log(`[home-joined-root] ${sites.length}/${HOME_JOIN_CEILING} sites`)
    if (sites.length > HOME_JOIN_CEILING) {
      throw new Error(
        `${sites.length} \`join(<home>, ".quanta", …)\` site(s) (ceiling ${HOME_JOIN_CEILING}). ` +
          `Each takes a home from its caller and hard-codes the root, which is how the ` +
          `memory plane stopped following QUANTA_HOME. Derive from \`quantaHomeDir()\` / ` +
          `\`quantaHomeDirFrom(env)\`:\n${sites.map((x) => `  ${x}`).join("\n")}`,
      )
    }
    expect(sites.length).toBeLessThanOrEqual(HOME_JOIN_CEILING)
  })

  test("the second detector distinguishes home-scoped from project-scoped", () => {
    const sites = homeJoinedRootSites()
    expect(sites.length, "the AST census found nothing — it stopped resolving").toBeGreaterThan(5)
    // The resolver itself must be in the census, or the detector is not seeing the
    // one site it is guaranteed to be able to see.
    expect(sites.some((s) => s.startsWith("src/shared/quanta-home.ts"))).toBe(true)
    // …and a project-scoped join must NOT be, or the ceiling counts the wrong thing.
    expect(sites.some((s) => s.startsWith("src/tool/registry.ts"))).toBe(false)
    expect(sites.some((s) => s.startsWith("src/permission/trust-scope-store.ts"))).toBe(false)
    // The memory plane's CONSOLIDATOR is gone from the census — that was the defect.
    expect(sites.some((s) => s.startsWith("src/memory/consolidate/"))).toBe(false)
    // `store-path.ts` IS in the raw census (its OS-home join is deliberate, see the
    // allowlist) and the ceiling arm filters it out. Asserting both directions keeps
    // the allowlist honest: a dead entry would make the first expectation fail.
    expect(sites.some((s) => s.startsWith("src/memory/store-path.ts"))).toBe(true)
  })

  test("DETECTOR has teeth (red-on-injection)", () => {
    expect(RAW.test('join(homedir(), ".quanta", "snooze")')).toBe(true)
    expect(RAW.test("const p = quantaHomeDir()")).toBe(false)
    expect(RAW.test('join(homedir(), ".codex")')).toBe(false)
  })
})
