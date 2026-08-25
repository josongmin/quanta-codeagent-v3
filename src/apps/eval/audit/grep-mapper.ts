/**
 * Static grep-based mapper from `UseCaseId` to source/test/runbook evidence.
 *
 * Pure static analysis — no LLM, no agent run. We scan the configured roots
 * for tokens registered against each leaf (`AuditRule.tokens`) and any extra
 * required path globs. A leaf with ≥1 token hit AND ≥1 test hit is `ok`;
 * token hit but no test is `partial`; no hit at all is `tbd`; explicit
 * exclusion is `no` (scope out).
 *
 * The rule table is intentionally hand-curated and SMALL. Adding a leaf
 * without a rule degrades gracefully to `tbd` — the audit then surfaces the
 * gap and the operator either fills it in or decides `no`.
 *
 * Tool selection: ripgrep when available, BSD/GNU `grep -r -F` as fallback —
 * we use `-F` (the portable short flag for fixed-strings, supported by both
 * BSD and GNU grep) rather than `--fixed-strings` (GNU-only). Absence of BOTH
 * is treated as a HARD ERROR (`auditOne` returns coverage `tbd` with a clear
 * note instead of pretending grep succeeded and producing all-empty hits).
 */
import { spawnSync } from "node:child_process"
import type { CoverageLevel, UseCaseId } from "../types"

export interface AuditRule {
  /** Substring tokens; ANY hit in `roots.code` counts as code evidence. */
  tokens: readonly string[]
  /** Optional explicit `no` (scope out) — skip grep entirely. */
  scopedOut?: boolean
  /** Optional override note attached to the audit record. */
  note?: string
}

export interface AuditConfig {
  /** Source roots (search for tokens). */
  codeRoots: readonly string[]
  /** Test roots (a separate hit upgrades partial → ok). */
  testRoots: readonly string[]
  /** Runbook roots (informational evidence). */
  runbookRoots: readonly string[]
  /** Per-usecase rules. */
  rules: Readonly<Record<UseCaseId, AuditRule>>
  /** Override grep binary explicitly (skips probe). Useful for tests. */
  rgBin?: string
}

export interface AuditFinding {
  usecase: UseCaseId
  coverage: CoverageLevel
  evidence: readonly string[]
  note?: string
}

/** Default config — points at this repo's layout. */
export const DEFAULT_CONFIG: AuditConfig = {
  codeRoots: ["src"],
  testRoots: ["tests"],
  runbookRoots: ["docs/runbooks"],
  rules: {},
}

/** Resolved grep tool: which binary, with what flag style. */
interface GrepTool {
  bin: string
  /** Argv builder isolates the flag-syntax difference between rg and grep. */
  argv: (token: string, roots: readonly string[]) => readonly string[]
}

/** Build the argv for ripgrep: null-separated, files-only, fixed-strings. */
const rgArgv = (token: string, roots: readonly string[]): readonly string[] => [
  "-l",
  "--null",
  "--fixed-strings",
  "--",
  token,
  ...roots,
]

/** Build the argv for grep: portable BSD/GNU flags (`-r -l -F -Z`).
 *  `-Z` is the null-terminator (supported on both BSD and GNU); `-F` is the
 *  short fixed-strings flag. Using null-termination avoids a real-but-rare
 *  bug where a filename contains an embedded `\n` and we'd otherwise split
 *  it into two phantom paths. */
const grepArgv = (token: string, roots: readonly string[]): readonly string[] => [
  "-r",
  "-l",
  "-F",
  "-Z",
  "--",
  token,
  ...roots,
]

/** Hard timeout for the version probe (ms). A hung `rg`/`grep` (macOS
 *  Gatekeeper prompt on first run, …) would otherwise freeze the whole eval. */
const PROBE_TIMEOUT_MS = 3_000

/** Probe rg → grep. NULL means neither is usable (callers MUST handle this
 *  explicitly — no silent fallback to "no matches"). */
const resolveTool = (configured?: string): GrepTool | null => {
  if (configured !== undefined) {
    const isRg = configured === "rg" || configured.endsWith("/rg")
    return { bin: configured, argv: isRg ? rgArgv : grepArgv }
  }
  const rgProbe = spawnSync("rg", ["--version"], { encoding: "utf8", timeout: PROBE_TIMEOUT_MS })
  if (rgProbe.status === 0) return { bin: "rg", argv: rgArgv }
  const grepProbe = spawnSync("grep", ["--version"], {
    encoding: "utf8",
    timeout: PROBE_TIMEOUT_MS,
  })
  if (grepProbe.status === 0) return { bin: "grep", argv: grepArgv }
  return null
}

