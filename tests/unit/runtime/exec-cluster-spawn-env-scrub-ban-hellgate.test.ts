/**
 * ★ PERMANENT GUARD — EXEC-CLUSTER SPAWN ENV-SCRUB BAN (R-D3, RFC jun-7 Phase-2).
 *
 * THE BUG CLASS THIS LOCKS DOWN:
 *   A spawn site in the exec cluster that runs a user-command SHELL
 *   (`bash -lc <cmd>` / an interactive PTY shell) leaks the PARENT process env
 *   — including `*_API_KEY` / `*_TOKEN` / `*_SECRET` — into the child UNLESS it
 *   passes an `env:` that was produced by the shared scrubber (`scrubEnv` /
 *   `buildPtyEnv` / `applyLocalEnv`). There are TWO leak shapes:
 *     (1) a RAW `{ ...process.env }` spread — explicit full-inherit leak;
 *     (2) an `env:`-ABSENT spawn — Bun then SNAPSHOTS the parent env
 *         (inherit-by-omission), the silent leak the `R-D3` audit flagged.
 *   Both are a RED test here.
 *
 * ─── WHY THIS FILE WAS REWRITTEN (two MEASURED defects, aug-28) ───────────────
 *
 * DEFECT 1 — THE SCOPE LIST WAS STALE, so the ban scanned where the code no
 * longer is. It hardcoded five file paths:
 *   `runtime/shell.ts`, `runtime/bash-bg-registry.ts`, `runtime/sandbox.ts`,
 *   `agent/command-hooks/sandbox-exec.ts`, `host/runtime/pty-backend.ts`.
 * MEASURED on the tree it was guarding: across all five, exactly ONE real
 * `Bun.spawn(` survives — `pty-backend.ts`'s `["tmux", …]` runner — and that one
 * is itself allowlisted. The cluster had moved behind the `spawnScrubbed` PORT
 * (`src/runtime/scrubbed-spawn.ts`), which the list never named. RED PROOF: a
 * literal `Bun.spawn(["bash","-lc","echo pwn"], {})` appended to
 * `src/runtime/scrubbed-spawn.ts` left this guard GREEN (3 pass / 0 fail).
 * (The jun-08 test-quality audit had already recorded the same blind spot.)
 *   FIX: the population is DERIVED by measurement on every run — see
 *   {@link deriveClusterFiles}. A file cannot fall out of scope by being
 *   renamed, split, or replaced by a port.
 *
 * DEFECT 2 — FILE-GLOBAL IDENTIFIER RESOLUTION whitewashed real leaks. The old
 * `assignmentRhs` matched `(?:const|let|var)\s+<ident>\s*=` ANYWHERE in the
 * file, so ANY scrubbed binding named `env` cleared EVERY spawn in that file.
 * MEASURED, identical injected call `Bun.spawn(cmd, { env: process.env })`:
 *   A — `host/runtime/pty-backend.ts` (no file-level `const env`) → FLAGGED ✓
 *   B — `src/runtime/sandbox.ts` (has `const env = asScrubbedEnv(scrubEnv(…))`
 *       at line 213, in a DIFFERENT method) → NOT FLAGGED ✗  (guard green)
 * The B result is why an earlier control looked clean. Note the resolution did
 * not even need a same-named identifier in the leak: `process.env` contributes
 * the bare word `env` through the PROPERTY name, and the file-global scan
 * happily bound it.
 *   FIX: resolution runs on the TypeScript AST (`ts.createSourceFile`, the tool
 *   several `_arch` guards already use), against the NEAREST PRECEDING
 *   declaration in the ENCLOSING SCOPE CHAIN, and only for identifiers in VALUE
 *   position (a `.env` property name is not an identifier reference). A binding
 *   that is a parameter, a destructured element, or declared after the use is
 *   OPAQUE — fail-closed, not scrubbed.
 *
 * ─── SCOPE / ALLOWLIST ───────────────────────────────────────────────────────
 * Every {@link ALLOWLIST} entry carries its reason AND is itself ratcheted: a
 * test asserts each entry still matches a live spawn call, so the allowlist
 * cannot rot the way the scope list did. (Three entries that named spawns in
 * `sandbox.ts` were removed by that rule — `sandbox.ts` has no `Bun.spawn` at
 * all today; it routes through the port.)
 *
 * MEASURED-AND-CLASSIFIED, deliberately outside the derivation:
 *   - `runner/batch/**`, `apps/bench/**` — the bench/eval harness. Excluded by
 *     the SCOPE paragraph of `src/runtime/scrubbed-spawn.ts`, which names those
 *     directories as NON-exec-cluster consumers of `scrubEnv`. `eval/exec.ts`
 *     is scrubbed anyway (`execEnv` → `applyLocalEnv(scrubEnv(), …)`);
 *     `corpus/dataset.ts` passes a raw `env: process.env` to `bash -c` —
 *     reported separately, not silently adopted here.
 *   - `runtime/shell-snapshot/bun-spawner.ts` — spawns `zsh -i -c` /
 *     `bash -i -c`, but the argv is built by `{bash,zsh}-capture.ts` to CAPTURE
 *     the operator's own interactive shell; no model/user command is run and
 *     the operator env is the subject of the snapshot.
 *   - the `runtime/os-sandbox/*` exec adapters (env passed through from the caller).
 *   - `runtime/node-repl/default-kernel.ts` (`node -i`) WAS listed here as "not a shell;
 *     a different charter". That was the wrong test: the REPL runs model-authored
 *     JavaScript, which reads `process.env` as easily as a shell does, and the kernel
 *     spawned with no `env` at all. Measured with a provider key present at startup, the
 *     kernel printed it. It now spawns through `bunScrubbedSpawner` with
 *     `asScrubbedEnv(scrubEnv())`, so it imports the funnel and is IN this derivation.
 *     The binary list below stays shell-only; an interpreter REPL is covered by routing
 *     through the funnel, where an inherit-by-omission spawn is a type error.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"
import ts from "typescript"
import { assertScanPopulation } from "../_shared/scan-population"

const SRC = join(import.meta.dir, "..", "..", "..", "src")

/** The exec-cluster spawn PORT. Membership anchor for the derivation and the
 *  anti-vacuity floor: if this file stops being derived, the derivation broke. */
