/**
 * `tools/dev/tool-name-literals` — the AST census of TOOL NAME literals in `src/`.
 *
 * # Why this replaced a grep
 *
 * `tests/unit/tool-surface-manifest-hellgate.test.ts` proved the tool-surface
 * manifest complete by shelling out to
 *
 *   grep -rhoE 'name: "[a-z_]+"' src/tool src/subagent src/agent/tier1 \
 *     src/agent/budget-tool.ts src/agent/memory-tools.ts src/skill/skill-creator.ts \
 *     --exclude=manifest.ts --exclude=gated-tools.ts
 *
 * and comparing the captured set against `ALL_MANIFEST_TOOL_NAMES` in both
 * directions. Four independent holes, each measured on this tree:
 *
 *   1. `[a-z_]` excludes digits and uppercase. A tool named `apply_patch_v2`
 *      with `isReadOnly: () => false` and `hitlTier: () => "none"` — strictly
 *      weaker than the `apply_patch` it sits beside — was registered behind a
 *      conditional port with NO manifest row and the hellgate reported
 *      38 pass / 0 fail. Two files edited, zero test or manifest edits, and
 *      `bun run precommit` said `ok — 9 of 9`.
 *   2. Raw `grep` reads COMMENTS. Adding only the prose
 *      `// the old registry once had \`{ name: "zz_ghost_stale_tool" }\``
 *      to `src/tool/registry.ts` — no code, no registration — made the scan
 *      "find" the name, which MASKS a stale manifest row (37 pass / 1 fail
 *      becomes 38 pass / 0 fail). The reverse is worse: prose naming a DELETED
 *      tool produces a false RED whose natural repair is to add a ghost
 *      manifest row, corrupting the SSOT in the masking direction.
 *   3. `--exclude=<basename>` matches a basename anywhere, not a path. Nothing
 *      occupies that hole today; any future `src/tool/<x>/manifest.ts` would
 *      drop out silently.
 *   4. A hand-curated root list. `src/agent/branch-search/` and `src/skill/`
 *      (minus the one file bolted on after an earlier escape) were outside it —
 *      and `src/tool/lsp_nav/code-action.ts.tmp`, TRACKED in git, was inside it,
 *      because `grep -r` does not care about extensions.
 *
 * Holes 2, 3 and 4 were latent. Hole 1 was live in three real tools:
 * `branch_search` (write-capable), `Skill` and `ToolSearch` — all three minted
 * by tier-1 builders into `extraTools`, which lands in the live registry at
 * `src/agent/session-resources.ts`. The causal proof they are an ESCAPE and not
 * a deliberate exclusion: `buildSkillBlock` mints three tools, and only
 * `skill_create` was catalogued — because `src/skill/skill-creator.ts` had been
 * bolted onto the grep's root list after an earlier miss. Its two siblings,
 * from the same builder in the same directory, were never added, and being
 * uppercase they would have stayed invisible even if the roots had been widened.
 *
 * # What makes each rule structural rather than a guess
 *
 * A comment is not in the AST, so hole 2 cannot exist here. Formatting is not
 * in the AST either: `name:"x"` and a line-wrapped literal are the same node,
 * where the regex demanded exactly one space. Exclusion is by PATH. The file
 * list is tracked AND untracked-but-not-ignored `*.ts` (a new tool file is live
 * before it is committed; 9890282b5 — this said `git ls-files`, tracked only), so a
 * `.ts.tmp` is outside the census by construction rather than by remembering to say
 * `--include`.
 *
 * The narrowing is `name: "<literal>"` (or an `as const` / const-bound name) inside
 * an object literal OR a class body that ALSO carries at least one member of
 * {@link TOOL_SHAPE_KEYS} — classes and methods since 9890282b5. `isReadOnly` is a
 * REQUIRED member of `ToolCore` (`src/tool/factory.ts`), so a tool definition
 * cannot avoid the set; a domain object with a `name` field and none of these
 * keys is not a tool. That is what lets the census widen from six hand-picked
 * roots to all of `src/` without drowning in `{ name: "Sheet1" }`.
 *
 * # What it still cannot see, stated rather than implied
 *
 * A computed name (`name: TOOL_NAME`) and a tool built from a runtime handshake
 * (the MCP bridge) have no source literal at all. Those are unreachable for ANY
 * source-level instrument, which is why the manifest's completeness must also be
 * checked against the ASSEMBLED registry — see
 * `tests/unit/tool-surface-runtime-parity-hellgate.test.ts`. (Until sep-13 that file
 * did not exist while this sentence named it; an audit followed the reference and
 * found seven computed-name LSP tools uncatalogued.) This census is the cheap
 * backstop, not the authority.
 */
