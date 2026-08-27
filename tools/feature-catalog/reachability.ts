/**
 * tools/feature-catalog/reachability.ts — file-level static reachability for `src/`.
 *
 * THE trustworthy answer to "is this feature actually wired?" that the
 * self-declared `fc judge` axes + grep heuristics could not give. Builds the
 * real import/re-export graph over `src/**\/*.ts` (resolving `@/` + relative
 * specifiers to actual files), then BFS from the production ENTRYPOINTS
 * (`src/apps/<surface>/index.ts`). A feature whose `evidence.code` files are
 * NOT in the transitive closure is genuinely unreachable — no `.js`-mirror
 * noise, no basename collisions, no barrel/test false-positives.
 *
 * # Why this is conservative-correct for overclaim detection
 *
 * Edges include BOTH `import` AND `export … from` (barrel) specifiers, so a
 * file re-exported by a reached barrel counts as reached. That makes the
 * "UNREACHABLE" verdict a STRONG signal (not even barrel-reachable) — safe to
 * act on (downgrade) without false-downgrading a wired feature. The inverse
 * blind spot (a file barrel-re-exported but whose symbols are never used reads
 * as reached) is covered by {@link computeSymbolReachability} below.
 *
 * Plane-clean: imports ONLY node built-ins (mirrors slice-graph tooling). Bun-
 * runnable: `bun tools/feature-catalog/reachability.ts [--unreached] [--check <file>] [--symbols]`.
 */

import { readdir, readFile, stat } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"

import { parseModuleExports } from "../shared/ts-exports"

const REPO_ROOT = resolve(import.meta.dir, "..", "..")
const SRC = join(REPO_ROOT, "src")

// `bun run <src/…>.ts` inside a package.json script — the LAUNCH form. Matches
// `bun run x.ts`, `bun --hot run x.ts`, and any env-prefixed variant
// (`FOO=1 bun run x.ts`). Deliberately does NOT match `bun build <file>` — a
// bundler input is not a process entrypoint, and treating it as one would mark
// a whole un-launched surface "reached" (the false-negative direction).
const PKG_RUN_SPEC_RE = /\bbun\s+(?:-{1,2}[\w-]+(?:=\S+)?\s+)*run\s+(src\/[\w./-]+\.ts)\b/g

/** Every `src/**.ts` that a package.json script actually LAUNCHES. Data-derived
 *  (no hand list): the repo's own script table is the SSOT for "what does this
 *  repo execute". This is what the `<surface>/index.ts` naming convention alone
 *  cannot see — e.g. `"bench": "bun run src/apps/bench/cli.ts"` is the real
 *  `bun run bench` entry (subcommand dispatcher for analyze / grade / terminal /
 *  pool), a sibling of `src/apps/bench/index.ts` rather than a module under it.
 *  Missing/malformed package.json ⇒ empty (falls back to index.ts discovery). */
const packageJsonEntrypoints = async (): Promise<string[]> => {
  let scripts: Record<string, unknown>
  try {
    const raw = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8")) as {
      scripts?: Record<string, unknown>
    }
    scripts = raw.scripts ?? {}
  } catch {
    return []
  }
  const out = new Set<string>()
  for (const cmd of Object.values(scripts)) {
    if (typeof cmd !== "string") continue
    PKG_RUN_SPEC_RE.lastIndex = 0
    let m = PKG_RUN_SPEC_RE.exec(cmd)
    while (m !== null) {
      out.add(m[1] as string)
      m = PKG_RUN_SPEC_RE.exec(cmd)
    }
  }
  const existing: string[] = []
  for (const p of out) {
    try {
      if ((await stat(join(REPO_ROOT, p))).isFile()) existing.push(p)
    } catch {
      /* script points at a deleted path — ignore */
    }
  }
  return existing
}

/** Production entrypoints — EVERY shipped surface's root module. Two
 *  data-derived sources, unioned (never a hand list):
 *    1. `src/apps/<surface>/index.ts` — the naming convention. This is what
 *       fixes the agent audit's false positives: apps/bench, apps/eval,
 *       apps/probe, apps/headless are ALL real surfaces and must seed.
 *    2. every `src/**.ts` a package.json script LAUNCHES (`bun run …`) — the
 *       convention's blind spot. `bun run bench` boots
 *       `src/apps/bench/cli.ts`, NOT `index.ts`, so without this source the
 *       whole bench subcommand tree (analyze / leaderboard / grade / terminal /
 *       remote / auth-pool, 70 files) reads as UNREACHABLE and every feature
 *       resting on it looks like a maturity overclaim when it is in fact live.
 *  A feature is "wired" iff reachable from at least one. */
