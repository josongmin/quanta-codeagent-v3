/**
 * `tools/dev/catalog-config-refs` — an env var the catalog offers an operator
 * must be one some code READS.
 *
 * # The defect
 *
 * `config_refs.env` is the field that renders as "**Configurable**: partial ·
 * env: …" in `docs/10.feature-catalog.md`. It is read by operators and by CI
 * authors, and NOTHING checked the names in it. The catalog's guards cover
 * evidence existence, code reachability and render shape; a name that no code
 * reads passed all of them.
 *
 * MEASURED when this was written, eight false claims across six features:
 *
 *   QUANTA_REQUIRE_CAPABILITY              retired name, superseded by the plural
 *   QUANTA_VERIFICATION_REQUIRED           no counterpart anywhere in the tree
 *   QUANTA_DOCTOR                          proposed in a plan doc, never built
 *   QUANTA_MCP_PROGRESS                    no such var among the real QUANTA_MCP_*
 *   QUANTA_MEMORY_SUBDIR                   a local path constant, not an env var
 *   QUANTA_FORCE_BACKGROUND_SUBAGENT_BG    invented suffix; the var is
 *   QUANTA_FORCE_BACKGROUND_SUBAGENT_QUEUE  QUANTA_FORCE_BACKGROUND
 *   QUANTA_PILL                            a PREFIX; the scalar is QUANTA_PILLS
 *
 * The first one is why this module exists: a CI job copied from the TVH-03
 * handoff set `QUANTA_REQUIRE_CAPABILITY=<group>`, which armed nothing, and
 * reported a pass.
 *
 * # Why a mention is not evidence
 *
 * `grep -w QUANTA_REQUIRE_CAPABILITY` finds four hits: three docstrings
 * explaining that the name is retired, and one test asserting that setting it
 * does nothing. A guard built on mentions would call the deadest name in the
 * tree alive — and would be satisfied forever by the very test that proves it
 * dead. So evidence is a SHAPE, not a substring:
 *
 *   ts-literal    a string literal whose text is exactly the name
 *                 (`gateOn(env, "QUANTA_X")`, `envKey: "QUANTA_X"`)
 *   ts-access     `x.QUANTA_X`, `x["QUANTA_X"]`, or `const { QUANTA_X } = env`
 *   quoted        a double- or single-quoted exact token in a non-TS source
 *                 (Swift `ProcessInfo…environment["SCREEN_OCR_DEBUG"]`)
 *   workflow      the token in `.github/workflows/*.yml`, where env appears
 *                 unquoted as `vars.X`, `env.X` or `X: value`
 *
 * A comment cannot satisfy any of the first three, because a comment is not a
 * node. That is the whole distinction, and it is why this is a parse.
 *
 * The property-access rule does not try to prove the object is an env bag. It
 * does not need to: the name is one the CATALOG declares to be an environment
 * variable, and no domain object in this tree carries a property called
 * `VITE_QUANTA_WS_URL` or `QUANTA_REQUIRE_CAPABILITIES`. Same reasoning
 * `knob-env-access.ts` gives for the reserved `QUANTA_*` namespace, narrowed to
 * a set the catalog names rather than to a prefix.
 */

import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import ts from "typescript"

/** How a declared name was found to be real. */
export type EnvEvidenceKind = "ts-literal" | "ts-access" | "quoted" | "workflow"

export interface EnvEvidence {
  readonly kind: EnvEvidenceKind
  /** `path:line`, or just the path for whole-file shapes. */
  readonly where: string
}

/** Which features declare each env name. */
export type DeclaredEnvNames = ReadonlyMap<string, readonly string[]>

export interface UnbackedEnvName {
  readonly name: string
  readonly records: readonly string[]
}

const TS_SOURCE = /\.(ts|tsx|mts|mjs)$/
const NON_TS_SOURCE = /\.(swift|rs|kt|java|go|py|sh|toml)$/

