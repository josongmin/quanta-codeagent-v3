/**
 * Static guard against module-init deadlocks in `src/agent/*.ts`.
 *
 * ## Background
 * `src/agent/` has known value-level import cycles, tolerated because the
 * cross-edge values are ONLY referenced at runtime — never evaluated at module
 * top-level. Referencing a cycle-partner's binding while the module body is
 * still running is an ESM circular-init TDZ crash / deadlock; this test seals
 * that invariant for every ring on {@link WHITELIST}.
 *
 * ## KNOWN SCOPE GAP — read before trusting a green run
 * The graph below is built over the FLAT `src/agent/*.ts` listing only:
 * {@link resolveRelTarget} maps any specifier containing a `/`
 * (`./loop/entry`, `./tier1/subagent`) to `null`, i.e. an external node that
 * can never close a ring. The historical
 * `{features, loop, subagent-runner, branch-search-runner}` SCC is therefore
 * NOT dissolved — it is INVISIBLE. The value ring is intact today:
 *
 *   subagent-runner.ts  --runAgent-->              loop.ts (14-line barrel)
 *   loop.ts             --re-export-->             loop/entry.ts
 *   loop/entry.ts       --createRunAgentContext--> loop/session-bootstrap.ts
 *   loop/session-bootstrap.ts --buildSessionFeatures--> features.ts
 *   features.ts         --createSubagentRunner-->  tier1/subagent.ts
 *   tier1/subagent.ts   --createSubagentRunner-->  subagent-runner.ts
 *
 * Every hop is a VALUE edge. Two barrel/subdirectory hops (`./loop/*`,
 * `./tier1/*`) are all that keep it out of this analysis, so assertions (a)
 * and (b) pass vacuously for that ring and assertion (c) never scans it.
 * Widening the walk to recurse into `src/agent/ ** / *.ts` is the real fix and
 * is deliberately NOT done here (it re-surfaces the ring and needs its own
 * reviewed whitelist entry) — but do not read a green run as "src/agent has
 * only the two whitelisted cycles".
 *
 * ## What this test enforces
 * - Build the value-import graph of `src/agent/*.ts` (TS-files only, not
 *   subdirectories — those don't form cycles with `loop.ts` today).
 * - Find every strongly-connected component of size ≥ 2 (Tarjan).
 * - Fail loudly when:
 *     (a) a SCC contains files NOT on the known whitelist, OR
 *     (b) the known whitelist contains files NOT in any found SCC (drift in
 *         the opposite direction — refactor removed the cycle but forgot to
 *         relax the guard), OR
 *     (c) any edge inside a whitelisted SCC's ring uses the imported symbol
 *         at module top-level (synchronous, outside a function body) — that
 *         IS the deadlock condition. Scanned with the TypeScript AST; see
 *         {@link findTopLevelUsage} for why a regex/brace-depth scanner was
 *         removed (it silently stopped scanning at the first `from`-less
 *         top-level `export` and was inert on all four whitelisted files).
 *
 * ## What counts as a "value edge"
 * - `import type { ... } from "./x"`         — IGNORED (type-only, erased).
 * - `import { type Foo } from "./x"`         — counted as value-edge
 *                                              (mixed; we're conservative).
 * - `import { foo } from "./x"`              — value-edge.
 * - `import foo from "./x"`                  — value-edge (default).
 * - `import "./x"`                           — value-edge (side-effect).
 * - `export { foo } from "./x"`              — value-edge (re-export).
 * - `export type { Foo } from "./x"`         — IGNORED.
 *
 * Subdirectory imports (`from "./branch-search"`, `from "./run-mode/..."`)
 * are tracked as separate "external" nodes that can never form a cycle with
 * the top-level files (they're directories, not files in this graph).
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import ts from "typescript"
import { assertScanPopulation } from "./_shared/scan-population"

const AGENT_DIR = join(import.meta.dir, "..", "..", "src", "agent")

/** Whitelisted SCCs: the known + reviewed value cycles. Sorted alphabetically
 *  for stable comparison; the SCC finder also sorts each component before
 *  emitting it.
 *
 *  Entry 1 — `steering ↔ conversation-action` ring. `conversation-action.ts`
 *    imports `steer` / `SteerInputInvalidError` for use inside `decideAction`;
 *    `steering.ts` re-exports the conversation-action surface as a one-stop
 *    barrel. Safe because every reference lives in a function body.
 *
 *  NOTE: the historical `{branch-search-runner, features, loop, subagent-
 *  runner}` SCC is absent from this list because the `features.ts → tier1/*`
 *  split and the `loop.ts → loop/entry.ts` barrel put every return edge behind
 *  a subdirectory hop, which this flat analysis treats as an external node.
 *  The ring itself still exists in the real module graph — see "KNOWN SCOPE
 *  GAP" in the file header. It is out of scope, not gone. */