import { execFileSync } from "node:child_process"
import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import ts from "typescript"

/** A `name: "x"` literal whose enclosing object literal looks like a tool. */
export interface ToolNameLiteral {
  readonly name: string
  readonly file: string
  readonly line: number
  /** The sibling key that admitted it — reported so a widening is auditable. */
  readonly admittedBy: string
}

/**
 * The keys that mark an object literal as a tool definition.
 *
 * `isReadOnly` is required by `ToolCore`; the rest are the other universal
 * members of the same interface. A name literal with none of them is a domain
 * object, and the three such literals on this tree confirm it: `Sheet1`
 * (a spreadsheet tab), `Enter` (a key name), `...` (a judge placeholder).
 */
export const TOOL_SHAPE_KEYS: readonly string[] = [
  "isReadOnly",
  "hitlTier",
  "execute",
  "inputSchema",
  "isConcurrencySafe",
]

/**
 * The two files that ARE the manifest. Excluded by PATH, not basename.
 *
 * Without the exclusion every catalogued name is "found" by virtue of being
 * catalogued, and the reverse direction — no stale manifest row — can never
 * fail. Measured: one injected stale row is caught with the exclusion and
 * silent without it.
 */
export const SSOT_FILES: readonly string[] = [
  "src/tool/surface/manifest.ts",
  "src/tool/surface/gated-tools.ts",
  "src/tool/surface/gated-tools-ports.ts",
]

/**
 * A tool-shaped CONTAINER: an object literal, or a class. An adversarial audit
 * registered `class SpawnBatchUnattendedTool implements Tool { name = "…"; hitlTier() {…} }`
 * and the census, which only read object literals, never saw it.
 */
type Container = ts.ObjectLiteralExpression | ts.ClassDeclaration | ts.ClassExpression

const isContainer = (node: ts.Node): node is Container =>
  ts.isObjectLiteralExpression(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)

/** One member of a container, reduced to what the census reads. */
interface Member {
  readonly key: string | undefined
  /** A value expression, type wrappers removed (`as const`, `satisfies`, parens, `!`). */
  readonly value: ts.Expression | undefined
  /** A function body, for arrow / function-expression values, methods and getters. */
  readonly body: ts.Node | undefined
  readonly spread: boolean
}

/** Strip `x as const`, `x satisfies T`, `(x)`, `<T>x` and `x!`. `name: "x" as const`
 *  was invisible: the initializer is an AsExpression, not a string literal. */
const unwrap = (e: ts.Expression): ts.Expression => {
  let cur = e
  while (
    ts.isAsExpression(cur) ||
    ts.isSatisfiesExpression(cur) ||
    ts.isParenthesizedExpression(cur) ||
    ts.isTypeAssertionExpression(cur) ||
    ts.isNonNullExpression(cur)
  ) {
    cur = cur.expression
  }
  return cur
}

const keyOf = (name: ts.PropertyName | undefined): string | undefined => {
  if (name === undefined) return undefined
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name)) {
    return name.text
  }
  // `["hitlTier"]: …` — a computed key that is a string literal is still that key.
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) {
    return name.expression.text
  }
  return undefined
}

const functionBodyOf = (e: ts.Expression | undefined): ts.Node | undefined => {
  if (e === undefined) return undefined
  const u = unwrap(e)
  return ts.isArrowFunction(u) || ts.isFunctionExpression(u) ? u.body : undefined
}

