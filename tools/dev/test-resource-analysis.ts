/**
 * WHAT A TEST FILE CAN REACH — the module closure behind its claims.
 *
 * # Why a closure and not the file's own source
 *
 * The first-match classifier read one file. That is exactly the hole TVH-04
 * names: a `main()` that opens a daemon port, a fixture helper that spawns a
 * child, a harness that rewrites `process.env` — none of them appear in the
 * test file that calls them, so every such file scored `pure`, or landed in
 * the path-only `integration-path` bucket with no idea what it owned.
 *
 * This walks the import graph from a test file through every module it can
 * reach inside the repository, unions the claims of each, and refuses to
 * certify when it meets something it cannot read.
 *
 * # The three ways a walk fails closed
 *
 *  - a specifier that resolves to no file (`unresolved`)
 *  - a computed `import(expr)` / `require(expr)` / `eval` — the claim detector
 *    in `test-resource-claims.ts` contributes `unknown` for these, so they
 *    arrive as a claim rather than as a special case here
 *  - an external package that is not in `EXTERNAL_MODULE_EFFECTS`
 *
 * The external table is an ALLOWLIST, which is what makes the last one
 * self-maintaining: a new dependency anywhere in the closure of a certified
 * test flips that test to `unknown` until somebody says what it owns. Measured
 * on this tree, the whole integration-path corpus reaches 41 distinct external
 * specifiers, so the table is a reviewable object rather than an aspiration.
 *
 * # Why a fixpoint and not a recursive walk
 *
 * The repository's module graph has cycles. A recursive walk must either cache
 * a frame that was cut short by a cycle — publishing an UNDER-approximation,
 * the one direction that corrupts a peer — or refuse to cache inside every
 * cycle and pay for it exponentially. Claims form a join-semilattice, so the
 * least fixpoint of `claims[m] = own[m] ∪ ⋃ claims[successors]` is both exact
 * and cheap: measured 2,428 modules to a stable point in a handful of rounds.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"

import {
  mergeResourceClaims,
  pathOnlyResourceClass,
  type ResourceClaim,
  resourceEvidenceFor,
  type TestResourceClass,
} from "./test-resource-claims"

/**
 * The analyzer's own version. A certified row records the version that
 * produced it, so a claim set can never be read as if a later, different
 * analyzer had vouched for it.
 */
export const RESOURCE_ANALYZER_VERSION = "quanta.test-resource-analysis.v1"

const UNKNOWN: readonly ResourceClaim[] = [{ key: "unknown", mode: "exclusive" }]

/**
 * What an external specifier owns, in HOST-shared terms.
 *
 * `[]` does not mean "harmless" — it means "owns nothing another test PROCESS
 * can observe". An outbound HTTP client (`openai`, the Anthropic SDKs) opens
 * client sockets, which collide with nobody; a listening server does, and
 * `node:net`/`node:http`/`node:tls` can do either, so they claim the port
 * space. `node:fs` carries no blanket claim because a temp-dir write collides
 * with nobody either — the call-site detectors are what recognise a write
 * aimed at the checkout. Anything absent from this table is `unknown`.
 */
