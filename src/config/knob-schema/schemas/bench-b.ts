/**
 * Pillar A — authored {@link KnobSchema} declarations for the SECOND THIRD of the
 * bench knob inventory (entries 26–50 by order in src/config/knob-inventory/
 * bench.ts): the spec-fidelity / localize / CHA / model-lane / patch-budget /
 * verify-select family. SSOT for derive (see ../derive).
 *
 * Each schema mirrors the EXISTING data verbatim so the derive is provably equal
 * (locked by tests/unit/kernel/derive-parity-b.test.ts):
 *   - `parse`    mirrors src/runner/knobs/knobs/<id>.ts verbatim (re-derived here,
 *     proven equal over active/off/garbage/boundary raws),
 *   - `describe`/`default`/`kind`/`readSite`/`envKey` mirror the CURRENT bench.ts
 *     inventory entry; `home` derives from `surfaces`.
 *
 * Additive: not registered, not imported by the live driver.
 *
 * DERIVE GAPS (knobs in entries 26–50 EXCLUDED because the current READ-ONLY
 * `deriveInventoryEntry` cannot reproduce their inventory entry):
 *   - QUANTA_BENCH_LSP_STEER, QUANTA_BENCH_LSP_CHEAP,
 *     QUANTA_BENCH_VERIFY_SELECT_EARLY_ACCEPT, QUANTA_BENCH_VERIFY_SELECT_RISK_GATE:
 *       inventory `kind:"bool"` with `default:undefined` (tri-state OFF-switch).
 *       `deriveInventoryDefault` forces a bool default to `false` when the schema
 *       default is undefined, so the derived entry would carry `default:false`
 *       and never deep-equal the `default:undefined` inventory entry. There is no
 *       authorable schema default that round-trips (`false` ⇒ derives `false`,
 *       collapsing the tri-state; `undefined` ⇒ also derives `false`).
 *   - QUANTA_BENCH_NO_PATCH_FORCE_FRACTION: inventory `kind:"float"`. `KnobKind`
 *     has no `"float"` member, so no KnobSchema.kind can reproduce the entry.
 *   - QUANTA_BENCH_MODEL_LANES: read directly in src/apps/bench/model-lanes.ts
 *     with NO registry knob in src/runner/knobs/knobs — there is no live `parse`
 *     to prove parse-parity against, so it is out of scope for the schema SSOT.
 *
 * SKIPPED (already authored in sibling schema files):
 *   - QUANTA_BENCH_REPRO_VOTE, QUANTA_BENCH_REPRO_DOUBT,
 *     QUANTA_BENCH_REPRO_EXEC_TIMEOUT_MS → bench-repro.ts.
 */

import type { KnobSchema } from "../contracts"

const BENCH: readonly ["bench"] = ["bench"] as const

const ENABLING_TRUTHY = new Set(["1", "on", "true"])

/* ── spec-fidelity-invariant (QUANTA_BENCH_SPEC_FIDELITY_INVARIANT) ─────────── */
const parseSpecFidelityInvariant = (raw: string | undefined): true | undefined => {
  if (raw === undefined) return undefined
  return ENABLING_TRUTHY.has(raw.trim().toLowerCase()) ? true : undefined
}
export const specFidelityInvariantSchema: KnobSchema<boolean> = {
  id: "spec-fidelity-invariant",
  envKey: "QUANTA_BENCH_SPEC_FIDELITY_INVARIANT",
  kind: "bool",
  category: "tool",
  default: false,
  describe:
    "Bench (T2b, jun-24): spec-fidelity invariant — when the issue declares a concrete expected output, wire a PUBLIC-issue-text declared-expected port so the existing hard:declaredExpectedMatch=false veto may fire in CLEAN mode against candidates that invent a different message shape. Answer-key guarded (public provenance only). Default-OFF ⇒ clean-mode gate stays disabled (byte-identical).",
  knobDescribe:
    "T2b spec-fidelity invariant (public-issue-text declared-expected veto in clean mode; fires only when issue declares an exact expected output)",
  readSite: "runner/batch/eval/knobs-bench.ts",
  surfaces: BENCH,
  source: "jun-24 scaffold SOTA absorption plan (T2b)",
  parse: parseSpecFidelityInvariant,
}

