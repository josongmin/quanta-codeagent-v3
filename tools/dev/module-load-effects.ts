/**
 * MODULE-LOAD EXTERNAL-EFFECT DETECTOR (TVH-11).
 *
 * WHY IT EXISTS. Discovering a test suite must be free. It was not: several
 * ordinary test files spawned Chrome, started `Bun.serve`, ran `git init`,
 * probed four Python interpreters serially, or started a nested `bun test` —
 * all at MODULE LOAD, i.e. during discovery, before a single case was selected
 * to run. A `--list`-style pass, a shard planner that imports to classify, or a
 * developer running one unrelated case in the same file all paid the full bill.
 *
 * WHY IT IS AST-BASED AND NOT A GREP. The distinction that matters is
 * positional, not lexical: `Bun.spawn(...)` inside a `test()` or `beforeAll()`
 * callback is the correct place for it, and the identical text at module top
 * level is the defect. A regex cannot tell those apart, so a grep guard is
 * either vacuous (matches nothing useful) or an avalanche of false positives
 * that gets disabled. This walks the real TypeScript AST and tracks whether the
 * node is reachable during module evaluation.
 *
 * THREE SCOPE RULES THAT A NAIVE "AM I INSIDE A FUNCTION" WALK GETS WRONG:
 *
 *   1. `describe(...)` callbacks RUN AT MODULE LOAD under bun:test — collection
 *      is eager. `describe("x", () => { const probe = spawnProbe() })` is a
 *      module-load spawn wearing a function's clothes. `test`/`beforeAll`/
 *      `afterAll` callbacks are the opposite: deferred, and therefore fine.
 *   2. A top-level `const X = probeChrome()` is a module-load spawn even though
 *      the spawn is lexically inside `probeChrome`. Every real defect in this
 *      repo's corpus had exactly this shape (`await spawnProbe()`,
 *      `lldbDapPath()`, `await resolvePython()`), so the walk resolves calls to
 *      file-local function bindings and descends into them, carrying the
 *      callsite chain for the report.
 *   3. An IIFE — `const X = await (async () => { ... })()` — is module scope,
 *      and so is a `new Promise(executor)` executor and a class static block.
 *
 * The detector is PURE over `{ path, text }` records: no fs, no spawn, no
 * network. The enforcement test supplies the corpus.
 */

import ts from "typescript"

/**
 * What kind of external effect was found. Kept as a closed union with an
 * exhaustive `Record` at each use site so a new kind cannot be added without
 * every consumer classifying it.
 */
export type ModuleLoadEffectKind =
  | "spawn"
  | "install-or-build"
  | "git-init"
  | "serve"
  | "network"
  | "temp-dir"

export const MODULE_LOAD_EFFECT_KINDS: readonly ModuleLoadEffectKind[] = [
  "spawn",
  "install-or-build",
  "git-init",
  "serve",
  "network",
  "temp-dir",
]

export const MODULE_LOAD_EFFECT_KIND_DESCRIPTIONS: Record<ModuleLoadEffectKind, string> = {
  spawn: "starts a child process during module evaluation",
  "install-or-build":
    "runs a package manager / build / nested test command during module evaluation",
  "git-init": "creates or mutates a git repository during module evaluation",
  serve: "binds a server socket during module evaluation",
  network: "issues a network request during module evaluation",
  "temp-dir": "creates a temp directory during module evaluation",
}

export interface ModuleLoadEffect {
  /** Corpus-relative file path, exactly as handed in. */
  readonly file: string
  readonly kind: ModuleLoadEffectKind
  /**
   * STABLE identity for allowlisting: the resolution chain that reaches the
   * effect, then the callee text. `spawnProbe>Bun.spawn`. Deliberately NOT the
   * line number — line numbers drift on every edit above them, and an allowlist
   * keyed on a drifting field silently stops covering what it named.
   */
  readonly callsite: string
  /** Advisory only. Never part of allowlist matching. */
  readonly line: number
  readonly detail: string
}

export interface ModuleLoadScanInput {
  readonly path: string
  readonly text: string
}

export interface ModuleLoadScanResult {
  readonly effects: readonly ModuleLoadEffect[]
  /** Anti-vacuum: how many files the walk actually parsed. */
  readonly filesParsed: number
  /** Files whose parse produced a syntactic diagnostic — never silently ignored. */
  readonly parseFailures: readonly string[]
}

// ── vocabulary ──────────────────────────────────────────────────────────────

/** bun:test collection callbacks that RUN during module evaluation. */
const EAGER_CALLBACK_HEADS: ReadonlySet<string> = new Set(["describe", "suite", "xdescribe"])