const FUNNEL = "runtime/scrubbed-spawn.ts"

/** An import of the funnel, by ANY spelling. MEASURED: matching only the alias
 *  form (`@/runtime/scrubbed-spawn`) missed every sibling that imports it
 *  RELATIVELY — `src/runtime/sandbox.ts` says `from "./scrubbed-spawn"`, and a
 *  leak injected there stayed green because the file was never derived into the
 *  population at all. Match the module basename. */
const IMPORTS_FUNNEL = /from\s+["'][^"']*scrubbed-spawn["']/

/** The scrubber producers — an `env:` value MUST reach one of these to count as
 *  routed. `withProxyEnv(...)` / `applyLocalEnv(...)` compose OVER a scrubber
 *  base, so they are accepted only when a base token is also reachable. */
const SCRUBBER_TOKENS = ["scrubEnv", "buildPtyEnv", "applyLocalEnv"]

/** Shell binaries whose argv-literal head marks a spawn as a user-command
 *  shell. `node`/`python` are NOT here — see the header's classification. */
const SHELL_BINARIES = new Set(["bash", "sh", "zsh", "dash", "ksh"])

/** Helpers that BUILD a user-command shell argv (`["bash","-lc",cmd]`). */
const SHELL_ARGV_BUILDERS = new Set(["disclaimedShellArgv", "POSIX_SHELL_ARGV"])

/** Directories whose spawns are governed by a different, documented scope
 *  decision (see the header). Excluded from the derivation, never from the
 *  reporting in the header. */
const EXCLUDED_ROOTS = ["runner/batch/", "apps/bench/"]

interface Ruled {
  /** Cluster-relative path (`runtime/scrubbed-spawn.ts`). */
  readonly file: string
  /** A stable substring of the spawn call's text. */
  readonly match: string
  /** Why this call is not a leak. Every entry is asserted to still match. */
  readonly why: string
}