/* ── dynamic-message-matcher (QUANTA_BENCH_DYNAMIC_MESSAGE_MATCHER) ─────────── */
const parseDynamicMessageMatcher = (raw: string | undefined): true | undefined => {
  if (raw === undefined) return undefined
  return ENABLING_TRUTHY.has(raw.trim().toLowerCase()) ? true : undefined
}
export const dynamicMessageMatcherSchema: KnobSchema<boolean> = {
  id: "dynamic-message-matcher",
  envKey: "QUANTA_BENCH_DYNAMIC_MESSAGE_MATCHER",
  kind: "bool",
  category: "tool",
  default: false,
  describe:
    "Bench (H1, jun-24 astropy-13033 residual): dynamic-message-matcher — narrow the spec-fidelity matcher's dynamic-format abstain region by comparing a candidate template's FIXED skeleton (literal fragments around the placeholders) against the PUBLIC declared value. Skeleton consistent with V ⇒ still abstain (correct dynamic fix); skeleton competing ⇒ the existing clean-mode veto may fire. Layers on QUANTA_BENCH_SPEC_FIDELITY_INVARIANT. Default-OFF ⇒ every template literal abstains (byte-identical).",
  knobDescribe:
    "H1 dynamic-message-matcher: narrow the spec-fidelity matcher's dynamic-format abstain region by comparing the candidate template's FIXED skeleton against the public declared value (consistent ⇒ abstain, competing ⇒ may veto). Layers on spec-fidelity-invariant; default-OFF ⇒ every template literal abstains as before",
  readSite: "runner/batch/eval/knobs-bench.ts",
  surfaces: BENCH,
  source: "jun-24 scaffold SOTA absorption plan (H1)",
  parse: parseDynamicMessageMatcher,
}

/* ── repair-spec-gate (QUANTA_BENCH_REPAIR_SPEC_GATE) ──────────────────────── */
const parseRepairSpecGate = (raw: string | undefined): true | undefined => {
  if (raw === undefined) return undefined
  return ENABLING_TRUTHY.has(raw.trim().toLowerCase()) ? true : undefined
}
export const repairSpecGateSchema: KnobSchema<boolean> = {
  id: "repair-spec-gate",
  envKey: "QUANTA_BENCH_REPAIR_SPEC_GATE",
  kind: "bool",
  category: "tool",
  default: false,
  describe:
    "Bench (jun-26 repair-loop oracle-hardening): repair-rail spec gate. When the PUBLIC problem statement declares a concrete expected output, the primary-rail repair validator's predicate ALSO requires that declared expected to appear in the observed output — so an exit-0 round whose output lacks it reads as a FALSE GREEN and the repair loop does not stop at round 0 (runs rounds 1..N). Answer-key guarded (public-issue-text provenance only). Layers on QUANTA_BENCH_PRIMARY_RAIL. Default-OFF ⇒ the repair predicate stays observe-only / test_exit_zero (byte-identical).",
  knobDescribe:
    "repair-loop spec gate: require the public issue-declared expected output in the repair rail's observed output so an over-narrow exit-0 false green keeps the loop iterating (needs primary-rail; fires only when the issue declares an exact expected output)",
  readSite: "runner/batch/eval/knobs-bench.ts",
  surfaces: BENCH,
  source: "jun-26 repair-loop false-green RCA (round-0 over-narrow patch passes weak repro)",
  parse: parseRepairSpecGate,
}

