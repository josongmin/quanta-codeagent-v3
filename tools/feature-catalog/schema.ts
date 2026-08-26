/**
 * Feature-catalog zod schema + loader.
 *
 * Canonical schema for YAML-backed feature entries. See README.md for layout.
 * Mini-YAML parser lives in ./yaml.ts (no external yaml dep).
 */
import type { Dirent } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { isAbsolute, join, relative } from "node:path"
import { parseDocument } from "yaml"
import { z } from "zod"
import { FEATURES_DIR } from "./paths"
import { parseYaml } from "./yaml"

export const Maturity = z.enum(["L1", "L2", "L3", "L4", "L5"])
export const Status = z.enum(["stable", "new", "refined", "hold", "deprecated"])
export const LifecycleStage = z.enum(["proposed", "active", "deprecated", "sunset", "removed"])

// SOTA Tier-3 — integration tracking axes.
export const UiSurface = z.enum(["cli", "web", "ide", "tauri", "api", "none", "n-a"])
export const IntegrationStatus = z.enum(["integrated", "partial", "planned", "none", "n-a"])
export const ConfigStatus = z.enum(["integrated", "partial", "planned", "static", "none", "n-a"])

// SOTA Tier-5 — per-surface integration with code-grounded EVIDENCE.
//
// Orthogonal to `ui_surfaces` (bare *intended*-surface tags that this audit
// found to be ~unreliable: only ~13/933 list web while the web app surfaces
// far more, and several [cli] tags are "accidentally right" because the web
// slash stubs do not actually execute). `surface_integration` records, PER
// SURFACE, the AUDITED wiring status + the file:line proof — so the question
// "is feature X actually wired into the CLI / the web app?" is answerable from
// the catalog instead of re-greping the tree. See README §"surface_integration".
//
//   full    — produced/handled on this surface AND a user-visible affordance
//   partial — produced/handled but weak/incomplete render or control
//   missing — neither (e.g. dropped at the web event-bridge default arm)
//   na      — not applicable to this surface
//   unknown — not yet audited (default; the populate sweep fills these)
//
// method:  audited (a human/agent opened the files) | derived (computed from a
//          code SSOT e.g. the toSessionHostTurnEvent whitelist) | unverified.
// The drift ratchet (tests/unit/feature-catalog-surface-integration.test.ts)
// requires evidence text whenever status ∈ {full,partial,missing}.
export const SurfaceStatus = z.enum(["full", "partial", "missing", "na", "unknown"])
export const SurfaceMethod = z.enum(["audited", "derived", "unverified"])
export const SurfaceIntegrationSchema = z
  .object({
    cli: SurfaceStatus.default("unknown"),
    web: SurfaceStatus.default("unknown"),
    evidence: z
      .object({ cli: z.string().default(""), web: z.string().default("") })
      .partial()
      .default({}),
    method: SurfaceMethod.default("unverified"),
    verified: z.string().optional(),
  })
  .default({ cli: "unknown", web: "unknown", evidence: {}, method: "unverified" })

// SOTA Tier-6 — MACHINE-CHECKABLE producer/consumer wiring contract.
//
// `surface_integration` above is prose + a hand-audited status word: it cannot
// mechanically distinguish "there is a type-surface" from "it is actually wired
// end-to-end". That gap produces FALSE-GREENs — e.g. the deferred-tool-registry
// declared `cli: full` while its own evidence says "deliberately NO scheduler
// wired into the loop": a pure in-memory type-surface with no end-to-end effect,
// scored as fully integrated. The `wiring` block below closes that gap with a
// STATIC, symbol-resolvable contract that the wiring-contract ratchet checks.
//
// Scope boundary (deliberate): this is a DECLARATION-vs-symbol-resolution proof
// — every SiteRef must resolve to a real {module, exportedSymbol}, and
// `wireStatus` must be honest about it (a `wired` surface needs BOTH a producer
// and a consumer symbol that resolve; `seam-only` needs a producer but declares
// NO consumer). It does NOT prove runtime composition-reachability (that the
// consumer is invoked from a live surface builder) — that is a SEPARATE, heavier
// proof kind (running the surface builder / import-graph BFS in reachability.ts).
// Conflating the two is exactly what made `cli: full` untrustworthy.

