/**
 * PMX-06 — THE SOURCE-OWNER AUDIT, as an executable check.
 *
 * The ticket asks for a receipt, not a grep transcript: *"The report classifies
 * every hit as canonical definition, composition wiring, process-boundary
 * serialization, compatibility projection, or remaining debt. Unclassified
 * duplicates block live spend. … The `rg` inventory alone is not acceptance
 * proof."*
 *
 * ## What it proves
 *
 *  1. OWNERSHIP — each of the seven canonical owners is DEFINED exactly once, at
 *     the path that is supposed to own it. Two definitions of one owner is the
 *     shape every "parallel ProMax framework" takes.
 *  2. CLASSIFICATION — every remaining hit (raw family env mentions, ProMax
 *     family branches, legacy verdict-bucket consumers, ProMax-named modules)
 *     matches a DECLARED rule carrying a written reason. A hit nobody classified
 *     is `unclassified`, and unclassified blocks live spend through
 *     {@link assertOwnerAuditAdmitsLiveSpend} — a throw, not a paragraph.
 *  3. RATCHET — the three Foundation-gate counters are compared against the
 *     baseline recorded when PMX-06 froze. They may go down; a rise is refused.
 *
 * ## Why the classification key is PATH-EXACT
 *
 * A directory-prefix rule would let a NEW file inherit an old justification
 * silently, which is exactly how "one owner" rots. A rule names one path (and
 * optionally one line substring, for a file that legitimately holds two
 * different kinds of hit), so a moved or added file is unclassified until an
 * author writes down why it is allowed.
 *
 * ## Asymmetry, deliberately
 *
 * An UNCLASSIFIED hit fails the audit. A STALE rule (one whose path no longer
 * exists) is reported but does NOT fail it: a stale rule cannot cause spend, and
 * this repo has concurrent sessions moving files around. The receipt names them
 * so they can be cleaned up.
 *
 * PURE core: `auditProMaxSourceOwners` takes the source text it should judge.
 * The only impure function is the walker, which reads files and nothing else.
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { canonicalJson } from "../corpus"
import { sha256Hex } from "../provenance"

/** One source file, as text. The audit never opens a file itself. */
export interface OwnerAuditSourceFile {
  /** repo-relative, POSIX separators. */
  readonly path: string
  readonly text: string
}

/** The seven canonical owners the packet's integration authority names. */
export const PROMAX_OWNER_ROLES = [
  "typed_config_resolver",
  "family_profile_registry",
  "promax_harness_adapter",
  "remote_grade_receipt_contract",
  "official_grade_aggregation",
  "canonical_report_writer",
  "swe_projector_promax_registration",
] as const

export type ProMaxOwnerRole = (typeof PROMAX_OWNER_ROLES)[number]

/** The five classifications the ticket enumerates. Closed. */
export const PROMAX_OWNER_CLASSES = [
  "canonical_definition",
  "composition_wiring",
  "process_boundary_serialization",
  "compatibility_projection",
  "remaining_debt",
] as const

export type ProMaxOwnerClass = (typeof PROMAX_OWNER_CLASSES)[number]

/** The three Foundation-gate counters. Recorded at freeze, ratcheted after. */
export interface ProMaxOwnerAuditCounters {
  readonly rawFamilyEnvReads: number
  readonly promaxBranchesOutsideProfile: number
  readonly legacyVerdictConsumers: number
}

export interface OwnerAuditHit {
  readonly path: string
  readonly line: number
  readonly detector: string
  readonly text: string
  readonly classification: ProMaxOwnerClass | null
  readonly why: string | null
}

export interface ProMaxOwnerAuditReceipt {
  readonly ok: boolean
  /** Content address over the scanned inventory AND what was found in it. */
  readonly digest: string
  readonly ownerCounts: Readonly<Record<ProMaxOwnerRole, number>>
  readonly hits: readonly OwnerAuditHit[]
  /** `path:line` of every hit no rule classified. */
  readonly unclassified: readonly string[]
  /** Rules whose path is no longer in the tree. Reported, not fatal. */
  readonly staleRules: readonly string[]
  readonly baseline: ProMaxOwnerAuditCounters
  readonly final: ProMaxOwnerAuditCounters
  /** Human problems, one per failing clause. Empty iff `ok`. */
  readonly problems: readonly string[]
}