/** Benign / type-enforced spawn calls. NOT a place to park a real leak. */
const ALLOWLIST: readonly Ruled[] = [
  {
    file: "host/runtime/pty-backend.ts",
    match: '["tmux"',
    why: "tmux subcommand runner: argv-array (no shell), runs no model command, inherits the operator env on purpose.",
  },
  {
    file: FUNNEL,
    match: "argv as string[]",
    why: "`bunScrubbedSpawner` IS the chokepoint: its `env` parameter is the branded `ScrubbedEnv`, minted only by `asScrubbedEnv`, so a leak here is a tsc error rather than a scan hit (pinned by scrubbed-spawn-brand-hellgate.test.ts). The brand arrives destructured from `options`, which this scanner is deliberately fail-closed about.",
  },
]

/**
 * GENUINE, UNFIXED leaks the aug-28 derivation surfaced — recorded, not
 * forgiven. This is a TWO-WAY ratchet: the ban asserts the offender set equals
 * this list EXACTLY, so a new leak goes red AND landing the fix goes red until
 * the entry is deleted. Never move a call here to make a suite green.
 */
/**
 * Leaks this ban has SEEN and not yet closed. Two-way: a new one is red, and so
 * is a stale entry once the real fix lands — which is how the single entry that
 * lived here got retired. `subagent/exec-command.ts` ran a MODEL-SUPPLIED
 * `bash -lc` with `env` omitted on one branch (inherit-by-omission) and
 * `{ ...process.env, ...input.env }` on the other; it now routes through
 * `scrubEnv()`, and its own hellgate holds that.
 */
const KNOWN_OPEN_LEAKS: readonly Ruled[] = []

// ─── AST scanning ────────────────────────────────────────────────────────────

const parse = (text: string): ts.SourceFile =>
  ts.createSourceFile("scan.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

/** Every real `Bun.spawn(...)` CallExpression. Comments and string literals are
 *  excluded BY PARSING — a doc-comment mention is not a node. */
const spawnCalls = (sf: ts.SourceFile): ts.CallExpression[] => {
  const out: ts.CallExpression[] = []
  const visit = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ts.isIdentifier(n.expression.expression) &&
      n.expression.expression.text === "Bun" &&
      n.expression.name.text === "spawn"
    ) {
      out.push(n)
    }
    n.forEachChild(visit)
  }
  sf.forEachChild(visit)
  return out
}

/** A scope for `var`-free (const/let) resolution purposes. */
const isScope = (n: ts.Node): boolean =>
  ts.isSourceFile(n) ||
  ts.isBlock(n) ||
  ts.isModuleBlock(n) ||
  ts.isCaseBlock(n) ||
  ts.isForStatement(n) ||
  ts.isForInStatement(n) ||
  ts.isForOfStatement(n)

const enclosingScope = (n: ts.Node): ts.Node | undefined => {
  let p: ts.Node | undefined = n.parent
  while (p !== undefined && !isScope(p)) p = p.parent
  return p
}

const scopeDeclCache = new WeakMap<ts.Node, ts.VariableDeclaration[]>()

/** Variable declarations whose OWN enclosing scope is `scope` (not a nested
 *  function's locals). Memoized — a file is scanned many times. */
const declarationsIn = (scope: ts.Node): ts.VariableDeclaration[] => {
  const cached = scopeDeclCache.get(scope)
  if (cached !== undefined) return cached
  const out: ts.VariableDeclaration[] = []
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && enclosingScope(n) === scope) out.push(n)
    n.forEachChild(visit)
  }
  scope.forEachChild(visit)
  scopeDeclCache.set(scope, out)
  return out
}

/** Names bound by a declaration name node (identifier or binding pattern). */
const boundNames = (name: ts.BindingName, out: Set<string> = new Set()): Set<string> => {
  if (ts.isIdentifier(name)) out.add(name.text)
  else for (const el of name.elements) if (!ts.isOmittedExpression(el)) boundNames(el.name, out)
  return out
}

