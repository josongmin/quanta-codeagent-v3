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
 *   workflow     `vars.X` / `env.X` / `secrets.X` in a parsed workflow, and the
 *                shell rule over `run:` bodies; `env:` KEYS are writes
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
 */

import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import ts from "typescript"
import { isMap, isPair, isScalar, isSeq, parseDocument } from "yaml"

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

const isWriteTarget = (node: ts.Node): boolean => {
  const target = outermostWrapper(node)
  const parent = target.parent
  if (parent === undefined) return false
  if (ts.isDeleteExpression(parent)) return true
  return (
    ts.isBinaryExpression(parent) &&
    parent.left === target &&
    WRITE_OPERATORS.has(parent.operatorToken.kind)
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
const RAW_READ_CONTEXT =
  /(?:environment\[|getenv\(|Getenv\(|LookupEnv\(|env::var\(|env::var_os\(|environ\[|environ\.get\(|env_var\(|env_var_or_default\()\s*$/

/** A shell line with single-quoted spans and a trailing `#` comment removed. */
const shellCode = (line: string): string => {
  let code = ""
  let quote: "'" | '"' | undefined
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] ?? ""
    if (quote === "'") {
      if (character === "'") quote = undefined
      continue
    }
    if (quote === '"') {
      if (character === "\\") index += 1
      else if (character === '"') quote = undefined
      code += character
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      continue
    }
    const previous = line[index - 1]
    if (character === "#" && (index === 0 || /[\s;]/.test(previous ?? "")) && previous !== "$")
      break
    code += character
  }
  return code
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
  const lines = text.split("\n")
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ""
    scan(shellCode(line))
    const heredoc = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line)
    if (heredoc === null) continue
    const literal = heredoc[1] !== ""
    const body: string[] = []
    for (
      index += 1;
      index < lines.length && (lines[index] ?? "").trim() !== heredoc[2];
      index += 1
    ) {
      if (literal) body.push(lines[index] ?? "")
      else scan(lines[index] ?? "")
    }
    // A quoted-delimiter heredoc is usually an embedded interpreter: only a read call counts.
    const embedded = body.join("\n")
    for (const { value, offset } of pythonStrings(embedded)) {
      if (
        names.has(value) &&
        RAW_READ_CONTEXT.test(embedded.slice(Math.max(0, offset - 32), offset))
      ) {
        found.add(value)
      }
    }
  }
  return found
}

/** Workflow YAML, parsed: `env:` KEYS are writes; expressions and `run:` bodies read. */
export const workflowReads = (text: string, names: ReadonlySet<string>): ReadonlySet<string> => {
  const found = new Set<string>()
  const expressions = (value: string): void => {
    for (const match of value.matchAll(/\b(?:vars|env|secrets)\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
      const name = match[1]
      if (name !== undefined && names.has(name)) found.add(name)
    }
  }
  const walk = (node: unknown, key: string | undefined): void => {
    if (isMap(node)) for (const pair of node.items) walk(pair, undefined)
    else if (isSeq(node)) for (const item of node.items) walk(item, undefined)
    else if (isPair(node)) walk(node.value, isScalar(node.key) ? String(node.key.value) : undefined)
    else if (isScalar(node) && typeof node.value === "string") {
      expressions(node.value)
      if (key === "run") for (const name of shellReads(node.value, names)) found.add(name)
    }
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
    if (test && !RAW_READ_CONTEXT.test(before)) continue
    sink(value, "quoted", rel)
  }
}

const parsedEvidence = (rel: string, text: string, lang: Lang, sink: Sink): void => {
  const literals = !isTestFile(rel)
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.ESNext, true, scriptKindOf(lang))
  const visit = (node: ts.Node): void => {
    const hit = classifyNode(node, literals)
    if (hit !== undefined) {
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
      text ??= readFileSync(join(repoRoot, rel), "utf8")
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

/** A ledger row's `gate_owner` names, which nothing checked were read either. */
export const gateOwnerEnvNames = (gateOwner: readonly string[]): readonly string[] =>
  gateOwner.filter((name) => ENV_SHAPED.test(name))

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