// A single source-site: resolve the symbol VIA the module (not fragile
// file:line). `module` is a repo-relative `src/**.ts` path; `exportedSymbol` is
// a name the module exports (directly OR via barrel re-export — the ratchet
// follows `export … from` chains, mirroring reachability.ts's parseSymbols).
// `role` is free-form prose (e.g. "issues DeferredHandle", "invokes the seam").
export const SiteRefSchema = z.object({
  module: z.string().min(1),
  exportedSymbol: z.string().min(1),
  role: z.string().min(1),
})
export type SiteRef = z.infer<typeof SiteRefSchema>

// One activation CONDITION. A feature is typically gated by a UNION of these
// (knob AND preset AND a wired port present), so `wiring.activation` is an
// ARRAY, not a single knob field.
//   env          — process env var gate (key = VAR name, value? = required literal)
//   config       — runtime-config knob (key = config path, value? = required value)
//   preset       — a mode/agent preset selects it (key = preset id)
//   port-present — activated only when a port symbol is injected/wired
//                  (key = the port symbol name)
export const ActivationKind = z.enum(["env", "config", "preset", "port-present"])
export const ActivationConditionSchema = z.object({
  kind: ActivationKind,
  key: z.string().min(1),
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
})
export type ActivationCondition = z.infer<typeof ActivationConditionSchema>

// Honest wiring posture — the third value is what makes "type surface only, no
// scheduler" declarable instead of laundered into `cli: full`:
//   wired            — producer AND consumer both exist and resolve; the
//                      contract is exercised end-to-end at the type level.
//   seam-only        — producer exists (the surface is real) but there is NO
//                      consumer wired yet (e.g. a registry with no scheduler, a
//                      port with no in-slice caller). This is the deferred-tool-
//                      registry's true state.
//   forward-contract — declared ahead of any producer; a placeholder that a
//                      future implementation will fill (weakest posture).
export const WireStatus = z.enum(["wired", "seam-only", "forward-contract"])
export type WireStatus = z.infer<typeof WireStatus>

// The full surface set — the current cli/web-only `surface_integration` model is
// too coarse: bench/headless/daemon/sdk are all real surfaces with distinct
// wiring. A per-surface contract can carry its OWN producer/consumer SiteRef.
export const WiringSurface = z.enum(["cli", "web", "sdk", "headless", "bench", "daemon"])
export type WiringSurface = z.infer<typeof WiringSurface>

export const SurfaceContractSchema = z.object({
  status: SurfaceStatus,
  producer: SiteRefSchema.optional(),
  consumer: SiteRefSchema.optional(),
})
export type SurfaceContract = z.infer<typeof SurfaceContractSchema>

// The OPTIONAL machine-checkable wiring block. Absent ⇒ legacy behavior is
// byte-identical (no wiring claim, nothing new to check). Present ⇒ the
// wiring-contract ratchet resolves every SiteRef + enforces wireStatus honesty.
export const WiringSchema = z.object({
  wireStatus: WireStatus,
  activation: z.array(ActivationConditionSchema).default([]),
  producer: z.array(SiteRefSchema).default([]),
  consumer: z.array(SiteRefSchema).default([]),
  contracts: z.record(WiringSurface, SurfaceContractSchema).default({}),
})
export type Wiring = z.infer<typeof WiringSchema>

export const RunMode = z.enum([
  "interactive",
  "headless",
  "batch",
  "daemon",
  "ide",
  "ci-bot",
  "n-a",
])

