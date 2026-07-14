/**
 * INV-03 / G8 — runAgent CALL-SITE AUTHORITY FENCE (static completeness hellgate).
 *
 * PROBLEM (from AUDIT-2026-07-14): descendant agents are forked by calling the
 * loop entrypoint `runAgent(config)` (`src/agent/loop/entry.ts`). The spawn-depth
 * AUTHORITY — the "child depth exceeds cap ⇒ deny" reject built on `childDepthOf`
 * / `effectiveCap` / `canAdmitChildDepth` — lives in the subagent-runner path AND,
 * as of D1, in `branch-search-runner.ts`. But `runAgent` is a plain exported
 * function: ANY new file can import it and fork a child DIRECTLY, bypassing the
 * authority. Grep can't defend this (renames / aliases / whitespace fool it).
 *
 * THIS GATE enumerates — via the TypeScript compiler AST, NOT grep — every
 * PRODUCTION reference to the imported `runAgent` binding (both direct calls
 * `runAgent(...)` AND value-injections `const run = deps.runAgent ?? runAgent`,
 * because the inject pattern is an equally real spawn surface) and asserts each
 * host FILE is in a REVIEWED allowlist. A NEW, unclassified `runAgent` call site
 * turns this test RED — forcing a human review + an explicit authority decision
 * (is the new vector a root entry, or a descendant that MUST route through the
 * depth reject?).
 *
 * Non-vacuity: the enumeration actually parses the files and resolves the local
 * import name of `runAgent` per file (so an `import { runAgent as fork }` alias
 * is still caught). A scratch edit adding a fake `runAgent(` call in a
 * non-allowlisted file makes this RED (demonstrated at review time, then
 * reverted). The allowlist is also checked for STALE entries so a removed call
 * site can't leave dead review-debt behind.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import ts from "typescript"

const REPO_ROOT = join(import.meta.dir, "../..")
const SRC_ROOT = join(REPO_ROOT, "src")

/** The barrel / relative specifiers from which the loop entrypoint `runAgent`
 *  is re-exported. A value-import of `runAgent` from ANY of these resolves to
 *  the real fork entrypoint (`src/agent/loop/entry.ts`). We intentionally do
 *  NOT resolve arbitrary specifiers — these are the only paths that re-export
 *  it, verified against `src/agent/index.ts` (`export { runAgent } from
 *  "./loop"`). If a future refactor adds another re-export path, the scanner
 *  will simply not see imports through it; that is caught by the sanity floor
 *  (below) which asserts the known authority-gated sites are always present. */
const RUNAGENT_EXPORT_SPECIFIERS: ReadonlySet<string> = new Set([
  "@/agent",
  "./loop",
  "../loop",
  "../../loop",
])

/** Classification of a reviewed `runAgent` host file. */
type Kind =
  | "root-entry" // top-level agent run (depth 0), no descendant authority applies
  | "descendant-authority-gated" // forks a CHILD; MUST route the depth reject
  | "host-eval-entry" // bench/eval harness root — a fresh top-level run per task
  | "runner-orchestration" // batch/live conversation host driving a top-level run

interface Allowed {
  readonly path: string // repo-relative, forward-slash
  readonly kind: Kind
  readonly why: string
}

/**
 * REVIEWED ALLOWLIST — the CURRENT (2026-07-14) set of production files that
 * reference the `runAgent` binding, each classified + justified. Landing this
 * list GREEN encodes the review that happened; any NEW file forces a re-review.
 */