/* ── repair-strong-oracle (QUANTA_BENCH_REPAIR_STRONG_ORACLE) ──────────────── */
const parseRepairStrongOracle = (raw: string | undefined): true | undefined => {
  if (raw === undefined) return undefined
  return ENABLING_TRUTHY.has(raw.trim().toLowerCase()) ? true : undefined
}
export const repairStrongOracleSchema: KnobSchema<boolean> = {
  id: "repair-strong-oracle",
  envKey: "QUANTA_BENCH_REPAIR_STRONG_ORACLE",
  kind: "bool",
  category: "tool",
  default: false,
  describe:
    "Bench (jun-28 repair-loop SOTA++ oracle-hardening): STRONG-ORACLE clear gate. The repair loop normally clears the moment the agent's OWN self-repro goes GREEN — too lenient: an over-narrow patch that handles only the issue's happy-path example passes that weak repro (false green at round 0) while the general FAIL_TO_PASS stays red. When ON, a round clears ONLY when its exit-0 green ALSO survives a CONJUNCTION of the AVAILABLE strong, no-leak signals: (1) base-discrimination (already required), (2) declared-expected match (lever #2, the PUBLIC issue-stated expected output — needs repair-spec-gate/primary-rail to surface the predicate), (3) repro-vote K-of-N RESOLVED consensus (needs repro-vote). Each conjunct FAILS OPEN when its signal is unavailable, so a correct patch is never blocked (issue declares nothing + single repro ⇒ behaves as today). A green round contradicted by any available strong signal is a FALSE GREEN ⇒ the loop iterates rounds 1..N toward a general fix. RAISES precision of the clear gate (fewer false greens) at the cost of MORE repair rounds — opt-in, A/B before promotion. Layers on closure-repair + (repair-spec-gate and/or repro-vote). Answer-key guarded (PUBLIC inputs only — issue text / agent-side repros). Default-OFF ⇒ the legacy single-green clear (byte-identical).",
  knobDescribe:
    "repair-loop STRONG-ORACLE clear gate: clear a round ONLY when its self-repro green ALSO survives a conjunction of the available strong no-leak signals (declared-expected match + repro-vote RESOLVED consensus); a green contradicted by any available signal is a false green so the loop keeps iterating toward a general fix. Each conjunct fails-open on absence (never blocks a correct patch). Needs closure-repair + repair-spec-gate and/or repro-vote; raises precision at the cost of more rounds; default-OFF ⇒ legacy single-green clear (byte-identical)",
  readSite: "runner/batch/eval/knobs-bench.ts",
  surfaces: BENCH,
  source:
    "jun-28 repair-loop oracle adequacy RCA (over-narrow round-0 patch passes weak self-repro; closure-repair ties baseline)",
  parse: parseRepairStrongOracle,
}

/* ── forward-localize (QUANTA_BENCH_FORWARD_LOCALIZE) ──────────────────────── */
const parseForwardLocalize = (raw: string | undefined): true | undefined => {
  if (raw === undefined) return undefined
  return ENABLING_TRUTHY.has(raw.trim().toLowerCase()) ? true : undefined
}
export const forwardLocalizeSchema: KnobSchema<boolean> = {
  id: "forward-localize",
  envKey: "QUANTA_BENCH_FORWARD_LOCALIZE",
  kind: "bool",
  category: "tool",
  default: false,
  describe:
    "Bench (T3, jun-24): forward-localize — occupies the deeper_localize adaptive route. When the controller selects deeper_localize and this lever is on, trace the prior candidate's edited symbols to their consumer call-sites and widen the next pass's owner evidence (advisory candidates, never hard requiredFiles). Default-OFF ⇒ deeper_localize stays a no-op.",
  knobDescribe:
    "T3 forward-localize: on the deeper_localize adaptive route, trace the prior candidate's edited symbols to their consumer call-sites and merge them into the next pass's owner evidence (occupies the deeper_localize no-op route)",
  readSite: "runner/batch/eval/knobs-bench.ts",
  surfaces: BENCH,
  source: "jun-24 scaffold SOTA absorption plan (T3)",
  parse: parseForwardLocalize,
}