const memberOf = (m: ts.ObjectLiteralElementLike | ts.ClassElement): Member => {
  if (ts.isSpreadAssignment(m))
    return { key: undefined, value: undefined, body: undefined, spread: true }
  if (ts.isPropertyAssignment(m) || ts.isPropertyDeclaration(m)) {
    const value = m.initializer === undefined ? undefined : unwrap(m.initializer)
    return { key: keyOf(m.name), value, body: functionBodyOf(value), spread: false }
  }
  if (ts.isMethodDeclaration(m) || ts.isGetAccessorDeclaration(m)) {
    return { key: keyOf(m.name), value: undefined, body: m.body, spread: false }
  }
  // Shorthand `{ hitlTier }`, setters, index signatures: a key with nothing the census
  // can reduce, reported as such rather than dropped.
  return {
    key: keyOf((m as { name?: ts.PropertyName }).name),
    value: undefined,
    body: undefined,
    spread: false,
  }
}

const membersOf = (c: Container): Member[] =>
  ts.isObjectLiteralExpression(c) ? c.properties.map(memberOf) : c.members.map(memberOf)

const shapeKeyOf = (c: Container): string | undefined =>
  membersOf(c).find((m) => m.key !== undefined && TOOL_SHAPE_KEYS.includes(m.key))?.key

const nameLiteralOf = (c: Container): ts.StringLiteralLike | undefined => {
  for (const m of membersOf(c)) {
    if (m.key === "name" && m.value !== undefined && ts.isStringLiteralLike(m.value)) return m.value
  }
  return undefined
}

/**
 * Extract the tool-name literals from ONE module's source text.
 *
 * Exported so a fixture can assert the EXTRACTOR's verdict on the four shapes
 * that beat the grep. The old test pinned the command STRING and never the
 * behaviour, which is precisely the assertion whose absence let a digit-named
 * write-capable tool land green.
 */
export const extractToolNameLiterals = (file: string, source: string): ToolNameLiteral[] => {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const out: ToolNameLiteral[] = []
  const walk = (node: ts.Node): void => {
    if (isContainer(node)) {
      const lit = nameLiteralOf(node)
      const admittedBy = shapeKeyOf(node)
      if (lit !== undefined && admittedBy !== undefined) {
        out.push({
          name: lit.text,
          file,
          line: sf.getLineAndCharacterOfPosition(lit.getStart(sf)).line + 1,
          admittedBy,
        })
      }
    }
    ts.forEachChild(node, walk)
  }
  walk(sf)
  return out
}

/** Tracked and untracked-but-not-ignored `src/**\/*.ts`, tests and the SSOT files removed. */
export const censusFiles = (repoRoot: string): string[] => {
  // `--others --exclude-standard` too: an UNTRACKED new tool file was invisible, so a
  // write-capable tool at tier none stayed green locally until someone ran `git add`.
  const raw = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "src"],
    {
      cwd: repoRoot,
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
    },
  )
  return [...new Set(raw.split("\0"))]
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"))
    .filter((f) => !SSOT_FILES.includes(f))
    .sort()
}

/**
 * Per-process memo of one extractor's result for one file, keyed by path, size and
 * mtime. A single hellgate file ran the full 3430-file parse four times, and under a
 * loaded box one of those tests crossed bun's 5s timeout (5304ms) — a red that is about
 * the box, not the code. A changed file changes its mtime or size, so a mutation made
 * between runs is re-read.
 */
const memo = new Map<string, { readonly stamp: string; readonly value: unknown }>()
const cachedExtract = <T>(
  kind: string,
  repoRoot: string,
  file: string,
  extract: (file: string, source: string) => T,
): T => {
  const abs = join(repoRoot, file)
  const st = statSync(abs)
  const stamp = `${st.size}:${st.mtimeMs}`
  const key = `${kind}\0${abs}`
  const hit = memo.get(key)
  if (hit !== undefined && hit.stamp === stamp) return hit.value as T
  const value = extract(file, readFileSync(abs, "utf-8"))
  memo.set(key, { stamp, value })
  return value
}