export const EXTERNAL_MODULE_EFFECTS: Readonly<Record<string, readonly ResourceClaim[]>> = {
  // ── test harness ──
  "bun:test": [],
  bun: [],
  // ── pure computation / in-process ──
  "node:path": [],
  "node:url": [],
  "node:crypto": [],
  "node:util": [],
  "node:assert": [],
  "node:buffer": [],
  "node:events": [],
  "node:stream": [],
  "node:stream/promises": [],
  "node:string_decoder": [],
  "node:querystring": [],
  "node:zlib": [],
  "node:async_hooks": [],
  "node:timers": [],
  "node:timers/promises": [],
  "node:module": [],
  "node:worker_threads": [],
  zod: [],
  "is-path-inside": [],
  turndown: [],
  typescript: [],
  "quickjs-emscripten": [],
  "web-tree-sitter": [],
  // ── host inspection: reads, never writes ──
  "node:os": [],
  "node:process": [],
  "node:tty": [],
  "node:readline": [],
  "node:readline/promises": [],
  // ── filesystem / local storage ──
  "node:fs": [],
  "node:fs/promises": [],
  fs: [],
  "write-file-atomic": [],
  "bun:sqlite": [],
  // ── outbound network: client sockets only ──
  "node:dns": [],
  "node:dns/promises": [],
  openai: [],
  "@anthropic-ai/sdk": [],
  "@anthropic-ai/bedrock-sdk": [],
  "@anthropic-ai/vertex-sdk": [],
  "@anthropic-ai/foundry-sdk": [],
  // Resolved by constant folding from `MANTLE_SDK_PACKAGE`; an outbound LLM
  // SDK that is not installed on this tree, so the import always rejects.
  "@anthropic-ai/mantle-sdk": [],
  // ── pure libraries reached from the production graph ──
  yaml: [],
  "csv-parse/sync": [],
  "react-dom/server": [],
  // An API surface only: `@opentelemetry/api` is a no-op until an SDK
  // registers a provider, and the SDK/exporter packages are not in this graph.
  "@opentelemetry/api": [],
  // In-process scanning over strings the caller supplies.
  "@secretlint/core": [],
  "@secretlint/secretlint-rule-preset-recommend": [],
  // Optional platform natives, both loaded behind a `process.platform` guard
  // this host never takes. Each applies a PROCESS-LOCAL OS sandbox policy
  // (landlock / a helper-exe shim) to its own worker; nothing a peer test
  // process can observe, which is why the claim is empty rather than absent.
  "@quanta/linux-sandbox-native": [],
  "@quanta/windows-sandbox-native": [],
  "@quanta/darwin-vz-helper": [{ key: "child-process", mode: "shared" }],
  // ── resource owners ──
  ws: [{ key: "port:ephemeral", mode: "exclusive" }],
  "node:net": [{ key: "port:ephemeral", mode: "exclusive" }],
  "node:http": [{ key: "port:ephemeral", mode: "exclusive" }],
  "node:https": [{ key: "port:ephemeral", mode: "exclusive" }],
  "node:http2": [{ key: "port:ephemeral", mode: "exclusive" }],
  "node:tls": [{ key: "port:ephemeral", mode: "exclusive" }],
  "node:dgram": [{ key: "port:ephemeral", mode: "exclusive" }],
  "node:cluster": [{ key: "child-process", mode: "shared" }],
  "node:child_process": [{ key: "child-process", mode: "shared" }],
}

/**
 * Per-module narrowings of the external table, each with an owner and a
 * reason. A row says: "in THIS module, and only here, that specifier is used
 * for exactly this, and it owns exactly that."
 *
 * This exists so a package that CAN do anything does not have to be declared
 * globally harmless to be usable. `bun:ffi` is the case that forced it: it is
 * arbitrary native code, so the global table must call it `unknown` — and that
 * one entry made 522 of the 562 integration-path files unanalyzable, because
 * `@/shared` re-exports a flock primitive that almost everything reaches.
 */
export const MODULE_EXTERNAL_DECLARATIONS: Readonly<
  Record<
    string,
    {
      readonly owner: string
      readonly reason: string
      readonly externals: Readonly<Record<string, readonly ResourceClaim[]>>
    }
  >
> = {
  "src/shared/posix-flock.ts": {
    owner: "verification",
    reason:
      "dlopen is bounded to one libc symbol, flock(2), and the file it locks is the CALLER's " +
      "path argument — the module owns no fixed resource, so the claim belongs to the call " +
      "site, where the QUANTA_HOME / checkout detectors already see it.",
    externals: { "bun:ffi": [] },
  },
}

/** `.wasm`/asset imports carry no code we could analyse and run none. */
const ASSET_SPECIFIER = /\.(?:wasm|json|txt|md|css|svg|png)$/u

/**
 * Import specifiers, excluding TYPE-only statements.
 *
 * `import type X from "…"` and `export type { X } from "…"` are erased before
 * anything runs, so following them would attribute a module's effects to a
 * file that never loads it. Value imports with inline `type` specifiers
 * (`import { type A, b } from`) still load the module and ARE followed.
 *
 * # Two measured defects this shape exists to avoid
 *
 * A single-line `import … from "x"` pattern MISSES every multi-line import
 * statement, which is most of them after formatting — and a missed edge is an
 * under-approximation, the one direction that lets a hazard through. So the
 * `from` clause is matched on its own and the statement keyword is recovered
 * by looking back.
 *
 * A bare `import "x"` pattern that does not require a statement boundary
 * matched `command script import "${lookup}"` — an LLDB command inside a
 * template literal in `src/tool/evidence/runtime.ts`. That one false edge
 * resolved to a package named `${lookup}`, which the external table does not
 * declare, so 280 of the 562 integration-path files were reported unanalyzable
 * because of a string in a debugger adapter.
 */