/* ── cha-multisite-steer (QUANTA_BENCH_CHA_MULTISITE_STEER) ────────────────── */
const CHA_ENABLING = new Set(["1", "on", "true"])
const CHA_DISABLING = new Set(["0", "off", "false"])
const parseChaMultisiteSteer = (raw: string | undefined): boolean | undefined => {
  if (raw === undefined) return undefined
  const normalized = raw.trim().toLowerCase()
  if (CHA_ENABLING.has(normalized)) return true
  if (CHA_DISABLING.has(normalized)) return false
  return undefined
}
export const chaMultisiteSteerSchema: KnobSchema<boolean> = {
  id: "cha-multisite-steer",
  envKey: "QUANTA_BENCH_CHA_MULTISITE_STEER",
  kind: "bool",
  category: "tool",
  default: false,
  describe:
    "Bench (gap-C): when a localized Python method has sibling overrides under the same base class, append a concrete CHA-derived multi-site steer naming the sibling file:line sites (django-11138 class). Default-OFF ⇒ byte-identical.",
  knobDescribe:
    "append a concrete sibling-override steer from whole-repo CHA when a localized Python method has peer overrides",
  readSite: "runner/knobs/knobs/cha-multisite-steer.ts",
  surfaces: BENCH,
  source: "jun-24 django-11138 multisite override miss",
  parse: parseChaMultisiteSteer,
}

/* ── cha-multisite-general (QUANTA_BENCH_CHA_MULTISITE_GENERAL) ────────────── */
const parseChaMultisiteGeneral = (raw: string | undefined): boolean | undefined => {
  if (raw === undefined) return undefined
  const normalized = raw.trim().toLowerCase()
  if (CHA_ENABLING.has(normalized)) return true
  if (CHA_DISABLING.has(normalized)) return false
  return undefined
}
export const chaMultisiteGeneralSchema: KnobSchema<boolean> = {
  id: "cha-multisite-general",
  envKey: "QUANTA_BENCH_CHA_MULTISITE_GENERAL",
  kind: "bool",
  category: "tool",
  default: false,
  describe:
    "Bench (jun-25): generalize the CHA contract-fallback sibling rule from the legacy django/db/backends PATH HARDCODE to a structural parallel-sibling rule (same dir-root + same leaf filename, shared ancestor). Strict superset of the django match — byte-identical for django targets, additive elsewhere. Only meaningful with cha-multisite-steer. Default-OFF ⇒ byte-identical.",
  knobDescribe:
    "generalize the CHA contract-fallback sibling rule from the django path hardcode to a structural parallel-sibling rule (superset; byte-identical for django)",
  readSite: "runner/knobs/knobs/cha-multisite-general.ts",
  surfaces: BENCH,
  source: "jun-25 cha-multisite path-hardcode generalization",
  parse: parseChaMultisiteGeneral,
}

/* ── paired-control (QUANTA_BENCH_PAIRED_CONTROL) ─────────────────────────── */
const parsePairedControl = (raw: string | undefined): true | undefined => {
  if (raw === undefined) return undefined
  return ENABLING_TRUTHY.has(raw.trim().toLowerCase()) ? true : undefined
}
export const pairedControlSchema: KnobSchema<boolean> = {
  id: "paired-control",
  envKey: "QUANTA_BENCH_PAIRED_CONTROL",
  kind: "bool",
  category: "tool",
  default: false,
  describe:
    "Bench (gap-G2): require paired control tests to pass on base before admitting a reproducing symptom sample. Prevents false-red symptom admissions from env/import failures. Default-OFF ⇒ legacy reproduction admission.",
  knobDescribe:
    "G2 paired-control: admit a reproducing self-test only when its paired control tests (happy/edge, same repro-gen, never gold) pass on the base tree — rejects env/import-broken false-reds at the repro admission filter",
  readSite: "runner/knobs/knobs/paired-control.ts",
  surfaces: BENCH,
  source: "jun-24 scaffold SOTA absorption plan (G2)",
  parse: parsePairedControl,
}

