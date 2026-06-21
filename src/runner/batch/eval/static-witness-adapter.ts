/**
 * SCAFF-02 — PURE Python AST static-witness adapter.
 *
 * Turns Python source FACTS (defs/classes/calls extracted via regex AST-ish
 * scanning) into typed `StaticWitness[]` records. It finds STRUCTURAL relations
 * between owner-candidate files; it never decides final correctness and never
 * reads a benchmark label, gold patch, or path regex. Provenance is always
 * `"ast"`.
 *
 * Source-language scope: Python source, best-effort. A non-Python file (no
 * recognizable `def`/`class`) or a missing source (`readSource` returns null)
 * simply contributes no witness — the adapter never fabricates authority.
 *
 * The `readSource` is injected, so the provider is PURE/testable: no fs, no
 * spawn, deterministic for a fixed input.
 *
 * Relations & authoritative rules:
 *  - override-family: the SAME method/function symbol DEFINED in >= 2 owner files.
 *    Authoritative when that symbol is mentioned in the issue text, OR when one
 *    file structurally overrides the other (`class X(Base)` inheriting and both
 *    define the method). Advisory otherwise. This catches base/subclass backend
 *    overrides with NO file-path regex — purely "same method defined across owner
 *    files".
 *  - unique-symbol-definer: an issue-mentioned symbol with EXACTLY ONE static
 *    definer among the owner candidates -> authoritative, subjectFiles=[that file].
 *  - producer-consumer: a symbol returned/produced in one owner file and
 *    called/consumed in another. Authoritative when both producer & consumer files
 *    are known; advisory otherwise.
 *  - registration-callback: a function passed into a registry-like API call
 *    (`register(...)`, `create_function(name, fn)`, `add_*(...)`). Authoritative
 *    when both the registration site and the callback impl file are resolvable;
 *    advisory otherwise.
 *
 * Legacy compat feeder: `ownerResolved` same-symbol ripgrep siblings convert into
 * ADVISORY `override-family` witnesses only — a same-symbol sibling can NEVER be
 * authoritative on ripgrep provenance alone (no typed relation provenance).
 */

import {
  dedupeWitnesses,
  makeStaticWitness,
  type StaticWitness,
} from "./static-witness"

export interface StaticWitnessProviderInput {
  readonly problemStatement: string
  readonly ownerCandidates: readonly string[]
  readonly ownerResolved?: readonly {
    readonly file: string
    readonly forSymbol: string
    readonly fromFile?: string
  }[]
  readonly readSource: (relFile: string) => string | null
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** `def`/`async def` and `class` definitions (mirrors owner-sibling-resolve). */
const DEF_RE = /^[ \t]*(?:async[ \t]+)?def[ \t]+(\w+)|^[ \t]*class[ \t]+(\w+)/gm

/** `def`/`async def` names (methods/functions) only — excludes `class`. */
const FUNC_DEF_RE = /^[ \t]*(?:async[ \t]+)?def[ \t]+(\w+)/gm

/** `class Name(Base1, Base2):` — captures the class name and the base list. */
const CLASS_DEF_RE = /^[ \t]*class[ \t]+(\w+)[ \t]*(?:\(([^)]*)\))?/gm

/** Method/function symbols DEFINED in `source` (excludes dunder, ubiquitous). */
const funcDefsInSource = (source: string): Set<string> => {
  const out = new Set<string>()
  for (const m of source.matchAll(FUNC_DEF_RE)) {
    const name = m[1]
    if (name && !name.startsWith("__")) out.add(name)
  }
  return out
}

/** Any definition symbol (`def`/`class`) in `source` (excludes dunder). */
const allDefsInSource = (source: string): Set<string> => {
  const out = new Set<string>()
  for (const m of source.matchAll(DEF_RE)) {
    const name = m[1] ?? m[2]
    if (name && !name.startsWith("__")) out.add(name)
  }
  return out
}

interface ClassDef {
  readonly name: string
  readonly bases: readonly string[]
}