export const FeatureSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "kebab-case unique id"),
  title: z.string().min(1),
  section: z.number().int().min(1).max(20),
  subsystem: z.string().min(1),
  order: z.number().int().default(0),
  maturity: Maturity,
  status: Status.default("stable"),
  owners: z.array(z.string()).default([]),
  labels: z.array(z.string()).default([]),
  depends_on: z.array(z.string()).default([]),
  lifecycle_stage: LifecycleStage.default("active"),
  supersedes: z.array(z.string()).default([]),
  superseded_by: z.string().optional(),
  sunset_date: z.string().optional(),
  // Cross-axis link to the capability layer (`src/capability/registry.ts`).
  // Optional + additive: a feature exposed as a gated LLM-tool/slash/skill/hook
  // capability sets `capability:` to the capability id it maps to, making the
  // FEATURE axis ↔ CAPABILITY axis cross-referenceable (the 3-axis consistency
  // ratchet asserts this id resolves to a real CAPABILITIES entry).
  capability: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/, "kebab-case capability id")
    .optional(),
  // SOTA Tier-3 — 4-axis integration tracking (all optional, defaults to "n-a").
  ui_surfaces: z.array(UiSurface).default([]),
  monitoring: IntegrationStatus.default("n-a"),
  modes: z.array(RunMode).default([]),
  configurable: ConfigStatus.default("n-a"),
  telemetry_keys: z.array(z.string()).default([]),
  config_refs: z
    .object({
      env: z.array(z.string()).default([]),
      runtime: z.array(z.string()).default([]),
      cli: z.array(z.string()).default([]),
      prefs: z.array(z.string()).default([]),
    })
    .partial()
    .default({}),
  // SOTA Tier-5 — audited per-surface (CLI / web) integration + evidence.
  surface_integration: SurfaceIntegrationSchema,
  // SOTA Tier-6 — OPTIONAL machine-checkable producer/consumer wiring contract.
  // Additive: absent ⇒ byte-identical legacy. Present ⇒ the wiring-contract
  // ratchet (tests/unit/feature-catalog-wiring-contract.test.ts) resolves every
  // SiteRef's {module, exportedSymbol} and enforces wireStatus honesty. Lets a
  // "type surface only, no scheduler" be declared as `seam-only` instead of
  // being laundered into `surface_integration.cli: full` (a false-green).
  wiring: WiringSchema.optional(),
  purpose: z.string().min(1),
  evidence: z
    .object({
      code: z.array(z.string()).default([]),
      adrs: z.array(z.union([z.number().int(), z.string()])).default([]),
      tests: z
        .object({
          unit: z.array(z.string()).default([]),
          integration: z.array(z.string()).default([]),
          contract: z.array(z.string()).default([]),
        })
        .default({ unit: [], integration: [], contract: [] }),
    })
    .default({ code: [], adrs: [], tests: { unit: [], integration: [], contract: [] } }),
  knobs: z
    .array(
      z.union([
        z.string(),
        z.object({
          name: z.string(),
          where: z.string().optional(),
          default: z.union([z.string(), z.number(), z.boolean()]).optional(),
          purpose: z.string().optional(),
        }),
      ]),
    )
    .default([]),
  deliberate_hold: z
    .object({
      reason: z.string(),
      promotion_path: z.string().optional(),
    })
    .nullable()
    .default(null),
  notes: z.string().optional(),
})

export type Feature = z.infer<typeof FeatureSchema>
export type Maturity = z.infer<typeof Maturity>
export type Status = z.infer<typeof Status>
export type LifecycleStage = z.infer<typeof LifecycleStage>

export function computeGrade(f: Feature): "A" | "B" | "C" | "D" | "F" {
  const evidenceCount =
    f.evidence.code.length +
    f.evidence.tests.unit.length +
    f.evidence.tests.integration.length +
    f.evidence.tests.contract.length
  const hasAdr = f.evidence.adrs.length > 0
  const hasOwner = f.owners.length > 0
  if (evidenceCount === 0) return "F"
  if (evidenceCount === 1) return "D"
  if (evidenceCount <= 3) return "C"
  if (evidenceCount <= 5) return hasAdr || hasOwner ? "B" : "C"
  return hasAdr && hasOwner ? "A" : "B"
}