/** bun:test callbacks that are DEFERRED to run time. */
const DEFERRED_CALLBACK_HEADS: ReadonlySet<string> = new Set([
  "test",
  "it",
  "xtest",
  "xit",
  "beforeAll",
  "beforeEach",
  "afterAll",
  "afterEach",
])

const CHILD_PROCESS_SPAWNERS: ReadonlySet<string> = new Set([
  "spawn",
  "spawnSync",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "fork",
])

const BUN_SPAWNERS: ReadonlySet<string> = new Set(["spawn", "spawnSync"])
const BUN_SERVERS: ReadonlySet<string> = new Set(["serve", "listen"])
const BUN_NETWORK: ReadonlySet<string> = new Set(["connect"])

const NET_SERVER_FACTORIES: ReadonlySet<string> = new Set(["createServer"])
const NETWORK_GLOBALS: ReadonlySet<string> = new Set(["fetch", "XMLHttpRequest", "WebSocket"])
const TEMP_DIR_MAKERS: ReadonlySet<string> = new Set([
  "mkdtemp",
  "mkdtempSync",
  "mkdtempDisposableSync",
])

const INSTALL_TOOLS: ReadonlySet<string> = new Set([
  "npm",
  "npx",
  "bun",
  "bunx",
  "pnpm",
  "yarn",
  "pip",
  "pip3",
  "uv",
  "cargo",
  "go",
])
const INSTALL_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "install",
  "add",
  "ci",
  "build",
  "test",
  "run",
  "exec",
])

const GIT_MUTATORS: ReadonlySet<string> = new Set(["init", "clone", "worktree", "commit"])

// ── small AST helpers ───────────────────────────────────────────────────────

const textOf = (node: ts.Node, source: ts.SourceFile): string =>
  source.text.slice(node.getStart(source), node.end).trim()

const lineOf = (node: ts.Node, source: ts.SourceFile): number =>
  source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1

/** `a.b.c` → ["a","b","c"]; a non-identifier root yields []. */
const dottedPath = (node: ts.Expression): readonly string[] => {
  if (ts.isIdentifier(node)) return [node.text]
  if (ts.isPropertyAccessExpression(node)) {
    const head = dottedPath(node.expression)
    return head.length === 0 ? [] : [...head, node.name.text]
  }
  // `describe.skipIf(x)(...)` / `test.each(t)(...)` — the head is the call's own callee.
  if (ts.isCallExpression(node)) return dottedPath(node.expression)
  if (ts.isParenthesizedExpression(node)) return dottedPath(node.expression)
  return []
}

const unwrapParens = (node: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(node) ? unwrapParens(node.expression) : node

const isFunctionLike = (node: ts.Node): node is ts.ArrowFunction | ts.FunctionExpression =>
  ts.isArrowFunction(node) || ts.isFunctionExpression(node)

/** The literal string arguments of a spawn call, so `git init` is separable from `git log`. */
const literalArgv = (call: ts.CallExpression): readonly string[] => {
  const out: string[] = []
  for (const arg of call.arguments) {
    if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
      out.push(...arg.text.split(/\s+/u).filter((t) => t.length > 0))
      continue
    }
    if (ts.isArrayLiteralExpression(arg)) {
      for (const el of arg.elements) {
        if (ts.isStringLiteral(el) || ts.isNoSubstitutionTemplateLiteral(el)) out.push(el.text)
      }
    }
  }
  return out
}

/** Refine a spawn into `install-or-build` / `git-init` when the argv says so. */
const spawnKind = (call: ts.CallExpression): ModuleLoadEffectKind => {
  const argv = literalArgv(call)
  const tool = (argv[0] ?? "").split("/").pop() ?? ""
  const sub = argv[1] ?? ""
  if (tool === "git" && GIT_MUTATORS.has(sub)) return "git-init"
  if (INSTALL_TOOLS.has(tool) && INSTALL_SUBCOMMANDS.has(sub)) return "install-or-build"
  // `bash -c "git init"` / `sh -c "npm install"` — the shell hides the real argv.
  const joined = argv.join(" ")
  if (/\bgit\s+(?:init|clone|worktree)\b/u.test(joined)) return "git-init"
  if (/\b(?:npm|bun|pnpm|yarn|pip3?|uv|cargo|go)\s+(?:install|add|ci|build|test)\b/u.test(joined)) {
    return "install-or-build"
  }
  return "spawn"
}

// ── effect classification for one call at module scope ──────────────────────