/** `"opaque"` = the name IS bound here but the value cannot be followed
 *  (parameter, destructured element, declared after the use). Fail-closed: an
 *  opaque binding STOPS the outward walk, so an outer scrubbed binding of the
 *  same name can never whitewash an inner one. */
type Binding = ts.Expression | "opaque" | undefined

const resolveBinding = (name: string, use: ts.Node): Binding => {
  const useStart = use.pos
  for (let n: ts.Node | undefined = use.parent; n !== undefined; n = n.parent) {
    if (ts.isFunctionLike(n) && n.parameters.some((p) => boundNames(p.name).has(name))) {
      return "opaque"
    }
    if (!isScope(n)) continue
    const here = declarationsIn(n).filter((d) => boundNames(d.name).has(name))
    if (here.length === 0) continue
    const preceding = here.filter((d) => d.end <= useStart)
    if (preceding.length === 0) return "opaque" // declared, but not before the use
    const nearest = preceding[preceding.length - 1] as ts.VariableDeclaration
    if (!ts.isIdentifier(nearest.name)) return "opaque" // destructured
    return nearest.initializer ?? "opaque"
  }
  return undefined
}

/** Identifiers in VALUE position inside `expr` — a property NAME (`process.env`,
 *  `{ env: x }`) is not a reference and must not be resolved as one. Shorthand
 *  property names ARE references and are kept. */
const valueIdentifiers = (expr: ts.Node): ts.Identifier[] => {
  const out: ts.Identifier[] = []
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) {
      const p = n.parent
      const isPropName =
        (ts.isPropertyAccessExpression(p) && p.name === n) ||
        (ts.isPropertyAssignment(p) && p.name === n) ||
        (ts.isQualifiedName(p) && p.right === n) ||
        ts.isBindingElement(p)
      if (!isPropName) out.push(n)
      return
    }
    n.forEachChild(visit)
  }
  if (ts.isIdentifier(expr)) out.push(expr)
  else expr.forEachChild(visit)
  return out
}

/**
 * Does this env expression reach a scrubber producer? Directly (its text names
 * one) or transitively through bindings resolved in the SAME SCOPE CHAIN.
 * Bounded by `seen` (no cycle hang).
 */
const expressionIsScrubbed = (expr: ts.Node, seen: Set<ts.Node>): boolean => {
  if (seen.has(expr)) return false
  seen.add(expr)
  const text = expr.getText()
  if (SCRUBBER_TOKENS.some((t) => text.includes(t))) return true
  for (const id of valueIdentifiers(expr)) {
    const bound = resolveBinding(id.text, id)
    if (bound === undefined || bound === "opaque") continue
    if (expressionIsScrubbed(bound, seen)) return true
  }
  return false
}

/** The object-literal arguments of a spawn call (`Bun.spawn(opts)` and
 *  `Bun.spawn(argv, opts)` are both real Bun shapes). */
const optionObjects = (call: ts.CallExpression): ts.ObjectLiteralExpression[] =>
  call.arguments.filter(ts.isObjectLiteralExpression)

const isEnvName = (n: ts.PropertyName): boolean =>
  (ts.isIdentifier(n) || ts.isStringLiteral(n)) && n.text === "env"

/** The `env` value of one option object, ignoring spreads. A shorthand
 *  (`{ env }`) resolves to the identifier itself, so scope resolution starts at
 *  the USE site. */
const envPropOf = (obj: ts.ObjectLiteralExpression): ts.Node | undefined => {
  for (const prop of obj.properties) {
    if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === "env") return prop.name
    if (ts.isPropertyAssignment(prop) && isEnvName(prop.name)) return prop.initializer
  }
  return undefined
}

/** `env` reached through a SPREAD option bag — `...(env !== undefined ? { env }
 *  : {})` is the live shape in `subagent/exec-command.ts`. A conditionally
 *  present env counts as present, and must then be scrubbed. */
const envInSpread = (obj: ts.ObjectLiteralExpression): ts.Node | undefined => {
  let found: ts.Node | undefined
  const dig = (n: ts.Node): void => {
    if (found !== undefined) return
    if (ts.isObjectLiteralExpression(n)) found = envPropOf(n) ?? envInSpread(n)
    if (found === undefined) n.forEachChild(dig)
  }
  for (const prop of obj.properties) if (ts.isSpreadAssignment(prop)) dig(prop.expression)
  return found
}

