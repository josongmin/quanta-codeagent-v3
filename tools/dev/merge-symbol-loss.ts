/**
 * Merge symbol-loss detector.
 *
 * The incident: merge `9b21d2fd2` ("merge: reconcile parallel goal and
 * verification lanes") reconciled two goal lanes and took ONE side wholesale
 * for the objective domain. It deleted an entire enforcement half —
 * `src/objective/budget-limits.ts`, `resolveProductAutonomousTurnCap`,
 * `autonomousAllowance`, `clampBudgetLimit`, `PRODUCT_BUDGET_CEILING`, the
 * `hard-cap-exhausted` rejection, and two test files. The merge-base LACKED
 * those files and one parent ADDED them, so a plain 3-way merge would have KEPT
 * them. No commit message mentions the removal. Nothing in the repo noticed:
 * there are no git hooks (`.git/hooks` holds only samples, no husky/lefthook)
 * and CI has not run since billing was cut, so the only thing that actually
 * executes on this repo is `bun test`.
 *
 * THE SIGNAL (settled by measurement — do not redesign):
 *
 *   Symbol-level, SCOPED TO FILES THE MERGE TOUCHED. For merge M with parents
 *   P1..Pn, for each `.ts` (non-`.test.ts`, non-`.d.ts`) path in
 *   `git diff --name-only <parent> M`, extract exported symbol NAMES from
 *   `<parent>:<file>` and from `M:<file>`. A loss is a name present in a
 *   parent's set and absent from the merge's. A file the merge deleted
 *   contributes ALL of its parent exports.
 *
 * That shape separates the real case from controls (measured on this history):
 *
 *   9b21d2fd2  lost=56   merge: reconcile parallel goal and verification lanes
 *   79857f28b  lost=0    Merge branch 'codex/true100-message-ids'
 *   615b9b586  lost=1    Merge branch 'codex/feeder-checkpoint-capture'
 *   528f01ae5  lost=0    Merge branch 'codex/rfc-def-skill-startup-render'
 *   fc199ad3f  lost=0    Merge branch 'codex/rfc12-1-plan-dag'
 *
 * The UNSCOPED variant (diffing all of `src` between parent and merge) was
 * measured at 29–64 "losses" on every control merge — pure noise. It is not
 * implemented here on purpose.
 *
 * ESCAPE HATCH: a merge that MEANS to drop something can say so. If the commit
 * message names the lost path (full path or basename) or the lost symbol, that
 * loss is excused. Deliberate removal stays possible; SILENT removal does not.
 *
 * Export extraction uses the TypeScript compiler API (`typescript` is a
 * devDependency and is already imported by `tests/unit/_arch/slice-boundary-scanner.ts`),
 * so this is an AST fact, not a regex guess.
 */

import { spawnSync } from "node:child_process"
import { basename, join } from "node:path"
import ts from "typescript"

export const REPO_ROOT = join(import.meta.dir, "../..")

// ---------------------------------------------------------------------------
// Port
// ---------------------------------------------------------------------------

/**
 * Everything this detector needs from git. Narrow on purpose: the whole
 * decision procedure is a pure function of this port, so the red-on-injection
 * test can drive a synthetic merge that drops a symbol without inventing a
 * repository.
 */
export interface GitReadPort {
  /** Parent shas of `sha`, in order. */
  readonly parents: (sha: string) => readonly string[]
  /** Full commit message (subject + body) of `sha`. */
  readonly message: (sha: string) => string
  /** `git diff --name-only <from> <to>` — paths, repo-relative. */
  readonly changedFiles: (from: string, to: string) => readonly string[]
  /**
   * Contents of each path at `sha`. A path absent at that revision maps to
   * `null` (that is how a deletion is expressed). Batched because a single
   * merge can touch hundreds of files.
   */
  readonly readFiles: (sha: string, paths: readonly string[]) => ReadonlyMap<string, string | null>
  /**
   * The newest `maxMerges` merge commits reachable from `rev`, newest first.
   * The window is bounded by MERGE COUNT, not by commit count — `git log
   * --merges -n N` limits how many merges are printed, not how far it walks.
   */
  readonly listMerges: (rev: string, maxMerges: number) => readonly string[]
}