/**
 * Does this callee name an external effect? Returns the kind, or `undefined`
 * for an ordinary call.
 *
 * Import-binding aware: `spawnSync` is only treated as a spawner when the file
 * imported it from `node:child_process`, so a local helper called `exec` is not
 * a false positive.
 */
/** `Bun.spawn` / `Bun.serve` / `Bun.connect` — a global, so no import needed. */
const classifyBunMember = (
  call: ts.CallExpression,
  member: string,
): ModuleLoadEffectKind | undefined => {
  if (BUN_SPAWNERS.has(member)) return spawnKind(call)
  if (BUN_SERVERS.has(member)) return "serve"
  if (BUN_NETWORK.has(member)) return "network"
  return undefined
}

/**
 * A bare `spawnSync(...)` / `mkdtempSync(...)` / `createServer(...)`.
 *
 * The IMPORT is the qualifier: a file-local helper someone named `exec` is not
 * `child_process.exec`, and a guard that cannot tell those apart is the kind
 * that gets switched off. `fetch` and friends are the exception — they are
 * globals, so presence in the file is the whole condition.
 */
const classifyBareName = (
  call: ts.CallExpression,
  head: string,
  imported: ReadonlySet<string>,
): ModuleLoadEffectKind | undefined => {
  if (NETWORK_GLOBALS.has(head)) return "network"
  if (!imported.has(head)) return undefined
  if (CHILD_PROCESS_SPAWNERS.has(head)) return spawnKind(call)
  if (TEMP_DIR_MAKERS.has(head)) return "temp-dir"
  if (NET_SERVER_FACTORIES.has(head)) return "serve"
  return undefined
}

/** Namespace form: `fs.mkdtempSync(...)`, `cp.execSync(...)`, `http.createServer(...)`. */
const classifyNamespaced = (
  call: ts.CallExpression,
  head: string,
  member: string,
  imported: ReadonlySet<string>,
): ModuleLoadEffectKind | undefined => {
  if (!imported.has(head)) return undefined
  if (CHILD_PROCESS_SPAWNERS.has(member)) return spawnKind(call)
  if (TEMP_DIR_MAKERS.has(member)) return "temp-dir"
  if (NET_SERVER_FACTORIES.has(member)) return "serve"
  return undefined
}

const classifyCallee = (
  call: ts.CallExpression,
  imported: ReadonlySet<string>,
): ModuleLoadEffectKind | undefined => {
  const path = dottedPath(call.expression)
  const [head, member] = path as [string | undefined, string | undefined]
  if (head === undefined) return undefined
  if (head === "Bun" && member !== undefined) return classifyBunMember(call, member)
  if (path.length === 1) return classifyBareName(call, head, imported)
  if (path.length === 2 && member !== undefined) {
    return classifyNamespaced(call, head, member, imported)
  }
  return undefined
}

/** `Bun.$\`...\`` / `$\`...\`` at module scope is a shell spawn. */
const taggedShellEffect = (node: ts.TaggedTemplateExpression): boolean => {
  const path = dottedPath(node.tag as ts.Expression)
  return path.join(".") === "$" || path.join(".") === "Bun.$"
}

// ── binding collection (phase 1) ────────────────────────────────────────────

interface FileBindings {
  /** name → the body of a file-local function that a module-scope call may reach. */
  readonly functions: ReadonlyMap<string, ts.Node>
  /** Value-imported identifiers and namespace names, for import-aware classification. */
  readonly imported: ReadonlySet<string>
}

const collectBindings = (bindings: ts.NamedImportBindings, into: Set<string>): void => {
  if (ts.isNamespaceImport(bindings)) {
    into.add(bindings.name.text)
    return
  }
  for (const element of bindings.elements) {
    // A type-only import binds nothing at runtime, so it can never be an effect.
    if (!element.isTypeOnly) into.add(element.name.text)
  }
}

const collectImported = (source: ts.SourceFile, into: Set<string>): void => {
  for (const stmt of source.statements) {
    if (!ts.isImportDeclaration(stmt) || stmt.importClause === undefined) continue
    if (stmt.importClause.isTypeOnly) continue
    const { name, namedBindings } = stmt.importClause
    if (name !== undefined) into.add(name.text)
    if (namedBindings !== undefined) collectBindings(namedBindings, into)
  }
}

const collectTopLevelFunctions = (source: ts.SourceFile, into: Map<string, ts.Node>): void => {
  for (const stmt of source.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name !== undefined && stmt.body !== undefined) {
      into.set(stmt.name.text, stmt.body)
      continue
    }
    if (!ts.isVariableStatement(stmt)) continue
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.initializer === undefined) continue
      const init = unwrapParens(decl.initializer)
      if (isFunctionLike(init)) into.set(decl.name.text, init.body)
    }
  }
}