// --- SOTA Tier-4 — 4-axis composite judgment ------------------------------
//
// `computeGrade` above scores documentation/evidence quantity only.
// `computeAxisScores` / `computeJudgment` add operational coverage axes used
// to decide whether a registered L4+ feature is really wired-and-watched, or
// just "slice exists, never called". Use these to detect overclaimed-L4
// drift uncovered by the wave-2/wave-6 audits.
//
// Each axis is scored 0..3; total 0..12 maps to a composite letter.
//
// monitoring (0..3): "n-a"|"none" → 0, "planned" → 1, "partial" → 2,
//   "integrated" → 3
// hellgate   (0..3): count of test paths containing "hellgate" in
//   evidence.tests.{unit,integration,contract} (capped at 3)
// wiring     (0..3): callsite integration — ui_surfaces ∪ configurable.
//   0 = empty or [none]/[n-a]; 1 = ui_surfaces has any non-CLI surface or
//   ui_surfaces=[cli] but configurable=planned; 2 = ui_surfaces=[cli] +
//   configurable in {static, partial}; 3 = ui_surfaces=[cli] +
//   configurable=integrated
// structure  (0..3): modularization signal from evidence.code.
//   0 = empty; 1 = single file; 2 = 2..4 files; 3 = ≥5 files OR slice
//   barrel detected (any path matching `src/<slice>/index.ts`)
export interface AxisScores {
  readonly monitoring: 0 | 1 | 2 | 3
  readonly hellgate: 0 | 1 | 2 | 3
  readonly wiring: 0 | 1 | 2 | 3
  readonly structure: 0 | 1 | 2 | 3
  readonly total: number // 0..12
}

const monitoringScore = (monitoring: Feature["monitoring"]): 0 | 1 | 2 | 3 => {
  const scores = { integrated: 3, partial: 2, planned: 1, static: 0, none: 0, "n-a": 0 } as const
  return scores[monitoring] ?? 0
}

const wiringScore = (feature: Feature): 0 | 1 | 2 | 3 => {
  const hasCli = feature.ui_surfaces.includes("cli")
  const hasAnyRealSurface = feature.ui_surfaces.some(
    (surface) => surface !== "none" && surface !== "n-a",
  )
  if (!hasAnyRealSurface) return 0
  if (!hasCli) return 1
  if (feature.configurable === "integrated") return 3
  if (feature.configurable === "partial" || feature.configurable === "static") return 2
  return 1
}

const structureScore = (codePaths: readonly string[]): 0 | 1 | 2 | 3 => {
  const hasSliceBarrel = codePaths.some((path) => /^src\/[^/]+\/index\.ts$/.test(path))
  if (hasSliceBarrel || codePaths.length >= 5) return 3
  if (codePaths.length >= 2) return 2
  if (codePaths.length === 1) return 1
  return 0
}

export function computeAxisScores(f: Feature): AxisScores {
  const allTests = [
    ...f.evidence.tests.unit,
    ...f.evidence.tests.integration,
    ...f.evidence.tests.contract,
  ]
  const monitoring = monitoringScore(f.monitoring)
  const hellCount = allTests.filter((t) => t.includes("hellgate")).length
  const hellgate = Math.min(hellCount, 3) as 0 | 1 | 2 | 3
  const wiring = wiringScore(f)
  const structure = structureScore(f.evidence.code)

  return {
    monitoring,
    hellgate,
    wiring,
    structure,
    total: monitoring + hellgate + wiring + structure,
  }
}

// Composite letter from 0..12 total + maturity adjustment.
// L4+ features with total<6 are flagged as "L4-overclaimed" via the
// `judge` command; this letter still maps cleanly so it composes with the
// evidence-only grade for two-axis viewing.
export function compositeLetter(total: number): "A" | "B" | "C" | "D" | "F" {
  if (total >= 10) return "A"
  if (total >= 7) return "B"
  if (total >= 4) return "C"
  if (total >= 2) return "D"
  return "F"
}