// ── the scan roots ──────────────────────────────────────────────────────────

/** Exactly the trees the ticket's inventory covers. */
export const PROMAX_OWNER_AUDIT_ROOTS = [
  join("src", "apps", "bench"),
  join("src", "runner", "batch"),
  join("tools", "leaderboard-dashboard"),
  join("tools", "bench-promax"),
] as const

/**
 * Where a ProMax-named module is ALLOWED to live. Invariant 10: *"New behavior
 * lives in cohesive `promax/` and remote helper modules … `promax/` may own
 * provenance and family-specific projections; evaluator/image behavior belongs
 * to `harness/promax/`."* A ProMax-named file anywhere else is the first visible
 * symptom of a parallel framework.
 */
const PROMAX_MODULE_OWNER_PREFIXES = [
  "src/apps/bench/promax/",
  "src/apps/bench/harness/promax/",
  "src/apps/bench/profiles/promax",
  "tools/leaderboard-dashboard/projectors/swe-bench/promax",
  "tools/bench-promax/",
] as const

/** Paths permitted to branch on the ProMax family: the registered profile and
 *  the registered dashboard family view. Nothing else. */
const PROMAX_BRANCH_OWNER_PREFIXES = [
  "src/apps/bench/profiles/promax",
  "src/apps/bench/profiles/registry.ts",
  "tools/leaderboard-dashboard/projectors/swe-bench/promax",
] as const

// ── detectors ───────────────────────────────────────────────────────────────

/** Built by concatenation so this module's own source never CONTAINS the
 *  literal it hunts for — a scanner that trips on itself teaches nothing. */
const FAMILY_TOKEN = "promax"
const FAMILY_ENV_KEY = "QUANTA_SWEBENCH_DATASET_FAMILY"

