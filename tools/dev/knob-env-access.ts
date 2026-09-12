/**
 * `tools/dev/knob-env-access` — the AST census of `QUANTA_*` environment access.
 *
 * # Why this replaced a regex
 *
 * The completeness ratchet recognised a read only in three shapes: a quoted
 * token, `env.QUANTA_X` where the identifier is literally `env`, and a
 * destructure off `env` / `process.env`. Everything else was invisible, and
 * invisible meant an undeclared knob read green. Measured against the tree, the
 * shapes it could not see included:
 *
 *   env("QUANTA_PERMISSION", "default")   env is a FUNCTION, not a bag
 *   isOn(e.QUANTA_REWIND, "1")            bag aliased to `e`
 *   envSource.QUANTA_BROWSER_MCP_CONFIG   bag aliased to `envSource`
 *   args.envSource.QUANTA_BG_STORE_DIR    bag nested behind a field
 *   (env as { QUANTA_LLM_REPLAY?: string }).QUANTA_LLM_REPLAY
 *   intEnv("QUANTA_SHELL_SNAPSHOT_TIMEOUT_MS")
 *
 * A seventh regex would have closed six of those and left the seventh. The
 * classification below is structural instead.
 *
 * # What makes each rule a fact rather than a guess
 *
 * `QUANTA_*` is a RESERVED env-key namespace in this repo — no domain object
 * carries a property in it — so a property or element access whose NAME is a
 * `QUANTA_*` token is an environment access whatever the object expression is.
 * That is what lets the census stop trying to prove an identifier is a bag.
 *
 * A key never ends in `_`. `QUANTA_BENCH_`, `QUANTA_PROMAX_`,
 * `QUANTA_SWEBENCH_`, `QUANTA_VERIFICATION_LEASE_` are PREFIXES composed at the
 * call site; counting one as a scalar knob asks the registry to declare
 * something that is not a variable.
 *
 * A string literal is a read candidate only when its text is EXACTLY the key.
 * `Error("QUANTA_X failed")` is a message; `gateOn(env, "QUANTA_X")` is a read.
 * This is the AST version of the old `[=:]\s*"…"` trick and needs no anchor.
 *
 * Writes are not reads. `process.env.QUANTA_ALLOW_UNSIGNED = "1"` is a process
 * SEEDING its own child; asking the registry to declare it as a knob an operator
 * can set inverts the data flow. `delete env.QUANTA_X` is likewise not a read.
 *
 * # Deliberately not modelled
 *
 * Cross-module const resolution. `gateOn(env, SOME_ENV)` where `SOME_ENV` is
 * imported is reported as `const-alias-unresolved`, not silently dropped: the
 * caller decides whether an unresolved alias is a gap. Within one file the alias
 * IS resolved, which covers the const-keyed pattern the regex needed a special
 * case for.
 */
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import ts from "typescript"

const KEY_RE = /^QUANTA_[A-Z0-9_]+$/
/** A trailing `_` marks a composed prefix, never a scalar key. */
const isPrefixToken = (t: string): boolean => t.endsWith("_")
const isKeyToken = (t: string): boolean => KEY_RE.test(t) && !isPrefixToken(t)

/**
 * Whether an expression is SYNTACTICALLY an environment bag.
 *
 * The asymmetry this encodes is the whole design: when the key is visible in the
 * syntax (`bag.QUANTA_X`, `bag["QUANTA_X"]`) the object does not matter, because
 * `QUANTA_*` is a reserved namespace no domain object uses. When the key is NOT
 * visible (`bag[SOME_CONST]`, `bag[expr]`) the object is the only evidence there
 * is — so those forms are reported only for a bag, and `rows[i]` never enters the
 * census. Naming convention, not inference: every bag in this repo is
 * `process.env` or a binding whose last name segment ends in `env`/`Env`.
 */
const isEnvLikeExpression = (expr: ts.Expression): boolean => {
  if (ts.isPropertyAccessExpression(expr)) return /(^|[a-z])[Ee]nv$/.test(expr.name.text)
  if (ts.isIdentifier(expr)) return /(^|[a-z])[Ee]nv$/.test(expr.text)
  if (ts.isAsExpression(expr) || ts.isParenthesizedExpression(expr)) {
    return isEnvLikeExpression(expr.expression)
  }
  if (ts.isNonNullExpression(expr)) return isEnvLikeExpression(expr.expression)
  return false
}

