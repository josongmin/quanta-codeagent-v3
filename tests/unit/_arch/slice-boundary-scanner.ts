/**
 * Shared slice-boundary scanner (S4 hardening). One engine, per-slice config in
 * `slice-boundary-configs.ts`. Individual `*-slice-boundary.test.ts` files are
 * thin evidence/catalog entrypoints only.
 */

import { describe, test } from "bun:test"
import { readdirSync, readFileSync, type Stats, statSync } from "node:fs"
import { join, relative } from "node:path"
import ts from "typescript"
import { assertScanPopulation } from "../_shared/scan-population"

const REPO_ROOT = join(import.meta.dir, "../../..")

export type SliceAllowImport = string | { readonly spec: string; readonly files: readonly string[] }

export interface SliceBoundaryConfig {
  readonly slice: string
  /** Import specifiers denied under this slice (exact or `@/slice/...` prefix). */
  readonly denyImports: readonly string[]
  /** Documented carve-outs: imports that match a `denyImports` prefix but are
   *  explicitly allowed as named sub-barrels. A bare string applies to every
   *  file in the slice. A `{spec, files}` entry is limited to those slice-
   *  relative paths (posix, OS-independent). */
  readonly allowImports?: readonly SliceAllowImport[]
  readonly stdioAllowFiles?: readonly string[]
  readonly envAllowFiles?: readonly string[]
  readonly consoleAllowFiles?: readonly string[]
  /** Skip `.from-worktree` / `.my-backup` filename carve-outs (runner/ipc). */
  readonly includeBackupArtifacts?: boolean
  /** Require `src/<slice>/index.ts`. */
  readonly requireSliceBarrel?: boolean
  /** Require sub-slice barrels relative to `src/<slice>/`. */
  readonly requireSubSliceBarrels?: readonly string[]
  /** Explicit budget for the runtime+type-position apps-surface AST scan. The
   *  default behavioural-test deadline can be too short for a large slice under
   *  full-suite CPU contention without changing this structural assertion. */
  readonly surfaceIsolationScanTimeoutMs?: number
  /** Layer-2 composition slices (e.g. `@/host`) are NOT pure libraries: they
   *  legitimately read `process.env`, write startup stdio, and import every
   *  lower layer. Only the ONE invariant that still applies to them — surface
   *  isolation (no `apps/**` reference, runtime OR type-position) — is run when
   *  this is set; the library-purity tests (deny-list / env / stdio / console /
   *  alt-runtime / node-surface / barrel) are skipped. */
  readonly surfaceIsolationOnly?: boolean
}