const bindingsOf = (source: ts.SourceFile): FileBindings => {
  const functions = new Map<string, ts.Node>()
  const imported = new Set<string>()
  collectImported(source, imported)
  collectTopLevelFunctions(source, functions)
  return { functions, imported }
}

// ── module-scope walk (phase 2) ─────────────────────────────────────────────

const MAX_RESOLUTION_DEPTH = 6

interface WalkState {
  readonly source: ts.SourceFile
  readonly file: string
  readonly bindings: FileBindings
  readonly out: ModuleLoadEffect[]
  readonly chain: readonly string[]
  readonly visiting: ReadonlySet<string>
}

const record = (
  state: WalkState,
  kind: ModuleLoadEffectKind,
  node: ts.Node,
  calleeText: string,
): void => {
  const callsite = [...state.chain, calleeText].join(">")
  state.out.push({
    file: state.file,
    kind,
    callsite,
    line: lineOf(node, state.source),
    detail: `${MODULE_LOAD_EFFECT_KIND_DESCRIPTIONS[kind]} (${callsite})`,
  })
}

const descend = (node: ts.Node, state: WalkState): void => {
  node.forEachChild((child) => {
    walkModuleScope(child, state)
  })
}

/**
 * Walk a function BODY.
 *
 * A concise arrow (`() => Bun.spawn(...)`) has an EXPRESSION body, not a block,
 * so descending into its children skips the expression itself — which silently
 * lost every one-line probe helper. The body node is walked directly unless it
 * is a block, whose children are the statements.
 */
const walkBody = (body: ts.Node, state: WalkState): void => {
  if (ts.isBlock(body)) descend(body, state)
  else walkModuleScope(body, state)
}

/** `describe(…)` body / IIFE body / resolved local function body — still module scope. */
const enterEager = (body: ts.Node, state: WalkState, label: string): void => {
  if (state.chain.length >= MAX_RESOLUTION_DEPTH) return
  walkBody(body, { ...state, chain: [...state.chain, label] })
}

const handleEagerCallbackCall = (call: ts.CallExpression, state: WalkState, head: string): void => {
  for (const arg of call.arguments) {
    const inner = unwrapParens(arg)
    if (isFunctionLike(inner)) enterEager(inner.body, state, head)
    else walkModuleScope(arg, state)
  }
  // `describe.skipIf(<expr>)(cb)` — the gate expression is itself module scope.
  if (ts.isCallExpression(call.expression)) walkModuleScope(call.expression, state)
}

const handleDeferredCallbackCall = (call: ts.CallExpression, state: WalkState): void => {
  for (const arg of call.arguments) {
    if (!isFunctionLike(unwrapParens(arg))) walkModuleScope(arg, state)
  }
  if (ts.isCallExpression(call.expression)) walkModuleScope(call.expression, state)
}

/**
 * A call to a file-local function is resolved and its body walked AS MODULE
 * SCOPE. This is the rule that catches `const PROBE = await spawnProbe()`,
 * where the text at top level is innocent and the spawn is one hop away.
 */
const handleLocalResolution = (
  call: ts.CallExpression,
  state: WalkState,
  name: string,
  body: ts.Node,
): void => {
  if (!state.visiting.has(name) && state.chain.length < MAX_RESOLUTION_DEPTH) {
    walkBody(body, {
      ...state,
      chain: [...state.chain, name],
      visiting: new Set([...state.visiting, name]),
    })
  }
  for (const arg of call.arguments) walkModuleScope(arg, state)
}

const handleCall = (call: ts.CallExpression, state: WalkState): void => {
  const kind = classifyCallee(call, state.bindings.imported)
  if (kind !== undefined) {
    record(state, kind, call, textOf(call.expression, state.source))
    for (const arg of call.arguments) walkModuleScope(arg, state)
    return
  }
  const path = dottedPath(call.expression)
  const head = path[0]
  if (head !== undefined && EAGER_CALLBACK_HEADS.has(head)) {
    handleEagerCallbackCall(call, state, head)
    return
  }
  if (head !== undefined && DEFERRED_CALLBACK_HEADS.has(head)) {
    handleDeferredCallbackCall(call, state)
    return
  }
  const callee = unwrapParens(call.expression)
  if (isFunctionLike(callee)) {
    enterEager(callee.body, state, "(iife)")
    for (const arg of call.arguments) walkModuleScope(arg, state)
    return
  }
  if (path.length === 1 && head !== undefined) {
    const body = state.bindings.functions.get(head)
    if (body !== undefined) {
      handleLocalResolution(call, state, head, body)
      return
    }
  }
  descend(call, state)
}