/** The whole census over a checkout. */
export const scanToolNameLiterals = (repoRoot: string): ToolNameLiteral[] =>
  censusFiles(repoRoot).flatMap((f) => cachedExtract("names", repoRoot, f, extractToolNameLiterals))

/* ── HITL posture, the axis with no runtime guard ───────────────────────────── */

/**
 * What a declaration says, as opposed to what it might do.
 *
 * `dynamic` is its own answer and not a synonym for unknown-so-assume-safe: a
 * body this census cannot reduce to a literal is reported as `dynamic` so the
 * consumer must decide, rather than silently classified.
 */
export type DeclaredBool = "true" | "false" | "dynamic" | "absent"

/** One tool literal's DECLARED permission posture. */
export interface ToolPosture extends ToolNameLiteral {
  /** What `isReadOnly` returns, when it can be reduced to a literal. */
  readonly readOnly: DeclaredBool
  /** Whether a `hitlTier` member is declared at all. Absent is the SAFE state:
   *  `inferToolTierDetailed` then falls through to the `isReadOnly()` branch and
   *  a write-capable tool gets `always-confirm` / `needs-sandbox`. */
  readonly hasHitlTier: boolean
  /** Every HITL-tier string literal `hitlTier`'s body can yield. */
  readonly tiers: readonly string[]
  /** `hitlTier`'s body is not a bare string literal (a conditional, or an
   *  identifier closed over from the factory). The tiers list is then a lower
   *  bound, not the whole answer. */
  readonly tierDynamic: boolean
}

/** The closed HITL tier vocabulary, mirrored from `@/permission`. A literal
 *  outside it is a typo or a new tier, and either way must not be silently
 *  swallowed by the census. */
export const HITL_TIERS: readonly string[] = [
  "none",
  "pre-approval-ok",
  "always-confirm",
  "hand-off-required",
]

/** The single value a function body yields, when it has exactly one: an expression
 *  body, or a block whose only statement is `return <expr>`. */
const soleReturnOf = (body: ts.Node): ts.Expression | undefined => {
  if (!ts.isBlock(body)) return ts.isExpression(body) ? unwrap(body) : undefined
  if (body.statements.length !== 1) return undefined
  const only = body.statements[0]
  return only !== undefined && ts.isReturnStatement(only) && only.expression !== undefined
    ? unwrap(only.expression)
    : undefined
}

const memberNamed = (c: Container, key: string): Member | undefined =>
  membersOf(c).find((m) => m.key === key)

const declaredBoolOf = (c: Container): DeclaredBool => {
  const m = memberNamed(c, "isReadOnly")
  if (m === undefined) return "absent"
  const v = m.body !== undefined ? soleReturnOf(m.body) : m.value
  if (v?.kind === ts.SyntaxKind.TrueKeyword) return "true"
  if (v?.kind === ts.SyntaxKind.FalseKeyword) return "false"
  return "dynamic"
}

const tiersOf = (c: Container): { hasHitlTier: boolean; tiers: string[]; tierDynamic: boolean } => {
  const m = memberNamed(c, "hitlTier")
  if (m === undefined) return { hasHitlTier: false, tiers: [], tierDynamic: false }
  if (m.body === undefined) return { hasHitlTier: true, tiers: [], tierDynamic: true }
  const sole = soleReturnOf(m.body)
  if (sole !== undefined && ts.isStringLiteralLike(sole)) {
    return { hasHitlTier: true, tiers: [sole.text], tierDynamic: false }
  }
  // Not a bare literal. Collect every tier literal reachable in the body as a LOWER
  // BOUND and say so, rather than reporting an empty set that reads as "cannot return
  // none". A tier held in a module const (`: PATCH_TIER`) collects nothing, so it lands
  // in the unresolved set the gate pins by name.
  const tiers: string[] = []
  const walk = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) && HITL_TIERS.includes(node.text)) tiers.push(node.text)
    ts.forEachChild(node, walk)
  }
  walk(m.body)
  return { hasHitlTier: true, tiers: [...new Set(tiers)], tierDynamic: true }
}