/** `import` / `export` at a statement boundary — not the word in prose. */
const STATEMENT_KEYWORD = /(?:^|[\n;}])[ \t]*(?:import|export)\b/g
const DYNAMIC_LITERAL = /\b(?:import|require)\s*\(\s*["']([^"'\n]+)["']\s*\)/g
/** `import(`./mode-presets/${mode}`)` — the static prefix is the directory. */
const DYNAMIC_TEMPLATE_PREFIX = /\b(?:import|require)\s*\(\s*`([^`$]*)\/\$\{/g
/** Longest import statement this will read before giving up on it. */
const STATEMENT_WINDOW = 1_000
const TYPE_ONLY = /^[ \t]+type[ \t]/u
const BARE_SPECIFIER = /^[ \t]*["']([^"'\n]+)["']/u
/**
 * `… from "spec"`, where everything between the keyword and `from` is an
 * import CLAUSE — identifiers, braces, commas, `*`, whitespace.
 *
 * A POSITIVE class, not an exclusion, and that distinction was measured twice.
 * Matching a bare `from "…"` anywhere read ordinary strings as specifiers and
 * reported 523 of 562 files as importing packages called `absent` or `the
 * client is spraying`. Excluding only quotes and `;` still let
 * `src/agent/prompt-body.ts` through: an `export const … = [ …spreads… ]`
 * whose body holds no quote at all, followed by a doc comment reading
 * `Everything from "Honesty rail"` — 265 files unanalyzable because of a
 * sentence. Nothing in a real import clause needs `/`, `=`, `(` or `[`.
 */
const FROM_CLAUSE = /^[A-Za-z0-9_$ \t\r\n,{}*]*?\bfrom[ \t]*["']([^"'\n]+)["']/u

/** Every specifier a module loads at runtime, deduplicated, in source order. */
export const importSpecifiers = (source: string): readonly string[] => {
  const specifiers = new Set<string>()
  for (const match of source.matchAll(STATEMENT_KEYWORD)) {
    if (match.index === undefined) continue
    const rest = source.slice(match.index + match[0].length, match.index + STATEMENT_WINDOW)
    // `import type X from "y"` is erased before anything runs; following it
    // would attribute a module's effects to a file that never loads it.
    if (TYPE_ONLY.test(rest)) continue
    const bare = BARE_SPECIFIER.exec(rest)?.[1]
    if (bare !== undefined) {
      specifiers.add(bare)
      continue
    }
    const from = FROM_CLAUSE.exec(rest)?.[1]
    if (from !== undefined) specifiers.add(from)
  }
  for (const match of source.matchAll(DYNAMIC_LITERAL)) {
    if (match[1] !== undefined) specifiers.add(match[1])
  }
  return [...specifiers]
}

/**
 * Directories named by the static prefix of a template dynamic import.
 *
 * This repository already treats `import(`<prefix>/${expr}`)` as "every module
 * under <prefix> is reachable" in `tools/feature-catalog/reachability.ts`.
 * Using the same convention here is what keeps `src/apps/agent/index.ts`'s
 * `import(`./mode-presets/${mode}`)` from making every test that can reach the
 * agent entrypoint permanently unanalyzable: the three presets ARE readable,
 * so their claims are counted instead of being replaced by `unknown`.
 */
export const dynamicImportPrefixes = (source: string): readonly string[] => {
  const prefixes = new Set<string>()
  for (const match of source.matchAll(DYNAMIC_TEMPLATE_PREFIX)) {
    if (match[1] !== undefined && match[1] !== "") prefixes.add(match[1])
  }
  return [...prefixes]
}

const CANDIDATE_SUFFIXES = ["", ".ts", ".tsx", ".mts", ".js", "/index.ts", "/index.tsx"] as const

const existingFile = (candidate: string): string | undefined => {
  for (const suffix of CANDIDATE_SUFFIXES) {
    const path = `${candidate}${suffix}`
    try {
      if (existsSync(path) && statSync(path).isFile()) return path
    } catch {
      // A racing delete between existsSync and statSync is indistinguishable
      // from "not a file"; both mean "do not follow this edge".
    }
  }
  return undefined
}

export type ModuleResolution =
  | { readonly kind: "module"; readonly path: string }
  | { readonly kind: "external"; readonly specifier: string }
  | { readonly kind: "unresolved"; readonly specifier: string }

export interface AliasTable {
  readonly repoRoot: string
  readonly aliases: readonly (readonly [string, string])[]
}

export const loadPathAliases = (repoRoot: string): AliasTable => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(repoRoot, "tsconfig.base.json"), "utf8"))
    const paths = (parsed as { compilerOptions?: { paths?: Record<string, string[]> } })
      .compilerOptions?.paths
    if (paths === undefined) return { repoRoot, aliases: [] }
    const aliases = Object.entries(paths)
      .map(([pattern, targets]) => [pattern, targets[0] ?? ""] as const)
      .filter(([, target]) => target !== "")
      // Longest pattern first so `@/shared/x` never resolves through `@/*`.
      .sort(([left], [right]) => right.length - left.length)
    return { repoRoot, aliases }
  } catch {
    return { repoRoot, aliases: [] }
  }
}