/* ── model-lane-diversity (QUANTA_BENCH_MODEL_LANE_DIVERSITY) ──────────────── */
const parseModelLaneDiversity = (raw: string | undefined): true | undefined => {
  if (raw === undefined) return undefined
  return ENABLING_TRUTHY.has(raw.trim().toLowerCase()) ? true : undefined
}
export const modelLaneDiversitySchema: KnobSchema<boolean> = {
  id: "model-lane-diversity",
  envKey: "QUANTA_BENCH_MODEL_LANE_DIVERSITY",
  kind: "bool",
  category: "tool",
  default: false,
  describe:
    "Bench (G1, jun-24 cross-vendor diversity): route verify-select candidate i to vendor lane (i mod V) over the injected provider-distinct LLM lanes (deps.llmLanes, built from existing createLLM adapters — no new transport), decorrelating the candidate set so the selector picks across vendors/families instead of N correlated samples of one model. lane = index mod laneCount (pure structure, no answer-key). Default-OFF (unset OR ≤1 lane ⇒ every candidate on deps.llm, byte-identical).",
  knobDescribe:
    "G1 model-lane-diversity: route verify-select candidate i to vendor lane (i mod V) over the injected provider-distinct LLM lanes, decorrelating the candidate set so the selector picks across vendors/families instead of N copies of one model (occupies the dual-provider generate seam; NOOP-apply, effect via benchPostureFromState)",
  readSite: "runner/knobs/knobs/model-lane-diversity.ts",
  surfaces: BENCH,
  source: "jun-24 scaffold SOTA absorption plan (G1 cross-vendor diversity)",
  parse: parseModelLaneDiversity,
}

/* ── closure-repair (QUANTA_BENCH_CLOSURE_REPAIR) ─────────────────────────── */
const parseClosureRepair = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined
  const s = raw.trim()
  if (s === "") return undefined
  if (!/^-?\d+$/.test(s)) return undefined
  const n = Number(s)
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined
  if (n < 1 || n > 10) return undefined
  return n
}
export const closureRepairSchema: KnobSchema<number> = {
  id: "closure-repair",
  envKey: "QUANTA_BENCH_CLOSURE_REPAIR",
  kind: "int",
  domain: { range: [1, 10] },
  default: undefined,
  describe:
    "Bench: closure-driven repair budget (max repair rounds N in [1,10]). Preset-level executor for the closure bundle verify gate. Default-OFF ⇒ byte-identical single-pass.",
  knobDescribe: "Repair-round budget for the closure gate's verify-first path (max N rounds)",
  readSite: "runner/knobs/knobs/closure-repair.ts",
  surfaces: BENCH,
  costMultiplier: 10,
  unit: "rounds",
  source: "closure-driven runner (jun-18) — the execution half of T-302",
  parse: parseClosureRepair,
}

/* ── repair-breadth (QUANTA_BENCH_REPAIR_BREADTH) ─────────────────────────── */
const parseRepairBreadth = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined
  const s = raw.trim()
  if (s === "") return undefined
  if (!/^-?\d+$/.test(s)) return undefined
  const n = Number(s)
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined
  if (n < 1 || n > 8) return undefined
  return n
}
export const repairBreadthSchema: KnobSchema<number> = {
  id: "repair-breadth",
  envKey: "QUANTA_BENCH_REPAIR_BREADTH",
  kind: "int",
  domain: { range: [1, 8] },
  // Default-OFF fence: like closure-repair/verify-select the registry Knob carries
  // NO default, so unset ⇒ INACTIVE and the posture projects `?? 1`. B=1 is the
  // legacy single-candidate path (no fork, no extra validate) ⇒ byte-identical.
  default: undefined,
  describe:
    "Bench (jun-28 repair-loop BREADTH): oracle-SELECTED best-of-N inside the repair loop. With B in [2,8], a repair round generates B INDEPENDENT candidates on B forked sandboxes (lane i = i mod laneCount when model-lane-diversity + ≥2 lanes are configured, else the same model with independent sampling), validates EACH against the SAME repro/primary-rail validator, and CONTINUES from the candidate the validator turns GREEN (the oracle as SELECTOR). None green ⇒ keep the best by validator signal (resolved > reproduced > other > exec_failed) to seed the next round. The cumulative diff of the selected candidate is handed to the grader EXACTLY ONCE (no-leak: selection uses ONLY the agent-side validator, never gold). COST ≈ B× patch-gen per round — that is why it is opt-in. Needs closure-repair (a repair budget) to engage. Default 1 ⇒ single candidate (byte-identical).",
  knobDescribe:
    "repair-loop BREADTH: generate B diverse candidates per repair round on B forked sandboxes (model lanes when configured), keep the one the validated-red repro/primary-rail oracle turns GREEN (else best validator signal). Needs closure-repair; default 1 ⇒ byte-identical single candidate; B candidates ⇒ ~B× patch-gen cost",
  readSite: "runner/batch/eval/knobs-bench.ts",
  surfaces: BENCH,
  costMultiplier: 8,
  unit: "candidates",
  source:
    "jun-28 repair-loop BREADTH (oracle-selected diverse candidates; synthesis over-narrow-patch lever)",
  parse: parseRepairBreadth,
}