const WHITELIST: ReadonlyArray<ReadonlyArray<string>> = [
  ["conversation-action.ts", "steering.ts"],
  // RFC04 MCP hot-reload: mcp-reload-source re-uses mcp-bridge's converters
  // (mcpToolToTool/tasksToolsFor/disambiguateMcpToolNames) so connect+reload
  // share one assembly. The edge is runtime-lazy (function-scoped imports; no
  // module-top-level call into the ring) — verified cycle-safe by the RFC04 wire.
  ["mcp-bridge.ts", "mcp-reload-source.ts"],
]

interface ImportLine {
  /** File the import resolves to (basename + .ts, relative to AGENT_DIR), or
   *  `null` when it targets a subdirectory or a non-existent file. Sub-dir /
   *  non-existent imports are ignored for cycle detection. */
  target: string | null
  /** Raw line number (1-based) for diagnostics. */
  line: number
  /** Whether this is a type-only edge (`import type { ... }` /
   *  `export type { ... }`). True ⇒ ignored for cycle detection. */
  typeOnly: boolean
  /** Symbols brought in as values (used to scan for module-top-level usage).
   *  Empty for side-effect-only and namespace imports. */
  valueNames: string[]
}

/** Parse the import/export lines of a `.ts` source. Single-line regex pass;
 *  multi-line imports are uncommon in this codebase but we still handle the
 *  trivial `\n`-joined form by collapsing whitespace within a candidate. */
const parseImports = (src: string, agentFiles: ReadonlySet<string>): ImportLine[] => {
  const out: ImportLine[] = []
  // Collapse multi-line `import { ... }` blocks into single logical lines by
  // joining continuation lines until a closing brace + `from "..."` is seen.
  // For this codebase a single-line regex over the original text plus a
  // multi-line fallback is sufficient.
  const rawLines = src.split(/\r?\n/)
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i] ?? ""
    if (!/^\s*(import|export)\b/.test(raw)) continue
    // Stitch a multi-line import together (read forward until we hit `from "..."` or `;`).
    let stitched = raw
    let j = i
    while (
      !/from\s+["'][^"']+["']\s*;?\s*$/.test(stitched) &&
      /\bfrom\b/.test(stitched) === false &&
      j < rawLines.length - 1
    ) {
      j++
      stitched += ` ${(rawLines[j] ?? "").trim()}`
    }
    // Side-effect import: `import "./x"` (no symbols, no `from`).
    const sideEffect = stitched.match(/^\s*import\s+["']([^"']+)["']/)
    if (sideEffect) {
      const target = resolveRelTarget(sideEffect[1] ?? "", agentFiles)
      out.push({ target, line: i + 1, typeOnly: false, valueNames: [] })
      continue
    }
    // `import [type] ... from "..."` or `export [type] {..} from "..."`.
    const m = stitched.match(/^\s*(import|export)\s+(type\s+)?(.+?)\s+from\s+["']([^"']+)["']/)
    if (!m) continue
    const isTypeOnly = (m[2] ?? "").trim() === "type"
    const symbolsBlob = m[3] ?? ""
    const spec = m[4] ?? ""
    const target = resolveRelTarget(spec, agentFiles)
    out.push({
      target,
      line: i + 1,
      typeOnly: isTypeOnly,
      valueNames: extractValueNames(symbolsBlob, isTypeOnly),
    })
  }
  return out
}