const resolved = (path: string | undefined, specifier: string): ModuleResolution =>
  path === undefined ? { kind: "unresolved", specifier } : { kind: "module", path }

/** The alias whose pattern matches, longest first, or undefined. */
const aliasTarget = (specifier: string, table: AliasTable): string | undefined => {
  for (const [pattern, target] of table.aliases) {
    if (pattern === specifier) return resolve(table.repoRoot, target)
    if (!pattern.endsWith("/*")) continue
    const prefix = pattern.slice(0, -1)
    if (!specifier.startsWith(prefix)) continue
    return resolve(table.repoRoot, `${target.slice(0, -1)}${specifier.slice(prefix.length)}`)
  }
  return undefined
}

export const resolveModuleSpecifier = (
  specifier: string,
  fromFile: string,
  table: AliasTable,
): ModuleResolution => {
  if (ASSET_SPECIFIER.test(specifier)) return { kind: "external", specifier }
  if (specifier.startsWith(".")) {
    return resolved(existingFile(resolve(dirname(fromFile), specifier)), specifier)
  }
  const aliased = aliasTarget(specifier, table)
  if (aliased !== undefined) return resolved(existingFile(aliased), specifier)
  // `tsconfig.base.json` lists one alias per top-level source directory rather
  // than a single `@/*`, so specifiers that escape a listed directory —
  // `@/../src/apps/agent/index`, 15 of them on this tree — matched no pattern
  // and were reported as an undeclared npm package. They are repository paths;
  // resolve them as such rather than failing 15 files closed for a gap in an
  // alias table.
  if (specifier.startsWith("@/")) {
    return resolved(existingFile(resolve(table.repoRoot, "src", specifier.slice(2))), specifier)
  }
  return { kind: "external", specifier }
}

interface GraphNode {
  /** Claims from this module's own source, plus its external imports. */
  readonly local: readonly ResourceClaim[]
  readonly edges: readonly string[]
  readonly externals: readonly string[]
  readonly unanalyzable: readonly string[]
}

export interface ModuleClosure {
  /** Every claim reachable from this module, its own source included. */
  readonly claims: readonly ResourceClaim[]
  /** How many repository modules the walk reached, this one included. */
  readonly moduleCount: number
  /** Unlisted externals and specifiers that resolved to nothing. */
  readonly unanalyzable: readonly string[]
  readonly externals: readonly string[]
}

/** Every readable module directly under a template import's static prefix. */
const modulesUnderPrefix = (
  prefix: string,
  fromFile: string,
  table: AliasTable,
): readonly string[] => {
  const directory = prefix.startsWith(".")
    ? resolve(dirname(fromFile), prefix)
    : prefix.startsWith("@/")
      ? resolve(table.repoRoot, "src", prefix.slice(2))
      : undefined
  if (directory === undefined) return []
  try {
    return readdirSync(directory)
      .filter((entry) => /\.(?:ts|tsx|mts|js)$/u.test(entry))
      .map((entry) => join(directory, entry))
      .filter((candidate) => {
        try {
          return statSync(candidate).isFile()
        } catch {
          return false
        }
      })
      .sort()
  } catch {
    return []
  }
}