/* ── patch-budget (QUANTA_BENCH_PATCH_BUDGET) ─────────────────────────────── */
const parsePatchBudget = (raw: string | undefined): boolean | undefined => {
  if (raw === undefined) return undefined
  const s = raw.trim().toLowerCase()
  if (s === "" || s === "0" || s === "off" || s === "false") return undefined
  return true
}
export const patchBudgetSchema: KnobSchema<boolean> = {
  id: "patch-budget",
  envKey: "QUANTA_BENCH_PATCH_BUDGET",
  kind: "bool",
  default: false,
  describe:
    "Bench: minimal-edit PatchBudget telemetry over the final diff (#13417 over-engineer class). Default-OFF ⇒ byte-identical; observe-first.",
  knobDescribe:
    "Minimal-edit admission: emit PatchBudget over the diff (#13417 over-engineer class)",
  readSite: "runner/knobs/knobs/patch-budget.ts",
  surfaces: BENCH,
  source: "jun-19 minimal-patch admission (Agentless 3-phase / mini-SWE thin scaffold)",
  parse: parsePatchBudget,
}

/* ── patch-budget-strict (QUANTA_BENCH_PATCH_BUDGET_STRICT) ────────────────── */
const parsePatchBudgetStrict = (raw: string | undefined): true | undefined => {
  if (raw === undefined) return undefined
  return raw === "1" || raw === "on" || raw === "true" ? true : undefined
}
export const patchBudgetStrictSchema: KnobSchema<boolean> = {
  id: "patch-budget-strict",
  envKey: "QUANTA_BENCH_PATCH_BUDGET_STRICT",
  kind: "bool",
  default: false,
  describe:
    "Bench: hard minimal-edit admission. Blocks over-budget final patches from official submission; use only in strict SOTA++ arms.",
  knobDescribe: "Hard minimal-edit admission: block over-budget final patches from submission",
  readSite: "runner/knobs/knobs/patch-budget-strict.ts",
  surfaces: BENCH,
  source: "jun-20 SOTA++ strict minimal-edit admission",
  parse: parsePatchBudgetStrict,
}

/* ── adversarial-repro (QUANTA_BENCH_ADVERSARIAL_REPRO) ────────────────────── */
const parseAdversarialRepro = (raw: string | undefined): boolean | undefined => {
  if (raw === undefined) return undefined
  const s = raw.trim().toLowerCase()
  if (s === "" || s === "0" || s === "off" || s === "false") return undefined
  return true
}
export const adversarialReproSchema: KnobSchema<boolean> = {
  id: "adversarial-repro",
  envKey: "QUANTA_BENCH_ADVERSARIAL_REPRO",
  kind: "bool",
  category: "tool",
  default: false,
  describe:
    "Bench: adversarial repro coverage block in repro generation (boundary/must-reject/no-copy-suggested-fix). Default-OFF ⇒ byte-identical repro prompt.",
  knobDescribe:
    "ALSO generate an advisory HARDENING repro set (boundary/must-reject/no-copy-suggested-fix) for tie-break/repair — NEVER the submit gate (jun-23 canonical/hardening split; #10999 under-fix class)",
  readSite: "runner/knobs/knobs/adversarial-repro.ts",
  surfaces: BENCH,
  source:
    "jun-19 repro-quality domino (10999 RCA); jun-23 split: advisory hardening, submit gate stays canonical (75% gold-FN fix)",
  parse: parseAdversarialRepro,
}