/** Resolve `./x` style specifiers to a file in `agentFiles`, or `null`. */
const resolveRelTarget = (spec: string, agentFiles: ReadonlySet<string>): string | null => {
  if (!spec.startsWith("./")) return null
  const tail = spec.slice(2)
  // Direct `.ts` neighbor?
  const direct = `${tail}.ts`
  if (agentFiles.has(direct)) return direct
  // Already includes the extension (rare in this codebase but harmless).
  if (agentFiles.has(tail)) return tail
  // Otherwise: subdirectory or `index` re-export — treat as external for the
  // purpose of cycle detection across the flat `src/agent/*.ts` graph.
  return null
}

/** Pull out the named value symbols from the brace blob (between `{` and `}`).
 *  Skip names individually marked `type` (mixed imports like
 *  `import { type Foo, bar }`). For `import X from "..."` (default), return
 *  `["default:X"]`. For `import * as ns from "..."`, return `["*:ns"]`.
 *  When the whole import is `type`-only, return `[]`. */
const extractValueNames = (blob: string, typeOnly: boolean): string[] => {
  if (typeOnly) return []
  const ns = blob.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/)
  if (ns) return [`*:${ns[1]}`]
  const brace = blob.match(/\{([^}]*)\}/)
  if (!brace) {
    // Pure default import: `import X from "..."` — `blob` is `X` (possibly
    // with leading whitespace).
    const def = blob.trim().match(/^([A-Za-z_$][\w$]*)$/)
    return def ? [`default:${def[1]}`] : []
  }
  const inside = brace[1] ?? ""
  const parts = inside
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
  const names: string[] = []
  // Default companion before the brace: `import X, { y } from "..."`.
  const beforeBrace = blob.slice(0, blob.indexOf("{")).trim().replace(/,$/, "").trim()
  const defM = beforeBrace.match(/^([A-Za-z_$][\w$]*)$/)
  if (defM) names.push(`default:${defM[1]}`)
  for (const p of parts) {
    if (/^type\s+/.test(p)) continue // erased
    // `foo as bar` ⇒ local binding is `bar`.
    const aliased = p.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/)
    if (aliased) {
      names.push(aliased[2] ?? "")
      continue
    }
    const plain = p.match(/^([A-Za-z_$][\w$]*)$/)
    if (plain) names.push(plain[1] ?? "")
  }
  return names.filter((n) => n.length > 0)
}

/** Enumerate `*.ts` files in `src/agent/` (top-level only). */
const listAgentFiles = (): string[] => {
  const all = readdirSync(AGENT_DIR)
  return all
    .filter((n) => n.endsWith(".ts"))
    .filter((n) => {
      try {
        return statSync(join(AGENT_DIR, n)).isFile()
      } catch {
        return false
      }
    })
    .sort()
}

/** Tarjan's SCC: returns SCCs of size ≥ 2 only (we don't care about
 *  self-loops here; none exist in TS imports anyway). Each SCC's nodes are
 *  sorted alphabetically for deterministic comparison. */
export const findSCCs = (nodes: string[], edges: Map<string, Set<string>>): string[][] => {
  let index = 0
  const idx = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const sccs: string[][] = []

  const strongconnect = (v: string): void => {
    idx.set(v, index)
    low.set(v, index)
    index++
    stack.push(v)
    onStack.add(v)
    for (const w of edges.get(v) ?? new Set<string>()) {
      if (!idx.has(w)) {
        strongconnect(w)
        low.set(v, Math.min(low.get(v) ?? 0, low.get(w) ?? 0))
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v) ?? 0, idx.get(w) ?? 0))
      }
    }
    if ((low.get(v) ?? 0) === (idx.get(v) ?? 0)) {
      const comp: string[] = []
      let w: string | undefined
      do {
        w = stack.pop()
        if (w === undefined) break
        onStack.delete(w)
        comp.push(w)
      } while (w !== v)
      if (comp.length >= 2) sccs.push(comp.sort())
    }
  }

  for (const v of nodes) if (!idx.has(v)) strongconnect(v)
  return sccs.sort((a, b) => a.join(",").localeCompare(b.join(",")))
}

/** Translate name decorations (`default:X` / `*:ns`) back to the local binding
 *  identifier visible in the source. */
