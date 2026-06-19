/**
 * Patch-budget admission (jun-19) — the MINIMAL-EDIT contract.
 *
 * Measured root cause of the over-engineering failures (django #13417: gold/mini
 * = a 1-line guard in one file; quanta = a new `has_results_ordering()` helper):
 * NOT "verification 부족" but **minimal-patch admission 부재**. round0 should
 * PREFER the smallest possible change; gratuitous expansion (new file, new
 * helper/class/method, unjustified cross-file) is over-budget.
 *
 * 🔴 SOFT-WITH-ESCALATION, never a hard reject. over-budget ⇒ `escalate:true`
 * (route to the late critic / verification path), so a legitimately-large fix
 * (e.g. #14315's base + postgresql cross-file) survives by PROVING itself — it is
 * never silently killed. This is the [[no-heuristics]]-safe shape: round0 prefers
 * minimal, over-budget DEMANDS proof.
 *
 * PURE + deterministic over the diff (+ owner evidence for the cross-file escape).
 * EXACT structural facts only — no semantic "vibe". Separate admission layer; NOT
 * mixed into patch-hygiene (which is telemetry).
 */

export interface PatchBudget {
  /** distinct non-test SOURCE files touched. */
  readonly sourceFiles: number
  /** files created (`new file mode`). new-file budget = 0. */
  readonly newFiles: number
  /** added `def`/`class`/`async def` lines = new helper/method/class. budget = 0. */
  readonly newDefs: number
  /** touches >1 source file. budget = 0 UNLESS all are owner-justified. */
  readonly crossFile: boolean
  /** source files NOT in the owner evidence set (the cross-file escape gate). */
  readonly filesOutsideOwner: readonly string[]
  /** OBSERVE-ONLY (jun-19 refinement): added calls that expand runtime surface
   *  (get_compiler / pre_sql_setup / IO/DB/subprocess). Name-based + fragile +
   *  django-specific, so it is COUNTED but NOT gated until measured. */
  readonly runtimeExpandingCalls: number
}

export interface PatchBudgetVerdict {
  readonly budget: PatchBudget
  /** round0 minimal admission: no over-budget reason fired. */
  readonly withinBudget: boolean
  readonly overBudgetReasons: readonly string[]
  /** !withinBudget ⇒ escalate to the late critic/verify path (NOT a hard reject). */
  readonly escalate: boolean
}

export interface PatchBudgetInput {
  /** owner evidence files — cross-file / extra source files are justified only
   *  when they are IN this set (T-202 owner-admission). Empty ⇒ no justification
   *  available ⇒ a single owner file is the budget. */
  readonly ownerFiles?: readonly string[]
  /** repo slug (e.g. "django/django") — reserved for repo-gated observe signals. */
  readonly repo?: string
}

const TEST_PATH = /(^|\/)(tests?|testing)\//i
const TEST_FILE = /(^|\/)(test_[^/]+|[^/]+_test)\.py$|conftest\.py$/i
const NON_SOURCE = /\.(md|txt|rst|cfg|ini|toml|lock|json|ya?ml)$/i
const REPRO = /(^|\/)reproduce_issue\.py$/

const isSource = (f: string): boolean =>
  !TEST_PATH.test(f) && !TEST_FILE.test(f) && !NON_SOURCE.test(f) && !REPRO.test(f)

/** Names whose ADDED call expands runtime surface (django over-engineer smell).
 *  Observe-only — counted, never gated, until measured. */
const RUNTIME_EXPAND = /\b(get_compiler|pre_sql_setup|execute_sql|subprocess\.|os\.system|\.cursor\(\))/

interface Block {
  file: string
  added: boolean
  addedLines: string[]
}

const parseDiff = (diff: string): Block[] => {
  const blocks: Block[] = []
  for (const part of diff.split(/^diff --git /m).slice(1)) {
    const m = part.match(/^a\/(\S+) b\/\S+/)
    if (!m) continue
    const file = m[1] as string
    const added = /^new file mode /m.test(part)
    // hunk body: lines starting with "+" but not the "+++ " file header.
    const addedLines = part
      .split(/\r?\n/)
      .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
      .map((l) => l.slice(1))
    blocks.push({ file, added, addedLines })
  }
  return blocks
}

/** Count added `def`/`class` declarations across the source-file hunks. */
const countNewDefs = (sourceBlocks: readonly Block[]): number => {
  let n = 0
  for (const b of sourceBlocks) {
    for (const line of b.addedLines) {
      if (/^\s*(async\s+def|def|class)\s+\w/.test(line)) n += 1
    }
  }
  return n
}

const countRuntimeExpanding = (sourceBlocks: readonly Block[]): number => {
  let n = 0
  for (const b of sourceBlocks) {
    for (const line of b.addedLines) if (RUNTIME_EXPAND.test(line)) n += 1
  }
  return n
}

export const analyzePatchBudget = (
  diff: string,
  input: PatchBudgetInput = {},
): PatchBudgetVerdict => {
  const blocks = parseDiff(diff)
  const sourceBlocks = blocks.filter((b) => isSource(b.file))
  const sourceFileSet = [...new Set(sourceBlocks.map((b) => b.file))]
  const owner = new Set(input.ownerFiles ?? [])
  const filesOutsideOwner = owner.size === 0 ? [] : sourceFileSet.filter((f) => !owner.has(f))
  const newFiles = sourceBlocks.filter((b) => b.added).length
  const newDefs = countNewDefs(sourceBlocks)

  const budget: PatchBudget = {
    sourceFiles: sourceFileSet.length,
    newFiles,
    newDefs,
    crossFile: sourceFileSet.length > 1,
    filesOutsideOwner,
    runtimeExpandingCalls: countRuntimeExpanding(sourceBlocks),
  }

  // GATED budget rules (round0 minimal preference). runtimeExpandingCalls is
  // OBSERVE-ONLY (not here) until measured.
  const reasons: string[] = []
  if (budget.newFiles > 0) reasons.push(`new-file budget=0 (created ${budget.newFiles})`)
  if (budget.newDefs > 0)
    reasons.push(`new-def budget=0 (added ${budget.newDefs} def/class — prefer in-place edit)`)
  // cross-file / extra source file: allowed ONLY when every touched source file
  // is owner-justified. >1 file with any file outside the owner set ⇒ over.
  if (budget.sourceFiles > 1 && filesOutsideOwner.length > 0)
    reasons.push(
      `cross-file budget=0 unless owner-justified (${filesOutsideOwner.length} file(s) outside owner)`,
    )
  // no owner evidence at all + >1 source file ⇒ over (single owner is the budget).
  if (budget.sourceFiles > 1 && owner.size === 0)
    reasons.push(`source-file budget=1 (no owner evidence to justify ${budget.sourceFiles})`)

  const withinBudget = reasons.length === 0
  return { budget, withinBudget, overBudgetReasons: reasons, escalate: !withinBudget }
}