// Final judgment: combines axis composite with code-presence signal.
//
// AUDIT-1 (2026-05-24): the previous matrix conflated axis-thinness
// (monitoring/wiring not applicable for the slice) with genuine overclaim
// (no code exists at all). 62.5% of features previously flagged
// "overclaimed" were actually "appropriate-thin": code exists, feature is
// real, but operational axes simply do not apply (e.g. a pure-library slice
// has no UI surface, no monitoring hook). Conflating these two states is
// noise that drowns out real overclaim drift.
//
// New matrix — verdict is derived from validated signals only:
//
//   1. deliberate-hold : f.deliberate_hold != null
//   2. overclaimed     : maturity ∈ {L4, L5} ∧ evidence.code.length == 0
//                        ∧ deliberate_hold == null
//        (= truly no code = the only honest "overclaimed" signal we can
//         derive without heuristics; axis-thinness alone is not enough)
//   3. solid           : axes.total >= 7
//   4. appropriate     : axes.total >= 4
//                        ∨ (evidence.code.length >= 2 ∧ axes.total >= 2)
//        (code-present-but-axis-thin is appropriate, not overclaimed)
//   5. thin            : everything else
//
// Note: this matrix applies uniformly across all maturity tiers. L1..L3
// features are not auto-classified as "appropriate" — they fall through
// the same gates; in practice they end up in {solid, appropriate, thin}
// based on the same evidence-driven signals as L4+.
export type Verdict = "solid" | "appropriate" | "thin" | "overclaimed" | "deliberate-hold"

export interface FeatureJudgment {
  readonly axes: AxisScores
  readonly composite: "A" | "B" | "C" | "D" | "F"
  readonly evidenceGrade: "A" | "B" | "C" | "D" | "F"
  readonly verdict: Verdict
}

export function computeJudgment(f: Feature): FeatureJudgment {
  const axes = computeAxisScores(f)
  const composite = compositeLetter(axes.total)
  const evidenceGrade = computeGrade(f)
  const codeLen = f.evidence.code.length
  const isL4Plus = f.maturity === "L4" || f.maturity === "L5"

  let verdict: Verdict
  if (f.deliberate_hold !== null) {
    verdict = "deliberate-hold"
  } else if (isL4Plus && codeLen === 0) {
    verdict = "overclaimed"
  } else if (axes.total >= 7) {
    verdict = "solid"
  } else if (axes.total >= 4 || (codeLen >= 2 && axes.total >= 2)) {
    verdict = "appropriate"
  } else {
    verdict = "thin"
  }
  return { axes, composite, evidenceGrade, verdict }
}

/** Canonical section name map (1..10). */
export const SECTION_NAMES: Readonly<Record<number, string>> = Object.freeze({
  1: "에이전트 코어 루프 (ReAct)",
  2: "도구 시스템",
  3: "권한 & 안전",
  4: "컨텍스트 관리",
  5: "장기 메모리",
  6: "Tier-1 능력",
  7: "복원력",
  8: "관측성",
  9: "통합 (MCP/LSP/Hooks)",
  10: "앱/영속/정책",
})

/** ASCII slug map for filesystem directory naming (1..10). */
export const SECTION_SLUGS: Readonly<Record<number, string>> = Object.freeze({
  1: "agent-loop",
  2: "tool-system",
  3: "permission-safety",
  4: "context-management",
  5: "memory",
  6: "tier1",
  7: "resilience",
  8: "observability",
  9: "integration",
  10: "app",
})

/**
 * Recursively gather *.yaml files under `dir`, sorted by relative path.
 *
 * Distinguishes three states the previous version collapsed into `[]`:
 * a relative path (the cwd is not an answer), an absent directory (a missing
 * catalog is never a clean one), and an empty directory (the only case where an
 * empty result is a real finding). The ENOENT→`[]` branch it used to have is what
 * let `validate --strict` report `0 feature(s), all evidence resolved` with
 * exit 0 from a foreign working directory.
 */