export const toLocalName = (n: string): string => {
  if (n.startsWith("default:")) return n.slice("default:".length)
  if (n.startsWith("*:")) return n.slice("*:".length)
  return n
}

/** ── module-top-level usage scanner (TypeScript AST) ────────────────────────
 *
 *  For each `name` we must ensure it is NOT *evaluated* while the module body
 *  runs — that is the ESM circular-init TDZ deadlock condition. Anything that
 *  only runs later (a function/arrow/method body, an instance field
 *  initializer) is safe.
 *
 *  HISTORY — why this is an AST walk and not a regex/brace-depth heuristic.
 *  The previous implementation tracked an `inImport` latch that was set on
 *  ANY depth-0 line starting with `import` or `export`, and cleared only on a
 *  line carrying a quoted module specifier after `from`. A `from`-less
 *  top-level `export` (`export const f = (`, `export interface X {`,
 *  `export type T =`, `export { a, b }`) therefore latched the scanner ON for
 *  the ENTIRE REST OF THE FILE, so every statement after it was skipped and
 *  the assertion below was inert. Measured on the four whitelisted files the
 *  latch fired at conversation-action.ts:64, steering.ts:40, mcp-bridge.ts:80
 *  and mcp-reload-source.ts:43 — i.e. the guard scanned only the file preamble
 *  in every single case, and a planted `const __eager = mcpToolToTool` at the
 *  bottom of mcp-reload-source.ts was invisible.
 *
 *  The latch existed to stop symbol names on the continuation lines of a
 *  multi-line `import { … } from "…"` block from being reported. The AST gives
 *  that for free: import/export *declarations* are skipped as whole nodes, so
 *  multi-line imports stay correctly excluded without any cross-line state. */

/** Bodies that evaluate at CALL time, never at module init. */
const isLazyContainer = (n: ts.Node): boolean =>
  ts.isFunctionDeclaration(n) ||
  ts.isFunctionExpression(n) ||
  ts.isArrowFunction(n) ||
  ts.isMethodDeclaration(n) ||
  ts.isGetAccessorDeclaration(n) ||
  ts.isSetAccessorDeclaration(n) ||
  ts.isConstructorDeclaration(n) ||
  // Instance field initializers run at construction time, not module init.
  (ts.isPropertyDeclaration(n) &&
    !(n.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.StaticKeyword))

/** Declaration forms whose identifier mentions are BINDINGS or re-export
 *  specifiers — never a module-init evaluation. `export { foo }` (with or
 *  without a `from` clause) creates a live binding; it does not read `foo`. */
const isBindingOnly = (n: ts.Node): boolean =>
  ts.isImportDeclaration(n) ||
  ts.isImportEqualsDeclaration(n) ||
  ts.isExportDeclaration(n) ||
  ts.isTypeAliasDeclaration(n) ||
  ts.isInterfaceDeclaration(n) ||
  ts.isModuleDeclaration(n) ||
  ts.isTypeNode(n)

/** True when this identifier is a genuine value *reference*, not a property
 *  key, a member name, or the name half of a declaration.
 *
 *  Table-driven on the parent's slot rather than a per-kind `if` chain: every
 *  non-reference position is either a `propertyName` / `label` / qualified-name
 *  `right` slot, or the `name` slot of a declaration. The single `name`-slot
 *  exception is a shorthand property (`const o = { foo }`), which DOES read the
 *  binding at module init. */
const isReferencePosition = (id: ts.Identifier): boolean => {
  const p: ts.Node | undefined = id.parent
  if (!p) return true
  const slots = p as { name?: ts.Node; propertyName?: ts.Node; label?: ts.Node; right?: ts.Node }
  if (slots.propertyName === id || slots.label === id) return false
  if (ts.isQualifiedName(p) && slots.right === id) return false
  if (slots.name !== id) return true
  return ts.isShorthandPropertyAssignment(p)
}

