/**
 * `tools/dev/catalog-config-refs` — an env var the catalog offers an operator
 * must be one some code READS.
 *
 * # The defect
 *
 * `config_refs.env` renders as "**Configurable**: partial · env: …" in
 * `docs/10.feature-catalog.md`, `knobs` renders as ⚙️ rows, and the default-off
 * ledger's `gate_owner` names the switch that turns a feature on. Operators and
 * CI authors read all three, and nothing checked the NAMES. A CI job copied from
 * the TVH-03 handoff set `QUANTA_REQUIRE_CAPABILITY=<group>`, which armed
 * nothing, and reported a pass.
 *
 * # Why evidence is a SHAPE, and why every shape is a parse or a tokenizer
 *
 * `grep -w QUANTA_REQUIRE_CAPABILITY` finds four hits — docstrings saying the
 * name is retired and a test asserting it does nothing. A mention-based guard
 * calls the deadest name alive and is satisfied forever by the test proving it
 * dead. So a name is backed only by a READ, recognised per language:
 *
 *   ts-literal   TS/JS string literal equal to the name, outside test files
 *                (`gateOn(env, "QUANTA_X")`, `envKey: "QUANTA_X"`)
 *   ts-access    `x.QUANTA_X`, `x["QUANTA_X"]`, object destructuring of the key,
 *                an assignment pattern, or `"QUANTA_X" in env` — never a write
 *   quoted       a string TOKEN in Python / Swift / Rust / Kotlin / Go / Java,
 *                comments masked by a tokenizer, writes (`.env("X", …)`,
 *                `setenv`) excluded, and in test files only in a read context
 *   shell        `$X` / `${X}` in shell, extensionless scripts and
 *                `package.json` scripts, outside comments and single quotes
 *                (quote state carried across lines)
 *   workflow     `vars.X` / `env.X` / `secrets.X` inside `${{ … }}` or an `if:`
 *                value of a parsed workflow, and the shell rule over `run:`
 *                bodies; `env:` KEYS are writes
 *
 * # What the previous version got wrong, each found by an audit of it
 *
 * - The two raw-text shapes were regexes over whole files. "A comment is not a
 *   node" held for TypeScript and not for them, so two names were backed by
 *   `#`-commented lines in a workflow TEMPLATE. Line-prefix stripping, the first
 *   patch, still accepted trailing and block comments, Python docstrings, step
 *   names and `.github/workflows/README.md`: 34 false greens in 62 probes.
 * - Every `.ts` file was parsed as TSX, where `<T>(x) =>` and `<T>expr` casts do
 *   not parse. 70 files in the tree misparsed and 25 real reads vanished.
 * - `??=`, `||=`, `&&=`, array bindings and rest bindings were READS; string-keyed
 *   object literal members, `type T = "X"` and Rust `.env("X", …)` were READS;
 *   `({ QUANTA_X: v } = env)` and `"X" in env` were not.
 * - Knobs without `where: "env"` were never extracted, so three names the
 *   catalog still offered as env knobs were read by nothing. Ledger
 *   `gate_owner` was not extracted at all.
 * - The corpus was six roots and three TS extensions: `adapters/`, shell
 *   scripts, extensionless scripts and `package.json` were invisible.
 *
 * # What the second audit found, and what is still true
 *
 * - Shell quote state reset per line, and heredocs were detected on the raw
 *   line, so a comment or string mentioning `<<EOF`, or `$((1<<N))`, switched
 *   off all masking for the rest of the file; a quoted delimiter was masked away.
 * - Workflow `env.X` matched anywhere in a scalar: a step NAME, a `run:` comment
 *   and an echoed string each backed a name.
 * - Python `os.environ["X"] = …`, `del`, `.pop` and dict keys, and TypeScript
 *   destructuring / `for…of` targets, were reads. `expect(process.env.X)` in a
 *   test backed the name it asserted dead.
 * - A tracked file deleted in the worktree crashed the scan.
 * - A dozen masking and language rules could each be deleted with the suite
 *   green; each now has a fixture line only it decides.
 *
 * # What the third audit found
 *
 * - Masking ran over heredoc bodies, so an apostrophe in a body masked every read
 *   after it; `$'it\'s'`, `don\'t` and `"$(echo "don't")"` did the same. Openers
 *   were still found inside double quotes, in nested arithmetic and in `<<<`.
 * - Only `${{ }}` read in a workflow, which dropped `process.env.X` in a
 *   github-script `script:` and in a `bun -e '…'` of a `run:` body.
 * - `token = os.environ.pop("X")` and `for n in "A", "X":` were writes.
 * - Fourteen rules still had no fixture line, and the four catalog fields were
 *   composed in the test, where dropping `activation` was green.
 *
 * STILL a limit, measured and left: a registry literal counts wherever a
 * generic accessor reads `env[entry.envKey]` for every entry (the knob
 * inventory's is `cli-knobs-accessor.ts`), so removing a knob's BEHAVIOURAL
 * reader leaves it backed by the accessor. Today no declared name is backed only
 * by a declaration-only file. Go backtick strings, Rust raw strings and reads
 * inside Python f-strings are not tokenized; each would show as a false red.
 */

import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import ts from "typescript"
import { isMap, isPair, isScalar, isSeq, parseDocument, type YAMLMap } from "yaml"

export type EnvEvidenceKind = "ts-literal" | "ts-access" | "quoted" | "shell" | "workflow"

export interface EnvEvidence {
  readonly kind: EnvEvidenceKind
  /** `path:line` for parsed shapes, the path for tokenized ones. */
  readonly where: string
}