export type KnobAccessKind = "read" | "write" | "delete" | "prefix" | "const-alias-unresolved"

export type KnobAccessForm =
  | "property"
  | "element-literal"
  | "element-alias"
  | "element-dynamic"
  | "destructure"
  | "call-arg"

export interface KnobAccess {
  readonly key: string
  readonly kind: KnobAccessKind
  readonly form: KnobAccessForm
  readonly file: string
  readonly line: number
}

export interface KnobAccessCensus {
  readonly accesses: readonly KnobAccess[]
  /** Files actually parsed — the anti-vacuity population. */
  readonly files: readonly string[]
}

/** Tracked `.ts`/`.mts`/`.mjs` under `roots`. `git ls-files` so an ignored src
 *  mirror (`tools/dev/.scratch`, `.pristine-audit`) can never enter a corpus and
 *  make the same ceiling mean different numbers on different machines. */
export const trackedSourceFiles = (repoRoot: string, roots: readonly string[]): string[] => {
  const out = execFileSync("git", ["ls-files", "-z", "--", ...roots], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
  return out
    .split("\0")
    .filter((p) => p !== "")
    .filter((p) => /\.(ts|mts|mjs)$/.test(p))
    .filter((p) => !p.endsWith(".d.ts"))
}

const lineOf = (sf: ts.SourceFile, node: ts.Node): number =>
  sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1

/** File-local `const X = "QUANTA_Y"` bindings, so `env[X]` resolves to `QUANTA_Y`. */
const collectLocalAliases = (sf: ts.SourceFile): Map<string, string> => {
  const aliases = new Map<string, string>()
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      const init = node.initializer
      const lit = ts.isAsExpression(init) ? init.expression : init
      if (ts.isStringLiteralLike(lit) && KEY_RE.test(lit.text)) {
        aliases.set(node.name.text, lit.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sf, visit)
  return aliases
}

/** Whether `node` is the target being assigned to (⇒ a write, not a read). */
const isAssignmentTarget = (node: ts.Node): boolean => {
  const p = node.parent
  if (p === undefined) return false
  if (ts.isBinaryExpression(p) && p.left === node) {
    const op = p.operatorToken.kind
    return (
      op === ts.SyntaxKind.EqualsToken ||
      op === ts.SyntaxKind.QuestionQuestionEqualsToken ||
      op === ts.SyntaxKind.BarBarEqualsToken ||
      op === ts.SyntaxKind.AmpersandAmpersandEqualsToken
    )
  }
  return false
}

const isDeleteTarget = (node: ts.Node): boolean =>
  node.parent !== undefined && ts.isDeleteExpression(node.parent)

const classify = (node: ts.Node): KnobAccessKind =>
  isDeleteTarget(node) ? "delete" : isAssignmentTarget(node) ? "write" : "read"

/** One emitter, shared by the per-form visitors below. */
type Push = (key: string, kind: KnobAccessKind, form: KnobAccessForm, node: ts.Node) => void

/** `<anything>.QUANTA_X` — the reserved namespace makes the object irrelevant. */
const visitPropertyAccess = (node: ts.Node, push: Push): void => {
  if (!ts.isPropertyAccessExpression(node)) return
  const t = node.name.text
  if (!KEY_RE.test(t)) return
  push(t, isPrefixToken(t) ? "prefix" : classify(node), "property", node)
}

/** `<anything>["QUANTA_X"]`, `[ALIAS]`, `[expr]`. */
const visitElementAccess = (
  node: ts.Node,
  aliases: ReadonlyMap<string, string>,
  push: Push,
): void => {
  if (!ts.isElementAccessExpression(node)) return
  const arg = node.argumentExpression
  if (ts.isStringLiteralLike(arg)) {
    const t = arg.text
    if (!KEY_RE.test(t)) return
    push(t, isPrefixToken(t) ? "prefix" : classify(node), "element-literal", node)
    return
  }
  // From here the key is NOT visible, so the object is the only evidence.
  if (!isEnvLikeExpression(node.expression)) return
  if (ts.isIdentifier(arg)) {
    const resolved = aliases.get(arg.text)
    if (resolved !== undefined) {
      push(resolved, isPrefixToken(resolved) ? "prefix" : classify(node), "element-alias", node)
      return
    }
    // A SCREAMING_CASE index into a bag that did not resolve in THIS file is an
    // imported key constant — reported under its own name so a reviewer can go
    // find the declaration.
    if (/^[A-Z][A-Z0-9_]*$/.test(arg.text)) {
      push(arg.text, "const-alias-unresolved", "element-alias", node)
      return
    }
    // Any other identifier index into a bag is a runtime-computed key. It is
    // still an env read, it just cannot be attributed — dropping it here is how
    // a dynamic lookup would slip past a guard that bans the shape.
    push("<computed>", "const-alias-unresolved", "element-dynamic", node)
    return
  }
  // A computed index into a bag cannot be attributed to a key at all. Surfaced
  // so a guard can BAN the shape rather than chase it with another regex.
  push("<computed>", "const-alias-unresolved", "element-dynamic", node)
}

/** `const { QUANTA_X, QUANTA_Y } = <anything>`. */
const visitDestructure = (node: ts.Node, push: Push): void => {
  if (!ts.isObjectBindingPattern(node)) return
  for (const el of node.elements) {
    const name = el.propertyName ?? el.name
    if (ts.isIdentifier(name) && isKeyToken(name.text)) push(name.text, "read", "destructure", el)
  }
}

/** `f(…, "QUANTA_X", …)` — exact-text literal only, so messages are excluded. */
const visitCallArgs = (node: ts.Node, push: Push): void => {
  if (!ts.isCallExpression(node)) return
  for (const a of node.arguments) {
    if (!ts.isStringLiteralLike(a)) continue
    const t = a.text
    if (!KEY_RE.test(t)) continue
    push(t, isPrefixToken(t) ? "prefix" : "read", "call-arg", a)
  }
}

/** Census one parsed file. Pure w.r.t. the filesystem. */
export const censusSource = (file: string, text: string): KnobAccess[] => {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)
  const aliases = collectLocalAliases(sf)
  const hits: KnobAccess[] = []
  const push: Push = (key, kind, form, node) => {
    hits.push({ key, kind, form, file, line: lineOf(sf, node) })
  }
  const visit = (node: ts.Node): void => {
    visitPropertyAccess(node, push)
    visitElementAccess(node, aliases, push)
    visitDestructure(node, push)
    visitCallArgs(node, push)
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sf, visit)
  return hits
}

export const censusFiles = (repoRoot: string, files: readonly string[]): KnobAccessCensus => {
  const accesses: KnobAccess[] = []
  for (const rel of files) {
    accesses.push(...censusSource(rel, readFileSync(join(repoRoot, rel), "utf8")))
  }
  return { accesses, files }
}

/** Distinct keys that are genuinely READ (writes, deletes, prefixes and
 *  unresolved aliases excluded), optionally ignoring declaration files. */
export const readKeys = (
  census: KnobAccessCensus,
  isDeclarationFile: (file: string) => boolean = () => false,
): Map<string, KnobAccess> => {
  const out = new Map<string, KnobAccess>()
  for (const a of census.accesses) {
    if (a.kind !== "read") continue
    if (isDeclarationFile(a.file)) continue
    if (!out.has(a.key)) out.set(a.key, a)
  }
  return out
}

/**
 * Every `QUANTA_*` key TOKEN appearing as a string literal in a declaration
 * file. Deliberately static, like the ratchet it feeds: importing the registries
 * to read them would make the census depend on module-registration side effects,
 * and `allKnobs()` is empty until the register modules are pulled in — a live
 * trap that silently turns declared knobs into orphans.
 *
 * Broader than the access census on purpose: a declaration is `envKey: "X"`, a
 * PropertyAssignment, which is not an access shape at all.
 */
export const declaredKeysInSources = (
  repoRoot: string,
  files: readonly string[],
  isDeclarationFile: (file: string) => boolean,
): Set<string> => {
  const out = new Set<string>()
  for (const rel of files) {
    if (!isDeclarationFile(rel)) continue
    const sf = ts.createSourceFile(
      rel,
      readFileSync(join(repoRoot, rel), "utf8"),
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TS,
    )
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteralLike(node) && isKeyToken(node.text)) out.add(node.text)
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(sf, visit)
  }
  return out
}
