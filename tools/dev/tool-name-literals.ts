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
 * list comes from `git ls-files` restricted to `*.ts`, so a tracked `.ts.tmp`
 * is outside the census by construction rather than by remembering to say
 * `--include`.
 *
 * The narrowing is `name: "<literal>"` inside an object literal that ALSO
 * carries at least one member of {@link TOOL_SHAPE_KEYS}. `isReadOnly` is a
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
import { readFileSync } from "node:fs"
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

const propKeyName = (p: ts.ObjectLiteralElementLike): string | undefined => {
  const n = p.name
  if (n === undefined) return undefined
  if (ts.isIdentifier(n) || ts.isStringLiteral(n)) return n.text
  return undefined
}

const shapeKeyOf = (obj: ts.ObjectLiteralExpression): string | undefined => {
  for (const p of obj.properties) {
    const n = p.name
    if (n === undefined) continue
    if (!ts.isIdentifier(n) && !ts.isStringLiteral(n)) continue
    if (TOOL_SHAPE_KEYS.includes(n.text)) return n.text
  }
  return undefined
}

const nameLiteralOf = (obj: ts.ObjectLiteralExpression): ts.StringLiteralLike | undefined => {
  for (const p of obj.properties) {
    if (!ts.isPropertyAssignment(p)) continue
    const n = p.name
    const key = ts.isIdentifier(n) || ts.isStringLiteral(n) ? n.text : undefined
    if (key !== "name") continue
    if (ts.isStringLiteralLike(p.initializer)) return p.initializer
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
    if (ts.isObjectLiteralExpression(node)) {
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

/** Tracked `src/**\/*.ts`, test files and the two SSOT files removed. */
export const censusFiles = (repoRoot: string): string[] => {
  const raw = execFileSync("git", ["ls-files", "-z", "--", "src"], {
    cwd: repoRoot,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  })
  return raw
    .split("\0")
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"))
    .filter((f) => !SSOT_FILES.includes(f))
    .sort()
}

/** The whole census over a checkout. */
export const scanToolNameLiterals = (repoRoot: string): ToolNameLiteral[] => {
  const out: ToolNameLiteral[] = []
  for (const f of censusFiles(repoRoot)) {
    out.push(...extractToolNameLiterals(f, readFileSync(join(repoRoot, f), "utf-8")))
  }
  return out
}

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

const arrowBody = (init: ts.Expression): ts.Node | undefined => {
  if (!ts.isArrowFunction(init) && !ts.isFunctionExpression(init)) return undefined
  return init.body
}

const declaredBoolOf = (obj: ts.ObjectLiteralExpression): DeclaredBool => {
  for (const p of obj.properties) {
    if (!ts.isPropertyAssignment(p)) continue
    const n = p.name
    if (!(ts.isIdentifier(n) || ts.isStringLiteral(n)) || n.text !== "isReadOnly") continue
    const body = arrowBody(p.initializer)
    if (body === undefined) return "dynamic"
    if (body.kind === ts.SyntaxKind.TrueKeyword) return "true"
    if (body.kind === ts.SyntaxKind.FalseKeyword) return "false"
    return "dynamic"
  }
  return "absent"
}

const tiersOf = (
  obj: ts.ObjectLiteralExpression,
): { hasHitlTier: boolean; tiers: string[]; tierDynamic: boolean } => {
  for (const p of obj.properties) {
    if (!ts.isPropertyAssignment(p)) continue
    const n = p.name
    if (!(ts.isIdentifier(n) || ts.isStringLiteral(n)) || n.text !== "hitlTier") continue
    const body = arrowBody(p.initializer)
    if (body === undefined) return { hasHitlTier: true, tiers: [], tierDynamic: true }
    if (ts.isStringLiteralLike(body)) {
      return { hasHitlTier: true, tiers: [body.text], tierDynamic: false }
    }
    // Not a bare literal. Collect every tier literal reachable in the body as a
    // LOWER BOUND and say so, rather than reporting an empty set that would read
    // as "cannot return none".
    const tiers: string[] = []
    const walk = (node: ts.Node): void => {
      if (ts.isStringLiteralLike(node) && HITL_TIERS.includes(node.text)) tiers.push(node.text)
      ts.forEachChild(node, walk)
    }
    walk(body)
    return { hasHitlTier: true, tiers: [...new Set(tiers)], tierDynamic: true }
  }
  return { hasHitlTier: false, tiers: [], tierDynamic: false }
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
    if (ts.isObjectLiteralExpression(node)) {
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
export const scanToolPostures = (repoRoot: string): ToolPosture[] => {
  const out: ToolPosture[] = []
  for (const f of censusFiles(repoRoot)) {
    out.push(...extractToolPostures(f, readFileSync(join(repoRoot, f), "utf-8")))
  }
  return out
}

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
  node: ts.ObjectLiteralExpression,
): { spreads: boolean; hasNameKey: boolean } | undefined => {
  const keys = node.properties.map(propKeyName)
  if (!keys.includes("hitlTier")) return undefined
  if (nameLiteralOf(node) !== undefined) return undefined
  return {
    spreads: node.properties.some((p) => ts.isSpreadAssignment(p)),
    hasNameKey: keys.includes("name"),
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
      if (ts.isObjectLiteralExpression(node)) {
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