/** Which records declare each env name. */
export type DeclaredEnvNames = ReadonlyMap<string, readonly string[]>

export interface UnbackedEnvName {
  readonly name: string
  readonly records: readonly string[]
}

export interface CatalogEnvSource {
  readonly path: string
  readonly env: readonly string[]
}

// ── the corpus ──────────────────────────────────────────────────────────────

/** Prose, the catalog itself, and the vendored task dataset are not readers. */
const EXCLUDED =
  /^(?:docs\/|terminal-bench\/|tools\/feature-catalog\/)|\.md$|(?:^|\/)\.env\.example$/

/**
 * Every tracked file that could read an environment variable.
 *
 * Whole repository, minus exclusions. Six hand-picked roots were the previous
 * corpus, and `adapters/terminal-bench/bin/quanta-terminal-brain` reads
 * `$QUANTA_TERMINAL_BRAIN_REPO` from outside all of them.
 */
export const catalogCorpus = (repoRoot: string): readonly string[] =>
  execFileSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter((path) => path !== "" && !EXCLUDED.test(path))

type Lang = "ts" | "tsx" | "js" | "jsx" | "py" | "shell" | "cstyle" | "workflow" | "package-json"

/** The language a file is READ as, or `undefined` when it cannot hold a read. */
export const languageOf = (rel: string, head: () => string): Lang | undefined => {
  // Installed workflows only: a `.yml.template` and a README are not workflows,
  // and `gate-manifest.ts` already says so of the template.
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(rel)) return "workflow"
  if (/(?:^|\/)package\.json$/.test(rel)) return "package-json"
  if (/\.d\.[cm]?ts$/.test(rel)) return undefined
  if (/\.[cm]?ts$/.test(rel)) return "ts"
  if (/\.tsx$/.test(rel)) return "tsx"
  if (/\.[cm]?js$/.test(rel)) return "js"
  if (/\.jsx$/.test(rel)) return "jsx"
  if (/\.py$/.test(rel)) return "py"
  if (/\.(?:sh|bash|zsh)$/.test(rel) || /(?:^|\/)(?:Dockerfile|[Jj]ustfile|Makefile)$/.test(rel)) {
    return "shell"
  }
  if (/\.(?:swift|rs|kt|java|go)$/.test(rel)) return "cstyle"
  if (/(?:^|\/)[^/.]+$/.test(rel)) {
    const first = head()
    if (/^#!.*\b(?:ba|z|da)?sh\b/.test(first)) return "shell"
    if (/^#!.*\b(?:bun|node)\b/.test(first)) return "js"
    if (/^#!.*python/.test(first)) return "py"
  }
  return undefined
}

/**
 * In a test file a bare literal NAMES a variable rather than reading it — which
 * is how this guard's own fixtures once backed the names they test. A read shape
 * still counts there.
 */
export const isTestFile = (rel: string): boolean =>
  /(?:^|\/)(?:tests|__tests__|__mocks__|__fixtures__|fixtures)\//.test(rel) ||
  /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(rel) ||
  /(?:^|\/)(?:test_[^/]+|[^/]+_test)\.(?:py|go)$/.test(rel) ||
  /(?:^|\/)Tests\/.+\.swift$/.test(rel)

// ── TypeScript / JavaScript ─────────────────────────────────────────────────

const K = ts.SyntaxKind

const scriptKindOf = (lang: Lang): ts.ScriptKind => {
  if (lang === "tsx") return ts.ScriptKind.TSX
  if (lang === "jsx") return ts.ScriptKind.JSX
  if (lang === "js") return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

/** `??=`, `||=` and `&&=` default a variable. They were counted as reads. */
const WRITE_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  K.EqualsToken,
  K.QuestionQuestionEqualsToken,
  K.BarBarEqualsToken,
  K.AmpersandAmpersandEqualsToken,
])

/** `(process.env.X) = "1"` and `process.env.X! = "1"` are the same write. */
const outermostWrapper = (node: ts.Node): ts.Node => {
  let current = node
  while (
    current.parent !== undefined &&
    (ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isNonNullExpression(current.parent) ||
      ts.isSatisfiesExpression(current.parent) ||
      ts.isTypeAssertionExpression(current.parent))
  ) {
    current = current.parent
  }
  return current
}

/**
 * The root of the destructuring TARGET `node` sits in, if any: `[process.env.X] = v`,
 * `({ a: process.env.X } = v)`, `for (process.env.X of xs)`. Each assigns to the
 * access; each was counted as a read.
 */
const destructuringTargetRoot = (node: ts.Node): ts.Node | undefined => {
  let current = node
  let climbed = false
  for (;;) {
    const parent = current.parent
    if (parent === undefined) return undefined
    const inPattern =
      ts.isArrayLiteralExpression(parent) ||
      ts.isSpreadElement(parent) ||
      (ts.isPropertyAssignment(parent) && parent.initializer === current) ||
      ts.isObjectLiteralExpression(parent) ||
      ts.isParenthesizedExpression(parent)
    if (!inPattern) break
    climbed = climbed || !ts.isParenthesizedExpression(parent)
    current = parent
  }
  return climbed ? current : undefined
}

const isWriteTarget = (node: ts.Node): boolean => {
  const target = outermostWrapper(node)
  const parent = target.parent
  if (parent === undefined) return false
  if (ts.isDeleteExpression(parent)) return true
  if (
    ts.isBinaryExpression(parent) &&
    parent.left === target &&
    WRITE_OPERATORS.has(parent.operatorToken.kind)
  ) {
    return true
  }
  if (
    (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) &&
    parent.initializer === target
  ) {
    return true
  }
  const root = destructuringTargetRoot(target)
  if (root === undefined || root.parent === undefined) return false
  const holder = root.parent
  return (
    (ts.isBinaryExpression(holder) &&
      holder.left === root &&
      holder.operatorToken.kind === K.EqualsToken) ||
    ((ts.isForOfStatement(holder) || ts.isForInStatement(holder)) && holder.initializer === root)
  )
}

/** The KEY of a write is part of the write, or `bag["X"] = 1` is re-admitted one node down. */
const isWriteKeyLiteral = (node: ts.Node): boolean =>
  node.parent !== undefined &&
  ts.isElementAccessExpression(node.parent) &&
  node.parent.argumentExpression === node &&
  isWriteTarget(node.parent)

/** `({ QUANTA_X: v } = env)` — the object literal is an assignment PATTERN, which reads. */
const isAssignmentPattern = (literal: ts.ObjectLiteralExpression): boolean => {
  let current: ts.Node = literal
  while (
    current.parent !== undefined &&
    (ts.isPropertyAssignment(current.parent) ||
      ts.isObjectLiteralExpression(current.parent) ||
      ts.isArrayLiteralExpression(current.parent) ||
      ts.isParenthesizedExpression(current.parent))
  ) {
    current = current.parent
  }
  const parent = current.parent
  if (parent === undefined) return false
  if (ts.isBinaryExpression(parent)) {
    return parent.left === current && parent.operatorToken.kind === K.EqualsToken
  }
  return (
    (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.initializer === current
  )
}

const keyText = (name: ts.Node): string | undefined =>
  ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)
    ? name.text
    : undefined

type Hit = { readonly name: string; readonly kind: EnvEvidenceKind } | undefined

const classifyLiteral = (
  node: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral,
  literals: boolean,
): Hit => {
  const parent = node.parent
  if (isWriteKeyLiteral(node)) return undefined
  if (parent !== undefined && ts.isLiteralTypeNode(parent)) return undefined
  if (
    parent !== undefined &&
    ts.isBinaryExpression(parent) &&
    parent.left === node &&
    parent.operatorToken.kind === K.InKeyword
  ) {
    return { name: node.text, kind: "ts-access" }
  }
  // A string KEY of an object literal builds a bag, exactly like an identifier key.
  if (
    parent !== undefined &&
    ts.isPropertyAssignment(parent) &&
    parent.name === node &&
    ts.isObjectLiteralExpression(parent.parent) &&
    !isAssignmentPattern(parent.parent)
  ) {
    return undefined
  }
  return literals ? { name: node.text, kind: "ts-literal" } : undefined
}

const classifyNode = (node: ts.Node, literals: boolean): Hit => {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return classifyLiteral(node, literals)
  }
  if (
    (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
    ts.isObjectLiteralExpression(node.parent) &&
    isAssignmentPattern(node.parent)
  ) {
    const name = keyText(node.name)
    return name === undefined ? undefined : { name, kind: "ts-access" }
  }
  if (isWriteTarget(node)) return undefined
  if (ts.isPropertyAccessExpression(node)) return { name: node.name.text, kind: "ts-access" }
  if (ts.isElementAccessExpression(node)) {
    const name = keyText(node.argumentExpression)
    return name === undefined ? undefined : { name, kind: "ts-access" }
  }
  if (
    ts.isBindingElement(node) &&
    ts.isObjectBindingPattern(node.parent) &&
    node.dotDotDotToken === undefined
  ) {
    const name = keyText(node.propertyName ?? node.name)
    return name === undefined ? undefined : { name, kind: "ts-access" }
  }
  return undefined
}

// ── tokenized languages ─────────────────────────────────────────────────────

interface StringToken {
  readonly value: string
  readonly offset: number
}

/** Index just past a block comment, honouring nesting (Swift and Rust nest them). */
const skipBlockComment = (text: string, start: number): number => {
  let depth = 1
  let index = start + 2
  while (index < text.length && depth > 0) {
    if (text.startsWith("/*", index)) {
      depth += 1
      index += 2
    } else if (text.startsWith("*/", index)) {
      depth -= 1
      index += 2
    } else {
      index += 1
    }
  }
  return index
}

/**
 * String tokens of a C-family source, comments masked.
 *
 * A Rust or Kotlin character literal such as `'"'` is skipped whole. Read as
 * text, its double quote would open a string that runs to the end of the line
 * and swallow a real read after it. A lifetime (`'a`) has no closing quote and
 * does not match.
 */
export const cStyleStrings = (text: string): readonly StringToken[] => {
  const out: StringToken[] = []
  let index = 0
  while (index < text.length) {
    if (text.startsWith("//", index)) {
      const end = text.indexOf("\n", index)
      index = end === -1 ? text.length : end
    } else if (text.startsWith("/*", index)) {
      index = skipBlockComment(text, index)
    } else if (text[index] === "'") {
      const character = /^'(?:\\.|[^\\'\n])'/.exec(text.slice(index, index + 4))
      index += character === null ? 1 : character[0].length
    } else if (text.startsWith('"""', index)) {
      const end = text.indexOf('"""', index + 3)
      const stop = end === -1 ? text.length : end
      out.push({ value: text.slice(index + 3, stop), offset: index })
      index = stop + 3
    } else if (text[index] === '"') {
      const start = index + 1
      let cursor = start
      while (cursor < text.length && text[cursor] !== '"' && text[cursor] !== "\n") {
        cursor += text[cursor] === "\\" ? 2 : 1
      }
      out.push({ value: text.slice(start, cursor), offset: index })
      index = cursor + 1
    } else {
      index += 1
    }
  }
  return out
}

