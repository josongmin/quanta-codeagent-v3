/**
 * `tools/dev/root-scratch-scan` — a test that writes into the repository ROOT.
 *
 * # Why this is a parse and not a regex
 *
 * The guard that preceded it was one regex:
 *
 *   /join\(\s*REPO_ROOT\s*,\s*`[^`\/]*\$\{[^}]*\}[^`\/]*\.(?:ts|js|mjs|cjs|json|txt)`/
 *
 * It caught the exact line that leaked and, MEASURED against eight realistic
 * spellings of the same mistake, one of eight:
 *
 *   caught   join(REPO_ROOT, `probe-${process.pid}.ts`)
 *   MISSED   join(REPO_ROOT, "probe.ts")
 *   MISSED   resolve(REPO_ROOT, `probe-${process.pid}.ts`)
 *   MISSED   writeFileSync(`${REPO_ROOT}/probe-${process.pid}.ts`, x)
 *   MISSED   join(REPO_ROOT, `probe-${process.pid}.md`)
 *   MISSED   join(REPO_ROOT, `probe-${process.pid}`)
 *   MISSED   join(repoRoot, `probe-${process.pid}.ts`)
 *   MISSED   join(ROOT, `probe-${process.pid}.ts`)
 *
 * An extension list and one helper name is not the invariant. The invariant is
 * "a WRITE whose destination is a leaf of the repository root", and separating
 * writes from reads is what keeps it from firing on the hundreds of legitimate
 * `readFileSync(join(REPO_ROOT, "package.json"))` calls. That distinction needs
 * the call, not the path — so it needs a parse.
 *
 * # Why the root leaf and not any repo path
 *
 * A pid-named file under `.cache/` is invisible to git and to every gate. The
 * same file at the repository root survives a SIGKILL, and the NEXT run's
 * typecheck, lint and `lint:debt` all see a stray source file. The root is the
 * only directory where a leak changes another run's verdict.
 */

import ts from "typescript"

/**
 * Calls whose destination argument is a path that will be created, and WHICH
 * argument that is.
 *
 * A `Map`, not an object literal: a source file that calls `constructor(...)`
 * or `toString(...)` reaches `Object.prototype` through a plain record and the
 * lookup returns something that is not a list. Measured as a crash on the real
 * corpus the first time this ran.
 */
const WRITE_CALLS = new Map<string, readonly number[]>([
  ["writeFileSync", [0]],
  ["appendFileSync", [0]],
  ["mkdirSync", [0]],
  ["mkdtempSync", [0]],
  ["openSync", [0]],
  ["createWriteStream", [0]],
  ["copyFileSync", [1]],
  ["cpSync", [1]],
  ["renameSync", [1]],
  ["symlinkSync", [1]],
  ["linkSync", [1]],
  ["write", [0]],
])

/**
 * Identifiers that NAME the repository root by convention.
 *
 * Convention alone is not enough and the name list alone was wrong: `root` and
 * `repoDir` are the commonest names for a `mkdtempSync` FIXTURE directory in
 * this corpus, and a first pass that trusted the name reported 119 writes, of
 * which essentially all were tests writing into their own temp dir. A binding
 * counts only when its initializer walks up from the SOURCE FILE — that is what
 * makes it the repository root rather than somewhere a test owns.
 */
const ROOT_BY_NAME = /^(?:REPO_ROOT|REPO_DIR)$/

/** `resolve(import.meta.dir, "..", "..")`, `dirname(fileURLToPath(...))`, … */
const ROOT_FROM_SOURCE_FILE = /import\.meta\.(?:dir|url)|fileURLToPath/

export interface RootScratchWrite {
  readonly line: number
  /** The destination expression, as written. */
  readonly text: string
  /** The write call it was passed to. */
  readonly callee: string
}

const calleeName = (node: ts.CallExpression, source: ts.SourceFile): string => {
  const text = node.expression.getText(source)
  return text.split(".").pop() ?? text
}

/**
 * Names bound, in THIS file, to a path computed by walking up from the source
 * file — plus the two the repository spells in capitals by convention.
 */
const rootBindings = (source: ts.SourceFile): ReadonlySet<string> => {
  const names = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const initializer = node.initializer?.getText(source) ?? ""
      if (ROOT_BY_NAME.test(node.name.text) || ROOT_FROM_SOURCE_FILE.test(initializer)) {
        names.add(node.name.text)
      }
    }
    // An import of `REPO_ROOT` from a helper is the same thing by another route.
    if (ts.isImportSpecifier(node) && ROOT_BY_NAME.test(node.name.text)) names.add(node.name.text)
    node.forEachChild(visit)
  }
  visit(source)
  return names
}