const git = (args: readonly string[], cwd: string): string => {
  const res = spawnSync("git", [...args], { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${res.status}): ${res.stderr ?? ""}`)
  }
  return res.stdout ?? ""
}

const LF = 0x0a

/**
 * `git cat-file --batch` over a list of `<sha>:<path>` specs. One subprocess
 * per revision instead of one per file — a 176-file merge parent is otherwise
 * 176 spawns.
 *
 * Batch output per request is either `<spec> missing\n` or
 * `<oid> <type> <size>\n<contents>\n`, and `<size>` is BYTES, so this parses
 * the raw buffer rather than a decoded string.
 */
const catFileBatch = (
  cwd: string,
  sha: string,
  paths: readonly string[],
): Map<string, string | null> => {
  const out = new Map<string, string | null>()
  if (paths.length === 0) return out
  const input = `${paths.map((p) => `${sha}:${p}`).join("\n")}\n`
  const res = spawnSync("git", ["cat-file", "--batch"], {
    cwd,
    input,
    maxBuffer: 512 * 1024 * 1024,
  })
  if (res.status !== 0) {
    throw new Error(`git cat-file --batch failed (${res.status}): ${String(res.stderr ?? "")}`)
  }
  const buf = res.stdout as Buffer
  let cursor = 0
  for (const path of paths) {
    if (cursor >= buf.length) {
      out.set(path, null)
      continue
    }
    const eol = buf.indexOf(LF, cursor)
    if (eol < 0) {
      out.set(path, null)
      cursor = buf.length
      continue
    }
    const header = buf.toString("utf8", cursor, eol)
    cursor = eol + 1
    if (header.endsWith(" missing") || header.endsWith(" ambiguous")) {
      out.set(path, null)
      continue
    }
    const parts = header.split(" ")
    const size = Number(parts[parts.length - 1])
    if (!Number.isFinite(size)) {
      out.set(path, null)
      continue
    }
    out.set(path, buf.toString("utf8", cursor, cursor + size))
    cursor = cursor + size + 1 // trailing LF after the object payload
  }
  return out
}

export const createGitReadPort = (cwd: string = REPO_ROOT): GitReadPort => ({
  parents: (sha) =>
    git(["rev-list", "--parents", "-n", "1", sha], cwd).trim().split(/\s+/).slice(1),
  message: (sha) => git(["log", "-1", "--format=%B", sha], cwd),
  changedFiles: (from, to) =>
    git(["diff", "--name-only", from, to], cwd)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0),
  readFiles: (sha, paths) => catFileBatch(cwd, sha, paths),
  listMerges: (rev, maxMerges) =>
    git(["log", "--merges", "--format=%H", "-n", String(maxMerges), rev], cwd)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0),
})

// ---------------------------------------------------------------------------
// Export extraction (TypeScript AST)
// ---------------------------------------------------------------------------

/** Files the settled signal looks at: `.ts`, excluding tests and declarations. */
export const isScannedPath = (path: string): boolean =>
  path.endsWith(".ts") && !path.endsWith(".test.ts") && !path.endsWith(".d.ts")

const collectBindingNames = (name: ts.BindingName, out: Set<string>): void => {
  if (ts.isIdentifier(name)) {
    out.add(name.text)
    return
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) collectBindingNames(element.name, out)
  }
}

const isExported = (node: ts.Node): boolean =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)

const NAMED_DECLARATION_GUARDS = [
  ts.isFunctionDeclaration,
  ts.isClassDeclaration,
  ts.isInterfaceDeclaration,
  ts.isTypeAliasDeclaration,
  ts.isEnumDeclaration,
  ts.isModuleDeclaration,
] as const

/** `export { a, b as c }`, `export * as ns from`, `export default`. */
const collectFromExportClause = (statement: ts.ExportDeclaration, out: Set<string>): void => {
  const clause = statement.exportClause
  if (clause === undefined) return // `export * from "..."` — no name to compare
  if (ts.isNamespaceExport(clause)) {
    out.add(clause.name.text)
    return
  }
  for (const element of clause.elements) out.add(element.name.text)
}

/** `export function f`, `export class C`, `export type T`, … */
const collectFromNamedDeclaration = (statement: ts.Statement, out: Set<string>): void => {
  if (!NAMED_DECLARATION_GUARDS.some((is) => is(statement))) return
  const name = (statement as ts.DeclarationStatement).name
  if (name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteral(name))) {
    out.add(name.text)
    return
  }
  const modifiers = ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : []
  if (modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) out.add("default")
}

const collectFromStatement = (statement: ts.Statement, out: Set<string>): void => {
  if (ts.isExportAssignment(statement)) {
    out.add("default")
    return
  }
  if (ts.isExportDeclaration(statement)) {
    collectFromExportClause(statement, out)
    return
  }
  if (!isExported(statement)) return
  if (ts.isVariableStatement(statement)) {
    for (const decl of statement.declarationList.declarations) collectBindingNames(decl.name, out)
    return
  }
  collectFromNamedDeclaration(statement, out)
}

/**
 * Exported symbol NAMES declared by a TypeScript source. Names only — this
 * deliberately does not compare signatures or types; the settled signal is
 * presence/absence of a name.
 *
 * `export * from "..."` contributes nothing (it has no name to compare), so a
 * barrel that swaps a star re-export is invisible here. That is a known and
 * accepted blind spot of the name-level signal.
 */
export const extractExportedSymbols = (source: string, fileName = "input.ts"): Set<string> => {
  const names = new Set<string>()
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    ts.ScriptKind.TS,
  )
  for (const statement of sourceFile.statements) collectFromStatement(statement, names)
  return names
}

// ---------------------------------------------------------------------------
// Escape hatch
// ---------------------------------------------------------------------------

const escapeForRegex = (raw: string): string => raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Does `message` name this identifier as a word (not as a substring)? */
export const messageNamesSymbol = (message: string, symbol: string): boolean =>
  new RegExp(`(^|[^A-Za-z0-9_$])${escapeForRegex(symbol)}([^A-Za-z0-9_$]|$)`).test(message)

/** Does `message` name this file, by full repo-relative path or by basename? */
export const messageNamesPath = (message: string, path: string): boolean =>
  message.includes(path) || message.includes(basename(path))

/**
 * The escape hatch. A merge that deliberately drops something says so in its
 * message; naming EITHER the file or the symbol excuses that loss.
 */
export const isExcusedByMessage = (message: string, loss: SymbolLoss): boolean =>
  messageNamesPath(message, loss.file) || messageNamesSymbol(message, loss.symbol)

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export interface SymbolLoss {
  /** Repo-relative path of the file that lost the export. */
  readonly file: string
  /** The exported symbol name present in `parent` and absent in the merge. */
  readonly symbol: string
  /** Sha of the parent that still had it. */
  readonly parent: string
}

export interface MergeScan {
  readonly sha: string
  readonly parents: readonly string[]
  /** First line of the commit message, for reporting. */
  readonly subject: string
  /** Unexcused losses — what the ratchet fails on. */
  readonly losses: readonly SymbolLoss[]
  /** Losses the commit message named. Deliberate removal, on the record. */
  readonly excused: readonly SymbolLoss[]
  /**
   * How many (parent, file) pairs were actually opened and parsed. The
   * anti-vacuity floor: a scan that examined 0 pairs found 0 losses for free,
   * and must never read as a pass.
   */
  readonly filesExamined: number
}

const sortLosses = (losses: SymbolLoss[]): SymbolLoss[] =>
  losses.sort((a, b) => a.file.localeCompare(b.file) || a.symbol.localeCompare(b.symbol))

/**
 * Losses this parent contributes, appended to `out`. Returns how many files it
 * actually opened — the anti-vacuity count.
 */
const collectParentLosses = (
  parent: string,
  paths: readonly string[],
  port: GitReadPort,
  exportsAfter: (path: string) => Set<string>,
  out: SymbolLoss[],
): number => {
  const parentSide = port.readFiles(parent, paths)
  let examined = 0
  for (const file of paths) {
    const source = parentSide.get(file) ?? null
    if (source === null) continue // added by the merge — nothing could be lost
    examined += 1
    const after = exportsAfter(file)
    for (const symbol of extractExportedSymbols(source, file)) {
      if (!after.has(symbol)) out.push({ file, symbol, parent })
    }
  }
  return examined
}

/**
 * The whole decision procedure, as a pure function of the port.
 *
 * A non-merge commit (fewer than 2 parents) scans to an empty, zero-examined
 * result: this detector has nothing to say about linear history.
 */
/** Every scanned path the merge changed relative to each parent. */
const changedScannedPaths = (
  sha: string,
  parents: readonly string[],
  port: GitReadPort,
): Map<string, readonly string[]> =>
  new Map(parents.map((p) => [p, port.changedFiles(p, sha).filter(isScannedPath)]))

/** Memoised export sets for the MERGE side, so a path shared by both parents is parsed once. */
const mergeSideExports = (
  sha: string,
  paths: readonly string[],
  port: GitReadPort,
): ((path: string) => Set<string>) => {
  const contents = port.readFiles(sha, paths)
  const cache = new Map<string, Set<string>>()
  return (path) => {
    const hit = cache.get(path)
    if (hit !== undefined) return hit
    const source = contents.get(path) ?? null
    const computed = source === null ? new Set<string>() : extractExportedSymbols(source, path)
    cache.set(path, computed)
    return computed
  }
}

/**
 * The whole decision procedure, as a pure function of the port.
 *
 * A non-merge commit (fewer than 2 parents) scans to an empty, zero-examined
 * result: this detector has nothing to say about linear history.
 */
export const scanMerge = (sha: string, port: GitReadPort): MergeScan => {
  const parents = port.parents(sha)
  if (parents.length < 2) {
    return { sha, parents, subject: "", losses: [], excused: [], filesExamined: 0 }
  }
  const message = port.message(sha)
  const subject = message.split("\n")[0]?.trim() ?? ""

  const perParentPaths = changedScannedPaths(sha, parents, port)
  const allPaths = [...new Set([...perParentPaths.values()].flat())]
  const exportsAfter = mergeSideExports(sha, allPaths, port)

  const found: SymbolLoss[] = []
  let filesExamined = 0
  for (const parent of parents) {
    filesExamined += collectParentLosses(
      parent,
      perParentPaths.get(parent) ?? [],
      port,
      exportsAfter,
      found,
    )
  }
  const excused = found.filter((l) => isExcusedByMessage(message, l))
  const losses = found.filter((l) => !isExcusedByMessage(message, l))

  return {
    sha,
    parents,
    subject,
    losses: sortLosses(losses),
    excused: sortLosses(excused),
    filesExamined,
  }
}

// ---------------------------------------------------------------------------
// Enforcement policy (SSOT for the ratchet in
// `tests/unit/_arch/merge-symbol-loss-ratchet.test.ts`)
// ---------------------------------------------------------------------------

/** CLI default: the whole reachable merge history of this repo is ~70 merges. */
export const DEFAULT_MAX_MERGES = 200

/**
 * How many of the newest merges the ratchet enforces. Bounded so the unit test
 * stays fast (the full ~70-merge history is a ~30s scan).
 *
 * 14 is not arbitrary: merges #2..#14 newest-first are ALL clean at 0 losses, so
 * this window is the largest one whose only dirty member is the recorded
 * incident. Widening it past 14 pulls in `deeaa91da` and the `aug02-integration`
 * chain, which carry real (small) historical losses and would each need their
 * own written justification rather than being waved through.
 */
export const ENFORCED_MERGE_WINDOW = 14

/**
 * Grandfathered merges: already in history, already shipped, cannot be
 * un-merged. They are NOT hidden — the ratchet re-measures every one of them and
 * fails if a baseline entry stops reporting loss, so gutting the detector cannot
 * masquerade as progress.
 *
 * A new entry here is a decision to accept a silent deletion. It needs a reason,
 * in writing, in this file.
 */
export const GRANDFATHERED_MERGES: ReadonlyMap<string, string> = new Map([
  [
    "9b21d2fd295097009487d9b37b477fd1f5be2388",
    "THE incident this detector exists for. Took one goal lane wholesale and dropped " +
      "src/objective/budget-limits.ts, resolveProductAutonomousTurnCap, autonomousAllowance, " +
      "clampBudgetLimit, PRODUCT_BUDGET_CEILING and the hard-cap-exhausted rejection with no " +
      "mention in the commit message. Already in history; some symbols have since been restored " +
      "by later work, while clampBudgetLimit, PRODUCT_BUDGET_CEILING and " +
      "src/objective/budget-limits.ts are still absent. Grandfathered so the guard is green " +
      "TODAY while still naming the loss out loud.",
  ],
])

/** Is this merge on the recorded baseline? Accepts abbreviated shas. */
export const isGrandfathered = (sha: string): boolean => {
  for (const known of GRANDFATHERED_MERGES.keys()) {
    if (known === sha || known.startsWith(sha) || sha.startsWith(known)) return true
  }
  return false
}

export interface WindowScan {
  readonly merges: readonly MergeScan[]
  /** Total (parent, file) pairs opened across the window — anti-vacuity floor. */
  readonly filesExamined: number
}

/** Scan the newest `maxMerges` merges reachable from `rev`. */
export const scanMergeWindow = (
  port: GitReadPort,
  rev = "HEAD",
  maxMerges = DEFAULT_MAX_MERGES,
): WindowScan => {
  const merges = port.listMerges(rev, maxMerges).map((sha) => scanMerge(sha, port))
  return { merges, filesExamined: merges.reduce((n, m) => n + m.filesExamined, 0) }
}

/** One-line rendering of a scan, used by the CLI and by the ratchet's failure text. */
export const formatMergeScan = (scan: MergeScan): string => {
  const head = `${scan.sha.slice(0, 9)}  lost=${scan.losses.length}  excused=${scan.excused.length}  files=${scan.filesExamined}  ${scan.subject}`
  const detail = scan.losses.map(
    (l) => `    - ${l.file}: ${l.symbol}  (kept in ${l.parent.slice(0, 9)})`,
  )
  return [head, ...detail].join("\n")
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const readFlag = (argv: readonly string[], flag: string): string | undefined => {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}

const main = (argv: readonly string[]): number => {
  const port = createGitReadPort()
  const maxMerges = Number(readFlag(argv, "--max-merges") ?? DEFAULT_MAX_MERGES)
  const rev = readFlag(argv, "--rev") ?? "HEAD"
  const flagValues = new Set([readFlag(argv, "--max-merges"), readFlag(argv, "--rev")])
  const shas = argv.filter((a) => !a.startsWith("--") && !flagValues.has(a))

  const scans =
    shas.length > 0
      ? shas.map((sha) => scanMerge(sha, port))
      : scanMergeWindow(port, rev, maxMerges).merges

  let dirty = 0
  for (const scan of scans) {
    process.stdout.write(`${formatMergeScan(scan)}\n`)
    if (scan.losses.length > 0) dirty += 1
  }
  const pairs = scans.reduce((n, s) => n + s.filesExamined, 0)
  process.stdout.write(
    `\nscanned ${scans.length} merge(s), ${pairs} (parent,file) pair(s); ${dirty} with unexcused symbol loss\n`,
  )
  return dirty > 0 ? 1 : 0
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))