/**
 * The `env` value expression of a spawn call, or `undefined` when there is no
 * `env` at all (inherit-by-omission).
 */
const envExpression = (call: ts.CallExpression): ts.Node | undefined => {
  for (const obj of optionObjects(call)) {
    const found = envPropOf(obj) ?? envInSpread(obj)
    if (found !== undefined) return found
  }
  return undefined
}

/** Is the env routed through a scrubber producer? `env` must be present AND
 *  reach a scrubber token through the scope-resolved chain. */
const hasScrubbedEnv = (call: ts.CallExpression): boolean => {
  const value = envExpression(call)
  if (value === undefined) return false
  return expressionIsScrubbed(value, new Set())
}

/** Does this call run a user-command shell (`["bash","-lc",cmd]`,
 *  `disclaimedShellArgv("bash", cmd)`, `[...POSIX_SHELL_ARGV(cmd)]`)? */
/** The initializer a local `const`/`let` binds, when the name resolves inside
 *  this file. Needed because `const argv = ["bash","-lc",cmd]` before the spawn
 *  is an ordinary refactor, and requiring the array AT THE CALL SITE let that
 *  one-line change walk the whole derivation — measured. */
const localInitializer = (id: ts.Identifier, file: ts.SourceFile): ts.Expression | undefined => {
  let found: ts.Expression | undefined
  const visit = (node: ts.Node): void => {
    if (
      found === undefined &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === id.text &&
      node.initializer !== undefined
    ) {
      found = node.initializer
      return
    }
    if (found === undefined) ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

/** The head token of an argv array, resolving a `const SH = "bash"` head. */
/** `"/bin/bash"` is `bash`. Comparing the whole token let an absolute path walk
 *  straight past the derivation — measured. */
const namesShell = (token: string): boolean =>
  SHELL_BINARIES.has(token) || SHELL_BINARIES.has(token.slice(token.lastIndexOf("/") + 1))

const argvHeadIsShell = (argv: ts.ArrayLiteralExpression, file: ts.SourceFile): boolean => {
  const head = argv.elements[0]
  if (head === undefined) return false
  if (ts.isStringLiteral(head)) return namesShell(head.text)
  if (ts.isIdentifier(head)) {
    const init = localInitializer(head, file)
    return init !== undefined && ts.isStringLiteral(init) && namesShell(init.text)
  }
  // A spread (`[...argv]`, `[...BASE, cmd]`) hides its head. Treating that as a
  // shell was tried and REVERTED: it pulled in six spawners that are not shells
  // at all — `browser/cdp/defaults.ts`, the two voice recorders,
  // `shell-snapshot/bun-spawner.ts` — each of which forwards an argv its own
  // caller built. A ban that flags a Chrome launch as an unscrubbed shell is a
  // ban people turn off. The residual is stated in the header instead: a
  // spread-headed argv is outside this derivation.
  return false
}

const isUserCommandShell = (call: ts.CallExpression, file: ts.SourceFile): boolean => {
  const raw = call.arguments[0]
  if (raw === undefined) return false
  // Follow a variable to its initializer first: the array need not be written
  // at the call site to be the same argv.
  const argv = ts.isIdentifier(raw) ? (localInitializer(raw, file) ?? raw) : raw
  if (ts.isCallExpression(argv) || ts.isArrayLiteralExpression(argv)) {
    for (const id of valueIdentifiers(argv)) {
      if (SHELL_ARGV_BUILDERS.has(id.text)) return true
    }
  }
  if (!ts.isArrayLiteralExpression(argv)) return false
  return argvHeadIsShell(argv, file)
}

// ─── Derivation (defect 1) ───────────────────────────────────────────────────

const tsFilesUnder = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) tsFilesUnder(p, out)
    else if (p.endsWith(".ts") && !p.includes(".test.")) out.push(p)
  }
  return out
}
const EXEC_CLUSTER_SRC_FILES = tsFilesUnder(SRC)