const SURFACE_PATTERNS = [/^@\/apps\b/, /(^|\/)apps\//, /(^|\/)src\/apps\//] as const

/** Does an import specifier point at a surface (`apps/**`)? SSOT for the
 *  surface-isolation guard — a core/wiring slice may never reference these,
 *  runtime OR type-position. Exported so the negative-proof battery can drive
 *  the SAME predicate the guard uses (no second copy to drift). */
export const isSurfaceSpec = (spec: string): boolean => SURFACE_PATTERNS.some((p) => p.test(spec))

const NODE_SURFACE_MODULES = new Set<string>([
  "node:readline",
  "node:readline/promises",
  "node:tty",
  "node:repl",
])

export const sliceDir = (slice: string): string => join(REPO_ROOT, "src", slice)

/** Is `name` a PRODUCTION `.ts` slice member to be scanned? Excludes:
 *   - non-`.ts` and `.d.ts` (declaration-only) files;
 *   - `*.test.ts` (incl. `*.hellgate.test.ts`) — TEST files that legitimately
 *     import peer slices' tools end-to-end. Matches the god-code ratchet
 *     walker's `!p.endsWith(".test.ts")` exclusion so both walkers see the same
 *     production file set;
 *   - `.from-worktree` / `.my-backup` artifacts (unless `includeBackupArtifacts`).
 *  (`__tests__/` DIRECTORIES are pruned by the caller before descent.) */
const isScannableSliceFile = (name: string, includeBackupArtifacts: boolean): boolean => {
  if (!name.endsWith(".ts") || name.endsWith(".d.ts")) return false
  if (name.endsWith(".test.ts")) return false
  if (!includeBackupArtifacts && (name.includes(".from-worktree") || name.includes(".my-backup"))) {
    return false
  }
  return true
}

const isEnoent = (err: unknown): boolean =>
  typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT"

/**
 * PROVENANCE, CARRIED BY THE ARRAY — not by the path string.
 *
 * A guard that enumerates and then reads has a TOCTOU window, and this repo
 * churns constantly: a file listed by the walk can be gone microseconds later.
 * At MODULE scope (`core-no-vscode-leak-ratchet.test.ts` reads inside an IIFE)
 * that ENOENT is an UNHANDLED ERROR, so bun never registers the file's arms —
 * MEASURED: three arms became `0 pass, 1 error`. One vanished file erased the
 * whole guard rather than failing one assertion.
 *
 * The skip that fixes it must be SCOPED. ENOENT on a path a LIVE WALK produced
 * means the file really did vanish; ENOENT on a CONSTANT or FIXTURE path
 * (`surfaces/vscode/src/provider.ts`, a slice barrel, a named owner module)
 * means the guard is pointed at nothing and MUST fail loudly — swallowing those
 * makes the ratchet wholly vacuous.
 *
 * So provenance rides on the ARRAY IDENTITY the walk returned, registered here.
 * A hand-built array of constants is not a member and every read of it is
 * strict. Rebuilding a walk result (`[...files]`, `files.filter(...)`) also
 * drops membership — deliberately, because the safe default is to throw.
 */
const WALK_RESULTS = new WeakSet<readonly string[]>()

/** Is this exact array the one a live walk handed back? */
export const isWalkDerived = (files: readonly string[]): boolean => WALK_RESULTS.has(files)

/** `readdirSync`, or `null` when a WALK-DERIVED sub-directory vanished mid-walk.
 *  The ROOT is a CONSTANT the caller chose: its absence is a real defect — a
 *  guard aimed at a slice that no longer exists must go red, not report clean
 *  over an empty set — so a root ENOENT is re-thrown. */
const readdirOrSkip = (dir: string, isRoot: boolean): readonly string[] | null => {
  try {
    return readdirSync(dir)
  } catch (err) {
    if (isRoot || !isEnoent(err)) throw err
    return null
  }
}

/** `statSync`, or `null` when the entry was deleted between `readdirSync` and
 *  `statSync` — the same TOCTOU one level up, and walk-derived, so skippable. */
const statOrSkip = (full: string): Stats | null => {
  try {
    return statSync(full)
  } catch (err) {
    if (!isEnoent(err)) throw err
    return null
  }
}

/** Descend into `name`, or return the files it contributes. `__tests__/`
 *  sub-trees hold TEST files that legitimately exercise cross-slice CONTRACTS
 *  end-to-end (importing a peer slice's tool under test is what the test IS).
 *  They are not production slice members, so — like the god-code / no-raw-nul
 *  walkers — they are pruned before descent. */
const walkEntry = (
  dir: string,
  name: string,
  includeBackupArtifacts: boolean,
): readonly string[] => {
  const full = join(dir, name)
  const st = statOrSkip(full)
  if (st === null) return []
  if (st.isDirectory()) {
    if (name === "__tests__") return []
    return walkSliceTsFiles(full, includeBackupArtifacts, false)
  }
  return st.isFile() && isScannableSliceFile(name, includeBackupArtifacts) ? [full] : []
}

function walkSliceTsFiles(dir: string, includeBackupArtifacts: boolean, isRoot: boolean): string[] {
  const names = readdirOrSkip(dir, isRoot)
  if (names === null) return []
  const out: string[] = []
  for (const name of names) out.push(...walkEntry(dir, name, includeBackupArtifacts))
  return out
}

export const listSliceTsFiles = (dir: string, includeBackupArtifacts: boolean): string[] => {
  const out = walkSliceTsFiles(dir, includeBackupArtifacts, true).sort()
  WALK_RESULTS.add(out)
  return out
}

/** First path segment under `root` — the SUBTREE a file belongs to. Root-level
 *  files share the `"."` bucket. This is the unit the floor below defends: a
 *  guard that quietly stopped seeing `src/agent/**` is the failure that a bare
 *  "we read more than zero files" floor cannot detect. */
const subtreeOf = (root: string, file: string): string => {
  const rel = relative(root, file)
  const head = rel.split("/")[0]
  return head === undefined || head === rel ? "." : head
}

const tally = (root: string, files: readonly string[]): Map<string, number> => {
  const counts = new Map<string, number>()
  for (const f of files) {
    const key = subtreeOf(root, f)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

export interface WalkCoverage {
  readonly root: string
  readonly includeBackupArtifacts: boolean
  readonly enumerated: readonly string[]
  readonly read: readonly string[]
  /** Enumerated, then gone by the time the read ran. */
  readonly vanished: readonly string[]
  readonly enumeratedSubtrees: ReadonlyMap<string, number>
  readonly readSubtrees: ReadonlyMap<string, number>
}

export interface WalkedFile {
  readonly file: string
  readonly src: string
}

export interface WalkedReadResult {
  readonly files: readonly WalkedFile[]
  readonly coverage: WalkCoverage
}

/**
 * Read every enumerated file, skipping only what genuinely vanished.
 *
 * Skipping is enabled ONLY when `files` is the array a live walk returned (see
 * {@link WALK_RESULTS}). Pass any other array — a constant list, a filtered
 * copy — and every read is strict, so a missing fixture still throws.
 *
 * Does NOT assert. The floor is a separate call so it can run INSIDE a test
 * arm: asserting here would re-create the very defect this fixes, since a
 * throw at module scope takes down every arm in the file.
 */
export const readWalkedFiles = (
  root: string,
  files: readonly string[],
  includeBackupArtifacts = false,
): WalkedReadResult => {
  const skippable = isWalkDerived(files)
  const out: WalkedFile[] = []
  const read: string[] = []
  const vanished: string[] = []
  for (const file of files) {
    let src: string
    try {
      src = readFileSync(file, "utf8")
    } catch (err) {
      if (skippable && isEnoent(err)) {
        vanished.push(file)
        continue
      }
      throw err
    }
    out.push({ file, src })
    read.push(file)
  }
  return {
    files: out,
    coverage: {
      root,
      includeBackupArtifacts,
      enumerated: files,
      read,
      vanished,
      enumeratedSubtrees: tally(root, files),
      readSubtrees: tally(root, read),
    },
  }
}

/**
 * THE FLOOR. The moment a skip exists, "read nothing, pass" becomes a way to be
 * green, so every arm that consumes the enumerator asserts this before it
 * concludes anything.
 *
 * A global `enumerated > 0` is not enough: it survives losing an entire
 * subtree, which is the realistic shape of the failure (a racing `rm -rf`, a
 * `readdirSync` that came back short, a walk that started descending the wrong
 * tree). So the floor is checked per TOP-LEVEL SUBTREE of the walk root, from
 * both directions:
 *
 *   1. WALK vs DISK — every immediate child directory of `root` that still
 *      holds a scannable file must appear in the enumeration. Catches the walk
 *      itself dropping a subtree, which no enumeration-derived check can see.
 *      The re-probe only runs for subtrees that are ABSENT, so it costs nothing
 *      in the normal case, and a subtree that vanished outright probes empty —
 *      no false red.
 *   2. READ vs WALK — every subtree the walk DID enumerate must contribute at
 *      least one successfully read file. Catches a subtree lost entirely to
 *      ENOENT skips.
 *
 * Plus non-vacuity: something was enumerated and something was read.
 */
/** Non-vacuity: something was enumerated, and something survived to be read. */
const vacuityProblems = (coverage: WalkCoverage): string[] => {
  if (coverage.enumerated.length === 0) {
    return [`the walk of ${coverage.root} enumerated NO files`]
  }
  if (coverage.read.length === 0) {
    return [`all ${coverage.enumerated.length} enumerated files vanished before they could be read`]
  }
  return []
}

/** FLOOR 1 — WALK vs DISK. Catches the walk itself dropping a subtree, which no
 *  enumeration-derived check can see: the files are absent from BOTH the
 *  enumerated and the read set. The re-probe runs only for subtrees ABSENT from
 *  the enumeration, so it costs nothing normally, and a subtree that vanished
 *  outright probes empty — no false red. */
const walkVsDiskProblems = (coverage: WalkCoverage): string[] => {
  let children: readonly string[]
  try {
    children = readdirSync(coverage.root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== "__tests__")
      .map((e) => e.name)
  } catch (err) {
    if (!isEnoent(err)) throw err
    return [`the walk root ${coverage.root} no longer exists`]
  }
  const problems: string[] = []
  for (const child of children) {
    if (coverage.enumeratedSubtrees.has(child)) continue
    const probe = walkSliceTsFiles(
      join(coverage.root, child),
      coverage.includeBackupArtifacts,
      false,
    )
    if (probe.length > 0) {
      problems.push(
        `subtree "${child}/" holds ${probe.length} scannable file(s) on disk but the walk enumerated NONE of them`,
      )
    }
  }
  return problems
}

/** FLOOR 2 — READ vs WALK. Catches a subtree lost entirely to ENOENT skips. */
const readVsWalkProblems = (coverage: WalkCoverage): string[] => {
  const problems: string[] = []
  for (const [subtree, enumerated] of coverage.enumeratedSubtrees) {
    if ((coverage.readSubtrees.get(subtree) ?? 0) === 0) {
      problems.push(
        `subtree "${subtree}/" enumerated ${enumerated} file(s) but NONE were read (all vanished)`,
      )
    }
  }
  return problems
}

export const assertWalkFloor = (coverage: WalkCoverage, label: string): void => {
  const problems = [
    ...vacuityProblems(coverage),
    ...walkVsDiskProblems(coverage),
    ...readVsWalkProblems(coverage),
  ]
  if (problems.length === 0) return
  throw new Error(
    `FLOOR VIOLATION — ${label} scanned a tree it did not actually cover, so a green ` +
      `result here proves nothing:\n\n${problems.map((p) => `- ${p}`).join("\n")}\n\n` +
      `root=${coverage.root} enumerated=${coverage.enumerated.length} ` +
      `read=${coverage.read.length} vanished=${coverage.vanished.length}`,
  )
}

const parseSourceFile = (src: string): ts.SourceFile =>
  ts.createSourceFile(
    "slice-boundary-scanner.ts",
    src,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )

const lineOf = (sf: ts.SourceFile, pos: number): number =>
  sf.getLineAndCharacterOfPosition(pos).line + 1

const isPropertyAccessLike = (
  node: ts.Node,
): node is ts.PropertyAccessExpression | ts.PropertyAccessChain =>
  ts.isPropertyAccessExpression(node) || ts.isPropertyAccessChain(node)

const getNodeLabel = (node: ts.Node): string | null => {
  if (ts.isIdentifier(node)) return node.text
  if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
    return node.getText()
  }
  return null
}

const matchesMember = (node: ts.Node, objectName: string, propertyName: string): boolean =>
  isPropertyAccessLike(node) &&
  getNodeLabel(node.expression) === objectName &&
  node.name.text === propertyName

const collectAstHits = (
  src: string,
  matcher: (node: ts.Node, sf: ts.SourceFile) => string | null,
): Array<{ line: number; hit: string }> => {
  const sf = parseSourceFile(src)
  const out: Array<{ line: number; hit: string }> = []
  const visit = (node: ts.Node): void => {
    const hit = matcher(node, sf)
    if (hit) out.push({ line: lineOf(sf, node.getStart(sf)), hit })
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/**
 * Single-file const-alias table: `const IDENT = "literal"` at MODULE scope with
 * a plain string-literal initializer. Used to resolve a dynamic `import(IDENT)`
 * whose specifier was hoisted into a const variable — the exact trick
 * `apps/agent/mode-presets/batch.ts` used (`const BENCH_EVAL_MODULE =
 * "@/apps/bench/eval"` → `await import(BENCH_EVAL_MODULE)`) to make a real
 * cross-surface edge invisible to the literal-only dynamic-import scanner.
 *
 * Deliberately conservative: only top-level `const` declarations with a bare
 * string-literal initializer are collected (no `let`, no member/computed access,
 * no concatenation, no cross-file resolution). Anything else stays unresolved
 * (as before) rather than risk a false edge.
 */
const collectModuleConstStringLiterals = (sf: ts.SourceFile): ReadonlyMap<string, string> => {
  const table = new Map<string, string>()
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt) || (stmt.declarationList.flags & ts.NodeFlags.Const) === 0) {
      continue
    }
    for (const decl of stmt.declarationList.declarations) {
      if (
        ts.isIdentifier(decl.name) &&
        decl.initializer &&
        ts.isStringLiteralLike(decl.initializer)
      ) {
        // First binding wins (a re-declared const is a compile error anyway).
        if (!table.has(decl.name.text)) table.set(decl.name.text, decl.initializer.text)
      }
    }
  }
  return table
}

const staticValueImportSpecifier = (node: ts.Node): string | null => {
  if (!ts.isImportDeclaration(node) || node.importClause?.isTypeOnly) return null
  return node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)
    ? node.moduleSpecifier.text
    : null
}