/** String tokens of Python, `#` comments masked, f-strings skipped. */
export const pythonStrings = (text: string): readonly StringToken[] => {
  const out: StringToken[] = []
  let index = 0
  while (index < text.length) {
    const character = text[index]
    if (character === "#") {
      const end = text.indexOf("\n", index)
      index = end === -1 ? text.length : end
      continue
    }
    if (character !== '"' && character !== "'") {
      index += 1
      continue
    }
    const prefix = /[rRbBuUfF]{0,2}$/.exec(text.slice(Math.max(0, index - 2), index))?.[0] ?? ""
    const triple = text.startsWith(character.repeat(3), index)
    const quote = triple ? character.repeat(3) : character
    const start = index + quote.length
    let cursor = start
    while (
      cursor < text.length &&
      !text.startsWith(quote, cursor) &&
      (triple || text[cursor] !== "\n")
    ) {
      cursor += text[cursor] === "\\" ? 2 : 1
    }
    if (!/[fF]/.test(prefix)) out.push({ value: text.slice(start, cursor), offset: index })
    index = cursor + quote.length
  }
  return out
}

const RAW_WRITE_CONTEXT =
  /(?:\.env|\.env_remove|set_var|remove_var|setenv|Setenv|Unsetenv|putenv|delenv)\(\s*$/

/** `os.environ.pop(` / `.setdefault(`: a write only as a bare statement (see `isPythonWrite`). */
const PY_CONSUMING_CALL = /^[ \t]*[\w.]*environ\.(?:pop|setdefault)\(\s*$/u

/**
 * The innermost bracket still open at `offset`, scanning back. Brackets inside
 * strings are counted too; a Python dict key whose enclosing literal holds an
 * unbalanced bracket in a string reads as not-a-key, which is the read side.
 */
const innermostOpenBracket = (text: string, offset: number): string | undefined => {
  const closes: string[] = []
  const pairs: Readonly<Record<string, string>> = { ")": "(", "]": "[", "}": "{" }
  for (let index = offset - 1; index >= 0; index -= 1) {
    const character = text[index] ?? ""
    if (character in pairs) closes.push(pairs[character] ?? "")
    else if (character === "(" || character === "[" || character === "{") {
      if (closes.length === 0) return character
      closes.pop()
    }
  }
  return undefined
}

/**
 * A Python token that is written, not read: `os.environ["X"] = "1"`,
 * `del os.environ["X"]`, a dict KEY (`env={"X": "1"}`), or a bare
 * `os.environ.pop("X")` / `.setdefault("X", …)` statement. All were backed — and
 * in a test file `environ[` is a read context, so the write qualified there.
 *
 * `token = os.environ.pop("X", None)` READS the value it removes, and
 * `v = os.environ.setdefault("X", "1")` returns it: both were writes. And
 * `for n in "A", "X":` matched the dict-key rule on its comma and colon; a key
 * now needs a `{` as the innermost open bracket.
 */
const isPythonWrite = (text: string, offset: number, value: string): boolean => {
  const quoteLength =
    text.startsWith(`"${value}"`, offset) || text.startsWith(`'${value}'`, offset) ? 1 : 0
  const after = text.slice(offset + value.length + quoteLength * 2, offset + value.length + 40)
  const before = text.slice(Math.max(0, offset - 40), offset)
  const lineHead = text.slice(text.lastIndexOf("\n", offset - 1) + 1, offset)
  return (
    /^\s*\]\s*=(?!=)/u.test(after) ||
    /\bdel\s+[\w.]*environ\[\s*$/u.test(before) ||
    PY_CONSUMING_CALL.test(lineHead) ||
    (/^\s*:/u.test(after) && /[{,]\s*$/u.test(before) && innermostOpenBracket(text, offset) === "{")
  )
}
const RAW_READ_CONTEXT =
  /(?:environment\[|getenv\(|Getenv\(|LookupEnv\(|env::var\(|env::var_os\(|environ\[|environ\.get\(|environ\.pop\(|environ\.setdefault\(|env_var\(|env_var_or_default\()\s*$/

/** Python READS by call shape only: in a test, an embedded heredoc, or a `-c` argument. */
const pythonReads = (text: string, names: ReadonlySet<string>): readonly string[] =>
  pythonStrings(text).flatMap(({ value, offset }) =>
    names.has(value) &&
    RAW_READ_CONTEXT.test(text.slice(Math.max(0, offset - 32), offset)) &&
    !isPythonWrite(text, offset, value)
      ? [value]
      : [],
  )

/** JavaScript READS (accesses, never bare literals) in code embedded in another file. */
const scriptReads = (code: string, names: ReadonlySet<string>): readonly string[] => {
  const found: string[] = []
  const source = ts.createSourceFile(
    "inline.js",
    code,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.JS,
  )
  const visit = (node: ts.Node): void => {
    const hit = classifyNode(node, false)
    if (hit !== undefined && names.has(hit.name)) found.push(hit.name)
    node.forEachChild(visit)
  }
  visit(source)
  return found
}

/** An interpreter handed code on its command line: `bun -e '…'`, `python3 -c '…'`. */
const JS_INLINE =
  /\b(?:bun|node|deno|tsx)(?:\s+run)?(?:\s+-{1,2}[\w-]+)*?\s+(?:-e|--eval|-p|--print)\s*$/u
const PY_INLINE = /\bpython[\d.]*(?:\s+-{1,2}[\w-]+)*?\s+-c\s*$/u
const JS_INTERPRETER = /\b(?:bun|node|deno|tsx)\b/u

type ShellFrameKind = "single" | "ansi" | "double" | "substitution"

interface ShellFrame {
  readonly kind: ShellFrameKind
  /** The code in front of the opening quote: an inline script's command. */
  readonly before: string
  parens: number
  text: string
}

/** A quoted span that closed, with the code in front of it: an inline script's argument. */
interface QuotedSpan {
  readonly before: string
  readonly text: string
}

interface HeredocBody {
  readonly heredoc: number
  /** A quoted or escaped delimiter: the body does not expand. */
  readonly literal: boolean
  /** The code in front of the opener: which interpreter reads the body. */
  readonly command: string
}

interface ShellLine {
  /** Code: single-quoted text and comments removed, double-quoted text kept (it expands). */
  readonly code: string
  readonly raw: string
  readonly spans: readonly QuotedSpan[]
  readonly body?: HeredocBody
}

/** Remove balanced `((…))` spans, `$((…))` included: `1<<SHIFT` is a shift, not a heredoc. */
const stripArithmetic = (code: string): string => {
  let out = ""
  let index = 0
  while (index < code.length) {
    if (!code.startsWith("((", index)) {
      out += code[index]
      index += 1
      continue
    }
    let depth = 0
    let end = index
    for (; end < code.length; end += 1) {
      depth += code[end] === "(" ? 1 : code[end] === ")" ? -1 : 0
      if (depth === 0) break
    }
    index = end + 1
  }
  return out
}

const HEREDOC =
  /(?<!<)<<(?!<)-?\s*(?:(['"])([A-Za-z_][A-Za-z0-9_]*)\1|\\([A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*))/gu

interface PendingHeredoc {
  readonly delimiter: string
  readonly literal: boolean
  readonly command: string
}

/** Every heredoc a finished line opens, in order: bodies follow one after another. */
const heredocsOpenedBy = (bare: string): readonly PendingHeredoc[] => {
  const code = stripArithmetic(bare)
  return [...code.matchAll(HEREDOC)].map((match) => ({
    delimiter: match[2] ?? match[3] ?? match[4] ?? "",
    literal: match[2] !== undefined || match[3] !== undefined,
    command: code.slice(0, match.index),
  }))
}

/**
 * The masking of one line of shell CODE, with quote state carried in `stack`
 * from the line before.
 *
 * Escapes are honoured outside quotes (`don\'t`) and inside `$'…'` (`it\'s`), and
 * a `$(…)` inside double quotes is its own context (`"$(echo "don't")"`). `bare`
 * is `code` without double-quoted text, which is where an opener is looked for:
 * `echo "use <<EOF"` opens nothing.
 */
class ShellLineMasker {
  code = ""
  bare = ""
  spans: QuotedSpan[] = []

  constructor(private readonly stack: ShellFrame[]) {}

  mask(raw: string): void {
    for (let index = 0; index < raw.length; index = this.step(raw, index) + 1) {
      if (index < 0) return
    }
  }

  /** Consumes `raw[index]`; returns the last index consumed, or -2 at a comment. */
  private step(raw: string, index: number): number {
    const frame = this.stack.at(-1)
    if (frame?.kind === "single" || frame?.kind === "ansi") return this.inSingle(frame, raw, index)
    if (frame?.kind === "double") return this.inDouble(frame, raw, index)
    return this.inCode(frame, raw, index)
  }

  private emit(piece: string): void {
    this.code += piece
    if (!this.stack.some((frame) => frame.kind === "double")) this.bare += piece
  }

  private close(frame: ShellFrame): void {
    this.stack.pop()
    if (this.stack.length === 0) this.spans.push({ before: frame.before, text: frame.text })
  }

  private inSingle(frame: ShellFrame, raw: string, index: number): number {
    const character = raw[index] ?? ""
    if (frame.kind === "ansi" && character === "\\") {
      frame.text += raw.slice(index, index + 2)
      return index + 1
    }
    if (character === "'") this.close(frame)
    else frame.text += character
    return index
  }

  private inDouble(frame: ShellFrame, raw: string, index: number): number {
    const character = raw[index] ?? ""
    const piece = character === "\\" || (character === "$" && raw[index + 1] === "(")
    const taken = piece ? raw.slice(index, index + 2) : character
    this.emit(taken)
    if (character === '"') {
      this.close(frame)
      return index
    }
    frame.text += taken
    if (taken === "$(")
      this.stack.push({ kind: "substitution", before: this.code, parens: 1, text: "" })
    return index + taken.length - 1
  }

  /** Top level, or a `$(…)` inside double quotes. */
  private inCode(frame: ShellFrame | undefined, raw: string, index: number): number {
    const character = raw[index] ?? ""
    if (character === "\\") {
      this.emit(raw.slice(index, index + 2))
      return index + 1
    }
    if (frame !== undefined && this.closesSubstitution(frame, character)) return index
    if (character === "'" || character === '"') return this.openQuote(raw, index)
    if (character === "#" && (index === 0 || /[\s;]/u.test(raw[index - 1] ?? ""))) return -2
    this.emit(character)
    return index
  }

  private closesSubstitution(frame: ShellFrame, character: string): boolean {
    if (character === "(") frame.parens += 1
    if (character !== ")") return false
    frame.parens -= 1
    if (frame.parens > 0) return false
    this.stack.pop()
    this.emit(character)
    return true
  }

  private openQuote(raw: string, index: number): number {
    const character = raw[index] ?? ""
    // A quoted heredoc DELIMITER is kept: masked away, `<<'PY'` read as a bare
    // `<<` and the embedded interpreter's reads were never looked at.
    const end = raw.indexOf(character, index + 1)
    if (/<<-?\s*$/u.test(this.bare) && end !== -1) {
      this.emit(raw.slice(index, end + 1))
      return end
    }
    const kind: ShellFrameKind =
      character === '"' ? "double" : this.code.endsWith("$") ? "ansi" : "single"
    if (kind === "double") this.emit(character)
    this.stack.push({ kind, before: this.code, parens: 0, text: "" })
    return index
  }
}

/**
 * Shell, one entry per line, in ONE pass that knows heredocs.
 *
 * Quote state carries across lines, and a heredoc BODY never touches it. The
 * masking ran over the whole text first and found heredocs afterwards, so an
 * apostrophe in a body (`Don't`) opened a single quote that swallowed every real
 * read after the heredoc. `<<<` is a here-string, not an opener.
 */
const shellLines = (text: string): readonly ShellLine[] => {
  const out: ShellLine[] = []
  const stack: ShellFrame[] = []
  const pending: PendingHeredoc[] = []
  let heredocs = 0
  for (const raw of text.split("\n")) {
    const current = pending[0]
    if (current !== undefined) {
      const ends = raw.trim() === current.delimiter
      out.push({
        code: "",
        raw,
        spans: [],
        ...(ends
          ? {}
          : { body: { heredoc: heredocs, literal: current.literal, command: current.command } }),
      })
      if (ends) {
        pending.shift()
        heredocs += 1
      }
      continue
    }
    const masker = new ShellLineMasker(stack)
    masker.mask(raw)
    out.push({ code: masker.code, raw, spans: masker.spans })
    if (stack.length === 0) pending.push(...heredocsOpenedBy(masker.bare))
  }
  return out
}

/** The reads in a quoted argument handed to an interpreter (`bun -e '…'`). */
const spanReads = (span: QuotedSpan, names: ReadonlySet<string>): readonly string[] => {
  if (JS_INLINE.test(span.before)) return scriptReads(span.text, names)
  return PY_INLINE.test(span.before) ? pythonReads(span.text, names) : []
}

/** `$NAME`, `${NAME}`, `${NAME:-x}`, `${#NAME}` outside comments, single quotes and quoted heredocs. */
export const shellReads = (text: string, names: ReadonlySet<string>): ReadonlySet<string> => {
  const found = new Set<string>()
  const scan = (code: string): void => {
    for (const match of code.matchAll(/\$\{?#?([A-Za-z_][A-Za-z0-9_]*)/g)) {
      const name = match[1]
      if (name !== undefined && names.has(name)) found.add(name)
    }
  }
  const embedded = new Map<number, { readonly command: string; readonly lines: string[] }>()
  for (const line of shellLines(text)) {
    if (line.body?.literal === true) {
      const body = embedded.get(line.body.heredoc) ?? { command: line.body.command, lines: [] }
      body.lines.push(line.raw)
      embedded.set(line.body.heredoc, body)
      continue
    }
    scan(line.body === undefined ? line.code : line.raw)
    for (const name of line.spans.flatMap((span) => spanReads(span, names))) found.add(name)
  }
  // A quoted-delimiter heredoc is usually an embedded interpreter: only a read counts.
  for (const { command, lines } of embedded.values()) {
    const body = lines.join("\n")
    const reads = JS_INTERPRETER.test(command) ? scriptReads(body, names) : pythonReads(body, names)
    for (const name of reads) found.add(name)
  }
  return found
}

/** `uses: actions/github-script` runs its `with.script` as JavaScript. */
const githubScriptReads = (step: YAMLMap, names: ReadonlySet<string>): readonly string[] => {
  const uses = step.get("uses")
  const inputs = step.get("with")
  if (typeof uses !== "string" || !uses.startsWith("actions/github-script") || !isMap(inputs)) {
    return []
  }
  const script = inputs.get("script")
  return typeof script === "string" ? scriptReads(script, names) : []
}

/** A YAML node's children, each with the key it sits under (a pair's key names its value). */
const yamlChildren = (node: unknown): readonly (readonly [unknown, string | undefined])[] => {
  if (isMap(node) || isSeq(node)) return node.items.map((item) => [item, undefined] as const)
  if (!isPair(node)) return []
  return [[node.value, isScalar(node.key) ? String(node.key.value) : undefined]]
}

/** Workflow YAML, parsed: `env:` KEYS are writes; expressions and `run:` bodies read. */
export const workflowReads = (text: string, names: ReadonlySet<string>): ReadonlySet<string> => {
  const found = new Set<string>()
  const references = (value: string): void => {
    for (const match of value.matchAll(/\b(?:vars|env|secrets)\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
      const name = match[1]
      if (name !== undefined && names.has(name)) found.add(name)
    }
  }
  // Only EXPRESSIONS read: `${{ … }}` spans, and an `if:` value, which is an
  // expression without the braces. Matching the raw scalar backed a step NAME
  // ("previously gated by env.X"), a `run:` comment and an echoed string.
  const scalar = (value: string, key: string | undefined): void => {
    if (key === "if") references(value)
    else for (const span of value.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) references(span[1] ?? "")
    if (key === "run") for (const name of shellReads(value, names)) found.add(name)
  }
  const walk = (node: unknown, key: string | undefined): void => {
    if (isMap(node)) for (const name of githubScriptReads(node, names)) found.add(name)
    if (isScalar(node) && typeof node.value === "string") scalar(node.value, key)
    for (const [child, childKey] of yamlChildren(node)) walk(child, childKey)
  }
  walk(parseDocument(text).contents, undefined)
  return found
}

// ── the index ───────────────────────────────────────────────────────────────

const reEscape = (name: string): string => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

type Sink = (name: string, kind: EnvEvidenceKind, where: string) => void

const tokenEvidence = (
  rel: string,
  text: string,
  lang: Lang,
  names: ReadonlySet<string>,
  sink: Sink,
): void => {
  const test = isTestFile(rel)
  for (const { value, offset } of lang === "py" ? pythonStrings(text) : cStyleStrings(text)) {
    if (!names.has(value)) continue
    const before = text.slice(Math.max(0, offset - 32), offset)
    if (RAW_WRITE_CONTEXT.test(before)) continue
    if (lang === "py" && isPythonWrite(text, offset, value)) continue
    if (test && !RAW_READ_CONTEXT.test(before)) continue
    sink(value, "quoted", rel)
  }
}

/**
 * Inside `expect(…)` a test ASSERTS on a variable — `expect(process.env.RETIRED)
 * .toBeUndefined()` asserts a name is dead, and `expect(childEnv.X).toBe("1")`
 * asserts a write. Both backed the name they were checking.
 */
const insideExpect = (node: ts.Node): boolean => {
  for (let at = node.parent; at !== undefined; at = at.parent) {
    if (
      ts.isCallExpression(at) &&
      ts.isIdentifier(at.expression) &&
      at.expression.text === "expect"
    ) {
      return true
    }
  }
  return false
}

const parsedEvidence = (rel: string, text: string, lang: Lang, sink: Sink): void => {
  const test = isTestFile(rel)
  const literals = !test
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.ESNext, true, scriptKindOf(lang))
  const visit = (node: ts.Node): void => {
    const hit = classifyNode(node, literals)
    if (hit !== undefined && !(test && insideExpect(node))) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
      sink(hit.name, hit.kind, `${rel}:${line}`)
    }
    node.forEachChild(visit)
  }
  visit(source)
}

const packageScriptEvidence = (
  rel: string,
  text: string,
  names: ReadonlySet<string>,
  sink: Sink,
): void => {
  const scripts = (JSON.parse(text) as { scripts?: Record<string, string> }).scripts ?? {}
  for (const script of Object.values(scripts)) {
    for (const name of shellReads(script, names)) sink(name, "shell", rel)
  }
}

const fileEvidence = (
  rel: string,
  text: string,
  lang: Lang,
  names: ReadonlySet<string>,
  sink: Sink,
): void => {
  if (lang === "workflow")
    for (const name of workflowReads(text, names)) sink(name, "workflow", rel)
  else if (lang === "package-json") packageScriptEvidence(rel, text, names, sink)
  else if (lang === "shell") for (const name of shellReads(text, names)) sink(name, "shell", rel)
  else if (lang === "py" || lang === "cstyle") tokenEvidence(rel, text, lang, names, sink)
  else
    parsedEvidence(
      rel,
      text,
      lang,
      (name, kind, where) => names.has(name) && sink(name, kind, where),
    )
}

const walkEvidence = (
  repoRoot: string,
  declared: Iterable<string>,
  files: readonly string[],
  sink: Sink,
): void => {
  const names = new Set(declared)
  if (names.size === 0) return
  const prefilter = new RegExp([...names].map(reEscape).join("|"))
  for (const rel of files) {
    let text: string | undefined
    const read = (): string => {
      if (text === undefined) {
        try {
          text = readFileSync(join(repoRoot, rel), "utf8")
        } catch (error) {
          // Tracked and gone: a concurrent session's unstaged deletion. It reads
          // nothing, and crashing the whole scan over it reported nothing either.
          if ((error as { code?: string }).code !== "ENOENT") throw error
          text = ""
        }
      }
      return text
    }
    const lang = languageOf(rel, () => read().slice(0, 200))
    if (lang === undefined || !prefilter.test(read())) continue
    fileEvidence(rel, read(), lang, names, sink)
  }
}

/** The FIRST evidence found for each declared name. */
export const envEvidenceIndex = (
  repoRoot: string,
  declared: Iterable<string>,
  files: readonly string[],
): ReadonlyMap<string, EnvEvidence> => {
  const found = new Map<string, EnvEvidence>()
  walkEvidence(repoRoot, declared, files, (name, kind, where) => {
    if (!found.has(name)) found.set(name, { kind, where })
  })
  return found
}

/**
 * EVERY evidence found for each declared name.
 *
 * First-only was enough for the ratchet and not for a sentinel: "this root still
 * yields this shape" cannot be asked of a name whose first hit came from
 * somewhere else.
 */
export const envEvidenceAll = (
  repoRoot: string,
  declared: Iterable<string>,
  files: readonly string[],
): ReadonlyMap<string, readonly EnvEvidence[]> => {
  const found = new Map<string, EnvEvidence[]>()
  walkEvidence(repoRoot, declared, files, (name, kind, where) => {
    const list = found.get(name) ?? []
    list.push({ kind, where })
    found.set(name, list)
  })
  return found
}

// ── what the catalog declares ──────────────────────────────────────────────

/** An identifier shaped like an environment variable. */
const ENV_SHAPED = /^[A-Z][A-Z0-9_]{3,}$/
/** This repository's reserved env namespace. A knob named in it is an env knob, whatever `where` says. */
const RESERVED_ENV = /^(?:VITE_)?QUANTA_[A-Z0-9_]+$/

type CatalogKnob = string | { readonly name: string; readonly where?: string | undefined }

/**
 * The env names a knob list declares.
 *
 * Only `where: "env"` counted before, and three knobs the catalog still offers
 * as env switches carry no `where` or a file path in it: `QUANTA_MCP_PROGRESS`
 * (a name `c41d78212` reported as fixed), `QUANTA_SANDBOX_STRICT` and
 * `QUANTA_SWEBENCH_RUN_ID`. None is read by anything.
 */
export const envKnobNames = (knobs: readonly CatalogKnob[] | undefined): readonly string[] =>
  (knobs ?? []).flatMap((knob) => {
    if (typeof knob === "string") return ENV_SHAPED.test(knob) ? [knob] : []
    return knob.where === "env" || RESERVED_ENV.test(knob.name) ? [knob.name] : []
  })

/** `wiring.activation` conditions of `kind: env`, whose `key` IS the variable. */
export const activationEnvNames = (
  activation: readonly { readonly kind: string; readonly key?: string | undefined }[] | undefined,
): readonly string[] =>
  (activation ?? []).flatMap((condition) =>
    condition.kind === "env" && condition.key !== undefined && ENV_SHAPED.test(condition.key)
      ? [condition.key]
      : [],
  )

/** A ledger row's `gate_owner` names, which nothing checked were read either. */
export const gateOwnerEnvNames = (gateOwner: readonly string[]): readonly string[] =>
  gateOwner.filter((name) => ENV_SHAPED.test(name))

/** The four env-naming fields of the catalog, each on its own. */
export interface CatalogEnvFields {
  readonly configRefs: readonly string[]
  readonly knobs: readonly string[]
  readonly gateOwner: readonly string[]
  readonly activation: readonly string[]
}

export interface CatalogFeatureSource {
  readonly path: string
  readonly feature: {
    readonly config_refs?: { readonly env?: readonly string[] | undefined } | undefined
    readonly knobs?: readonly CatalogKnob[] | undefined
    readonly wiring?:
      | {
          readonly activation?:
            | readonly { readonly kind: string; readonly key?: string | undefined }[]
            | undefined
        }
      | undefined
  }
}

export interface LedgerGateSource {
  readonly feature_id: string
  readonly gate_owner: readonly string[]
}

/**
 * The records the ratchet checks: every feature's four fields, and every ledger
 * row's `gate_owner`.
 *
 * Composed HERE, not in the test. It lived in the test's `beforeAll`, where
 * dropping a field was an edit to the test, and dropping `activation` was green:
 * its one real key is also a knob. `catalog-config-refs.test.ts` drives this with
 * a record per field that only that field names.
 */
export const catalogEnvSources = (
  features: readonly CatalogFeatureSource[],
  ledger: readonly LedgerGateSource[],
  relativePath: (path: string) => string,
): { readonly records: readonly CatalogEnvSource[]; readonly fields: CatalogEnvFields } => {
  const perFeature = features.map(({ path, feature }) => ({
    path: relativePath(path),
    configRefs: feature.config_refs?.env ?? [],
    knobs: envKnobNames(feature.knobs),
    activation: activationEnvNames(feature.wiring?.activation),
  }))
  const perRow = ledger.map((row) => ({
    path: `tools/feature-catalog/default-off-ledger.yaml#${row.feature_id}.gate_owner`,
    env: gateOwnerEnvNames(row.gate_owner),
  }))
  return {
    records: [
      ...perFeature.map((one) => ({
        path: one.path,
        env: [...one.configRefs, ...one.knobs, ...one.activation],
      })),
      ...perRow,
    ],
    fields: {
      configRefs: perFeature.flatMap((one) => one.configRefs),
      knobs: perFeature.flatMap((one) => one.knobs),
      gateOwner: perRow.flatMap((row) => row.env),
      activation: perFeature.flatMap((one) => one.activation),
    },
  }
}

/** Every env name any record declares, mapped to the records that declare it. */
export const declaredEnvNames = (records: readonly CatalogEnvSource[]): DeclaredEnvNames => {
  const out = new Map<string, string[]>()
  for (const { path, env } of records) {
    for (const name of env) {
      const list = out.get(name) ?? []
      list.push(path)
      out.set(name, list)
    }
  }
  return out
}

/** Declared names no shape could back. */
export const unbackedEnvNames = (
  declared: DeclaredEnvNames,
  evidence: ReadonlyMap<string, unknown>,
): readonly UnbackedEnvName[] =>
  [...declared.keys()]
    .filter((name) => !evidence.has(name))
    .sort()
    .map((name) => ({ name, records: declared.get(name) ?? [] }))

/** The refusal text, naming every offender and the record that declares it. */
export const describeUnbackedEnvNames = (unbacked: readonly UnbackedEnvName[]): string =>
  [
    `[catalog] ${unbacked.length} declared env name(s) that no code reads:`,
    ...unbacked.map(({ name, records }) => `  ${name} — declared by ${records.join(", ")}`),
    "Look in every env-naming field of the named record: config_refs.env (rendered",
    'for operators as "Configurable · env: …"), knobs in either spelling, and the',
    "default-off ledger's gate_owner. A name nothing reads is an instruction that",
    "silently does nothing, which is how a CI job copied from the TVH-03 handoff",
    "armed no capability and reported a pass. Wire the name, or name the variable",
    "the code actually reads.",
  ].join("\n")