const OWNER_DETECTORS: Record<ProMaxOwnerRole, RegExp> = {
  typed_config_resolver: /^export const resolveBenchRunConfig\b/,
  family_profile_registry: /^export const DATASET_FAMILY_PROFILES\b/,
  promax_harness_adapter: /^export const buildProMaxOfficialGradeReceipt\b/,
  remote_grade_receipt_contract: /^export interface OfficialGradeReceipt\s*\{/,
  official_grade_aggregation: /^export const aggregateOfficialGrade\b/,
  canonical_report_writer: /^export const writeReport\b/,
  swe_projector_promax_registration: new RegExp(
    `\\bregister[A-Za-z]*\\s*\\([^\\n]*(?:PROMAX_FAMILY_VIEW|["']${FAMILY_TOKEN}["'])`,
  ),
}

const FAMILY_ENV_DETECTOR = new RegExp(
  `\\benv(?:Vars)?\\s*(?:\\.\\s*${FAMILY_ENV_KEY}\\b|\\[\\s*["']${FAMILY_ENV_KEY}["'])|["']${FAMILY_ENV_KEY}["']\\s*[,)\\]]`,
)

const FAMILY_BRANCH_DETECTOR = new RegExp(
  `[!=]==\\s*["']${FAMILY_TOKEN}["']|["']${FAMILY_TOKEN}["']\\s*[!=]==|case\\s+["']${FAMILY_TOKEN}["']\\s*:`,
)

/** A module that speaks the LEGACY four-bucket verdict vocabulary. Module-level
 *  (not line-level) because "consumer" is the unit the Foundation gate counts. */
const LEGACY_QUARTET = ["resolved", "unresolved", "errored", "emptyPatch"] as const
const LEGACY_OWNER_SYMBOLS = /\bprojectLegacyBuckets\b|\bLEGACY_BUCKET_BY_STATE\b/

export const DETECTOR_IDS = [
  "owner_definition",
  "family_env",
  "family_branch",
  "legacy_verdict_consumer",
  "promax_module_location",
] as const

// ── the classification table ────────────────────────────────────────────────

interface OwnerAuditRule {
  readonly path: string
  readonly detector: (typeof DETECTOR_IDS)[number]
  /** Optional line substring, for a file holding two kinds of hit. */
  readonly match?: string
  readonly classification: ProMaxOwnerClass
  readonly why: string
}

/**
 * EVERY hit the tree legitimately contains, with the reason it is allowed.
 * Adding a hit without adding a rule is what `unclassified` reports.
 */
const CLASSIFICATION_RULES: readonly OwnerAuditRule[] = [
  // ── the seven canonical owners ────────────────────────────────────────────
  {
    path: "src/apps/bench/run-config.ts",
    detector: "owner_definition",
    classification: "canonical_definition",
    why: "jun-30 T2 — the ONE typed bench run-config resolver, called once at the composition root",
  },
  {
    path: "src/apps/bench/profiles/registry.ts",
    detector: "owner_definition",
    classification: "canonical_definition",
    why: "jun-30 T4 — the ONE dataset-family profile registry; adding a family is one entry here",
  },
  {
    path: "src/apps/bench/harness/promax/adapter.ts",
    detector: "owner_definition",
    classification: "canonical_definition",
    why: "PMX-03 — the ONE ProMax harness adapter: pinned-evaluator output → the generic receipt",
  },
  {
    path: "src/runner/batch/eval/official-grade/types.ts",
    detector: "owner_definition",
    classification: "canonical_definition",
    why: "PMX-03 — the ONE generic remote grade-receipt contract, imported by runner and report code",
  },
  {
    path: "src/runner/batch/report-official-grade.ts",
    detector: "owner_definition",
    classification: "canonical_definition",
    why: "PMX-05 — the ONE official-grade aggregation function (the only place a rate is divided)",
  },
  {
    path: "src/runner/batch/report-envelope.ts",
    detector: "owner_definition",
    classification: "canonical_definition",
    why: "BFND-02 — the ONE canonical report writer for every suite branch",
  },
  {
    path: "tools/leaderboard-dashboard/projectors/swe-bench/registry.ts",
    detector: "owner_definition",
    classification: "canonical_definition",
    why: "BFND-03 / PMX-05 — the ONE ProMax registration, inside the SWE projector's family-view registry",
  },

  // ── raw family env mentions ───────────────────────────────────────────────
  {
    path: "src/apps/bench/run-config.ts",
    detector: "family_env",
    match: "= family",
    classification: "process_boundary_serialization",
    why: "the subprocess/SSH wire encoder — env may SERIALIZE the resolved family across a real process boundary",
  },
  {
    path: "src/apps/bench/run-config.ts",
    detector: "family_env",
    classification: "canonical_definition",
    why: "the ONE argv/env family resolution, performed exactly once into the typed config",
  },
  {
    path: "src/apps/bench/benchmark-suite.ts",
    detector: "family_env",
    classification: "composition_wiring",
    why: "BFND-01 asks WHETHER the SWE-only family axis was named, in order to refuse it on a non-SWE suite; it never derives behavior from the value",
  },
  {
    path: "src/apps/bench/dataset-family.ts",
    detector: "family_env",
    classification: "compatibility_projection",
    why: "the legacy lenient resolver retained for pre-T2 callers; it produces no typed config and is not on the gated path",
  },
  {
    path: "src/apps/bench/remote/box-session.ts",
    detector: "family_env",
    classification: "process_boundary_serialization",
    why: "the key appears in the list of env names forwarded to a REAL remote process, not as an in-process authority read",
  },

  // ── ProMax family branches ────────────────────────────────────────────────
  {
    path: "tools/leaderboard-dashboard/projectors/swe-bench/promax.ts",
    detector: "family_branch",
    classification: "compatibility_projection",
    why: "the registered ProMax family view's own client bundle filters the rows it renders; presentation only, no denominator",
  },

  // ── legacy verdict-bucket consumers ───────────────────────────────────────
  {
    path: "src/apps/bench/harness/promax/chunk-verdicts.ts",
    detector: "legacy_verdict_consumer",
    classification: "compatibility_projection",
    why: "PMX-04 — projects the pinned evaluator's pass-rate document into the legacy quartet for CHUNK bookkeeping; it imports LEGACY_BUCKET_BY_STATE rather than declaring a second state→bucket table (it had one when first written, and this detector is what caught it)",
  },
  {
    path: "src/apps/bench/profiles/types.ts",
    detector: "legacy_verdict_consumer",
    classification: "compatibility_projection",
    why: "PMX-04 — declares the SHAPE (FamilyBoxGradeVerdicts) a family's own grader returns; a type with no mapping and no denominator, spelled structurally so profiles stay a leaf under remote/",
  },
  {
    path: "src/apps/bench/remote/box-session/family-box-grade.ts",
    detector: "legacy_verdict_consumer",
    classification: "compatibility_projection",
    why: "PMX-04 — transports the quartet from the family's profile port to the chunk result; it copies the arrays and decides nothing about which bucket a row belongs in",
  },

  {
    path: "src/runner/batch/eval/official-grade/legacy-buckets.ts",
    detector: "legacy_verdict_consumer",
    classification: "canonical_definition",
    why: "PMX-03 — the ONE projection from the receipt to the legacy four arrays, in one direction only",
  },
  {
    path: "src/runner/batch/eval/official-grade/index.ts",
    detector: "legacy_verdict_consumer",
    classification: "canonical_definition",
    why: "the official-grade barrel re-exports the projection; it defines nothing of its own",
  },
  {
    path: "src/apps/bench/analyze/diff.ts",
    detector: "legacy_verdict_consumer",
    classification: "remaining_debt",
    why: "offline analysis over ALREADY-PERSISTED legacy reports; migrating it needs historical reports re-projected, which PMX-06 does not do",
  },
  {
    path: "src/apps/bench/analyze/leaderboard.ts",
    detector: "legacy_verdict_consumer",
    classification: "remaining_debt",
    why: "offline analysis over already-persisted legacy reports (same migration as analyze/diff.ts)",
  },
  {
    path: "src/apps/bench/analyze/verdicts.ts",
    detector: "legacy_verdict_consumer",
    classification: "remaining_debt",
    why: "the legacy verdict decoder for historical reports; the official-grade section is decoded separately",
  },
  {
    // THE SCANNER IS ITS OWN SUBJECT — deliberately, rather than exempting the
    // file from the walk. An exemption would also hide a duplicate OWNER defined
    // here; a rule keeps every other detector live over this module and states
    // exactly why this one hit is not a consumer: the four bucket names appear
    // below as the PATTERN the detector matches, never as a shape this module
    // reads, writes, or scores from.
    path: "src/apps/bench/promax/campaign/owner-audit.ts",
    detector: "legacy_verdict_consumer",
    classification: "canonical_definition",
    why: "this file DEFINES the legacy-consumer detector; the bucket names occur here as the detector's own pattern, not as a consumed verdict shape",
  },
  {
    path: "src/apps/bench/commands/grade.ts",
    detector: "legacy_verdict_consumer",
    classification: "compatibility_projection",
    why: "the CLI prints the legacy buckets for a local grade run; ProMax grades through the official-grade receipt instead",
  },
  {
    path: "src/apps/bench/remote/backend.ts",
    detector: "legacy_verdict_consumer",
    classification: "process_boundary_serialization",
    why: "the remote backend's ON-THE-WIRE grade payload is still the legacy shape; the receipt travels beside it (PMX-04) and is what ProMax scores from",
  },
  {
    path: "src/apps/bench/remote/box-session.ts",
    detector: "legacy_verdict_consumer",
    classification: "process_boundary_serialization",
    why: "box session transports the legacy arrays a box emits; it classifies nothing itself",
  },
  {
    path: "src/apps/bench/remote/box-session/types.ts",
    detector: "legacy_verdict_consumer",
    classification: "process_boundary_serialization",
    why: "the wire types for the legacy arrays a box emits",
  },
  {
    path: "src/apps/bench/remote/box-session/verdict-parse.ts",
    detector: "legacy_verdict_consumer",
    classification: "process_boundary_serialization",
    why: "parses the legacy arrays off a box's stdout; the official receipt is parsed by its own fail-closed parser",
  },
  {
    path: "src/apps/bench/remote/fanout.ts",
    detector: "legacy_verdict_consumer",
    classification: "process_boundary_serialization",
    why: "merges the legacy per-chunk payloads; official-grade receipts merge through mergeOfficialGradeReceipts",
  },
  {
    path: "src/apps/bench/remote/full.ts",
    detector: "legacy_verdict_consumer",
    classification: "compatibility_projection",
    why: "the full-remote accumulator keeps the legacy buckets alongside the receipt-derived coverage",
  },
  {
    path: "src/apps/bench/remote/pool/coverage.ts",
    detector: "legacy_verdict_consumer",
    classification: "compatibility_projection",
    why: "pool coverage keeps the legacy buckets alongside the receipt-derived coverage",
  },
  {
    path: "src/apps/bench/remote/verdict-buckets.ts",
    detector: "legacy_verdict_consumer",
    classification: "compatibility_projection",
    why: "the one helper that moves an id between legacy buckets, kept so callers do not each re-implement it",
  },
]

/** The counters as recorded when PMX-06 froze the campaign inputs. They are a
 *  RATCHET: a later ticket may drive them down, never up. */
export const PROMAX_OWNER_AUDIT_BASELINE: ProMaxOwnerAuditCounters = {
  rawFamilyEnvReads: 4,
  promaxBranchesOutsideProfile: 0,
  legacyVerdictConsumers: 12,
}

// ── the scan ────────────────────────────────────────────────────────────────

/** Strip comment content so a rail keys on CODE, never on prose. */
const stripComments = (line: string): string => {
  const t = line.trim()
  if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return ""
  return line.replace(/(^|[^:])\/\/.*$/, "$1")
}

const startsWithAny = (path: string, prefixes: readonly string[]): boolean =>
  prefixes.some((prefix) => path.startsWith(prefix))

const ruleFor = (
  path: string,
  detector: (typeof DETECTOR_IDS)[number],
  text: string,
): OwnerAuditRule | undefined => {
  const candidates = CLASSIFICATION_RULES.filter((r) => r.path === path && r.detector === detector)
  return (
    candidates.find((r) => r.match !== undefined && text.includes(r.match)) ??
    candidates.find((r) => r.match === undefined)
  )
}

const classify = (
  path: string,
  line: number,
  detector: (typeof DETECTOR_IDS)[number],
  text: string,
): OwnerAuditHit => {
  const rule = ruleFor(path, detector, text)
  return {
    path,
    line,
    detector,
    text: text.trim(),
    classification: rule?.classification ?? null,
    why: rule?.why ?? null,
  }
}

/**
 * THE audit. Pure: source text in, receipt out.
 */
export const auditProMaxSourceOwners = (
  files: readonly OwnerAuditSourceFile[],
  baseline: ProMaxOwnerAuditCounters = PROMAX_OWNER_AUDIT_BASELINE,
): ProMaxOwnerAuditReceipt => {
  const hits: OwnerAuditHit[] = []
  const ownerCounts: Record<ProMaxOwnerRole, number> = {
    typed_config_resolver: 0,
    family_profile_registry: 0,
    promax_harness_adapter: 0,
    remote_grade_receipt_contract: 0,
    official_grade_aggregation: 0,
    canonical_report_writer: 0,
    swe_projector_promax_registration: 0,
  }

  for (const file of files) {
    const lines = file.text.split("\n")
    lines.forEach((raw, index) => {
      const code = stripComments(raw)
      if (code.trim() === "") return
      for (const role of PROMAX_OWNER_ROLES) {
        if (!OWNER_DETECTORS[role].test(code)) continue
        ownerCounts[role] += 1
        hits.push({ ...classify(file.path, index + 1, "owner_definition", raw), text: role })
      }
      if (FAMILY_ENV_DETECTOR.test(code)) {
        hits.push(classify(file.path, index + 1, "family_env", raw))
      }
      if (FAMILY_BRANCH_DETECTOR.test(code)) {
        hits.push(classify(file.path, index + 1, "family_branch", raw))
      }
    })

    // module-level detectors
    const speaksLegacy =
      LEGACY_OWNER_SYMBOLS.test(file.text) ||
      LEGACY_QUARTET.every((word) => new RegExp(`\\b${word}\\b`).test(file.text))
    if (speaksLegacy) {
      hits.push(classify(file.path, 1, "legacy_verdict_consumer", file.path))
    }
    if (
      file.path.toLowerCase().includes(FAMILY_TOKEN) &&
      !startsWithAny(file.path, PROMAX_MODULE_OWNER_PREFIXES)
    ) {
      hits.push(classify(file.path, 1, "promax_module_location", file.path))
    }
  }

  const unclassified = hits
    .filter((h) => h.classification === null)
    .map((h) => `${h.path}:${h.line} (${h.detector})`)

  const counted = (detector: (typeof DETECTOR_IDS)[number]): readonly OwnerAuditHit[] =>
    hits.filter((h) => h.detector === detector && h.classification !== "canonical_definition")

  const final: ProMaxOwnerAuditCounters = {
    rawFamilyEnvReads: counted("family_env").length,
    promaxBranchesOutsideProfile: counted("family_branch").filter(
      (h) => !startsWithAny(h.path, PROMAX_BRANCH_OWNER_PREFIXES),
    ).length,
    legacyVerdictConsumers: counted("legacy_verdict_consumer").length,
  }

  const present = new Set(files.map((f) => f.path))
  const staleRules = CLASSIFICATION_RULES.filter((r) => !present.has(r.path)).map(
    (r) => `${r.path} (${r.detector})`,
  )

  const problems: string[] = []
  for (const role of PROMAX_OWNER_ROLES) {
    if (ownerCounts[role] !== 1) {
      problems.push(
        `owner "${role}" is defined ${ownerCounts[role]} time(s); exactly one canonical definition is required` +
          (ownerCounts[role] > 1
            ? ` — at ${hits
                .filter((h) => h.detector === "owner_definition" && h.text === role)
                .map((h) => `${h.path}:${h.line}`)
                .join(", ")}`
            : ""),
      )
    }
  }
  if (unclassified.length > 0) {
    problems.push(
      `${unclassified.length} hit(s) are unclassified: ${unclassified.slice(0, 5).join("; ")} — ` +
        "every hit must be declared canonical definition / composition wiring / process-boundary " +
        "serialization / compatibility projection / remaining debt",
    )
  }
  for (const key of [
    "rawFamilyEnvReads",
    "promaxBranchesOutsideProfile",
    "legacyVerdictConsumers",
  ] as const) {
    if (final[key] > baseline[key]) {
      problems.push(
        `counter "${key}" rose from the PMX-06 baseline ${baseline[key]} to ${final[key]} — ` +
          "these counts are a ratchet and may only go down",
      )
    }
  }

  const digest = sha256Hex(
    canonicalJson({
      inventory: files.map((f) => [f.path, sha256Hex(f.text)]),
      hits: hits.map((h) => [h.path, h.line, h.detector, h.classification]),
      final,
    }),
  )

  return {
    ok: problems.length === 0,
    digest,
    ownerCounts,
    hits,
    unclassified,
    staleRules,
    baseline,
    final,
    problems,
  }
}

/** The hard gate. Unclassified duplicates BLOCK live spend — as a throw. */
export const assertOwnerAuditAdmitsLiveSpend = (receipt: ProMaxOwnerAuditReceipt): void => {
  if (receipt.ok) return
  throw new Error(
    `bench: the ProMax source-owner audit does not admit live spend — ${receipt.problems.join(" | ")}. ` +
      "REFUSING to launch a campaign while a canonical owner has a duplicate or an unclassified hit.",
  )
}

// ── the walker (the only impure part) ───────────────────────────────────────

const walk = (dir: string, out: string[]): void => {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue
    const abs = join(dir, entry)
    if (statSync(abs).isDirectory()) {
      walk(abs, out)
      continue
    }
    if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue
    out.push(abs)
  }
}

/**
 * Read the declared roots. Returns repo-relative POSIX paths, sorted, so an
 * audit receipt taken on two machines is byte-comparable.
 */
export const collectOwnerAuditSources = (repoRoot: string): readonly OwnerAuditSourceFile[] => {
  const absolute: string[] = []
  for (const root of PROMAX_OWNER_AUDIT_ROOTS) walk(join(repoRoot, root), absolute)
  return absolute
    .map((abs) => ({
      path: relative(repoRoot, abs).split(sep).join("/"),
      text: readFileSync(abs, "utf8"),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}