const staticValueExportSpecifier = (node: ts.Node): string | null => {
  if (!ts.isExportDeclaration(node) || node.isTypeOnly) return null
  return node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)
    ? node.moduleSpecifier.text
    : null
}

const dynamicImportSpecifier = (
  node: ts.Node,
  constStrings: ReadonlyMap<string, string>,
): string | null => {
  if (
    !ts.isCallExpression(node) ||
    node.expression.kind !== ts.SyntaxKind.ImportKeyword ||
    node.arguments.length === 0
  ) {
    return null
  }
  const firstArg = node.arguments[0]
  if (firstArg && ts.isStringLiteralLike(firstArg)) return firstArg.text
  return firstArg && ts.isIdentifier(firstArg) ? (constStrings.get(firstArg.text) ?? null) : null
}

const valueModuleSpecifier = (
  node: ts.Node,
  constStrings: ReadonlyMap<string, string>,
): string | null =>
  staticValueImportSpecifier(node) ??
  staticValueExportSpecifier(node) ??
  dynamicImportSpecifier(node, constStrings)

export const extractImports = (src: string): Array<{ line: number; spec: string }> => {
  const out: Array<{ line: number; spec: string }> = []
  const sf = parseSourceFile(src)
  const constStrings = collectModuleConstStringLiterals(sf)
  const visit = (node: ts.Node): void => {
    const spec = valueModuleSpecifier(node, constStrings)
    if (spec) out.push({ line: lineOf(sf, node.getStart(sf)), spec })
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/**
 * Type-POSITION module references that {@link extractImports} deliberately
 * skips: `import type … from "x"`, `export type … from "x"`, and the inline
 * `import("x").Member` type syntax (`ts.ImportTypeNode`). These are erased at
 * compile time, so for a general peer-library deny-list they are correctly
 * ignored (slice purity is a RUNTIME-dependency invariant). But a CORE slice
 * referencing a SURFACE (`apps/**`) is a dependency-direction INVERSION
 * regardless of erasure — and the inline `import("../../apps/cli/…").Port`
 * form is exactly how three such references hid in `@/agent` until the surface
 * ports were hoisted to `@/agent/surface-ports`. The surface-isolation guard
 * scans these in ADDITION to runtime imports so the inversion cannot regress.
 */
export const extractTypeOnlyModuleRefs = (src: string): Array<{ line: number; spec: string }> => {
  const out: Array<{ line: number; spec: string }> = []
  const sf = parseSourceFile(src)
  const visit = (node: ts.Node): void => {
    // `import type … from "x"` / `export type … from "x"`
    if (
      ts.isImportDeclaration(node) &&
      node.importClause?.isTypeOnly &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      out.push({ line: lineOf(sf, node.getStart(sf)), spec: node.moduleSpecifier.text })
    } else if (
      ts.isExportDeclaration(node) &&
      node.isTypeOnly &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      out.push({ line: lineOf(sf, node.getStart(sf)), spec: node.moduleSpecifier.text })
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      // `import("x").Member` — the argument is a LiteralTypeNode wrapping the string.
      const lit = node.argument.literal
      if (ts.isStringLiteralLike(lit)) {
        out.push({ line: lineOf(sf, node.getStart(sf)), spec: lit.text })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/**
 * DELETED, not converted: `scanLines` and the local `stripComments` it was the
 * sole consumer of.
 *
 * The local stripper was the naive two-regex form, defeated by a `/*` inside a
 * string literal or a regex character class. MEASURED against a real
 * `process.env` violation: the bare source gave `scanLines` 1 hit; wrapping it
 * in `const A = "/*"` … `const B = "*​/"` — and, separately, in `const A = /[/*]/`
 * … `const B = /[*​/]/` — gave 0 hits both times, i.e. the guard reported clean
 * over a violation it was looking straight at.
 *
 * The obvious repair was to import the shared quoting- AND regex-literal-aware
 * scanner from `tests/unit/_shared/strip-comments.ts`. But converting it would
 * have been work on DEAD CODE: `scanLines` had ZERO callers anywhere in the
 * repo (`grep -rn scanLines tests src tools` matched only its own definition),
 * and `stripComments` here had exactly one caller — `scanLines`. Nothing else
 * in the repo imported either symbol from this module. Both are gone; every
 * live scan in this file is AST-based (`collectAstHits`), which never had the
 * comment-stripping problem in the first place.
 *
 * This is why `tests/unit/_arch/slice-boundary-scanner.ts` no longer appears in
 * the burn-down list in `comment-scanner-burndown-ratchet.test.ts`.
 */

const isDeniedImport = (
  spec: string,
  deny: ReadonlySet<string>,
  allow: ReadonlySet<string>,
): boolean => {
  // Allow-list checked first: documented carve-outs override deny prefix.
  if (allow.has(spec)) return false
  for (const a of allow) {
    if (spec === a || spec.startsWith(`${a}/`)) return false
  }
  if (deny.has(spec)) return true
  for (const d of deny) {
    if (spec === d || spec.startsWith(`${d}/`)) return true
  }
  return false
}

/** Posix-slash relative path, independent of the host path separator. */
const posixNorm = (p: string): string => p.replaceAll("\\", "/").replace(/^\.\//, "")

const posixRel = (from: string, to: string): string => posixNorm(relative(from, to))

const fileMatchesAllow = (fromFile: string, files: readonly string[]): boolean => {
  const norm = posixNorm(fromFile)
  const leaf = norm.split("/").pop() ?? norm
  for (const raw of files) {
    const f = posixNorm(raw)
    if (norm === f || leaf === f || norm.endsWith(`/${f}`)) return true
  }
  return false
}

/** Specifiers allowed for `fromFile`. File-scoped entries apply only when a
 *  file is supplied; omitting the file keeps them denied (fail closed). */
export const allowSpecsForFile = (
  entries: readonly SliceAllowImport[] | undefined,
  fromFile: string | undefined,
): Set<string> => {
  const allow = new Set<string>()
  for (const e of entries ?? []) {
    if (typeof e === "string") {
      allow.add(e)
      continue
    }
    if (fromFile !== undefined && fileMatchesAllow(fromFile, e.files)) allow.add(e.spec)
  }
  return allow
}

/** Policy-level predicate: would `config`'s deny-list flag a VALUE import of
 *  `spec`? Composed EXACTLY as `registerSliceBoundarySuite` does (same
 *  self-prefix strip + deny/allow sets), so a negative test that drives this
 *  proves the LIVE guard fires on a synthetic violation without needing an
 *  on-disk fixture. (Type-only imports never reach this — `extractImports`
 *  skips `import type` upstream.) `fromFile` is a slice-relative posix path
 *  or basename; omit it to apply only global string allows. */
export const isImportDeniedByConfig = (
  spec: string,
  config: SliceBoundaryConfig,
  fromFile?: string,
): boolean => {
  const selfPrefix = `@/${config.slice}`
  const deny = new Set(config.denyImports.filter((d) => d !== selfPrefix))
  const allow = allowSpecsForFile(config.allowImports, fromFile)
  return isDeniedImport(spec, deny, allow)
}

const leafName = (sliceDirPath: string, filePath: string): string => {
  const base = relative(sliceDirPath, filePath)
  return base.split("/").pop() ?? base
}

/** Does an env-allow entry cover this slice file? An entry WITHOUT a `/` is a
 *  bare BASENAME (`from-env.ts`) — matched against the file's leaf name (legacy
 *  behavior). An entry WITH a `/` is a slice-relative PATH suffix
 *  (`container-exec/tool.ts`) — matched against the file's path RELATIVE to the
 *  slice dir. Path-scoped entries exist precisely for non-unique basenames (e.g.
 *  the 10 `tool.ts` files under `@/tool`): they exempt exactly ONE file, so a
 *  future env read in a SIBLING `<other>/tool.ts` still trips the guard. */
const isEnvAllowed = (
  allow: ReadonlySet<string>,
  sliceDirPath: string,
  filePath: string,
): boolean => {
  if (allow.has(leafName(sliceDirPath, filePath))) return true
  const rel = relative(sliceDirPath, filePath)
  for (const entry of allow) {
    if (entry.includes("/") && (rel === entry || rel.endsWith(`/${entry}`))) return true
  }
  return false
}

const scanProcessEnvArgv = (src: string): Array<{ line: number; hit: string }> =>
  collectAstHits(src, (node) => {
    if (!isPropertyAccessLike(node)) return null
    if (!matchesMember(node, "process", "env") && !matchesMember(node, "process", "argv")) {
      return null
    }
    return node.expression.getText() === "process" ? `process.${node.name.text}` : null
  })

const scanProcessStdio = (src: string): Array<{ line: number; hit: string }> =>
  collectAstHits(src, (node) => {
    if (!isPropertyAccessLike(node)) return null
    if (
      !matchesMember(node, "process", "stdin") &&
      !matchesMember(node, "process", "stdout") &&
      !matchesMember(node, "process", "stderr")
    ) {
      return null
    }
    return node.expression.getText() === "process" ? `process.${node.name.text}` : null
  })

/** AST-based `console.<method>(` detector (ignores string literals and comments
 *  natively — a `"console.log($A)"` inside a string or a commented-out call is
 *  NOT a hit). Exported so the terminal-defaults ratchet can reuse the SAME
 *  detector the per-slice battery uses (no second, regex-based copy to drift). */
export const scanConsoleCalls = (src: string): Array<{ line: number; hit: string }> =>
  collectAstHits(src, (node) => {
    if (!ts.isCallExpression(node) || !isPropertyAccessLike(node.expression)) return null
    const callee = node.expression
    if (getNodeLabel(callee.expression) !== "console") return null
    const method = callee.name.text
    if (!["log", "error", "warn", "info", "debug", "dir", "trace"].includes(method)) {
      return null
    }
    return `console.${method}(`
  })

const scanAltRuntimeEnvArgv = (src: string): Array<{ line: number; hit: string }> =>
  collectAstHits(src, (node) => {
    if (!isPropertyAccessLike(node)) return null
    if (matchesMember(node, "Bun", "env") || matchesMember(node, "Bun", "argv")) {
      return `Bun.${node.name.text}`
    }
    if (matchesMember(node, "Deno", "env") || matchesMember(node, "Deno", "args")) {
      return `Deno.${node.name.text}`
    }
    if (matchesMember(node, "import.meta", "env")) {
      return "import.meta.env"
    }
    if (
      (node.name.text === "env" || node.name.text === "argv") &&
      isPropertyAccessLike(node.expression) &&
      matchesMember(node.expression, "globalThis", "process")
    ) {
      return `globalThis.process.${node.name.text}`
    }
    return null
  })

const scanNodeProcessNamedImports = (src: string): Array<{ line: number; hit: string }> =>
  collectAstHits(src, (node) => {
    if (!ts.isImportDeclaration(node) || !node.importClause || !node.moduleSpecifier) return null
    if (
      !ts.isStringLiteralLike(node.moduleSpecifier) ||
      node.moduleSpecifier.text !== "node:process"
    ) {
      return null
    }
    const bindings = node.importClause.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) return null
    return node.getText().replace(/\s+/g, " ").trim()
  })

const surfaceImportViolations = (dir: string, file: string, src: string): string[] => {
  const relativeFile = relative(dir, file)
  const runtime = extractImports(src)
    .filter(({ spec }) => isSurfaceSpec(spec))
    .map(({ line, spec }) => `${relativeFile}:${line}  import "${spec}"`)
  const typeOnly = extractTypeOnlyModuleRefs(src)
    .filter(({ spec }) => isSurfaceSpec(spec))
    .map(({ line, spec }) => `${relativeFile}:${line}  type-import "${spec}"`)
  return [...runtime, ...typeOnly]
}

const collectSurfaceImportViolations = (dir: string, files: readonly WalkedFile[]): string[] =>
  files.flatMap(({ file, src }) => surfaceImportViolations(dir, file, src))

const assertNoSurfaceImportViolations = (slice: string, violations: readonly string[]): void => {
  if (violations.length === 0) return
  throw new Error(
    `@/${slice} must not reference apps/** (incl. type-only):\n\n${violations.join("\n")}`,
  )
}

/** Register the standard architecture-guard battery for one slice config. */
export const registerSliceBoundarySuite = (config: SliceBoundaryConfig): void => {
  const dir = sliceDir(config.slice)
  // Strip self-imports from deny-list: a slice referencing its own files via
  // `@/<slice>/X` is intra-slice (not a peer-library crossing). PEER_LIBRARY_DENY
  // lists every slice for cross-slice isolation; this filter makes self-import
  // intent universal without per-slice config maintenance.
  const selfPrefix = `@/${config.slice}`
  const deny = new Set(config.denyImports.filter((d) => d !== selfPrefix))
  const stdioAllow = new Set(config.stdioAllowFiles ?? [])
  const envAllow = new Set(config.envAllowFiles ?? [])
  const consoleAllow = new Set(config.consoleAllowFiles ?? [])
  const includeBackup = config.includeBackupArtifacts ?? false
  const registerSurfaceIsolationGuard = (name: string, body: () => void): void => {
    if (config.surfaceIsolationScanTimeoutMs === undefined) {
      test(name, body)
      return
    }
    test(name, body, config.surfaceIsolationScanTimeoutMs)
  }

  describe(`@/${config.slice} — architecture guard`, () => {
    const files = listSliceTsFiles(dir, includeBackup)

    /**
     * ONE read pass for ONE arm, with the floor asserted before the arm is
     * allowed to draw a conclusion. Every arm below goes through this — a
     * vanished file no longer takes the read site down, and in exchange no arm
     * may reach "no violations" over a tree it did not actually cover.
     */
    const scanned = (arm: string): readonly WalkedFile[] => {
      const { files: read, coverage } = readWalkedFiles(dir, files, includeBackup)
      assertWalkFloor(coverage, `@/${config.slice} — ${arm}`)
      return read
    }

    test("the slice's committed reach (phase D)", () => {
      // `toBeGreaterThan(0)` was the whole floor here, for 49 slices and every
      // ceiling arm below them. It is satisfied by one surviving file, and
      // measured: 12 of the 49 slices have a single top-level bucket, so the
      // per-subtree floor degenerates to the same claim for them. Every arm
      // under it asserts an EMPTY violation list, which a shrunken scan
      // satisfies for free.
      //
      // The number now comes from tools/dev/scan-reach-baseline.json, measured
      // per slice, and reach is what git tracks — not what a walk happened to
      // find.
      assertScanPopulation(files, dir, { id: `slice-boundary:${config.slice}` })
    })

    registerSurfaceIsolationGuard(
      "no file imports from any `apps/**` (surface isolation, incl. type-position)",
      () => {
        assertNoSurfaceImportViolations(
          config.slice,
          collectSurfaceImportViolations(dir, scanned("surface isolation")),
        )
      },
    )

    // Layer-2 composition slices run ONLY the surface-isolation invariant above.
    if (config.surfaceIsolationOnly) return

    test("no file imports from the slice deny-list", () => {
      const violations: string[] = []
      for (const { file: f, src } of scanned("deny-list")) {
        const allow = allowSpecsForFile(config.allowImports, posixRel(dir, f))
        for (const { line, spec } of extractImports(src)) {
          if (isDeniedImport(spec, deny, allow)) {
            violations.push(`${posixRel(dir, f)}:${line}  import "${spec}"`)
          }
        }
      }
      if (violations.length > 0) {
        throw new Error(`@/${config.slice} deny-list violation:\n\n${violations.join("\n")}`)
      }
    })

    test("no file reads process.env or process.argv (must take plain config)", () => {
      const violations: string[] = []
      for (const { file: f, src } of scanned("process.env / argv")) {
        if (isEnvAllowed(envAllow, dir, f)) continue
        for (const { line, hit } of scanProcessEnvArgv(src)) {
          violations.push(`${relative(dir, f)}:${line}  ${hit}`)
        }
      }
      if (violations.length > 0) {
        throw new Error(
          `@/${config.slice} must not read process.env / process.argv:\n\n${violations.join("\n")}`,
        )
      }
    })

    test("no file touches process.stdin / process.stdout / process.stderr", () => {
      const violations: string[] = []
      for (const { file: f, src } of scanned("process stdio")) {
        const leaf = leafName(dir, f)
        if (stdioAllow.has(leaf)) continue
        for (const { line, hit } of scanProcessStdio(src)) {
          violations.push(`${relative(dir, f)}:${line}  ${hit}`)
        }
      }
      if (violations.length > 0) {
        throw new Error(
          `@/${config.slice} must not access raw process stdio:\n\n${violations.join("\n")}`,
        )
      }
    })

    test("no file calls console.log / error / warn / info / debug / dir / trace", () => {
      const violations: string[] = []
      for (const { file: f, src } of scanned("console.*")) {
        const leaf = leafName(dir, f)
        if (consoleAllow.has(leaf)) continue
        for (const { line, hit } of scanConsoleCalls(src)) {
          violations.push(`${relative(dir, f)}:${line}  ${hit}`)
        }
      }
      if (violations.length > 0) {
        throw new Error(`@/${config.slice} must not call console.*:\n\n${violations.join("\n")}`)
      }
    })

    test("no alt-runtime ENV/argv (Bun / Deno / import.meta.env / globalThis.process.*)", () => {
      const violations: string[] = []
      for (const { file: f, src } of scanned("alt-runtime ENV/argv")) {
        for (const { line, hit } of scanAltRuntimeEnvArgv(src)) {
          violations.push(`${relative(dir, f)}:${line}  ${hit}`)
        }
      }
      if (violations.length > 0) {
        throw new Error(
          `@/${config.slice} must not read alt-runtime ENV/argv:\n\n${violations.join("\n")}`,
        )
      }
    })

    test("no surface-coupled node modules (node:readline / tty / repl)", () => {
      const violations: string[] = []
      for (const { file: f, src } of scanned("node surface modules")) {
        for (const { line, spec } of extractImports(src)) {
          if (NODE_SURFACE_MODULES.has(spec)) {
            violations.push(`${relative(dir, f)}:${line}  import "${spec}"`)
          }
        }
      }
      if (violations.length > 0) {
        throw new Error(
          `@/${config.slice} must not import CLI-coupled node modules:\n\n${violations.join("\n")}`,
        )
      }
    })

    // BUDGET, not decoration. Measured on a full `bun test tests/unit tests/meta
    // tests/adversarial` run (39,118 arms, 3,034 files): this arm took 5,547ms
    // against bun's 5,000ms default and FAILED — reporting a guard violation
    // when the truth was that a repo-wide scan did not finish in time. Exactly
    // four arms in the whole suite exceed 2,500ms, and all four are repo-wide
    // source scans; unloaded this one passes in well under a second. A false
    // accusation is worse than a slow test: it trains the reader to discount the
    // gate, and it cost a real misattribution on 2026-08-28 before the four were
    // re-run serially and all passed. A genuine hang is still bounded by the
    // outer `timeout` on the suite command.
    test("no `node:process` named imports", () => {
      const violations: string[] = []
      for (const { file: f, src } of scanned("node:process named imports")) {
        for (const { line, hit } of scanNodeProcessNamedImports(src)) {
          violations.push(`${relative(dir, f)}:${line}  ${hit}`)
        }
      }
      if (violations.length > 0) {
        throw new Error(
          `@/${config.slice} must not use named imports from "node:process":\n\n${violations.join("\n")}`,
        )
      }
    }, 60_000)

    if (config.requireSliceBarrel) {
      test(`slice barrel exists (src/${config.slice}/index.ts)`, () => {
        let ok = false
        try {
          ok = statSync(join(dir, "index.ts")).isFile()
        } catch {
          ok = false
        }
        if (!ok) {
          throw new Error(`Slice barrel missing at src/${config.slice}/index.ts.`)
        }
      })
    }

    const subSliceBarrels = config.requireSubSliceBarrels
    if (subSliceBarrels && subSliceBarrels.length > 0) {
      test(`sub-slice barrels exist (${subSliceBarrels.join(", ")})`, () => {
        const missing = subSliceBarrels.filter((p) => {
          try {
            return !statSync(join(dir, p)).isFile()
          } catch {
            return true
          }
        })
        if (missing.length > 0) {
          throw new Error(
            `Sub-slice barrels missing under src/${config.slice}/: ${missing.join(", ")}`,
          )
        }
      })
    }
  })
}