/**
 * Replace `import(IDENT)` with `import("literal")` where IDENT is a string
 * constant declared in the same module.
 *
 * Not a nicety: `src/llm/providers/mantle-adapter.ts` holds its specifier in a
 * variable ON PURPOSE (the comment there says so — it keeps a bundler from
 * resolving a package that is not installed), and that single call site made
 * 276 of the 562 integration-path files unanalyzable. Constant folding is a
 * SOUND reading of that code, where declaring the module harmless by hand
 * would have been a rubber stamp.
 *
 * One alias hop is followed (`const specifier = MANTLE_SDK_PACKAGE`), bounded
 * so a cycle of aliases cannot spin.
 */
export const foldConstantSpecifiers = (source: string): string => {
  const literals = new Map<string, string>()
  const aliases = new Map<string, string>()
  for (const match of source.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*["']([^"'\n]+)["']/g,
  )) {
    if (match[1] !== undefined && match[2] !== undefined) literals.set(match[1], match[2])
  }
  for (const match of source.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*(?:$|\n)/gm,
  )) {
    if (match[1] !== undefined && match[2] !== undefined) aliases.set(match[1], match[2])
  }
  const resolve = (name: string): string | undefined => {
    let cursor = name
    for (let hop = 0; hop < 5; hop += 1) {
      const literal = literals.get(cursor)
      if (literal !== undefined) return literal
      const alias = aliases.get(cursor)
      if (alias === undefined) return undefined
      cursor = alias
    }
    return undefined
  }
  return source.replace(
    /\b(import|require)\(\s*([A-Za-z_$][\w$]*)\s*\)/g,
    (whole, keyword: string, name: string) => {
      const literal = resolve(name)
      return literal === undefined ? whole : `${keyword}("${literal}")`
    },
  )
}

interface ModuleParse {
  readonly claimSets: (readonly ResourceClaim[])[]
  readonly edges: Set<string>
  readonly externals: Set<string>
  readonly unanalyzable: Set<string>
}

/** A template import's prefix: edges to the directory, or `unknown`. */
const addDynamicPrefixes = (
  parse: ModuleParse,
  source: string,
  path: string,
  table: AliasTable,
): void => {
  for (const prefix of dynamicImportPrefixes(source)) {
    const members = modulesUnderPrefix(prefix, path, table)
    if (members.length === 0) {
      // A template import whose prefix names nothing readable is exactly as
      // opaque as a fully computed one.
      parse.unanalyzable.add(`dynamic-prefix:${prefix}`)
      parse.claimSets.push(UNKNOWN)
      continue
    }
    for (const member of members) parse.edges.add(member)
  }
}

const addExternal = (
  parse: ModuleParse,
  specifier: string,
  declared: Readonly<Record<string, readonly ResourceClaim[]>>,
): void => {
  parse.externals.add(specifier)
  const effects = ASSET_SPECIFIER.test(specifier)
    ? []
    : (declared[specifier] ?? EXTERNAL_MODULE_EFFECTS[specifier])
  if (effects === undefined) {
    parse.unanalyzable.add(`undeclared-package:${specifier}`)
    parse.claimSets.push(UNKNOWN)
    return
  }
  parse.claimSets.push(effects)
}

const addImports = (
  parse: ModuleParse,
  source: string,
  path: string,
  table: AliasTable,
  declared: Readonly<Record<string, readonly ResourceClaim[]>>,
): void => {
  for (const specifier of importSpecifiers(source)) {
    const resolved = resolveModuleSpecifier(specifier, path, table)
    if (resolved.kind === "module") {
      parse.edges.add(resolved.path)
      continue
    }
    if (resolved.kind === "unresolved") {
      parse.unanalyzable.add(`unresolved:${specifier}`)
      parse.claimSets.push(UNKNOWN)
      continue
    }
    addExternal(parse, resolved.specifier, declared)
  }
}