const isRootIdentifier = (node: ts.Expression, roots: ReadonlySet<string>): boolean =>
  ts.isIdentifier(node) && roots.has(node.text)

/** A literal path segment with no separator — i.e. a leaf of its parent. */
const isLeafLiteral = (node: ts.Expression, source: ts.SourceFile): boolean => {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return !node.text.includes("/") && node.text !== "" && node.text !== "."
  }
  if (ts.isTemplateExpression(node)) {
    // A dynamic leaf: `probe-${process.pid}.ts`. Every literal piece must be
    // separator-free, or it descends into a subdirectory.
    const pieces = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)]
    return pieces.every((piece) => !piece.includes("/"))
  }
  return false
}

/**
 * `true` when the expression names a file directly inside the repository root.
 *
 * Three shapes, because all three appear in this tree: `join(ROOT, leaf)`,
 * `resolve(ROOT, leaf)` and a template `${ROOT}/leaf`.
 */
const isRootLeafPath = (
  node: ts.Expression,
  source: ts.SourceFile,
  roots: ReadonlySet<string>,
): boolean => {
  if (ts.isCallExpression(node)) {
    const name = calleeName(node, source)
    if ((name === "join" || name === "resolve") && node.arguments.length === 2) {
      const [base, leaf] = node.arguments
      return (
        base !== undefined &&
        leaf !== undefined &&
        isRootIdentifier(base, roots) &&
        isLeafLiteral(leaf, source)
      )
    }
    return false
  }
  if (ts.isTemplateExpression(node)) {
    // `${ROOT}/name-${pid}.ts`: head empty, first span is the root, and the
    // literal that follows starts with exactly one separator.
    const first = node.templateSpans[0]
    if (node.head.text !== "" || first === undefined) return false
    if (!isRootIdentifier(first.expression, roots)) return false
    if (!first.literal.text.startsWith("/")) return false
    const rest = [
      first.literal.text.slice(1),
      ...node.templateSpans.slice(1).map((span) => span.literal.text),
    ]
    return rest.every((piece) => !piece.includes("/"))
  }
  return false
}

/**
 * Dot-prefixed leaves are the repository's ignored scratch space (`.cache`,
 * `.tmp`). A DYNAMIC leaf is never exempt: a pid-named file cannot be listed in
 * `.gitignore` by name, which is the whole reason the original leak survived.
 */
const isIgnoredLeaf = (node: ts.Expression): boolean =>
  (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
  node.text.startsWith(".")

const destinationLeaf = (node: ts.Expression): ts.Expression | undefined => {
  if (ts.isCallExpression(node) && node.arguments.length === 2) return node.arguments[1]
  return undefined
}

/** Every write in `text` whose destination is a leaf of the repository root. */
export const rootScratchWrites = (text: string, path = "input.ts"): readonly RootScratchWrite[] => {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const roots = rootBindings(source)
  if (roots.size === 0) return []
  const found: RootScratchWrite[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node, source)
      for (const index of WRITE_CALLS.get(name) ?? []) {
        const argument = node.arguments[index]
        if (argument === undefined) continue
        if (!isRootLeafPath(argument, source, roots)) continue
        const leaf = destinationLeaf(argument)
        if (leaf !== undefined && isIgnoredLeaf(leaf)) continue
        found.push({
          line: source.getLineAndCharacterOfPosition(argument.getStart(source)).line + 1,
          text: argument.getText(source),
          callee: name,
        })
      }
    }
    node.forEachChild(visit)
  }
  visit(source)
  return found
}

/**
 * Cheap prefilter: files that cannot possibly match are not parsed.
 *
 * Three conditions, all necessary for the AST rule to fire, because the parse is
 * the expensive part — measured 2.9s for 141 files and 1.8s for 85. A file needs
 * a root-shaped binding, a write call, and a two-argument `join`/`resolve` with a
 * literal leaf (or a `${X}/…` template) for any hit to be possible.
 *
 * It is a filter on the PARSE, never on the verdict: the test that uses it pins
 * that every shape the parser flags also passes the filter, so an over-tight
 * prefilter fails loudly instead of hiding an offender.
 */
export const mightWriteToRoot = (text: string): boolean =>
  ROOT_MENTION.test(text) && WRITE_MENTION.test(text) && PATH_SHAPE.test(text)

const ROOT_MENTION = /\b(?:REPO_ROOT|REPO_DIR)\b|import\.meta\.(?:dir|url)|fileURLToPath/
const PATH_SHAPE = /(?:join|resolve)\(\s*[A-Za-z_$][\w$]*\s*,|`\$\{[A-Za-z_$][\w$]*\}\//
const WRITE_MENTION = new RegExp(`\\b(?:${[...WRITE_CALLS.keys()].join("|")})\\b`)