/** `new Promise(executor)` runs the executor immediately; other `new` does not. */
const handleNew = (node: ts.NewExpression, state: WalkState): void => {
  const isPromise = dottedPath(node.expression).join(".") === "Promise"
  for (const arg of node.arguments ?? []) {
    const inner = unwrapParens(arg)
    if (isFunctionLike(inner)) {
      if (isPromise) enterEager(inner.body, state, "(promise-executor)")
      continue
    }
    walkModuleScope(arg, state)
  }
}

const handleClass = (node: ts.ClassDeclaration | ts.ClassExpression, state: WalkState): void => {
  for (const member of node.members) {
    if (ts.isClassStaticBlockDeclaration(member)) {
      enterEager(member.body, state, "(static-block)")
      continue
    }
    if (
      ts.isPropertyDeclaration(member) &&
      member.initializer !== undefined &&
      member.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) === true
    ) {
      walkModuleScope(member.initializer, state)
    }
  }
}

function walkModuleScope(node: ts.Node, state: WalkState): void {
  // A function DEFINITION does not run. Its body is reached only through the
  // eager/resolution paths above, never by falling through here.
  if (
    ts.isFunctionDeclaration(node) ||
    isFunctionLike(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  ) {
    return
  }
  if (ts.isCallExpression(node)) {
    handleCall(node, state)
    return
  }
  if (ts.isNewExpression(node)) {
    handleNew(node, state)
    return
  }
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
    handleClass(node, state)
    return
  }
  if (ts.isTaggedTemplateExpression(node)) {
    if (taggedShellEffect(node)) {
      record(state, "spawn", node, textOf(node.tag, state.source))
      return
    }
  }
  descend(node, state)
}

// ── public entry points ─────────────────────────────────────────────────────

interface OneFileScan {
  readonly effects: readonly ModuleLoadEffect[]
  readonly parseFailed: boolean
}

/**
 * Parse ONCE, then answer both questions. Parsing twice (once for effects, once
 * for diagnostics) doubled the cost of a 3,600-file corpus for nothing.
 *
 * `parseDiagnostics` is internal-but-stable; its ABSENCE must not read as
 * "clean", so an unreadable shape counts as a parse failure.
 */
const scanOne = (input: ModuleLoadScanInput): OneFileScan => {
  const source = ts.createSourceFile(
    input.path,
    input.text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const diagnostics = (source as unknown as { parseDiagnostics?: readonly unknown[] })
    .parseDiagnostics
  const out: ModuleLoadEffect[] = []
  const state: WalkState = {
    source,
    file: input.path,
    bindings: bindingsOf(source),
    out,
    chain: [],
    visiting: new Set<string>(),
  }
  for (const stmt of source.statements) walkModuleScope(stmt, state)
  return { effects: dedupe(out), parseFailed: diagnostics === undefined || diagnostics.length > 0 }
}

/** Scan ONE file. Pure: no fs, no spawn. */
export const detectModuleLoadEffects = (input: ModuleLoadScanInput): readonly ModuleLoadEffect[] =>
  scanOne(input).effects

/**
 * The resolution walk can reach the same physical call twice (two module-scope
 * calls into one helper). One finding per file+kind+callsite+line.
 */
const dedupe = (effects: readonly ModuleLoadEffect[]): readonly ModuleLoadEffect[] => {
  const seen = new Set<string>()
  const out: ModuleLoadEffect[] = []
  for (const e of effects) {
    const key = `${e.file}\u0000${e.kind}\u0000${e.callsite}\u0000${e.line}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(e)
  }
  return out
}

/** Scan a corpus. Returns the anti-vacuum counters alongside the findings. */
export const scanModuleLoadEffects = (
  inputs: readonly ModuleLoadScanInput[],
): ModuleLoadScanResult => {
  const effects: ModuleLoadEffect[] = []
  const parseFailures: string[] = []
  for (const input of inputs) {
    const one = scanOne(input)
    if (one.parseFailed) parseFailures.push(input.path)
    effects.push(...one.effects)
  }
  effects.sort(
    (a, b) =>
      a.file.localeCompare(b.file) || a.line - b.line || a.callsite.localeCompare(b.callsite),
  )
  return { effects, filesParsed: inputs.length, parseFailures }
}