/* ── verify-select (QUANTA_BENCH_VERIFY_SELECT) ───────────────────────────── */
const parseVerifySelect = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined
  const s = raw.trim()
  if (s === "") return undefined
  if (!/^-?\d+$/.test(s)) return undefined
  const n = Number(s)
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined
  if (n < 1 || n > 8) return undefined
  return n
}
export const verifySelectSchema: KnobSchema<number> = {
  id: "verify-select",
  envKey: "QUANTA_BENCH_VERIFY_SELECT",
  kind: "int",
  domain: { range: [1, 8] },
  default: undefined,
  describe:
    "Bench: verify-and-select outer plane — generate N candidate patches, score via VerificationBundle, submit best. Domain N in [1,8]. Default-OFF ⇒ single-pass.",
  knobDescribe:
    "Verify-and-select: generate N candidates, score via VerificationBundle, submit the best",
  readSite: "runner/knobs/knobs/verify-select.ts",
  surfaces: BENCH,
  costMultiplier: 8,
  unit: "candidates",
  source: "verify-and-select Phase 1 (jun-19) — TD selection executor",
  parse: parseVerifySelect,
}

/* ── localize-budget (QUANTA_BENCH_LOCALIZE_BUDGET) ───────────────────────── */
interface LocalizeBudgetValue {
  readonly topK?: number
  readonly maxTreeChars?: number
  readonly maxFiles?: number
  readonly chaMultisiteFiles?: number
}
const LOCALIZE_BUDGET_FIELD = {
  topk: { key: "topK", min: 1, max: 50 },
  tree: { key: "maxTreeChars", min: 1_000, max: 200_000 },
  files: { key: "maxFiles", min: 100, max: 50_000 },
  chafiles: { key: "chaMultisiteFiles", min: 1, max: 50 },
} as const
const parseLocalizeBudget = (raw: string | undefined): LocalizeBudgetValue | undefined => {
  if (raw === undefined) return undefined
  const out: {
    topK?: number
    maxTreeChars?: number
    maxFiles?: number
    chaMultisiteFiles?: number
  } = {}
  for (const part of raw.split(",")) {
    const [name, val] = part.split("=").map((x) => x.trim())
    const spec =
      name !== undefined
        ? LOCALIZE_BUDGET_FIELD[name as keyof typeof LOCALIZE_BUDGET_FIELD]
        : undefined
    if (spec === undefined || val === undefined || !/^\d+$/.test(val)) return undefined
    const n = Number(val)
    if (!Number.isInteger(n) || n < spec.min || n > spec.max) return undefined
    out[spec.key] = n
  }
  return Object.keys(out).length === 0 ? undefined : out
}
export const localizeBudgetSchema: KnobSchema<LocalizeBudgetValue> = {
  id: "localize-budget",
  envKey: "QUANTA_BENCH_LOCALIZE_BUDGET",
  kind: "string",
  category: "hint",
  default: undefined,
  describe:
    "Bench: agentless one-shot localizer breadth `topk=N,tree=N,files=N` (defaults 5/12000/3000). Unset ⇒ defaults (byte-identical). Distinct from localize-phase (agent turns).",
  knobDescribe:
    "Bench: agentless one-shot localizer breadth — `topk=N,tree=N,files=N,chafiles=N` (defaults 5/12000/3000/3). The most localization-recall-sensitive levers, was un-sweepable.",
  readSite: "runner/knobs/knobs/localize-budget.ts",
  surfaces: BENCH,
  costMultiplier: 1,
  unit: "spec",
  source:
    "jun-22 magic-number config-extraction (agentless-localize DEFAULT_TOP_K/MAX_TREE_CHARS/MAX_FILES)",
  parse: parseLocalizeBudget,
}

/* ── regression-max-tests (QUANTA_BENCH_REGRESSION_MAX_TESTS) ──────────────── */
const parseRegressionMaxTests = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined
  const s = raw.trim()
  if (s === "" || !/^\d+$/.test(s)) return undefined
  const n = Number(s)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 200) return undefined
  return n
}
export const regressionMaxTestsSchema: KnobSchema<number> = {
  id: "regression-max-tests",
  envKey: "QUANTA_BENCH_REGRESSION_MAX_TESTS",
  kind: "int",
  domain: { range: [1, 200] },
  default: undefined,
  describe:
    "Bench: max discovered keep-green regression witnesses executed per candidate. Domain [1,200]. Unset ⇒ 12 (byte-identical).",
  knobDescribe:
    "Bench: max discovered keep-green regression witnesses executed per candidate (default 12). Domain [1,200]. Raise for higher regression-gate recall.",
  readSite: "runner/knobs/knobs/regression-max-tests.ts",
  surfaces: BENCH,
  costMultiplier: 1,
  unit: "tests",
  source: "jun-22 magic-number config-extraction (was hardcoded/duplicated DEFAULT_MAX_TESTS=12)",
  parse: parseRegressionMaxTests,
}