async function gatherYamlFiles(dir: string): Promise<string[]> {
  if (!isAbsolute(dir)) {
    throw new Error(
      `feature catalog: "${dir}" is relative — pass an absolute path. A repo path built ` +
        `from the ambient cwd resolves to nothing outside the repo root, and an empty ` +
        `catalog is indistinguishable from a clean one. Use the anchored constants in ` +
        `tools/feature-catalog/paths.ts.`,
    )
  }
  const out: string[] = []
  let entries: Dirent[]
  try {
    entries = (await readdir(dir, { withFileTypes: true })) as Dirent[]
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT") {
      throw new Error(
        `feature catalog: directory not found: ${dir} — a missing catalog is not an empty one.`,
      )
    }
    throw err
  }
  for (const ent of entries) {
    const full = join(dir, ent.name)
    if (ent.isDirectory()) {
      out.push(...(await gatherYamlFiles(full)))
    } else if (ent.isFile() && ent.name.endsWith(".yaml")) {
      out.push(full)
    }
  }
  out.sort()
  return out
}

/** Loaded feature with its source path (for error reporting / diagnostics). */
export interface LoadedFeature {
  feature: Feature
  path: string
}

/**
 * The catalog's compact parser owns the supported feature subset, but its
 * permissive scalar handling must not let a file cease to be YAML for every
 * standard consumer. Validate the original bytes first so duplicate keys and
 * reserved leading scalars cannot be silently accepted as catalog truth.
 */
function assertStandardYaml(text: string, path: string): void {
  const document = parseDocument(text, { uniqueKeys: true })
  if (document.errors.length === 0) return
  const details = document.errors.map((error) => error.message.split("\n")[0]).join("; ")
  throw new Error(`YAML syntax failed at ${relative(process.cwd(), path)}: ${details}`)
}

/**
 * Load + validate all features under `dir`. Throws on first parse/zod error
 * with a clear message including the source path.
 */
export async function loadFeatures(dir: string = FEATURES_DIR): Promise<LoadedFeature[]> {
  const files = await gatherYamlFiles(dir)
  const loaded: LoadedFeature[] = []
  for (const path of files) {
    const text = await readFile(path, "utf8")
    let raw: unknown
    try {
      assertStandardYaml(text, path)
      raw = parseYaml(text)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`YAML parse failed at ${relative(process.cwd(), path)}: ${msg}`)
    }
    const result = FeatureSchema.safeParse(raw)
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
        .join("\n")
      throw new Error(`Schema validation failed at ${relative(process.cwd(), path)}:\n${issues}`)
    }
    loaded.push({ feature: result.data, path })
  }
  return loaded
}

// --- SOTA structural invariants -------------------------------------------
//
// `validateInvariants` runs MEASURABLE, FACT-BASED structural checks across
// loaded features. By default these are *advisory* — surfaced as warnings via
// `cmdValidate`. Pass `--strict` to `bun fc validate` to promote warnings to
// fail. Each invariant is a closed predicate over the validated `Feature`
// type (no I/O, no heuristics, no thresholds invented without evidence).
//
// Invariants:
//   1. labels-uniqueness  — at most one `surface:X` label and at most one
//      `tier:X` label per feature (multiple values for the same axis is a
//      modeling bug — the axis is single-valued by definition).
//   2. l4-owners-non-empty — features at maturity L4 must have at least one
//      owner. L5 already requires this via the gates; this extends the same
//      ownership invariant to L4 (the operational tier).
//   3. deliberate-hold-vs-progressing-status — `deliberate_hold != null`
//      contradicts a *progressing* status. We narrow "progressing" to
//      `refined` only (intentionally weaker than `stable`, which is widely
//      used as the default literal across the catalog and is not a fact-
//      based contradiction by itself).
//   4. lifecycle-vs-maturity — `lifecycle_stage == "deprecated"` cannot
//      co-exist with `maturity == "L5"` (deprecated means scheduled for
//      removal; L5 means polished operational tier — these are mutually
//      exclusive by definition).
export interface InvariantViolation {
  readonly invariant: string
  readonly featureId: string
  readonly path: string
  readonly message: string
}