const parseModule = (path: string, table: AliasTable): GraphNode => {
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    return { local: UNKNOWN, edges: [], externals: [], unanalyzable: [`unreadable:${path}`] }
  }
  const source = foldConstantSpecifiers(raw)
  const id = relative(table.repoRoot, path)
  const declared = MODULE_EXTERNAL_DECLARATIONS[id]?.externals ?? {}
  const own = resourceEvidenceFor(source).claims
  const parse: ModuleParse = {
    claimSets: [own],
    edges: new Set<string>(),
    externals: new Set<string>(),
    unanalyzable: new Set<string>(),
  }
  // An `unknown` from a DETECTOR (computed import, eval, new Function) is as
  // disqualifying as an undeclared package, and without this line it was the
  // only kind that carried no reason — 331 files were reported unanalyzable
  // with an empty explanation, which is indistinguishable from a bug in the
  // analyzer.
  if (own.some(({ key }) => key === "unknown")) parse.unanalyzable.add(`opaque-construct:${id}`)
  addDynamicPrefixes(parse, source, path, table)
  addImports(parse, source, path, table, declared)
  return {
    local: mergeResourceClaims(...parse.claimSets),
    edges: [...parse.edges],
    externals: [...parse.externals],
    unanalyzable: [...parse.unanalyzable],
  }
}

export interface ResourceAnalyzer {
  /**
   * Parse the graph reachable from these roots WITHOUT solving.
   *
   * Solving is O(graph) and every newly parsed module invalidates the previous
   * solution, so querying 562 roots one at a time re-solved a 2,400-module
   * graph 562 times (measured: >120s, versus ~2s when the roots are loaded
   * first). Batch loading is not an optimisation detail — it is the difference
   * between a gate check and a timeout.
   */
  preload(files: readonly string[]): void
  /** Claims reachable from `file`, computed over a cycle-exact fixpoint. */
  closureFor(file: string): ModuleClosure
  /** Repository modules parsed so far. */
  readonly moduleCount: number
}

/**
 * Claims that do NOT flow up an import edge.
 *
 * `host-cpu: exclusive` is the browser carve-out — "tolerates no peer at all"
 * — and it is calibrated on a file that actually drives Chrome, identified by
 * its OWN source (`REAL_CHROME`, `puppeteer`). Propagating it transitively
 * measured catastrophically: `src/browser/**` matches the browser detector on
 * its own adapter source, so every test that can REACH `@/browser` inherited
 * `host-cpu: exclusive` — 297 of 562 files, each of which would then have
 * refused to run beside even a `pure` chunk. Being able to reach a CDP adapter
 * is not the same as starting a browser, and the difference is the entire
 * parallelism budget.
 *
 * Every other key stays transitive: over-claiming `checkout` or `port` costs
 * overlap among claimants and leaves `pure` peers alone.
 */
const nonTransitive = (claims: readonly ResourceClaim[]): readonly ResourceClaim[] =>
  claims.filter(({ key }) => key !== "host-cpu")

interface SolvedNode {
  readonly claims: readonly ResourceClaim[]
  readonly unanalyzable: readonly string[]
}

type SolveState = Map<string, SolvedNode>

const predecessorMap = (nodes: ReadonlyMap<string, GraphNode>): Map<string, Set<string>> => {
  const predecessors = new Map<string, Set<string>>()
  for (const [id, node] of nodes) {
    for (const edge of node.edges) {
      const set = predecessors.get(edge) ?? new Set<string>()
      set.add(id)
      predecessors.set(edge, set)
    }
  }
  return predecessors
}

/** `local[m] ∪ ⋃ nonTransitive(claims[successors])`, plus the reason union. */
const joinWithSuccessors = (node: GraphNode, state: SolveState): SolvedNode => {
  const claimSets: (readonly ResourceClaim[])[] = [node.local]
  const unanalyzable = new Set(node.unanalyzable)
  for (const edge of node.edges) {
    const downstream = state.get(edge)
    if (downstream === undefined) continue
    claimSets.push(nonTransitive(downstream.claims))
    for (const reason of downstream.unanalyzable) unanalyzable.add(reason)
  }
  return { claims: mergeResourceClaims(...claimSets), unanalyzable: [...unanalyzable].sort() }
}

/**
 * Compares MODE as well as key.
 *
 * A `shared` claim that a successor raises to `exclusive` is a real change, and
 * a key-only comparison would declare the fixpoint reached while a strictness
 * increase was still propagating — i.e. publish an under-approximation.
 */
const sameSolvedNode = (left: SolvedNode, right: SolvedNode): boolean =>
  left.claims.length === right.claims.length &&
  left.unanalyzable.length === right.unanalyzable.length &&
  left.claims.every(
    (claim, index) =>
      claim.key === right.claims[index]?.key && claim.mode === right.claims[index]?.mode,
  )

