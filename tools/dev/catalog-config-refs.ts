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

const evidenceFromTs = (
  rel: string,
  text: string,
  declared: ReadonlySet<string>,
  found: Map<string, EnvEvidence>,
): void => {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX)
  const at = (node: ts.Node): string =>
    `${rel}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`
  const note = (name: string, kind: EnvEvidenceKind, node: ts.Node): void => {
    if (declared.has(name) && !found.has(name)) found.set(name, { kind, where: at(node) })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      note(node.text, "ts-literal", node)
    } else if (ts.isPropertyAccessExpression(node)) {
      note(node.name.text, "ts-access", node)
    } else if (ts.isElementAccessExpression(node)) {
      const argument = node.argumentExpression
      if (ts.isStringLiteral(argument)) note(argument.text, "ts-access", node)
    } else if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
      note(node.name.text, "ts-access", node)
    }
    node.forEachChild(visit)
  }
  visit(sf)
}

const evidenceFromQuoted = (
  rel: string,
  text: string,
  declared: ReadonlySet<string>,
  found: Map<string, EnvEvidence>,
): void => {
  for (const name of declared) {
    if (found.has(name)) continue
    if (new RegExp(`["']${reEscape(name)}["']`).test(text)) {
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
    if (new RegExp(`\\b${reEscape(name)}\\b`).test(text)) {
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