export const findTopLevelUsage = (
  src: string,
  names: string[],
): { name: string; line: number }[] => {
  if (names.length === 0) return []
  const wanted = new Set(names.map(toLocalName).filter((n) => n.length > 0))
  if (wanted.size === 0) return []
  const sf = ts.createSourceFile(
    "scan.ts",
    src,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  )
  const hits: { name: string; line: number }[] = []
  const visit = (node: ts.Node): void => {
    if (isBindingOnly(node) || isLazyContainer(node)) return
    if (ts.isIdentifier(node) && wanted.has(node.text) && isReferencePosition(node)) {
      hits.push({
        name: node.text,
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      })
    }
    node.forEachChild(visit)
  }
  sf.forEachChild(visit)
  return hits
}

describe("agent module import cycles", () => {
  test("ANTI-VACUITY: the enumeration reaches the real `src/agent` top level", () => {
    // This guard reports "no cycles" identically whether the graph is acyclic or
    // whether `listAgentFiles()` returned nothing — and it HAS been inert before:
    // its third assertion once visited a set of lines fully disjoint from the
    // violating ones, 0 of 30. The scan is deliberately non-recursive, so the
    // floor is too: every `.ts` sitting directly in `src/agent/` must appear.
    assertScanPopulation(
      listAgentFiles().map((n) => join(AGENT_DIR, n)),
      AGENT_DIR,
      {
        id: "tests/unit/agent-import-cycle.test.ts#src-agent-toplevel",
        topLevelOnly: true,
        collectable: (n) => n.endsWith(".ts"),
      },
    )
  })

  const files = listAgentFiles()
  const fileSet = new Set<string>(files)
  // Build the parsed-imports table once.
  const parsed = new Map<string, ImportLine[]>()
  for (const f of files) {
    const src = readFileSync(join(AGENT_DIR, f), "utf8")
    parsed.set(f, parseImports(src, fileSet))
  }

  test("known cycles are exactly the whitelisted ones", () => {
    const edges = new Map<string, Set<string>>()
    for (const f of files) edges.set(f, new Set<string>())
    for (const [f, imps] of parsed) {
      const set = edges.get(f)
      if (!set) continue
      for (const imp of imps) {
        if (imp.typeOnly) continue
        if (imp.target === null) continue
        if (imp.target === f) continue
        set.add(imp.target)
      }
    }
    const sccs = findSCCs(files, edges)
    const sccKeys = sccs.map((s) => s.join(","))
    const whiteKeys = WHITELIST.map((w) => [...w].sort().join(","))

    // (a) no unknown SCC
    for (const k of sccKeys) {
      expect(
        whiteKeys,
        `unknown value-level import cycle detected: ${k}\n` +
          `If this is intentional and reviewed, add it to WHITELIST in ` +
          `tests/unit/agent-import-cycle.test.ts and ensure every edge in the ` +
          `ring stays runtime-lazy (no module-top-level calls into the cycle).`,
      ).toContain(k)
    }
    // (b) no stale whitelist entry
    for (const k of whiteKeys) {
      expect(
        sccKeys,
        `whitelisted cycle no longer present: ${k}\n` +
          `Refactor removed the cycle — drop the entry from WHITELIST.`,
      ).toContain(k)
    }
  })

  test("every edge inside a whitelisted cycle is runtime-lazy (no module-top usage)", () => {
    // For every value-import in a whitelisted SCC, verify the imported
    // symbols are not referenced at module top-level in the importing file.
    const inWhitelist = new Set<string>()
    for (const w of WHITELIST) for (const n of w) inWhitelist.add(n)
    for (const [f, imps] of parsed) {
      if (!inWhitelist.has(f)) continue
      const src = readFileSync(join(AGENT_DIR, f), "utf8")
      for (const imp of imps) {
        if (imp.typeOnly) continue
        if (imp.target === null) continue
        if (!inWhitelist.has(imp.target)) continue
        // This edge is INSIDE one of the rings — scan for top-level use.
        const hits = findTopLevelUsage(src, imp.valueNames)
        expect(
          hits,
          `${f}:${imp.line}: module-top-level use of symbol(s) from ` +
            `./${imp.target} would deadlock the known cycle.\n` +
            `Offending references: ${hits.map((h) => `${h.name}@L${h.line}`).join(", ")}.\n` +
            `Fix: only call/reference these symbols from inside a function body.`,
        ).toEqual([])
      }
    }
  })
})