/** `class X(Base):` declarations with their base class names. */
const classDefsInSource = (source: string): ClassDef[] => {
  const out: ClassDef[] = []
  for (const m of source.matchAll(CLASS_DEF_RE)) {
    const name = m[1]
    if (name === undefined) continue
    const baseList = (m[2] ?? "")
      .split(",")
      .map((b) => b.trim())
      // strip `metaclass=…`, keyword args, and module-qualified prefixes.
      .filter((b) => b.length > 0 && !b.includes("="))
      .map((b) => {
        const parts = b.split(".")
        return parts[parts.length - 1] ?? b
      })
      .filter((b) => /^\w+$/.test(b))
    out.push({ name, bases: baseList })
  }
  return out
}

/** Word-boundary mention (so `runshell` anchors but `env` ∌ `environment`). */
const issueMentions = (issueText: string, symbol: string): boolean =>
  new RegExp(`\\b${escapeRe(symbol)}\\b`).test(issueText)

/** Symbols called as `name(` in `source` (consumption sites). */
const callsInSource = (source: string): Set<string> => {
  const out = new Set<string>()
  for (const m of source.matchAll(/\b(\w+)[ \t]*\(/g)) {
    const name = m[1]
    if (name && !name.startsWith("__")) out.add(name)
  }
  return out
}

/**
 * Best-effort registration callsites: `register(cb)`, `create_function(name, fn)`,
 * `add_handler(cb)`, … — a registry-like API receiving a bare-name callback. We
 * capture (registrar, callbackName) pairs. The callback name is the LAST bare
 * identifier argument (no parens/quotes) inside the call.
 */
const REGISTRY_RE = /\b(register\w*|create_function|add_\w+)[ \t]*\(([^)]*)\)/g

interface RegistrationSite {
  readonly registrar: string
  readonly callback: string
}

const registrationsInSource = (source: string): RegistrationSite[] => {
  const out: RegistrationSite[] = []
  for (const m of source.matchAll(REGISTRY_RE)) {
    const registrar = m[1]
    if (registrar === undefined) continue
    const args = (m[2] ?? "").split(",").map((a) => a.trim())
    // last bare-identifier argument = the callback reference.
    let callback: string | undefined
    for (const a of args) {
      if (/^\w+$/.test(a) && !a.startsWith("__")) callback = a
    }
    if (callback !== undefined) out.push({ registrar, callback })
  }
  return out
}

/** Build a per-file fact map over the owner candidates (skipping unreadable). */
interface FileFacts {
  readonly file: string
  readonly source: string
  readonly funcDefs: Set<string>
  readonly allDefs: Set<string>
  readonly classes: readonly ClassDef[]
  readonly calls: Set<string>
  readonly registrations: readonly RegistrationSite[]
}

const collectFacts = (input: StaticWitnessProviderInput): FileFacts[] => {
  const out: FileFacts[] = []
  for (const file of input.ownerCandidates) {
    const source = input.readSource(file)
    // Non-Python / missing source => no witness contribution.
    if (source === null) continue
    out.push({
      file,
      source,
      funcDefs: funcDefsInSource(source),
      allDefs: allDefsInSource(source),
      classes: classDefsInSource(source),
      calls: callsInSource(source),
      registrations: registrationsInSource(source),
    })
  }
  return out
}