const ALLOWLIST: readonly Allowed[] = [
  // ── descendant-authority-gated: these fork CHILD runs and MUST obey the
  //    spawn-depth reject (childDepthOf / effectiveCap / canAdmitChildDepth).
  {
    path: "src/agent/subagent-runner.ts",
    kind: "descendant-authority-gated",
    why: "SSOT subagent fork; `req.depth > maxDepth ⇒ deny` reject. Injects `runAgent` via `opts.run ?? runAgent`.",
  },
  {
    path: "src/agent/branch-search-runner.ts",
    kind: "descendant-authority-gated",
    why: "D1 (AUDIT-2026-07-14): candidate fork now routes childDepthOf/effectiveCap/canAdmitChildDepth before `runAgent(child)`.",
  },
  // ── root-entry: top-level agent runs from a session host (depth 0). No
  //    descendant authority applies — these ARE the root.
  {
    path: "src/apps/agent/run.ts",
    kind: "root-entry",
    why: "CLI agent lifecycle root; injects real `runAgent` via `deps.runAgent ?? runAgent`.",
  },
  {
    path: "src/host/runtime/internal/context-binding/turn-runner.ts",
    kind: "root-entry",
    why: "Session-host turn driver — top-level interactive/IDE run.",
  },
  {
    path: "src/host/runtime/internal/context-binding/side-conversation.ts",
    kind: "root-entry",
    why: "Session-host side conversation — a fresh top-level run with a filtered tool surface.",
  },
  {
    path: "src/sdk/embed.ts",
    kind: "root-entry",
    why: "Embedded SDK entrypoint — top-level run for host embedders.",
  },
  {
    path: "src/host/runtime/agent-config-assembler.ts",
    kind: "root-entry",
    why: "SSOT resolveRunAgent picker (`seams?.runAgent ?? defaultRunAgent`, aliased import `runAgent as defaultRunAgent`) — the injection point every mode-preset uses to select the real top-level loop; not a descendant fork.",
  },
  // ── runner-orchestration: batch/live conversation host, top-level run per turn.
  {
    path: "src/runner/orchestrate/run-once.ts",
    kind: "runner-orchestration",
    why: "Runner single-turn orchestration — top-level `runAgent(assembleConfig(...))`.",
  },
  {
    path: "src/runner/orchestrate/side-chat.ts",
    kind: "runner-orchestration",
    why: "Runner side-chat orchestration — isolated top-level run.",
  },
  // ── host-eval-entry: bench/eval harness roots — one fresh top-level run per task.
  {
    path: "src/runner/batch/eval/driver/agent-phase.ts",
    kind: "host-eval-entry",
    why: "Bench eval driver agent phase — top-level run per candidate/attempt.",
  },
  {
    path: "src/apps/bench/eval/driver.ts",
    kind: "host-eval-entry",
    why: "Bench eval app driver — top-level run per task.",
  },
  {
    path: "src/apps/eval/synthetic/runner.ts",
    kind: "host-eval-entry",
    why: "Synthetic eval runner — top-level run per synthetic task.",
  },
  {
    path: "src/apps/eval/trajectory/replay.ts",
    kind: "host-eval-entry",
    why: "Trajectory replay eval — top-level run per replay.",
  },
]

const ALLOWLIST_PATHS: ReadonlySet<string> = new Set(ALLOWLIST.map((a) => a.path))

/** Files that MUST always appear as authority-gated descendant call sites — the
 *  non-vacuity floor. If a refactor makes these vanish from the enumeration,
 *  the gate has gone blind and the test fails (rather than silently passing on
 *  an empty scan). */
const AUTHORITY_GATED_FLOOR: readonly string[] = [
  "src/agent/subagent-runner.ts",
  "src/agent/branch-search-runner.ts",
]

// ─────────────────────────────────────────────────────────────────────────────
// AST enumeration engine (real parse — no grep, no hardcoded call-site list).
// ─────────────────────────────────────────────────────────────────────────────

const toRepoRel = (abs: string): string => relative(REPO_ROOT, abs).split("\\").join("/")

const listSourceTsFiles = (dir: string): string[] => {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      out.push(...listSourceTsFiles(full))
    } else if (
      st.isFile() &&
      name.endsWith(".ts") &&
      !name.endsWith(".d.ts") &&
      !name.endsWith(".test.ts") &&
      !name.endsWith(".spec.ts")
    ) {
      out.push(full)
    }
  }
  return out.sort()
}

