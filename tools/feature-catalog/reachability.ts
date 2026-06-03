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
 * act on (downgrade) without false-downgrading a wired feature. The known
 * residual blind spot is the inverse: a file barrel-re-exported but whose
 * symbols are never used will read as reached (false-negative for overclaim).
 * Catching that needs symbol-level resolution (a future increment); module
 * reachability is the SOTA baseline + the safe direction.
 *
 * Plane-clean: imports ONLY node built-ins (mirrors slice-graph tooling). Bun-
 * runnable: `bun tools/feature-catalog/reachability.ts [--unreached] [--check <file>]`.
 */

import { readdir, readFile, stat } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "..", "..")
const SRC = join(REPO_ROOT, "src")

/** Production entrypoints — EVERY shipped surface's root module, auto-
 *  discovered as `src/apps/<surface>/index.ts`. A feature is "wired" iff
 *  reachable from at least one. Auto-discovery (vs a hand list) is what fixes
 *  the agent audit's false positives — apps/bench, apps/eval, apps/probe,
 *  apps/headless are ALL real surfaces and must seed the closure. */
const discoverEntrypoints = async (): Promise<string[]> => {
  const out: string[] = []
  let apps: string[]
  try {
    apps = await readdir(join(SRC, "apps"))
  } catch {
    return out
  }
  for (const app of apps) {
    const idx = join(SRC, "apps", app, "index.ts")
    try {
      if ((await stat(idx)).isFile()) out.push(relative(REPO_ROOT, idx))
    } catch {
      /* no index */
    }
  }
  return out
}

const isSkipped = (name: string): boolean =>
  !name.endsWith(".ts") ||
  name.endsWith(".d.ts") ||
  name.endsWith(".test.ts") ||
  name.includes(".from-worktree") ||
  name.includes(".my-backup")

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
    if (checkIdx >= 0 && args[checkIdx + 1]) {
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