/** Everything git tracks under `roots`, so an untracked scratch file is not evidence. */
export const trackedFiles = (repoRoot: string, roots: readonly string[]): readonly string[] =>
  execFileSync("git", ["ls-files", "-z", "--", ...roots], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter((path) => path !== "" && !path.endsWith(".d.ts"))

const reEscape = (name: string): string => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * One alternation over every declared name, used ONLY to skip files that cannot
 * match. It is a filter on the PARSE, never on the verdict: a file it rejects
 * contains none of the names in any form, so no shape rule could have fired.
 */
const anyNameRe = (names: Iterable<string>): RegExp =>
  new RegExp([...names].map(reEscape).join("|"))

/**
 * In a TEST file, only an ACCESS counts — a bare literal does not.
 *
 * # Caught by this guard's own arm
 *
 * `catalog-config-refs.test.ts` writes `const retired = "QUANTA_REQUIRE_CAPABILITY"`
 * to assert that the retired name has no evidence. The moment that file became
 * tracked, `git ls-files` included it and the guard found its own arm's literal
 * and called the name alive. A guard whose fixtures manufacture evidence for the
 * names it tests measures nothing, and it would have been satisfied forever.
 *
 * # Why not exclude `tests/` outright
 *
 * MEASURED: six declared names are backed ONLY by a file under `tests/` —
 * `QUANTA_SMOKE_LIVE`, `QUANTA_SMOKE_MODEL`, `QUANTA_LLM_PROVIDER`,
 * `QUANTA_OLLAMA_URL`, `QUANTA_OLLAMA_MODEL`, `GOOGLE_APPLICATION_CREDENTIALS`
 * — and every one is a real `process.env.X` read by the smoke battery or the
 * eval harness, which legitimately live there. Dropping the root would invent
 * six false claims to avoid one.
 *
 * So the line is the SHAPE, not the directory: reading a variable is using it,
 * naming it in a string is talking about it, and outside `tests/` naming it in
 * a string IS how declarations are written (`envKey: "QUANTA_X"`).
 */
const isTestFile = (rel: string): boolean =>
  rel.startsWith("tests/") || /(?:^|\/)__tests__\//.test(rel) || /\.test\.tsx?$/.test(rel)

/**
 * `process.env.X = "1"` and `delete process.env.X` are WRITES, and a write is
 * not a read — the same distinction `knob-env-access.ts` draws, and the one the
 * test docstring claimed this module drew when it did not.
 *
 * MEASURED: a block of nine `process.env.QUANTA_* = "1"` writes in
 * `tests/unit/jun6-all-knobs-on-composition-hellgate.test.ts` would have backed
 * nine names on its own, inside the very directory where a bare literal is
 * already refused.
 */
const isWriteTarget = (node: ts.Node): boolean => {
  const parent = node.parent
  if (parent === undefined) return false
  if (ts.isDeleteExpression(parent)) return true
  return (
    ts.isBinaryExpression(parent) &&
    parent.left === node &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
  )
}

const evidenceFromTs = (
  rel: string,
  text: string,
  declared: ReadonlySet<string>,
  found: Map<string, EnvEvidence>,
): void => {
  const literalsAreEvidence = !isTestFile(rel)
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX)
  const at = (node: ts.Node): string =>
    `${rel}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`
  const note = (name: string, kind: EnvEvidenceKind, node: ts.Node): void => {
    if (declared.has(name) && !found.has(name)) found.set(name, { kind, where: at(node) })
  }
  const visit = (node: ts.Node): void => {
    const hit = classifyNode(node, literalsAreEvidence)
    if (hit !== undefined) note(hit.name, hit.kind, node)
    node.forEachChild(visit)
  }
  visit(sf)
}

/**
 * The KEY of a write is part of the write.
 *
 * `bag["QUANTA_X"] = "1"` is excluded as an element access and was then
 * re-admitted one node down, because outside a test file a bare literal IS
 * evidence by design — that is how declarations are spelled
 * (`envKey: "QUANTA_X"`). So the exclusion has to reach the literal too.
 */
const isWriteKeyLiteral = (node: ts.Node): boolean => {
  const parent = node.parent
  return (
    parent !== undefined &&
    ts.isElementAccessExpression(parent) &&
    parent.argumentExpression === node &&
    isWriteTarget(parent)
  )
}

/** The key a node names, and how, or `undefined` when it names none. */
const classifyNode = (
  node: ts.Node,
  literalsAreEvidence: boolean,
): { readonly name: string; readonly kind: EnvEvidenceKind } | undefined => {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    if (isWriteKeyLiteral(node)) return undefined
    return literalsAreEvidence ? { name: node.text, kind: "ts-literal" } : undefined
  }
  if (isWriteTarget(node)) return undefined
  if (ts.isPropertyAccessExpression(node)) return { name: node.name.text, kind: "ts-access" }
  if (ts.isElementAccessExpression(node)) {
    // A template literal with no substitutions is the same key written a
    // different way: `process.env[`QUANTA_X`]` was invisible.
    const argument = node.argumentExpression
    return ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)
      ? { name: argument.text, kind: "ts-access" }
      : undefined
  }
  if (ts.isBindingElement(node)) {
    // `const { QUANTA_X: alias } = env` binds `alias` and READS `QUANTA_X`.
    // Reading `node.name` recorded the alias and missed the key — and, in the
    // other direction, recorded a name destructured off an unrelated object.
    const key = node.propertyName ?? node.name
    return ts.isIdentifier(key) || ts.isStringLiteral(key)
      ? { name: key.text, kind: "ts-access" }
      : undefined
  }
  return undefined
}