/** override-family: same method defined across >= 2 owner files. */
const overrideFamilyWitnesses = (
  facts: readonly FileFacts[],
  issueText: string,
): StaticWitness[] => {
  // method symbol -> files (among owner candidates) that DEFINE it.
  const bySymbol = new Map<string, string[]>()
  for (const f of facts) {
    for (const sym of f.funcDefs) {
      const list = bySymbol.get(sym) ?? []
      list.push(f.file)
      bySymbol.set(sym, list)
    }
  }
  const out: StaticWitness[] = []
  for (const [symbol, rawFiles] of [...bySymbol.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const files = [...new Set(rawFiles)].sort()
    if (files.length < 2) continue
    const mentioned = issueMentions(issueText, symbol)
    // structural override: some owner file declares `class X(Base)` whose base is
    // a class DEFINED in another owner file, and both files define `symbol`.
    const structural = hasStructuralOverride(facts, files, symbol)
    const authoritative = mentioned || structural
    const why = mentioned
      ? "issue mentions the shared method"
      : structural
        ? "class inheritance override across owner files"
        : "same method defined across owner files (no override/mention proof)"
    out.push(
      makeStaticWitness({
        kind: "override-family",
        authority: authoritative ? "authoritative" : "advisory",
        provenance: "ast",
        subjectFiles: files,
        subjectSymbols: [symbol],
        reason: `override-family: \`${symbol}\` — ${why}`,
      }),
    )
  }
  return out
}

/** Does some owner file in `files` subclass a base class defined in another? */
const hasStructuralOverride = (
  facts: readonly FileFacts[],
  files: readonly string[],
  symbol: string,
): boolean => {
  const fileSet = new Set(files)
  const subjectFacts = facts.filter((f) => fileSet.has(f.file))
  // class name -> file that DEFINES it, among the subject owner files.
  const classFile = new Map<string, string>()
  for (const f of subjectFacts) {
    for (const c of f.classes) classFile.set(c.name, f.file)
  }
  for (const f of subjectFacts) {
    for (const c of f.classes) {
      for (const base of c.bases) {
        const baseFile = classFile.get(base)
        // base defined in a DIFFERENT subject owner file, and both files define
        // the shared method => structural override family.
        if (
          baseFile !== undefined &&
          baseFile !== f.file &&
          f.funcDefs.has(symbol) &&
          (subjectFacts.find((x) => x.file === baseFile)?.funcDefs.has(symbol) ?? false)
        ) {
          return true
        }
      }
    }
  }
  return false
}

/** unique-symbol-definer: issue-mentioned symbol with EXACTLY ONE owner definer. */
const uniqueDefinerWitnesses = (
  facts: readonly FileFacts[],
  issueText: string,
): StaticWitness[] => {
  const bySymbol = new Map<string, string[]>()
  for (const f of facts) {
    for (const sym of f.allDefs) {
      const list = bySymbol.get(sym) ?? []
      list.push(f.file)
      bySymbol.set(sym, list)
    }
  }
  const out: StaticWitness[] = []
  for (const [symbol, rawFiles] of [...bySymbol.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const files = [...new Set(rawFiles)]
    if (files.length !== 1) continue
    if (!issueMentions(issueText, symbol)) continue
    const file = files[0]
    if (file === undefined) continue
    out.push(
      makeStaticWitness({
        kind: "unique-symbol-definer",
        authority: "authoritative",
        provenance: "ast",
        subjectFiles: [file],
        subjectSymbols: [symbol],
        reason: `unique-symbol-definer: issue-mentioned \`${symbol}\` has exactly one static definer`,
      }),
    )
  }
  return out
}

/** producer-consumer: symbol defined in one owner file and called in another. */
const producerConsumerWitnesses = (facts: readonly FileFacts[]): StaticWitness[] => {
  // symbol -> producer file (defines it). Only single-definer symbols qualify as a
  // clean producer (multi-definer => that's an override family, handled above).
  const definers = new Map<string, string[]>()
  for (const f of facts) {
    for (const sym of f.funcDefs) {
      const list = definers.get(sym) ?? []
      list.push(f.file)
      definers.set(sym, list)
    }
  }
  const out: StaticWitness[] = []
  for (const [symbol, rawProducers] of [...definers.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const producers = [...new Set(rawProducers)]
    if (producers.length !== 1) continue
    const producer = producers[0]
    if (producer === undefined) continue
    const consumers = facts
      .filter((f) => f.file !== producer && f.calls.has(symbol))
      .map((f) => f.file)
      .sort()
    if (consumers.length === 0) continue
    const subjectFiles = [...new Set([producer, ...consumers])].sort()
    // authoritative only when BOTH producer and consumer files are known (they are,
    // by construction here, since both came from resolved owner sources).
    out.push(
      makeStaticWitness({
        kind: "producer-consumer",
        authority: "authoritative",
        provenance: "ast",
        subjectFiles,
        subjectSymbols: [symbol],
        fromFile: producer,
        reason: `producer-consumer: \`${symbol}\` produced in ${producer}, consumed by a caller`,
      }),
    )
  }
  return out
}

/** registration-callback: a callback passed into a registry-like API call. */
const registrationCallbackWitnesses = (facts: readonly FileFacts[]): StaticWitness[] => {
  // callback symbol -> file that DEFINES it (impl), among owner candidates.
  const implFile = new Map<string, string[]>()
  for (const f of facts) {
    for (const sym of f.funcDefs) {
      const list = implFile.get(sym) ?? []
      list.push(f.file)
      implFile.set(sym, list)
    }
  }
  const out: StaticWitness[] = []
  // Sort registration sites deterministically by (registrar, callback, file).
  const sites = facts
    .flatMap((f) => f.registrations.map((r) => ({ ...r, site: f.file })))
    .sort(
      (a, b) =>
        a.registrar.localeCompare(b.registrar) ||
        a.callback.localeCompare(b.callback) ||
        a.site.localeCompare(b.site),
    )
  for (const { registrar, callback, site } of sites) {
    const impls = implFile.get(callback) ?? []
    const impl = impls.length === 1 ? impls[0] : undefined
    const resolvable = impl !== undefined && impl !== site
    const subjectFiles = resolvable ? [site, impl as string].sort() : [site]
    out.push(
      makeStaticWitness({
        kind: "registration-callback",
        authority: resolvable ? "authoritative" : "advisory",
        provenance: "ast",
        subjectFiles,
        subjectSymbols: [callback],
        fromFile: site,
        reason: resolvable
          ? `registration-callback: \`${callback}\` registered via \`${registrar}\`, impl resolved`
          : `registration-callback: \`${callback}\` registered via \`${registrar}\` (impl unresolved)`,
      }),
    )
  }
  return out
}

/**
 * Legacy compat feeder: convert `ownerResolved` same-symbol ripgrep siblings into
 * ADVISORY override-family witnesses. NEVER authoritative — a ripgrep sibling has
 * no typed relation provenance, so it cannot confer clean authority on its own.
 */
const legacySiblingWitnesses = (input: StaticWitnessProviderInput): StaticWitness[] => {
  const bySymbol = new Map<string, Set<string>>()
  for (const r of input.ownerResolved ?? []) {
    const sym = r.forSymbol.trim()
    if (sym === "") continue
    const files = bySymbol.get(sym) ?? new Set<string>()
    if (r.file.trim() !== "") files.add(r.file.trim())
    if (r.fromFile !== undefined && r.fromFile.trim() !== "") files.add(r.fromFile.trim())
    bySymbol.set(sym, files)
  }
  const out: StaticWitness[] = []
  for (const [symbol, fileSet] of [...bySymbol.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const files = [...fileSet].sort()
    if (files.length < 2) continue
    out.push(
      makeStaticWitness({
        kind: "override-family",
        authority: "advisory",
        provenance: "ast",
        subjectFiles: files,
        subjectSymbols: [symbol],
        reason: `override-family (legacy ripgrep sibling): same-symbol \`${symbol}\` across files — advisory only`,
      }),
    )
  }
  return out
}

/**
 * PURE provider: Python source facts -> typed static witnesses.
 *
 * Python source-language best-effort; non-Python / missing source => no witness.
 */
export const buildAstStaticWitnesses = (
  input: StaticWitnessProviderInput,
): StaticWitness[] => {
  const facts = collectFacts(input)
  const witnesses: StaticWitness[] = [
    ...overrideFamilyWitnesses(facts, input.problemStatement),
    ...uniqueDefinerWitnesses(facts, input.problemStatement),
    ...producerConsumerWitnesses(facts),
    ...registrationCallbackWitnesses(facts),
    ...legacySiblingWitnesses(input),
  ]
  return dedupeWitnesses(witnesses)
}