/**
 * Extract the DECLARED permission posture of every tool literal in one module.
 *
 * # Why this exists
 *
 * `inferToolTierDetailed` (`src/permission/policy.ts`) is:
 *
 *   if (confirm) return { tier: "always-confirm", reason: "declared" }
 *   if (explicit) return { tier: explicit, reason: "declared" }
 *   return tool.isReadOnly()
 *     ? { tier: "none", reason: "inferred" }
 *     : { tier: "always-confirm", reason: "needs-sandbox" }
 *
 * `"none"` is a truthy string, so an EXPLICIT `hitlTier: () => "none"`
 * short-circuits the fail-closed branch directly below it. The fail-closed
 * default protects only tools that OMIT `hitlTier`; a tool that declares its way
 * out is never questioned. `src/agent/hitl-tier-registry.ts` ratchets operator
 * OVERRIDES escalate-only, ships zero built-in annotations, and clamps nothing
 * about a tool's own declaration.
 *
 * Measured: a probe with `isReadOnly: () => false` and `hitlTier: () => "none"`
 * passed 125 HITL / permission / tool test files — 2419 pass, 1 skip, 0 fail —
 * and `precommit: ok — 9 of 9`. Every existing assertion on this axis is
 * per-tool (`expect(tool.hitlTier?.(x)).toBe("none")`); none loops a set.
 *
 * # Why source and not a fixture
 *
 * The manifest names 60 distinct origin modules for its gated rows, so a runtime
 * two-way comparison means importing and port-stubbing all 60, and it would still
 * miss MCP-bridged tools. A declaration is exactly what this invariant is about —
 * it is about what a tool is ALLOWED to SAY — so the source is the right
 * instrument here, and it is complete over every tool with a literal name.
 */
export const extractToolPostures = (file: string, source: string): ToolPosture[] => {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const out: ToolPosture[] = []
  const walk = (node: ts.Node): void => {
    if (isContainer(node)) {
      const lit = nameLiteralOf(node)
      const admittedBy = shapeKeyOf(node)
      if (lit !== undefined && admittedBy !== undefined) {
        const t = tiersOf(node)
        out.push({
          name: lit.text,
          file,
          line: sf.getLineAndCharacterOfPosition(lit.getStart(sf)).line + 1,
          admittedBy,
          readOnly: declaredBoolOf(node),
          hasHitlTier: t.hasHitlTier,
          tiers: t.tiers,
          tierDynamic: t.tierDynamic,
        })
      }
    }
    ts.forEachChild(node, walk)
  }
  walk(sf)
  return out
}

/** The posture census over a checkout. */
export const scanToolPostures = (repoRoot: string): ToolPosture[] =>
  censusFiles(repoRoot).flatMap((f) => cachedExtract("postures", repoRoot, f, extractToolPostures))

/* ── the census's own blind spot, enumerated ────────────────────────────────── */

/** An object literal that declares `hitlTier` but carries no `name: "<literal>"`,
 *  so {@link extractToolPostures} cannot attribute it to a tool. */
export interface UnattributedTierDeclaration {
  readonly file: string
  readonly line: number
  /** Whether the literal spreads another object (a name could arrive from there). */
  readonly spreads: boolean
  /** Whether it has a `name` key at all (a computed or shorthand one). */
  readonly hasNameKey: boolean
}

/**
 * Every place a HITL tier is declared that the posture census cannot attribute.
 *
 * WHY THIS IS NEEDED. `extractToolPostures` keys on a `name` STRING LITERAL. A
 * tool built by a generic factory — `make(name, description, schema, readOnly, …)`
 * in `src/subagent/agent-tools-6.ts` builds the six router tools that way — has a
 * computed name, so it is invisible there. Those six are safe for a STRUCTURAL
 * reason rather than a lucky one: the factory takes no `hitlTier` parameter and
 * sets none, so `inferToolTierDetailed` falls through to the `isReadOnly()`
 * fail-closed branch. Add a `hitlTier` parameter to that factory and the
 * invariant could be broken with nothing to see it.
 *
 * So the consumer enumerates this instead of assuming the census is total.
 * MEASURED on this tree: two, and both are permission-INSPECTOR metadata objects
 * (`src/apps/cli/permission-explain.ts`, `src/permission/inspect.ts`) that report
 * a tier they were handed — neither is a tool.
 */