/* ── verify-select-concurrency (QUANTA_BENCH_VERIFY_SELECT_CONCURRENCY) ────── */
const parseVerifySelectConcurrency = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined
  const s = raw.trim()
  if (s === "") return undefined
  if (!/^-?\d+$/.test(s)) return undefined
  const n = Number(s)
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined
  if (n < 1 || n > 8) return undefined
  return n
}
export const verifySelectConcurrencySchema: KnobSchema<number> = {
  id: "verify-select-concurrency",
  envKey: "QUANTA_BENCH_VERIFY_SELECT_CONCURRENCY",
  kind: "int",
  domain: { range: [1, 8] },
  default: undefined,
  describe:
    "Bench: max verify-and-select candidates generated concurrently (requires isolated sandboxes). Domain [1,8]. Unset ⇒ sequential (byte-identical).",
  knobDescribe:
    "Verify-and-select: max candidates generated concurrently (requires isolated generate)",
  readSite: "runner/knobs/knobs/verify-select-concurrency.ts",
  surfaces: BENCH,
  costMultiplier: 1,
  unit: "concurrent",
  source: "verify-and-select Phase 1 (jun-19) — bounded-parallel candidate gen",
  parse: parseVerifySelectConcurrency,
}

/* ── verify-select-llm-risk-gate (QUANTA_BENCH_VERIFY_SELECT_LLM_RISK_GATE) ── */
type VerifySelectLlmRiskGateMode = "shadow" | "on"
const parseVerifySelectLlmRiskGate = (
  raw: string | undefined,
): VerifySelectLlmRiskGateMode | undefined => {
  if (raw === undefined) return undefined
  const s = raw.trim().toLowerCase()
  if (s === "") return undefined
  if (s === "shadow") return "shadow"
  if (s === "on" || s === "1" || s === "true") return "on"
  return undefined
}
export const verifySelectLlmRiskGateSchema: KnobSchema<VerifySelectLlmRiskGateMode> = {
  id: "verify-select-llm-risk-gate",
  envKey: "QUANTA_BENCH_VERIFY_SELECT_LLM_RISK_GATE",
  kind: "enum",
  domain: { enum: ["shadow", "on"] },
  default: undefined,
  describe:
    "Bench: optional LLM semantic expansion gate layered on top of the structural verify-select gate. Modes: shadow=telemetry only, on=fail-closed expand.",
  knobDescribe:
    "Verify-and-select semantic expansion gate: shadow telemetry or fail-closed LLM expand",
  readSite: "runner/knobs/knobs/verify-select-llm-risk-gate.ts",
  surfaces: BENCH,
  costMultiplier: 1,
  unit: "mode",
  source: "jun-21 llm semantic selector gate",
  parse: parseVerifySelectLlmRiskGate,
}

// DERIVE GAPS (entries 26–50, EXCLUDED — current deriveInventoryEntry cannot
// reproduce the inventory entry; see the module-doc for the full rationale):
//   - QUANTA_BENCH_LSP_STEER                  (bool kind + inventory default:undefined)
//   - QUANTA_BENCH_LSP_CHEAP                  (bool kind + inventory default:undefined)
//   - QUANTA_BENCH_VERIFY_SELECT_EARLY_ACCEPT (bool kind + inventory default:undefined)
//   - QUANTA_BENCH_VERIFY_SELECT_RISK_GATE    (bool kind + inventory default:undefined)
//   - QUANTA_BENCH_NO_PATCH_FORCE_FRACTION    (kind:"float" — no KnobKind member)
//   - QUANTA_BENCH_MODEL_LANES                (no registry knob/parse to prove parity)