const discoverEntrypoints = async (): Promise<string[]> => {
  const out = new Set<string>()
  let apps: string[] = []
  try {
    apps = await readdir(join(SRC, "apps"))
  } catch {
    /* no apps dir — package.json entries may still seed */
  }
  for (const app of apps) {
    const idx = join(SRC, "apps", app, "index.ts")
    try {
      if ((await stat(idx)).isFile()) out.add(relative(REPO_ROOT, idx))
    } catch {
      /* no index */
    }
  }
  for (const p of await packageJsonEntrypoints()) out.add(p)
  return [...out].sort()
}

const isSkipped = (name: string): boolean =>
  !name.endsWith(".ts") || name.endsWith(".d.ts") || name.endsWith(".test.ts")

const walk = async (dir: string): Promise<string[]> => {
  const out: string[] = []
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    const full = join(dir, name)
    let st: Awaited<ReturnType<typeof stat>>
    try {
      st = await stat(full)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue
      out.push(...(await walk(full)))
    } else if (st.isFile() && !isSkipped(name)) {
      out.push(full)
    }
  }
  return out
}

const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

// import … from "x" | import "x" | export … from "x" | import("x")
const SPEC_RE =
  /(?:import\s[\s\S]*?from\s+|export\s[\s\S]*?from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g

const specifiers = (src: string): string[] => {
  const out: string[] = []
  const s = stripComments(src)
  SPEC_RE.lastIndex = 0
  let m: RegExpExecArray | null = SPEC_RE.exec(s)
  while (m !== null) {
    if (m[1]) out.push(m[1])
    m = SPEC_RE.exec(s)
  }
  return out
}

// template dynamic import:  import(`<static-prefix>/${expr}`)  — the runtime
// target is data-dependent, so we conservatively treat EVERY module directly
// under <static-prefix>/ as reachable (e.g. `import(`./mode-presets/${mode}`)`
// in apps/agent/index.ts loads any mode-presets/<name>.ts). Without this the
// tool falsely marks dynamically-dispatched modules UNREACHABLE — the dangerous
// (false-positive overclaim) direction.
const TEMPLATE_SPEC_RE = /import\(\s*`([^`$]*)\/\$\{/g

/** Static prefixes of template dynamic imports (`import(`<prefix>/${x}`)`).
 *  Pure (no fs) so it is unit-testable in isolation — pins the R2 self-audit
 *  fix (literal-only specifier regex missed `./mode-presets/${mode}`). */
export const templatePrefixes = (raw: string): string[] => {
  const s = stripComments(raw)
  const out: string[] = []
  TEMPLATE_SPEC_RE.lastIndex = 0
  let m = TEMPLATE_SPEC_RE.exec(s)
  while (m !== null) {
    out.push(m[1] as string)
    m = TEMPLATE_SPEC_RE.exec(s)
  }
  return out
}

const templateImportTargets = async (raw: string, fromFile: string): Promise<string[]> => {
  const out: string[] = []
  for (const prefix of templatePrefixes(raw)) {
    let dir: string | null = null
    if (prefix.startsWith("@/")) dir = join(SRC, prefix.slice(2))
    else if (prefix.startsWith("./") || prefix.startsWith("../"))
      dir = resolve(dirname(fromFile), prefix)
    if (!dir) continue
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      continue
    }
    for (const name of names) {
      const full = join(dir, name)
      try {
        const st = await stat(full)
        if (st.isFile() && !isSkipped(name)) out.push(full)
        else if (st.isDirectory()) {
          const idx = join(full, "index.ts")
          if ((await stat(idx)).isFile()) out.push(idx)
        }
      } catch {
        /* skip */
      }
    }
  }
  return out
}

/** Resolve a specifier (from `fromFile`) to an absolute src .ts file, or null
 *  (node:/bare module, or unresolvable). Tries `<p>.ts` then `<p>/index.ts`. */