export interface ClusterFile {
  readonly file: string
  readonly sf: ts.SourceFile
  readonly calls: readonly ts.CallExpression[]
}

/**
 * MEASURE the exec cluster instead of listing it. A file is a member iff it has
 * a real `Bun.spawn(` AND one of:
 *   - it IS the {@link FUNNEL};
 *   - it imports the funnel (a declared exec-cluster member);
 *   - it builds a user-command shell argv at the spawn site.
 * Renames, splits and port moves are followed automatically — the failure mode
 * that made this guard vacuous cannot recur.
 */
export const deriveClusterFiles = (): ClusterFile[] => {
  const out: ClusterFile[] = []
  for (const abs of EXEC_CLUSTER_SRC_FILES) {
    const rel = relative(SRC, abs).split(sep).join("/")
    if (EXCLUDED_ROOTS.some((r) => rel.startsWith(r))) continue
    const text = readFileSync(abs, "utf8")
    if (!text.includes("Bun.spawn(")) continue
    const sf = parse(text)
    const calls = spawnCalls(sf)
    if (calls.length === 0) continue
    const member =
      rel === FUNNEL || IMPORTS_FUNNEL.test(text) || calls.some((c) => isUserCommandShell(c, sf))
    if (member) out.push({ file: rel, sf, calls })
  }
  return out.sort((a, b) => a.file.localeCompare(b.file))
}

const ruleMatches = (rules: readonly Ruled[], file: string, callText: string): boolean =>
  rules.some((r) => r.file === file && callText.includes(r.match))

export interface Offender {
  readonly file: string
  readonly call: string
}

/** The leaky calls of one derived cluster file (allowlist applied). */
const offendersIn = (entry: ClusterFile): Offender[] =>
  entry.calls
    .filter((c) => !ruleMatches(ALLOWLIST, entry.file, c.getText()) && !hasScrubbedEnv(c))
    .map((c) => ({ file: entry.file, call: c.getText().replace(/\s+/g, " ") }))

/**
 * Pure predicate over a source TEXT — the injection surface. Returns the leaky
 * `Bun.spawn` calls: not allowlisted (by argv-tool head) and not scrubbed.
 * Kept text-in/text-out so a synthetic snippet can be measured directly.
 */