const invariantViolation = (
  feature: Feature,
  path: string,
  invariant: string,
  message: string,
): InvariantViolation => ({ invariant, featureId: feature.id, path, message })

const collectLabelInvariants = (feature: Feature, path: string): InvariantViolation[] => {
  const violations: InvariantViolation[] = []
  const surfaceLabels = feature.labels.filter((label) => label.startsWith("surface:"))
  const tierLabels = feature.labels.filter((label) => label.startsWith("tier:"))
  if (surfaceLabels.length > 1) {
    violations.push(
      invariantViolation(
        feature,
        path,
        "labels-uniqueness",
        `multiple surface:* labels: [${surfaceLabels.join(", ")}] (single-valued axis)`,
      ),
    )
  }
  if (tierLabels.length > 1) {
    violations.push(
      invariantViolation(
        feature,
        path,
        "labels-uniqueness",
        `multiple tier:* labels: [${tierLabels.join(", ")}] (single-valued axis)`,
      ),
    )
  }
  const hasDefaultOn = feature.labels.some((label) => /^default-on\b/.test(label))
  const hasDefaultOff = feature.labels.some((label) => /^default-off\b/.test(label))
  if (hasDefaultOn && hasDefaultOff) {
    violations.push(
      invariantViolation(
        feature,
        path,
        "default-posture-single-axis",
        "labels claim BOTH default-on and default-off — pick one (stale-opposite doc drift)",
      ),
    )
  }
  return violations
}

const collectLifecycleInvariants = (feature: Feature, path: string): InvariantViolation[] => {
  const violations: InvariantViolation[] = []
  if (feature.maturity === "L4" && feature.owners.length === 0) {
    violations.push(
      invariantViolation(
        feature,
        path,
        "l4-owners-non-empty",
        "maturity=L4 requires owners.length >= 1",
      ),
    )
  }
  if (feature.deliberate_hold !== null && feature.status === "refined") {
    violations.push(
      invariantViolation(
        feature,
        path,
        "deliberate-hold-vs-progressing-status",
        "deliberate_hold set but status=refined (contradicts progress)",
      ),
    )
  }
  if (feature.lifecycle_stage === "deprecated" && feature.maturity === "L5") {
    violations.push(
      invariantViolation(
        feature,
        path,
        "lifecycle-vs-maturity",
        "lifecycle_stage=deprecated cannot be maturity=L5",
      ),
    )
  }
  return violations
}

export function validateInvariants(features: readonly LoadedFeature[]): InvariantViolation[] {
  const violations: InvariantViolation[] = []
  for (const { feature, path } of features) {
    violations.push(
      ...collectLabelInvariants(feature, path),
      ...collectLifecycleInvariants(feature, path),
    )
  }
  return violations
}

/**
 * Load + cross-feature validation (unique id, valid section, deterministic
 * ordering). Throws on first cross-feature violation.
 */
export async function loadFeaturesStrict(dir: string = FEATURES_DIR): Promise<LoadedFeature[]> {
  const loaded = await loadFeatures(dir)
  const seen = new Map<string, string>()
  for (const { feature, path } of loaded) {
    const prev = seen.get(feature.id)
    if (prev !== undefined) {
      throw new Error(
        `Duplicate feature id "${feature.id}": ${relative(process.cwd(), prev)} and ${relative(
          process.cwd(),
          path,
        )}`,
      )
    }
    seen.set(feature.id, path)
    if (!(feature.section in SECTION_NAMES)) {
      throw new Error(
        `Unknown section ${feature.section} in ${relative(process.cwd(), path)} (id=${feature.id})`,
      )
    }
  }
  // Stable sort: section → order → id
  loaded.sort((a, b) => {
    const sa = a.feature.section - b.feature.section
    if (sa !== 0) return sa
    const oa = a.feature.order - b.feature.order
    if (oa !== 0) return oa
    return a.feature.id < b.feature.id ? -1 : a.feature.id > b.feature.id ? 1 : 0
  })
  return loaded
}