const resolveSpec = async (spec: string, fromFile: string): Promise<string | null> => {
  let base: string | null = null
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2))
  else if (spec.startsWith("./") || spec.startsWith("../")) base = resolve(dirname(fromFile), spec)
  else return null // node:, bun:, npm pkg
  const cands = base.endsWith(".ts") ? [base] : [`${base}.ts`, join(base, "index.ts")]
  for (const c of cands) {
    try {
      if ((await stat(c)).isFile()) return c
    } catch {
      /* next */
    }
  }
  return null
}

export interface ReachResult {
  readonly allFiles: ReadonlySet<string> // repo-relative
  readonly reached: ReadonlySet<string> // repo-relative
  readonly adj: ReadonlyMap<string, ReadonlyArray<string>>
}

export const computeReachability = async (): Promise<ReachResult> => {
  const files = await walk(SRC)
  const rel = (f: string): string => relative(REPO_ROOT, f)
  const adj = new Map<string, string[]>()
  for (const f of files) {
    const content = await readFile(f, "utf8").catch(() => "")
    const targets: string[] = []
    for (const spec of specifiers(content)) {
      const t = await resolveSpec(spec, f)
      if (t !== null) targets.push(rel(t))
    }
    for (const t of await templateImportTargets(content, f)) targets.push(rel(t))
    adj.set(rel(f), targets)
  }
  // BFS from auto-discovered entrypoints.
  const entrypoints = await discoverEntrypoints()
  const reached = new Set<string>()
  const q: string[] = []
  for (const e of entrypoints) {
    if (adj.has(e)) {
      reached.add(e)
      q.push(e)
    }
  }
  while (q.length > 0) {
    const cur = q.shift() as string
    for (const next of adj.get(cur) ?? []) {
      if (!reached.has(next)) {
        reached.add(next)
        q.push(next)
      }
    }
  }
  return { allFiles: new Set(adj.keys()), reached, adj }
}

// ---------------------------------------------------------------------------
// Symbol-level refinement — catches the module-reachability blind spot.
//
// A module re-exported by a reached barrel (`export * from "./x"`) IS executed
// under ESM (its top-level code + any self-registration side effects run), so
// module-reachability correctly marks it "wired". What that MISSES: a module
// that loads but whose exported API is never named-imported AND that registers
// nothing at load time — a genuinely dead public surface. We flag a file as
// "dead-API" iff: reached, no own export is ever named-imported (through full
// re-export-chain resolution), NOT used wholesale (namespace/side-effect/dynamic
// import), and has NO top-level side effect (self-registration). All three
// guards lean conservative — a missed guard under-flags (safe), never over-flags.
// ---------------------------------------------------------------------------

export interface ParsedSymbols {
  readonly ownExports: Set<string>
  readonly reexports: Array<{ exposed: string; srcName: string; spec: string }>
  readonly starSpecs: string[]
  readonly namedImports: Array<{ name: string; spec: string }>
  /** namespace / side-effect / dynamic / default imports → whole-module use */
  readonly wildcardSpecs: string[]
  readonly hasSideEffect: boolean
}

const SIDE_EFFECT_KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "function",
  "async",
  "export",
  "import",
  "const",
  "let",
  "var",
  "type",
  "interface",
  "class",
  "enum",
  "declare",
  "abstract",
  "namespace",
  "throw",
  "yield",
])

/**
 * Parse the symbol-level facts one module contributes to the graph.
 *
 * EXPORTS come from `tools/shared/ts-exports.ts` — the shared AST reader — and
 * are computed over the RAW source, because a parser handles comments, string
 * literals and regex literals correctly. The regex that used to live here did
 * not: it hallucinated `resolveBenchRunConfig` out of the regex literal
 * `/^export const resolveBenchRunConfig\b/` in
 * `src/apps/bench/promax/campaign/owner-audit.ts`, it could not see
 * `export function*` (no `\s` after `function`), and its block-comment strip
 * ran before its line-comment strip, so the `//` comment at
 * `src/apps/cli/internal.ts:718` containing `@/runner/assemble/*` opened a
 * 576-character phantom comment that hid the very next `export type { Tooling }`.
 *
 * IMPORTS and the side-effect probe are still text-level. The `ownExports` /
 * `reexports` split is preserved exactly — it is load-bearing for callers.
 */