/** Classify ONE object literal for the unattributed-tier scan. Split out of the
 *  walker: inline, the walker scored 41 on the cognitive-complexity ratchet. */
const unattributedTierOf = (
  node: Container,
): { spreads: boolean; hasNameKey: boolean } | undefined => {
  const members = membersOf(node)
  if (!members.some((m) => m.key === "hitlTier")) return undefined
  if (nameLiteralOf(node) !== undefined) return undefined
  return {
    spreads: members.some((m) => m.spread),
    hasNameKey: members.some((m) => m.key === "name"),
  }
}

export const scanUnattributedTierDeclarations = (
  repoRoot: string,
): UnattributedTierDeclaration[] => {
  const out: UnattributedTierDeclaration[] = []
  for (const f of censusFiles(repoRoot)) {
    const sf = ts.createSourceFile(
      f,
      readFileSync(join(repoRoot, f), "utf-8"),
      ts.ScriptTarget.Latest,
      true,
    )
    const walk = (node: ts.Node): void => {
      if (isContainer(node)) {
        const hit = unattributedTierOf(node)
        if (hit !== undefined) {
          out.push({
            file: f,
            line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
            spreads: hit.spreads,
            hasNameKey: hit.hasNameKey,
          })
        }
      }
      ts.forEachChild(node, walk)
    }
    walk(sf)
  }
  return out
}

/* ── tool-shaped containers with no literal name ─────────────────────────────── */

/** A container carrying a {@link TOOL_SHAPE_KEYS} member and a `name` it does not spell
 *  as a literal (or no `name` but a spread that could supply one). */
export interface UnattributedToolContainer {
  readonly file: string
  readonly line: number
  readonly spreads: boolean
  readonly hasNameKey: boolean
}

/**
 * Every tool-SHAPED object or class whose name the census cannot read.
 *
 * WHY. The manifest's completeness rests on two instruments: this census (literal names)
 * and the assembled universe (tools the fixture's builders mint). A tool with a COMPUTED
 * name, minted by a builder the fixture does not call, is invisible to both — measured in
 * the round-8 audit: a fourth, computed-name tool injected into `memoryTools` kept all six
 * tool-surface gates green. The class is closed here, at the source: each such container
 * is enumerated with its file, and the consumer pins the set by file WITH A COUNT, so a
 * new one fails until it is catalogued or reviewed.
 */
/** The unattributed-container verdict for ONE module's source text. */
export const extractUnattributedToolContainers = (
  file: string,
  source: string,
): UnattributedToolContainer[] => {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const out: UnattributedToolContainer[] = []
  const walk = (node: ts.Node): void => {
    if (isContainer(node) && shapeKeyOf(node) !== undefined && nameLiteralOf(node) === undefined) {
      const members = membersOf(node)
      const spreads = members.some((m) => m.spread)
      const hasNameKey = members.some((m) => m.key === "name")
      // `execute` is REQUIRED on `ToolCore`. A permission action, a confirm request or a
      // stream-callback bag carries `isReadOnly` and never `execute`, so it is not a tool
      // that could mint a name; a wrapper that spreads a tool and replaces `execute` is.
      const hasExecute = members.some((m) => m.key === "execute")
      if (hasExecute && (spreads || hasNameKey)) {
        out.push({
          file,
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          spreads,
          hasNameKey,
        })
      }
    }
    ts.forEachChild(node, walk)
  }
  walk(sf)
  return out
}

export const scanUnattributedToolContainers = (repoRoot: string): UnattributedToolContainer[] =>
  censusFiles(repoRoot).flatMap((f) =>
    cachedExtract("unattributed-tools", repoRoot, f, extractUnattributedToolContainers),
  )