export const leakySpawnCalls = (text: string): string[] => {
  const sf = parse(text)
  return spawnCalls(sf)
    .filter((c) => !ALLOWLIST.some((r) => c.getText().includes(r.match)) && !hasScrubbedEnv(c))
    .map((c) => c.getText())
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("exec-cluster spawn env-scrub ban — every shell spawn routes through the scrubber (R-D3)", () => {
  const cluster = deriveClusterFiles()
  assertScanPopulation(EXEC_CLUSTER_SRC_FILES, SRC, {
    collectable: (name) => name.endsWith(".ts") && !name.includes(".test."),
    id: "tests/unit/runtime/exec-cluster-spawn-env-scrub-ban-hellgate.test.ts#SRC",
    matched: cluster.map(({ file }) => join(SRC, file)),
  })

  test("ANTI-VACUITY: the derived population is real, and contains the known spawner", () => {
    // A ban that scans nothing passes by construction — defect 1. The floor is
    // deliberately above the legacy list's TRUE content (which was 1 call, and
    // that one allowlisted).
    expect(cluster.length).toBeGreaterThanOrEqual(2)
    expect(cluster.map((c) => c.file)).toContain(FUNNEL)
    // MEASURED today: 3 files / 3 calls (`runtime/scrubbed-spawn.ts`,
    // `host/runtime/pty-backend.ts`, `subagent/exec-command.ts`). The floor is
    // set at the POST-FIX population (2/2) on purpose: fixing the recorded open
    // leak removes its raw spawn, and a floor pinned to today's count would
    // punish the fix instead of the rot.
    const totalCalls = cluster.reduce((n, c) => n + c.calls.length, 0)
    expect(totalCalls).toBeGreaterThanOrEqual(2)
    // Defect-1 regression pin: the derivation MUST reach past the five paths the
    // stale list named — `scrubbed-spawn.ts` was invisible to it.
    const LEGACY_LIST = [
      "runtime/shell.ts",
      "runtime/bash-bg-registry.ts",
      "runtime/sandbox.ts",
      "agent/command-hooks/sandbox-exec.ts",
      "host/runtime/pty-backend.ts",
    ]
    expect(cluster.filter((c) => !LEGACY_LIST.includes(c.file)).length).toBeGreaterThanOrEqual(1)
  })

  test("NO exec-cluster spawn leaks parent env (raw spread OR env-absent)", () => {
    const offenders = cluster.flatMap(offendersIn)
    // TWO-WAY ratchet against KNOWN_OPEN_LEAKS: a new leak is red, and so is a
    // stale entry after the real fix lands.
    const expected = KNOWN_OPEN_LEAKS.map((r) => r.file).sort()
    expect(offenders.map((o) => o.file).sort()).toEqual(expected)
    for (const o of offenders) {
      expect(
        ruleMatches(KNOWN_OPEN_LEAKS, o.file, o.call),
        `unrecorded leaky spawn in ${o.file}: ${o.call}`,
      ).toBe(true)
    }
  })

  test("the ALLOWLIST cannot rot: every entry still matches a live spawn call", () => {
    // The scope list went stale silently; the allowlist must not. Three entries
    // naming `sandbox.ts` spawns were deleted by this rule.
    for (const rule of [...ALLOWLIST, ...KNOWN_OPEN_LEAKS]) {
      const entry = cluster.find((c) => c.file === rule.file)
      expect(entry, `rule names a file outside the derived cluster: ${rule.file}`).toBeDefined()
      const hit = (entry?.calls ?? []).some((c) => c.getText().includes(rule.match))
      expect(hit, `rule matches no live spawn call: ${rule.file} :: ${rule.match}`).toBe(true)
      expect(rule.why.length).toBeGreaterThan(40)
    }
  })

  test("red-on-injection: env-absent AND raw-process.env spawns are flagged; scrubbed is clean", () => {
    // (2) inherit-by-omission — no `env:` at all.
    expect(leakySpawnCalls('Bun.spawn(["bash","-lc",c], {})')).toEqual([
      'Bun.spawn(["bash","-lc",c], {})',
    ])
    // (1) raw full-inherit spread.
    expect(
      leakySpawnCalls('Bun.spawn(argv, { cwd, env: { ...process.env }, stdout: "pipe" })'),
    ).toEqual(['Bun.spawn(argv, { cwd, env: { ...process.env }, stdout: "pipe" })'])
    // The fixed form — env routed through the scrubber.
    expect(leakySpawnCalls('Bun.spawn(argv, { cwd, env: scrubEnv(), stdout: "pipe" })')).toEqual([])
    // Bare identifier `env: childEnv` traced to its scrubber assignment ⇒ clean.
    expect(
      leakySpawnCalls(
        "const childEnv = buildPtyEnv({})\nconst child = Bun.spawn(argv, { cwd, env: childEnv })",
      ),
    ).toEqual([])
    // …but a bare identifier with NO scrubber assignment IS flagged.
    expect(
      leakySpawnCalls("const childEnv = process.env\nBun.spawn(a, { env: childEnv })"),
    ).toEqual(["Bun.spawn(a, { env: childEnv })"])
    // Allowlisted argv-tool — not flagged even without env.
    expect(leakySpawnCalls('Bun.spawn(["tmux", ...args], { stdout: "pipe" })')).toEqual([])
    // A CONDITIONAL env spread is `present` — and must still be scrubbed.
    expect(
      leakySpawnCalls(
        "const env = { ...process.env }\nBun.spawn(a, { ...(env !== undefined ? { env } : {}) })",
      ),
    ).toEqual(["Bun.spawn(a, { ...(env !== undefined ? { env } : {}) })"])
  })

  test("DEFECT 2 — identifier resolution is SCOPE-LOCAL, not file-global", () => {
    // The measured A/B pair, as source text. A: no `const env` anywhere.
    const A = "const child = Bun.spawn(cmd, { env: process.env })"
    expect(leakySpawnCalls(A)).toEqual(["Bun.spawn(cmd, { env: process.env })"])
    // B: an UNRELATED scrubbed `const env` elsewhere in the file. The old
    // file-global `assignmentRhs` bound `process.env`'s property word `env` to
    // it and returned []. It must not.
    const B = [
      "export const other = () => {",
      "  const env = scrubEnv({})",
      "  return env",
      "}",
      "export const leak = (cmd: string[]) => Bun.spawn(cmd, { env: process.env })",
    ].join("\n")
    expect(leakySpawnCalls(B)).toEqual(["Bun.spawn(cmd, { env: process.env })"])
    // Same shape, `env: env` — a real reference to a binding in ANOTHER scope is
    // not visible from the spawn site either.
    const C = [
      "export const other = () => {",
      "  const env = scrubEnv({})",
      "  return env",
      "}",
      "export const leak = (cmd: string[], env: NodeJS.ProcessEnv) => Bun.spawn(cmd, { env })",
    ].join("\n")
    expect(leakySpawnCalls(C)).toEqual(["Bun.spawn(cmd, { env })"])
    // PAIRED CONTROL — the SAME-scope scrubbed binding still resolves clean, so
    // the fix is scope-awareness and not a blanket "identifiers never resolve".
    const D = [
      "export const ok = (cmd: string[]) => {",
      "  const env = scrubEnv({})",
      "  return Bun.spawn(cmd, { env })",
      "}",
    ].join("\n")
    expect(leakySpawnCalls(D)).toEqual([])
    // And an ENCLOSING-scope scrubbed binding resolves clean too (real nesting).
    const E = [
      "const env = buildPtyEnv({})",
      "export const ok = (cmd: string[]) => Bun.spawn(cmd, { env })",
    ].join("\n")
    expect(leakySpawnCalls(E)).toEqual([])
    // A LATER declaration in the same scope must not clean an earlier spawn.
    const F = [
      "export const leak = (cmd: string[]) => {",
      "  const spawned = Bun.spawn(cmd, { env })",
      "  const env = scrubEnv({})",
      "  return [spawned, env]",
      "}",
    ].join("\n")
    expect(leakySpawnCalls(F)).toEqual(["Bun.spawn(cmd, { env })"])
  })

  test("comment MENTIONS never flag — line-leading AND trailing (both directions)", () => {
    const CALL = 'Bun.spawn(["bash","-lc",c], {})'
    // The docstring's claim, verified in both directions. The trailing case is
    // the one an earlier round measured as a FALSE POSITIVE, back when comment
    // handling was a line-leading-only regex; parsing removes the whole class.
    expect(leakySpawnCalls(`// ${CALL}\nconst a = 1`)).toEqual([])
    expect(leakySpawnCalls(`const a = 1 // ${CALL}`)).toEqual([])
    expect(leakySpawnCalls(`/* ${CALL} */\nconst a = 1`)).toEqual([])
    expect(leakySpawnCalls(`/**\n * ${CALL}\n */\nconst a = 1`)).toEqual([])
    expect(leakySpawnCalls(`const a = 1 // don't do this: ${CALL}`)).toEqual([])
    // A STRING holding the call text is not a call site either.
    expect(leakySpawnCalls(`const doc = ${JSON.stringify(CALL)}`)).toEqual([])
    // …and the same text as CODE still flags — the control that keeps the four
    // assertions above from passing vacuously.
    expect(leakySpawnCalls(CALL)).toEqual([CALL])
  })

  test("extraction handles nested parens / object literals", () => {
    const text = "Bun.spawn(argv, { env: withProxyEnv(scrubEnv(), {}) })"
    expect(leakySpawnCalls(text)).toEqual([]) // composed over scrubEnv ⇒ clean
    const nested = "Bun.spawn(argv, { env: withProxyEnv(process.env, {}) })"
    expect(leakySpawnCalls(nested)).toEqual([nested]) // composed over a LEAK ⇒ red
  })
})
