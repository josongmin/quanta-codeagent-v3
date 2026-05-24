/**
 * tools/slice-graph/build-graph.ts — static import-graph builder for `src/`.
 *
 * Walks every `src/**\/*.ts` (excluding tests, `.d.ts`, mirror `.js`,
 * `.from-worktree.*`, `.my-backup.*`) and parses `import` / `export ... from`
 * statements via regex (no AST). Aggregates edges by SLICE NAME — the first
 * path segment of an `@/<slice>[/<subslice>...]` specifier. Relative imports
 * (`./...`, `../...`) collapse to the same slice as the importer and do NOT
 * contribute cross-slice edges.
 *
 * Plane-clean: this file imports ONLY `node:fs/promises` + `node:path`. It
 * does NOT import any `@/*` slice, satisfying its own architectural invariant
 * (the slice-graph tool sits OUTSIDE the slice layering — it observes, does
 * not participate). The validator + reporter live in sibling files and inherit
 * the same constraint.
 *
 * Output shape:
 *   - `slices`: every slice name observed as either source or destination.
 *   - `edges`: deduped + count-aggregated (file, line) pairs collapsed to
 *     `{ from, to, count }` per ordered slice pair.
 *   - `violations`: empty here — populated by `validate.ts`. Kept on the
 *     `SliceGraph` type so consumers see one shape end-to-end.
 *
 * Bun-runnable as a script: `bun tools/slice-graph/build-graph.ts` prints
 * the JSON graph to stdout (callers downstream can pipe to `jq`).
 */

import { readdir, readFile, stat } from "node:fs/promises"
import { join, relative, resolve } from "node:path"

export interface SliceGraphEdge {
  readonly from: string
  readonly to: string
  readonly count: number
}

export interface SliceGraphViolation {
  readonly file: string
  readonly from: string
  readonly to: string
  readonly reason: string
}

export interface SliceGraph {
  readonly slices: ReadonlyArray<string>
  readonly edges: ReadonlyArray<SliceGraphEdge>
  readonly violations: ReadonlyArray<SliceGraphViolation>
  /** Per-edge source files — useful for diagnostics + dot rendering hints.
   *  `spec` is the raw import specifier (e.g. `@/agent/loop`), preserved
   *  so downstream validators can match sub-slice rules without re-reading
   *  files. */
  readonly sources: ReadonlyArray<{
    readonly file: string
    readonly from: string
    readonly to: string
    readonly spec: string
  }>
}

const REPO_ROOT = resolve(import.meta.dir, "..", "..")
const DEFAULT_ROOT = join(REPO_ROOT, "src")

/** Skip-list for filenames we must not parse. Mirrors the
 *  `agent-slice-boundary.test.ts` exclusion set so the graph + the runtime
 *  guard see the same set of files. */
const isSkippedName = (name: string): boolean => {
  if (!name.endsWith(".ts")) return true
  if (name.endsWith(".d.ts")) return true
  if (name.includes(".from-worktree")) return true
  if (name.includes(".my-backup")) return true
  return false
}

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
      const sub = await walk(full)
      out.push(...sub)
    } else if (st.isFile() && !isSkippedName(name)) {
      out.push(full)
    }
  }
  return out
}

const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

const IMPORT_RE =
  /(?:^|\s)(?:import\s[\s\S]*?from\s+|import\s+|export\s[\s\S]*?from\s+)["']([^"']+)["']/g

const extractSpecifiers = (src: string): string[] => {
  const out: string[] = []
  const stripped = stripComments(src)
  IMPORT_RE.lastIndex = 0
  let m: RegExpExecArray | null
  m = IMPORT_RE.exec(stripped)
  while (m !== null) {
    if (typeof m[1] === "string") out.push(m[1])
    m = IMPORT_RE.exec(stripped)
  }
  return out
}

/** Compute the slice name of a source file via its path relative to `src/`.
 *  e.g. `src/agent/loop.ts` → `agent`. */