/** Result of one grep invocation. `status === -1` denotes spawn failure
 *  (binary missing, permission denied, …) and is surfaced — never silently
 *  swallowed as "no matches". */
export interface GrepInvocation {
  files: readonly string[]
  status: number
  /** Truncated stderr for diagnostics. */
  stderr: string
}

const runGrep = (tool: GrepTool, token: string, roots: readonly string[]): GrepInvocation => {
  const r = spawnSync(tool.bin, [...tool.argv(token, roots)], { encoding: "utf8" })
  // Both rg and grep return 1 when no match — that is NOT an error.
  const ok = r.status === 0 || r.status === 1
  if (!ok) {
    return { files: [], status: r.status ?? -1, stderr: (r.stderr ?? "").slice(0, 200) }
  }
  // Null-separated output (`--null` / `-Z`): a filename can legally contain
  // `\n` on POSIX, so we MUST split on `\0` to avoid phantom paths.
  const files = Array.from(new Set((r.stdout ?? "").split("\0").filter((l) => l !== ""))).sort()
  return { files, status: r.status ?? 0, stderr: "" }
}

/** Union of every root class's hits for one rule, plus any grep failures.
 *  `errors` non-empty is fatal for the finding — see `auditOne`. */
interface RuleHits {
  code: ReadonlySet<string>
  test: ReadonlySet<string>
  runbook: ReadonlySet<string>
  errors: readonly string[]
}

/** Run every token of a rule against all three root classes and union the hits.
 *  A unit because the parent's score was dominated by this loop: three
 *  structurally identical grep+merge triples plus a nested status scan, all at
 *  depth 2-3 inside `auditOne`. The three root classes are now ONE table walked
 *  once, so adding a fourth class is a table row, not a fourth copy. */
const collectRuleHits = (
  tool: GrepTool,
  tokens: readonly string[],
  cfg: AuditConfig,
): RuleHits => {
  const code = new Set<string>()
  const test = new Set<string>()
  const runbook = new Set<string>()
  const errors: string[] = []
  const classes: readonly (readonly [Set<string>, readonly string[]])[] = [
    [code, cfg.codeRoots],
    [test, cfg.testRoots],
    [runbook, cfg.runbookRoots],
  ]
  for (const t of tokens) {
    for (const [sink, roots] of classes) {
      const inv = runGrep(tool, t, roots)
      for (const f of inv.files) sink.add(f)
      // Both rg and grep return 1 when no match — that is NOT an error.
      if (inv.status !== 0 && inv.status !== 1) {
        errors.push(`token=${t} status=${inv.status} ${inv.stderr}`.trim())
      }
    }
  }
  return { code, test, runbook, errors }
}

/** The three findings that short-circuit before any grep runs, as one table of
 *  (predicate → finding). A unit because each was an `if` whose whole body was
 *  a literal `AuditFinding`; collapsing them keeps `auditOne` to "resolve, then
 *  score". Returns null when the rule must actually be grepped. */
const earlyFinding = (id: UseCaseId, rule: AuditRule | undefined): AuditFinding | null => {
  if (rule === undefined) {
    return { usecase: id, coverage: "tbd", evidence: [], note: "no rule registered" }
  }
  if (rule.scopedOut === true) {
    return {
      usecase: id,
      coverage: "no",
      evidence: [],
      ...(rule.note !== undefined ? { note: rule.note } : { note: "scoped out" }),
    }
  }
  return null
}

/** Score one usecase against the configured roots. */
export const auditOne = (id: UseCaseId, cfg: AuditConfig): AuditFinding => {
  const rule = cfg.rules[id]
  const early = earlyFinding(id, rule)
  if (early !== null) return early
  const tool = resolveTool(cfg.rgBin)
  if (tool === null) {
    return {
      usecase: id,
      coverage: "tbd",
      evidence: [],
      note: "audit: neither rg nor grep available on PATH — install one to score this rule",
    }
  }
  const hits = collectRuleHits(tool, rule?.tokens ?? [], cfg)
  // A grep error must NEVER be silently treated as "no hits": producing
  // `coverage:"tbd"` from real grep failures would let infra rot into the
  // audit baseline.
  if (hits.errors.length > 0) {
    return {
      usecase: id,
      coverage: "tbd",
      evidence: [],
      note: `audit: grep errored — ${hits.errors.slice(0, 2).join("; ")}`,
    }
  }
  const evidence = [...hits.code, ...hits.test, ...hits.runbook].sort()
  const hasCode = hits.code.size > 0
  const hasTest = hits.test.size > 0
  const coverage: CoverageLevel = hasCode && hasTest ? "ok" : hasCode ? "partial" : "tbd"
  return {
    usecase: id,
    coverage,
    evidence,
    ...(rule?.note !== undefined ? { note: rule.note } : {}),
  }
}
