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
 * `tests/unit/tool-surface-runtime-parity-hellgate.test.ts`. This census is the
 * cheap backstop, not the authority.
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
]

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