export const sliceOfFile = (file: string, root: string): string | null => {
  const rel = relative(root, file)
  if (rel.startsWith("..") || rel.length === 0) return null
  const seg = rel.split(/[\\/]/)
  const first = seg[0]
  return typeof first === "string" && first.length > 0 ? first : null
}

/** Compute the slice name of an import specifier. Returns `null` for
 *  relative imports (same-slice) and for bare-module imports (`node:fs`,
 *  `bun:test`, `zod`). */
export const sliceOfSpec = (spec: string): string | null => {
  if (spec.startsWith("@/")) {
    const rest = spec.slice(2)
    const seg = rest.split("/")
    const first = seg[0]
    return typeof first === "string" && first.length > 0 ? first : null
  }
  return null
}

export interface BuildGraphOpts {
  readonly roots?: ReadonlyArray<string>
}

interface GraphAcc {
  readonly sliceSet: Set<string>
  readonly edgeCounts: Map<string, { from: string; to: string; count: number }>
  readonly sources: { file: string; from: string; to: string; spec: string }[]
}

const recordSpec = (acc: GraphAcc, file: string, fromSlice: string, spec: string): void => {
  const toSlice = sliceOfSpec(spec)
  if (toSlice === null) return
  acc.sliceSet.add(toSlice)
  if (toSlice !== fromSlice) {
    const key = `${fromSlice}->${toSlice}`
    const prev = acc.edgeCounts.get(key)
    if (prev === undefined) {
      acc.edgeCounts.set(key, { from: fromSlice, to: toSlice, count: 1 })
    } else {
      prev.count += 1
    }
  }
  acc.sources.push({ file, from: fromSlice, to: toSlice, spec })
}

const processFile = async (acc: GraphAcc, file: string, absRoot: string): Promise<void> => {
  const fromSlice = sliceOfFile(file, absRoot)
  if (fromSlice === null) return
  acc.sliceSet.add(fromSlice)
  let content: string
  try {
    content = await readFile(file, "utf8")
  } catch {
    return
  }
  const specs = extractSpecifiers(content)
  for (const spec of specs) {
    recordSpec(acc, file, fromSlice, spec)
  }
}

export const buildSliceGraph = async (opts?: BuildGraphOpts): Promise<SliceGraph> => {
  const roots = opts?.roots && opts.roots.length > 0 ? opts.roots : [DEFAULT_ROOT]
  const acc: GraphAcc = {
    sliceSet: new Set<string>(),
    edgeCounts: new Map(),
    sources: [],
  }

  for (const root of roots) {
    const absRoot = resolve(root)
    const files = await walk(absRoot)
    for (const file of files) {
      await processFile(acc, file, absRoot)
    }
  }

  const edges: SliceGraphEdge[] = []
  for (const value of acc.edgeCounts.values()) {
    edges.push({ from: value.from, to: value.to, count: value.count })
  }
  edges.sort((a, b) =>
    a.from === b.from ? a.to.localeCompare(b.to) : a.from.localeCompare(b.from),
  )

  const slices = [...acc.sliceSet].sort()

  return {
    slices,
    edges,
    violations: [],
    sources: acc.sources,
  }
}

const isDirectInvocation = (): boolean => {
  // Bun sets `import.meta.main` true for the entry script.
  // Falling back: compare argv[1] to the file path.
  const meta = import.meta as unknown as { main?: boolean }
  if (typeof meta.main === "boolean") return meta.main
  const argv1 = typeof process !== "undefined" ? process.argv[1] : undefined
  return typeof argv1 === "string" && argv1.endsWith("build-graph.ts")
}

if (isDirectInvocation()) {
  buildSliceGraph().then((graph) => {
    // biome-ignore lint/suspicious/noConsole: CLI tool entry — stdout is the contract.
    console.log(JSON.stringify(graph, null, 2))
  })
}