const parse = (path: string, src: string): ts.SourceFile =>
  ts.createSourceFile(path, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

const lineOf = (sf: ts.SourceFile, pos: number): number =>
  sf.getLineAndCharacterOfPosition(pos).line + 1

/**
 * Resolve the LOCAL name(s) that `runAgent` is imported under in this file, from
 * one of the known re-export specifiers. Handles `import { runAgent }`,
 * `import { runAgent as fork }`, and `import { type X, runAgent }`. Type-only
 * imports (`import type { runAgent }` or `{ type runAgent }`) are skipped — a
 * type reference cannot fork a run. Returns the set of local identifiers.
 */
const localRunAgentNames = (sf: ts.SourceFile): Set<string> => {
  const names = new Set<string>()
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue
    if (!ts.isStringLiteralLike(stmt.moduleSpecifier)) continue
    if (!RUNAGENT_EXPORT_SPECIFIERS.has(stmt.moduleSpecifier.text)) continue
    const clause = stmt.importClause
    if (!clause || clause.isTypeOnly) continue // whole `import type { ... }`
    const bindings = clause.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) continue
    for (const el of bindings.elements) {
      if (el.isTypeOnly) continue // per-specifier `{ type runAgent }`
      // `propertyName` is the ORIGINAL export name when aliased (`runAgent as fork`).
      const original = (el.propertyName ?? el.name).text
      if (original === "runAgent") names.add(el.name.text)
    }
  }
  return names
}

interface CallSite {
  readonly repoRel: string
  readonly line: number
  readonly form: "call" | "value-ref"
}

/**
 * Enumerate, for one file, every reference to the imported `runAgent` binding:
 *   - `call`      — a CallExpression whose callee is the bound identifier
 *                   (`runAgent(...)` / `fork(...)`), the direct fork.
 *   - `value-ref` — the bound identifier appearing in a NON-callee, non-import
 *                   position (`?? runAgent`, `run?: typeof runAgent`, passed as
 *                   an arg), i.e. the inject pattern that still forks a child.
 * The identifier's binding is resolved via {@link localRunAgentNames}, so a
 * same-named local that is NOT the imported entrypoint is ignored, and an
 * aliased import IS caught. `typeof runAgent` in a type position is skipped
 * (it declares a signature, it does not fork).
 */