export const parseSymbols = (raw: string): ParsedSymbols => {
  const s = stripComments(raw)
  const exported = parseModuleExports(raw)
  const ownExports = new Set<string>(exported.ownExports)
  const reexports: Array<{ exposed: string; srcName: string; spec: string }> = [
    ...exported.reexports,
  ]
  const starSpecs: string[] = [...exported.starSpecs]
  const namedImports: Array<{ name: string; spec: string }> = []
  // `export * as ns from "spec"` exposes `ns` (already in ownExports) AND uses
  // the whole target module — same as it always did.
  const wildcardSpecs: string[] = [...exported.namespaceReexportSpecs]
  const exec = (re: RegExp, fn: (m: RegExpExecArray) => void): void => {
    re.lastIndex = 0
    let m = re.exec(s)
    while (m !== null) {
      fn(m)
      m = re.exec(s)
    }
  }
  // import { a, b as c } from "spec"  (record ORIGINAL name)
  exec(/import\s*(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g, (m) => {
    const spec = m[2] as string
    for (const piece of (m[1] as string).split(",")) {
      const t = piece.trim().replace(/^type\s+/, "") // trim FIRST — inline `{ type X }`
      if (!t) continue
      const name = (t.split(/\s+as\s+/)[0] as string).trim()
      if (name) namedImports.push({ name, spec })
    }
  })
  // import def from / import def, {…} from  → default export used (whole-module too)
  exec(
    /import\s+(?:type\s+)?([A-Za-z0-9_$]+)\s*(?:,\s*\{[^}]*\})?\s*from\s*["']([^"']+)["']/g,
    (m) => wildcardSpecs.push(m[2] as string),
  )
  // import * as ns from
  exec(/import\s*\*\s*as\s+[A-Za-z0-9_$]+\s*from\s*["']([^"']+)["']/g, (m) =>
    wildcardSpecs.push(m[1] as string),
  )
  // side-effect import "spec"  +  dynamic import("spec")
  exec(/import\s*\(\s*["']([^"']+)["']/g, (m) => wildcardSpecs.push(m[1] as string))
  exec(/(?:^|;)\s*import\s+["']([^"']+)["']/gm, (m) => wildcardSpecs.push(m[1] as string))
  // top-level side effect: a bare call / new at column 0 (proxy for self-registration)
  let hasSideEffect = false
  for (const line of s.split("\n")) {
    const head = /^([A-Za-z_$][\w$]*)/.exec(line)
    if (
      head &&
      /^[A-Za-z_$][\w$.]*\s*[(<]/.test(line) &&
      !SIDE_EFFECT_KEYWORDS.has(head[1] as string)
    ) {
      hasSideEffect = true
      break
    }
    if (/^(?:new\s|void\s|await\s|\(|;|\[)/.test(line)) {
      hasSideEffect = true
      break
    }
  }
  return { ownExports, reexports, starSpecs, namedImports, wildcardSpecs, hasSideEffect }
}

export interface SymbolReachResult {
  /** reached files whose exported API is never used + no load-time side effect */
  readonly deadApi: ReadonlySet<string>
  /** reached files whose API is named-imported / wildcard-used / self-registers */
  readonly apiLive: ReadonlySet<string>
}

export const computeSymbolReachability = async (): Promise<SymbolReachResult> => {
  const base = await computeReachability()
  const files = await walk(SRC)
  const rel = (f: string): string => relative(REPO_ROOT, f)
  const sym = new Map<string, ParsedSymbols>()
  // resolve each spec relative to its file → repo-rel target
  const resolved = new Map<string, Map<string, string>>() // file → spec → target
  for (const f of files) {
    const r = rel(f)
    const content = await readFile(f, "utf8").catch(() => "")
    const p = parseSymbols(content)
    sym.set(r, p)
    const rmap = new Map<string, string>()
    const allSpecs = [
      ...p.reexports.map((x) => x.spec),
      ...p.starSpecs,
      ...p.namedImports.map((x) => x.spec),
      ...p.wildcardSpecs,
    ]
    for (const spec of allSpecs) {
      if (rmap.has(spec)) continue
      const t = await resolveSpec(spec, f)
      if (t !== null) rmap.set(spec, rel(t))
    }
    resolved.set(r, rmap)
  }

  const used = new Set<string>() // `${file}::${name}`
  const wholeModule = new Set<string>()
  const addUse = (file: string, name: string, seen: Set<string>): void => {
    const key = `${file}::${name}`
    if (used.has(key)) return
    used.add(key)
    const p = sym.get(file)
    if (!p) return
    // re-export chain: this name might be sourced elsewhere
    for (const rx of p.reexports) {
      if (rx.exposed === name) {
        const tgt = resolved.get(file)?.get(rx.spec)
        if (tgt && !seen.has(`${tgt}:${rx.srcName}`)) {
          seen.add(`${tgt}:${rx.srcName}`)
          addUse(tgt, rx.srcName, seen)
        }
      }
    }
    // star re-exports: if not own-defined here, could come from any star source
    if (!p.ownExports.has(name)) {
      for (const spec of p.starSpecs) {
        const tgt = resolved.get(file)?.get(spec)
        if (tgt && !seen.has(`${tgt}:${name}`)) {
          seen.add(`${tgt}:${name}`)
          addUse(tgt, name, seen)
        }
      }
    }
  }
  const addWhole = (file: string, seen: Set<string>): void => {
    if (wholeModule.has(file) || seen.has(file)) return
    wholeModule.add(file)
    seen.add(file)
    const p = sym.get(file)
    if (!p) return
    for (const n of p.ownExports) used.add(`${file}::${n}`)
    for (const rx of p.reexports) {
      const tgt = resolved.get(file)?.get(rx.spec)
      if (tgt) addUse(tgt, rx.srcName, new Set())
    }
    for (const spec of [...p.starSpecs, ...p.wildcardSpecs]) {
      const tgt = resolved.get(file)?.get(spec)
      if (tgt) addWhole(tgt, seen)
    }
  }

  // Only REACHED modules execute → only their imports count as real usage.
  for (const f of base.reached) {
    const p = sym.get(f)
    const rmap = resolved.get(f)
    if (!p || !rmap) continue
    for (const ni of p.namedImports) {
      const tgt = rmap.get(ni.spec)
      if (tgt) addUse(tgt, ni.name, new Set())
    }
    for (const spec of p.wildcardSpecs) {
      const tgt = rmap.get(spec)
      if (tgt) addWhole(tgt, new Set())
    }
  }

  const deadApi = new Set<string>()
  const apiLive = new Set<string>()
  const entrypoints = new Set(await discoverEntrypoints())
  for (const f of base.reached) {
    const p = sym.get(f)
    if (!p) continue
    if (entrypoints.has(f) || p.hasSideEffect || wholeModule.has(f)) {
      apiLive.add(f)
      continue
    }
    const live = [...p.ownExports].some((n) => used.has(`${f}::${n}`))
    if (live || p.ownExports.size === 0) apiLive.add(f)
    else deadApi.add(f)
  }
  return { deadApi, apiLive }
}

const isDirect = (): boolean => {
  const meta = import.meta as unknown as { main?: boolean }
  return typeof meta.main === "boolean"
    ? meta.main
    : (process.argv[1]?.endsWith("reachability.ts") ?? false)
}

if (isDirect()) {
  computeReachability().then((r) => {
    const args = process.argv.slice(2)
    const out = (s: string): void => {
      process.stdout.write(`${s}\n`)
    }
    const checkIdx = args.indexOf("--check")
    if (args.includes("--symbols")) {
      computeSymbolReachability().then((sr) => {
        const dead = [...sr.deadApi].sort()
        for (const f of dead) out(f)
        out(
          `# ${dead.length} dead-API (reached but exports unused + no side-effect) / ${r.reached.size} reached`,
        )
      })
    } else if (checkIdx >= 0 && args[checkIdx + 1]) {
      const f = args[checkIdx + 1] as string
      out(`${f}: ${r.reached.has(f) ? "REACHED" : "UNREACHABLE"}`)
    } else if (args.includes("--unreached")) {
      const dead = [...r.allFiles].filter((f) => !r.reached.has(f)).sort()
      for (const f of dead) out(f)
      out(`# ${dead.length} unreachable / ${r.allFiles.size} files`)
    } else {
      out(
        `reachable ${r.reached.size} / ${r.allFiles.size} src files (${r.allFiles.size - r.reached.size} unreachable)`,
      )
    }
  })
}