/**
 * Text with line comments removed, for the two shapes that cannot be parsed.
 *
 * # The hole this closes
 *
 * The module's thesis is "a comment is not a node… that is why this is a
 * parse". It was true of the two TypeScript shapes and FALSE of the other two,
 * which are raw-text regexes. MEASURED: two operator-facing names,
 * `QUANTA_GH_TRIGGER_PHRASES` and `QUANTA_GH_TRUST_SCOPE`, were called alive by
 * these two lines and nothing else in the tree —
 *
 *   .github/workflows/quanta-pr-bot.yml.template:166
 *     #       QUANTA_GH_TRIGGER_PHRASES="@quanta,/quanta,@my-bot"
 *
 * — while the values actually come from the `--phrases` and `--trust-scope` CLI
 * flags. `docs/integrations/github/SETUP.md` tells operators to set both as
 * workflow env, which is the "instruction that silently does nothing" this guard
 * exists to catch, and the guard published `0 unbacked`.
 *
 * Line comments only. A `/* … *\/` block or a quoted `#` inside a shell string
 * is not worth a second parser here: the shapes this feeds are already the
 * weakest two, and the arms pin the case that actually occurred.
 */
const withoutLineComments = (text: string): string =>
  text
    .split("\n")
    .filter((line) => !/^\s*(?:#|\/\/)/.test(line))
    .join("\n")

const evidenceFromQuoted = (
  rel: string,
  text: string,
  declared: ReadonlySet<string>,
  found: Map<string, EnvEvidence>,
): void => {
  for (const name of declared) {
    if (found.has(name)) continue
    if (new RegExp(`["']${reEscape(name)}["']`).test(withoutLineComments(text))) {
      found.set(name, { kind: "quoted", where: rel })
    }
  }
}

const evidenceFromWorkflow = (
  rel: string,
  text: string,
  declared: ReadonlySet<string>,
  found: Map<string, EnvEvidence>,
): void => {
  for (const name of declared) {
    if (found.has(name)) continue
    if (new RegExp(`\\b${reEscape(name)}\\b`).test(withoutLineComments(text))) {
      found.set(name, { kind: "workflow", where: rel })
    }
  }
}

/** Where each declared name is really read, by the four shapes above. */
export const envEvidenceIndex = (
  repoRoot: string,
  declared: Iterable<string>,
  files: readonly string[],
): ReadonlyMap<string, EnvEvidence> => {
  const names = new Set(declared)
  const found = new Map<string, EnvEvidence>()
  if (names.size === 0) return found
  const prefilter = anyNameRe(names)
  for (const rel of files) {
    const isWorkflow = rel.startsWith(".github/workflows/")
    if (!isWorkflow && !TS_SOURCE.test(rel) && !NON_TS_SOURCE.test(rel)) continue
    const text = readFileSync(join(repoRoot, rel), "utf8")
    // Prefiltering on the RAW text, deliberately. Stripping comments first would
    // narrow the parse set, and MEASURED it does not pay: the `readFileSync`
    // over ~9,500 files dominates, and running the stripper on all of them cost
    // more than the ~500 parses it saved (7.1-7.6s became 8.0-9.1s). The two
    // raw-text shapes strip inside themselves, where it is a correctness rule
    // rather than a filter.
    if (!prefilter.test(text)) continue
    if (isWorkflow) evidenceFromWorkflow(rel, text, names, found)
    else if (TS_SOURCE.test(rel)) evidenceFromTs(rel, text, names, found)
    else evidenceFromQuoted(rel, text, names, found)
  }
  return found
}

/** Declared names that no shape could back, with the records that declare them. */
export const unbackedEnvNames = (
  declared: DeclaredEnvNames,
  evidence: ReadonlyMap<string, EnvEvidence>,
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
    "Look in BOTH env-naming fields of the named record: config_refs.env, which",
    'renders for operators as "Configurable · env: …", and knobs, in either',
    "spelling — a bare string, or an object with where: env. A name nothing reads",
    "is an instruction that silently does nothing, which is how a CI job copied",
    "from the TVH-03 handoff armed no capability and reported a pass. Either wire",
    "the name, or name the variable the code actually reads.",
  ].join("\n")

/** The shape this module needs from a loaded catalog record. */
export interface CatalogEnvSource {
  readonly path: string
  readonly env: readonly string[]
}

/**
 * Every env name any record declares, mapped to the records that declare it.
 *
 * Takes the already-loaded records rather than re-reading the YAML: an earlier
 * draft of this module extracted the field with a regex over the files and saw
 * 147 of the 444 names, because it only understood the block-sequence spelling
 * (`env:` then `- NAME`) and two thirds of the catalog uses the inline flow
 * spelling (`env: [NAME, NAME]`). The loader owns the schema; this module owns
 * the evidence.
 */
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