const enumerateSource = (repoRel: string, src: string): CallSite[] => {
  const sf = parse(repoRel, src)
  const names = localRunAgentNames(sf)
  if (names.size === 0) return []
  const out: CallSite[] = []
  const seenCallLines = new Set<number>()

  const isImportSpecifierName = (id: ts.Identifier): boolean => {
    // The `runAgent` token INSIDE `import { runAgent }` is an ImportSpecifier
    // name, not a use — skip so the import line isn't counted as a value-ref.
    const p = id.parent
    return !!p && ts.isImportSpecifier(p)
  }

  const inTypeOnlyContext = (id: ts.Identifier): boolean => {
    // Walk up: if we hit a TypeQuery (`typeof runAgent`) or any TypeNode before
    // an expression boundary, this is a type-position reference (no fork).
    let n: ts.Node | undefined = id.parent
    while (n) {
      if (ts.isTypeQueryNode(n)) return true
      if (
        ts.isExpressionStatement(n) ||
        ts.isCallExpression(n) ||
        ts.isBinaryExpression(n) ||
        ts.isVariableDeclaration(n) ||
        ts.isArrowFunction(n) ||
        ts.isReturnStatement(n)
      ) {
        return false
      }
      n = n.parent
    }
    return false
  }

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (names.has(node.expression.text)) {
        const line = lineOf(sf, node.expression.getStart(sf))
        seenCallLines.add(line)
        out.push({ repoRel, line, form: "call" })
      }
    } else if (ts.isIdentifier(node) && names.has(node.text)) {
      // Value-ref: not the callee of a call (handled above), not an import
      // specifier, not a type position, not a declaration name.
      const p = node.parent
      const isCalleePosition = !!p && ts.isCallExpression(p) && p.expression === node
      const isDeclName =
        !!p &&
        ((ts.isVariableDeclaration(p) && p.name === node) ||
          (ts.isFunctionDeclaration(p) && p.name === node) ||
          (ts.isParameter(p) && p.name === node) ||
          (ts.isBindingElement(p) && p.name === node) ||
          (ts.isPropertyAssignment(p) && p.name === node) ||
          ts.isPropertySignature(p))
      if (
        !isCalleePosition &&
        !isImportSpecifierName(node) &&
        !isDeclName &&
        !inTypeOnlyContext(node)
      ) {
        out.push({ repoRel, line: lineOf(sf, node.getStart(sf)), form: "value-ref" })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/** Real-file entrypoint: read from disk, delegate to the (synthetic-testable)
 *  source-string engine. Keeps on-disk enumeration byte-identical while exposing
 *  {@link enumerateSource} so the non-vacuity tests can feed CONTROLLED sources
 *  (aliased import, inject value-ref, type-only) and assert the discrimination
 *  directly — not merely infer it from which real files land in the allowlist. */
const enumerateFile = (abs: string): CallSite[] =>
  enumerateSource(toRepoRel(abs), readFileSync(abs, "utf8"))

const enumerateAll = (): CallSite[] => {
  const out: CallSite[] = []
  for (const abs of listSourceTsFiles(SRC_ROOT)) {
    out.push(...enumerateFile(abs))
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("runAgent call-site authority fence (INV-03 / G8)", () => {
  const sites = enumerateAll()
  const filesWithSites = new Set(sites.map((s) => s.repoRel))

  test("AST enumeration is live (found real call sites)", () => {
    // Non-vacuity floor: if the scan finds nothing, the gate is blind. There
    // must be at least the known descendant + several host entries.
    expect(sites.length).toBeGreaterThanOrEqual(10)
    // The known authority-gated descendant forks MUST be present, or the fence
    // has gone blind on the very vectors it exists to defend.
    for (const gated of AUTHORITY_GATED_FLOOR) {
      expect(filesWithSites.has(gated)).toBe(true)
    }
  })

  test("every enumerated production runAgent call site is in the reviewed allowlist", () => {
    const unclassified = [...filesWithSites].filter((f) => !ALLOWLIST_PATHS.has(f)).sort()
    if (unclassified.length > 0) {
      const detail = unclassified
        .map((f) => {
          const first = sites.find((s) => s.repoRel === f)
          return `  - ${f}${first ? `:${first.line}` : ""}`
        })
        .join("\n")
      throw new Error(
        `NEW runAgent call site is not classified — it may bypass the spawn-depth authority; ` +
          `add it to the reviewed allowlist and confirm it is authority-gated.\n\n${detail}\n\n` +
          `Each new call site MUST be reviewed: is it a top-level (root/host/eval) run, or a ` +
          `DESCENDANT fork that must route childDepthOf/effectiveCap/canAdmitChildDepth (like ` +
          `subagent-runner.ts / branch-search-runner.ts)?`,
      )
    }
    expect(unclassified).toEqual([])
  })

  test("allowlist has no stale entries (every allowlisted file still has a call site)", () => {
    const stale = ALLOWLIST.map((a) => a.path)
      .filter((p) => !filesWithSites.has(p))
      .sort()
    if (stale.length > 0) {
      throw new Error(
        `Stale runAgent allowlist entries (no live call site — remove from the allowlist):\n` +
          stale.map((p) => `  - ${p}`).join("\n"),
      )
    }
    expect(stale).toEqual([])
  })

  test("every allowlist file resolves to a real, readable source file", () => {
    for (const a of ALLOWLIST) {
      const abs = join(REPO_ROOT, a.path)
      expect(statSync(abs).isFile()).toBe(true)
    }
  })

  test("descendant-authority-gated files route the spawn-depth reject (SSOT tokens present)", () => {
    // Cross-check: a file we CLASSIFIED as descendant-authority-gated must
    // actually reference the authority SSOT (childDepthOf / effectiveCap /
    // canAdmitChildDepth) — so the classification cannot lie. This is the
    // "confirm it is authority-gated" half of the review, made executable.
    const gated = ALLOWLIST.filter((a) => a.kind === "descendant-authority-gated")
    expect(gated.length).toBeGreaterThanOrEqual(2)
    for (const a of gated) {
      const src = readFileSync(join(REPO_ROOT, a.path), "utf8")
      const routesAuthority =
        // Direct authority-math reference…
        /\bchildDepthOf\b|\beffectiveCap\b|\bcanAdmitChildDepth\b/.test(src) ||
        // …or delegation to the SSOT runner reject (subagent-runner IS the SSOT;
        // it enforces `req.depth > maxDepth ⇒ deny` inline).
        /req\.depth\s*>\s*maxDepth|max subagent depth exceeded/.test(src)
      expect(routesAuthority).toBe(true)
    }
  })

  // ── NON-VACUITY: the AST engine is exercised on CONTROLLED synthetic sources,
  //    so the alias / inject-ref discrimination is asserted DIRECTLY (not merely
  //    inferred from which real files happen to be allowlisted). Each assertion
  //    goes RED under a plausible mutation of enumerateSource/localRunAgentNames.
  const formsAt = (repoRel: string, src: string): Set<CallSite["form"]> =>
    new Set(enumerateSource(repoRel, src).map((s) => s.form))

  test("catches a DIRECT call through the real binding name", () => {
    // Floor: the simplest form must be seen. RED if the CallExpression callee
    // branch (names.has(node.expression.text)) is removed.
    const sites = enumerateSource("src/x.ts", `import { runAgent } from "@/agent"\nrunAgent(cfg)\n`)
    expect(sites.some((s) => s.form === "call")).toBe(true)
  })

  test("catches an ALIASED import call (`runAgent as fork`) — grep-proof", () => {
    // The whole reason this is AST, not grep: `fork(cfg)` shows no `runAgent(`
    // token. RED if localRunAgentNames stops resolving `el.propertyName` (the
    // ORIGINAL export name) — the alias would then be missed entirely.
    const forms = formsAt(
      "src/x.ts",
      `import { runAgent as fork } from "@/agent"\nfork(childCfg)\n`,
    )
    expect(forms.has("call")).toBe(true)
  })

  test("catches an INJECT value-ref (`deps.runAgent ?? runAgent`)", () => {
    // The inject pattern is an equally real fork surface. RED if the value-ref
    // branch is dropped, or if `?? runAgent` is misclassified as a callee.
    const forms = formsAt(
      "src/x.ts",
      `import { runAgent } from "@/agent"\nconst run = deps.runAgent ?? runAgent\nrun(cfg)\n`,
    )
    expect(forms.has("value-ref")).toBe(true)
  })

  test("catches an ALIASED inject value-ref (`?? defaultRunAgent` from `runAgent as defaultRunAgent`)", () => {
    // Mirrors agent-config-assembler.ts EXACTLY: aliased import used only as a
    // `??` fallback value (never called locally). RED if alias resolution OR the
    // value-ref branch is broken — this form has NEITHER `runAgent(` NOR the
    // original name as a call.
    const forms = formsAt(
      "src/x.ts",
      `import { runAgent as defaultRunAgent } from "@/agent"\n` +
        `const pick = (seams) => seams?.runAgent ?? defaultRunAgent\n`,
    )
    expect(forms.has("value-ref")).toBe(true)
    expect(forms.has("call")).toBe(false)
  })

  test("IGNORES a type-only import (`import type { runAgent }`) — a type cannot fork", () => {
    // Anti-false-positive: a pure type import must NOT enter the enumeration.
    // RED if the `clause.isTypeOnly` skip is removed (the gate would then flag
    // every type-only consumer as a spawn surface).
    const sites = enumerateSource(
      "src/x.ts",
      `import type { runAgent } from "@/agent"\nlet r: typeof runAgent\n`,
    )
    expect(sites).toEqual([])
  })

  test("IGNORES a same-named local that is NOT the imported entrypoint", () => {
    // Binding resolution proof: `runAgent` here is a LOCAL function, imported
    // from nothing on the re-export list. RED if the engine matched on the bare
    // token instead of the resolved import binding (localRunAgentNames).
    const sites = enumerateSource("src/x.ts", `function runAgent(x) { return x }\nrunAgent(1)\n`)
    expect(sites).toEqual([])
  })

  test("IGNORES an import from an UNRELATED specifier (not a runAgent re-export)", () => {
    // Only the vetted re-export specifiers resolve to the fork entrypoint. RED if
    // RUNAGENT_EXPORT_SPECIFIERS membership check is dropped (any `runAgent`
    // import from anywhere would then be treated as the loop entrypoint).
    const sites = enumerateSource(
      "src/x.ts",
      `import { runAgent } from "@/some-other-lib"\nrunAgent(cfg)\n`,
    )
    expect(sites).toEqual([])
  })

  test("every allowlisted kind is a known classification", () => {
    const KNOWN: ReadonlySet<Kind> = new Set([
      "root-entry",
      "descendant-authority-gated",
      "host-eval-entry",
      "runner-orchestration",
    ])
    for (const a of ALLOWLIST) {
      expect(KNOWN.has(a.kind)).toBe(true)
    }
  })
})