/**
 * Least fixpoint of `claims[m] = local[m] ∪ ⋃ claims[successors]`.
 *
 * Worklist order does not matter for the RESULT — a join-semilattice has one
 * least fixpoint — only for how many rounds it takes.
 */
const solve = (nodes: ReadonlyMap<string, GraphNode>): SolveState => {
  const predecessors = predecessorMap(nodes)
  const state: SolveState = new Map(
    [...nodes].map(([id, node]) => [id, { claims: node.local, unanalyzable: node.unanalyzable }]),
  )
  const worklist = [...nodes.keys()]
  const queued = new Set(worklist)
  while (worklist.length > 0) {
    const id = worklist.pop() as string
    queued.delete(id)
    const node = nodes.get(id)
    const current = state.get(id)
    if (node === undefined || current === undefined) continue
    const next = joinWithSuccessors(node, state)
    if (sameSolvedNode(next, current)) continue
    state.set(id, next)
    for (const predecessor of predecessors.get(id) ?? []) {
      if (queued.has(predecessor)) continue
      queued.add(predecessor)
      worklist.push(predecessor)
    }
  }
  return state
}

const reachableCount = (root: string, nodes: ReadonlyMap<string, GraphNode>): number => {
  const seen = new Set<string>([root])
  const stack = [root]
  while (stack.length > 0) {
    const id = stack.pop() as string
    for (const edge of nodes.get(id)?.edges ?? []) {
      if (seen.has(edge)) continue
      seen.add(edge)
      stack.push(edge)
    }
  }
  return seen.size
}

export const createResourceAnalyzer = (repoRoot: string): ResourceAnalyzer => {
  const table = loadPathAliases(repoRoot)
  const nodes = new Map<string, GraphNode>()
  let solved: ReturnType<typeof solve> | undefined
  const load = (root: string): void => {
    const stack = [root]
    while (stack.length > 0) {
      const path = stack.pop() as string
      if (nodes.has(path)) continue
      const node = parseModule(path, table)
      nodes.set(path, node)
      solved = undefined
      for (const edge of node.edges) if (!nodes.has(edge)) stack.push(edge)
    }
  }
  return {
    preload(files) {
      for (const file of files) load(resolve(repoRoot, file))
    },
    closureFor(file) {
      const root = resolve(repoRoot, file)
      load(root)
      solved ??= solve(nodes)
      const result = solved.get(root)
      const node = nodes.get(root)
      return {
        claims: result?.claims ?? UNKNOWN,
        moduleCount: reachableCount(root, nodes),
        unanalyzable: result?.unanalyzable ?? [`unreadable:${relative(repoRoot, root)}`],
        externals: node?.externals ?? [],
      }
    },
    get moduleCount() {
      return nodes.size
    },
  }
}

export interface AnalyzedTestFile {
  readonly id: string
  readonly sourceSha256: string
  readonly resourceClass: TestResourceClass
  /** Claims from the test file's OWN source. */
  readonly ownClaims: readonly ResourceClaim[]
  /** Claims from the file plus everything it can reach. */
  readonly closureClaims: readonly ResourceClaim[]
  readonly moduleCount: number
  readonly unanalyzable: readonly string[]
}

/** Analyse a whole population with ONE fixpoint solve. */
export const analyzeTestFiles = (
  repoRoot: string,
  ids: readonly string[],
  analyzer: ResourceAnalyzer = createResourceAnalyzer(repoRoot),
): readonly AnalyzedTestFile[] => {
  analyzer.preload(ids)
  return ids.map((id) => analyzeTestFile(repoRoot, id, analyzer))
}

export const analyzeTestFile = (
  repoRoot: string,
  id: string,
  analyzer: ResourceAnalyzer,
): AnalyzedTestFile => {
  const absolute = resolve(repoRoot, id)
  const source = readFileSync(absolute, "utf8")
  const evidence = resourceEvidenceFor(source)
  const closure = analyzer.closureFor(absolute)
  return {
    id,
    sourceSha256: new Bun.CryptoHasher("sha256").update(source).digest("hex"),
    resourceClass: evidence.classSignal ?? pathOnlyResourceClass(id),
    ownClaims: evidence.claims,
    closureClaims: closure.claims,
    moduleCount: closure.moduleCount,
    unanalyzable: closure.unanalyzable,
  }
}
