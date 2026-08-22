/**
 * TB21-03 — the ONE typed Terminal-Bench run manifest.
 *
 * The manifest is the single channel through which a run's identity reaches the
 * canonical report: TB21-04's `buildTerminalRunReport` consumes `datasetRef`,
 * `timestamp`, `arm`, `k`, `harborJobIds`, `sourcePaths`, `model` and `preset`
 * from it and copies the whole object onto the report. So every rail in this
 * module exists to make one specific lie IMPOSSIBLE to express:
 *
 *  - `datasetFamily` on a Terminal manifest — a SWE axis on a suite that has
 *    none. Refused by SHAPE (it is not in the interface) and at RUNTIME.
 *  - a dataset shorthand (`terminal-bench`, `terminal-bench-2`, `latest`) — an
 *    identity that cannot be reconciled with an upstream submission.
 *  - a promotable run with a dirty tree or a nonstandard budget — the backlog's
 *    "a dirty run may be used for development but is not promotable".
 *  - an unregistered knob, or a terminal-local best-of-N under Harbor's `-k`.
 *
 * Provenance derivation (`agentVersion`, the pinned harbor version) lives here
 * too, because provenance IS the manifest's job; the git/file reads themselves
 * are injected by the command layer so this module stays pure.
 */
import type { TerminalRunManifestSection } from "@/runner/batch/report-terminal"
import {
  assertKnobsRegistered,
  assertNoTerminalBestOfN,
  isTerminalProfile,
  type KnobValue,
  type ReasoningEffortRecord,
  TERMINAL_PROVIDERS,
  TERMINAL_SANDBOXES,
  type TerminalProfile,
  type TerminalProvider,
  type TerminalRunConfig,
  type TerminalSandbox,
  type TerminalTaskSelection,
  type TerminalUploadPosture,
} from "./config"
import { MIN_TRIALS_PER_TASK, TERMINAL_BENCH_DATASET, TERMINAL_BENCH_DATASET_REF } from "./dataset"

export const TERMINAL_RUN_SCHEMA_VERSION = "terminal-bench-run/v2"

/** The env var the Python agent adapter reads for provenance
 *  (`parse_agent_version`). Declared HERE, beside the version it names, because
 *  provenance is this module's job; the delivery layer re-exports it. */
export const AGENT_VERSION_ENV = "QUANTA_TB_AGENT_VERSION"

/**
 * `<package-version>+g<sha>[.dirty]`.
 *
 * This is NOT an independently-chosen shape: it is the adapter's own
 * `AGENT_VERSION_RE` (`adapters/terminal-bench/quanta_agent.py`) with the named
 * groups stripped, and `manifest.test.ts` reads that file's bytes and compares
 * the two sources character for character. The Python half is fail-closed on it,
 * so a divergence here would be discovered as a crashed trial on a paid run.
 */
export const AGENT_VERSION_RE = /^([0-9]+(?:\.[0-9]+)*)\+g([0-9a-f]{7,40})(\.dirty)?$/

export interface RepoProvenance {
  /** `package.json` `version`. */
  readonly packageVersion: string
  /** `git rev-parse --short=12 HEAD` — 7–40 lowercase hex. */
  readonly sha: string
  /** `git status --porcelain` is non-empty. */
  readonly dirty: boolean
}

/** Format the injected `QUANTA_TB_AGENT_VERSION`. `.dirty` is REQUIRED iff the
 *  tree is dirty and FORBIDDEN when it is clean — that suffix is the only thing
 *  stopping a development run from presenting itself as the clean SHA. */
export const formatAgentVersion = (p: RepoProvenance): string =>
  `${p.packageVersion}+g${p.sha}${p.dirty ? ".dirty" : ""}`

/** Throw unless `raw` is a well-formed agent version (the adapter's contract). */
export const assertAgentVersion = (raw: string): void => {
  if (!AGENT_VERSION_RE.test(raw)) {
    throw new Error(
      `terminal manifest: agent version ${JSON.stringify(raw)} is malformed. Expected ` +
        "'<package-version>+g<sha>' with 7-40 lowercase hex and an optional '.dirty' suffix — " +
        "the adapter (adapters/terminal-bench/quanta_agent.py) refuses anything else BEFORE the " +
        "first model call, so a malformed version is a crashed paid trial.",
    )
  }
}

/** `harbor==X.Y.Z` out of the adapter's `pyproject.toml`. A range, a VCS URL or
 *  a missing requirement is REFUSED: the backlog forbids a floating dependency
 *  as promotable evidence, and a manifest that reported "harbor: main" would be
 *  unreproducible by construction. */
export const readPinnedHarborVersion = (pyprojectText: string): string => {
  const m = /"harbor==(\d+\.\d+\.\d+)"/.exec(pyprojectText)
  if (m?.[1] === undefined) {
    throw new Error(
      "terminal manifest: adapters/terminal-bench/pyproject.toml does not pin harbor exactly " +
        '(expected a `"harbor==X.Y.Z"` requirement). A range or VCS dependency resolves to ' +
        "whatever upstream main is today and can never be promotable evidence.",
    )
  }
  return m[1]
}

// ── the manifest ─────────────────────────────────────────────────────────────

/**
 * EXTENDS {@link TerminalRunManifestSection} — the provenance core the canonical
 * report validates at its read boundary. The `extends` is the compile-time link
 * between the manifest this module builds and the manifest a report carries: a
 * field renamed on either side stops satisfying it, so the hand-off cannot rot
 * into two shapes that merely look alike.
 */
export interface TerminalBenchRunManifest extends TerminalRunManifestSection {
  readonly schemaVersion: typeof TERMINAL_RUN_SCHEMA_VERSION
  readonly benchmarkVersion: "2.1"
  readonly dataset: typeof TERMINAL_BENCH_DATASET
  readonly profile: TerminalProfile
  readonly model: string
  readonly provider: TerminalProvider
  /** The effort the provider ACTUALLY receives — never the requested string. */
  readonly reasoningEffort: string
  /** The full decision, so a receipt can show what was asked for as well. */
  readonly reasoningEffortDecision: ReasoningEffortRecord
  readonly sandbox: TerminalSandbox
  readonly k: number
  readonly concurrency: number
  readonly timeoutMultiplier: 1
  readonly agentTimeoutOverride: null
  readonly verifierTimeoutOverride: null
  readonly resourceOverrides: null
  readonly taskSelection: "full" | TerminalTaskSelection
  readonly resolvedKnobs: Readonly<Record<string, KnobValue>>
  // ── the TB21-04 hand-off ───────────────────────────────────────────────────
  readonly timestamp: string
  /** Experiment arm == profile. Baseline and lever runs never union. */
  readonly arm: TerminalProfile
  readonly preset: string
  readonly harborJobIds: readonly string[]
  readonly sourcePaths: readonly string[]
  // ── promotion posture ──────────────────────────────────────────────────────
  readonly promotable: boolean
  readonly promotionBlockers: readonly string[]
  readonly upload: TerminalUploadPosture
}

const presetLabel = (profile: TerminalProfile): string => `terminal-bench-2.1/${profile}`

const computePromotionBlockers = (
  cfg: TerminalRunConfig,
  provenance: RepoProvenance,
): readonly string[] => {
  const blockers: string[] = []
  if (provenance.dirty) blockers.push("dirty-worktree")
  if (cfg.taskSelection !== "full")
    blockers.push(`partial-task-selection:${cfg.taskSelection.purpose}`)
  if (cfg.k < MIN_TRIALS_PER_TASK) blockers.push(`k-below-minimum:${cfg.k}`)
  return blockers
}

/** Build the manifest from the ONE resolved config plus the provenance the
 *  command layer read. Pure. */
export const buildTerminalRunManifest = (input: {
  readonly cfg: TerminalRunConfig
  readonly provenance: RepoProvenance
  readonly harborVersion: string
  readonly timestamp: string
  readonly harborJobIds?: readonly string[]
  readonly sourcePaths?: readonly string[]
}): TerminalBenchRunManifest => {
  const { cfg, provenance } = input
  const agentVersion = formatAgentVersion(provenance)
  assertAgentVersion(agentVersion)

  const blockers = computePromotionBlockers(cfg, provenance)
  if (cfg.promote && blockers.length > 0) {
    throw new Error(
      `terminal manifest: --promote requested but this run is NOT promotable (${blockers.join(", ")}). ` +
        "A dirty or partial run may be used for development; it may never be presented as the " +
        "clean-SHA submission.",
    )
  }
  if (cfg.effort.delivered === null) {
    throw new Error(
      "terminal manifest: no reasoning effort will reach the provider, so none may be reported. " +
        "Refusing to stamp a leaderboard row with an effort the provider never received.",
    )
  }

  return {
    schemaVersion: TERMINAL_RUN_SCHEMA_VERSION,
    benchmarkSuite: "terminal-bench",
    benchmarkVersion: "2.1",
    dataset: TERMINAL_BENCH_DATASET,
    datasetRef: TERMINAL_BENCH_DATASET_REF,
    harborVersion: input.harborVersion,
    quantaSha: provenance.sha,
    dirty: provenance.dirty,
    agentVersion,
    profile: cfg.profile,
    model: cfg.model,
    provider: cfg.provider,
    reasoningEffort: cfg.effort.delivered,
    reasoningEffortDecision: cfg.effort,
    sandbox: cfg.sandbox,
    k: cfg.k,
    concurrency: cfg.concurrency,
    timeoutMultiplier: 1,
    agentTimeoutOverride: null,
    verifierTimeoutOverride: null,
    resourceOverrides: null,
    taskSelection: cfg.taskSelection,
    resolvedKnobs: cfg.resolvedKnobs,
    timestamp: input.timestamp,
    arm: cfg.profile,
    preset: presetLabel(cfg.profile),
    harborJobIds: input.harborJobIds ?? [],
    sourcePaths: input.sourcePaths ?? [],
    promotable: cfg.promote && blockers.length === 0,
    promotionBlockers: blockers,
    upload: cfg.upload,
  }
}

// ── the decode boundary ──────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

const str = (v: unknown, field: string): string => {
  if (typeof v !== "string" || v.trim() === "") {
    throw new Error(`terminal manifest: ${field} must be a non-empty string`)
  }
  return v
}

const posInt = (v: unknown, field: string): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    throw new Error(`terminal manifest: ${field} must be a positive integer`)
  }
  return v
}

const strList = (v: unknown, field: string): readonly string[] => {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new Error(`terminal manifest: ${field} must be an array of strings`)
  }
  return v as readonly string[]
}

const decodeTaskSelection = (v: unknown): "full" | TerminalTaskSelection => {
  if (v === "full") return "full"
  if (!isRecord(v) || (v.purpose !== "oracle" && v.purpose !== "canary")) {
    throw new Error(
      'terminal manifest: taskSelection must be "full" or { ids, purpose: oracle|canary }',
    )
  }
  return { ids: strList(v.ids, "taskSelection.ids"), purpose: v.purpose }
}

const decodeKnobs = (v: unknown): Readonly<Record<string, KnobValue>> => {
  if (!isRecord(v)) throw new Error("terminal manifest: resolvedKnobs must be an object")
  const out: Record<string, KnobValue> = {}
  for (const [key, value] of Object.entries(v)) {
    if (typeof value !== "boolean" && typeof value !== "number" && typeof value !== "string") {
      throw new Error(
        `terminal manifest: resolvedKnobs.${key} must be a scalar (got ${typeof value})`,
      )
    }
    out[key] = value
  }
  // Order is load-bearing — see the note in `config.ts` (the retired knob would
  // otherwise be reported as merely "unregistered").
  assertNoTerminalBestOfN(out, "the manifest's resolvedKnobs")
  assertKnobsRegistered(out, "the manifest's resolvedKnobs")
  return out
}

const decodeEffortDecision = (v: unknown): ReasoningEffortRecord => {
  if (!isRecord(v)) throw new Error("terminal manifest: reasoningEffortDecision must be an object")
  const kind = v.kind
  if (kind !== "absent" && kind !== "delivered" && kind !== "rejected" && kind !== "unsupported") {
    throw new Error(`terminal manifest: unknown reasoning-effort decision kind ${String(kind)}`)
  }
  if (kind === "rejected" || kind === "unsupported") {
    throw new Error(
      `terminal manifest: the recorded reasoning effort was ${kind} by the provider surface — a ` +
        "run may not report an effort the provider never received.",
    )
  }
  const delivered = v.delivered
  if (delivered !== null && typeof delivered !== "string") {
    throw new Error("terminal manifest: reasoningEffortDecision.delivered must be a string or null")
  }
  return { requested: str(v.requested, "reasoningEffortDecision.requested"), delivered, kind }
}

const decodeUpload = (v: unknown): TerminalUploadPosture => {
  if (!isRecord(v) || typeof v.enabled !== "boolean") {
    throw new Error("terminal manifest: upload must be { enabled, visibility }")
  }
  const visibility = v.visibility
  if (visibility !== null && visibility !== "public" && visibility !== "private") {
    throw new Error("terminal manifest: upload.visibility must be public | private | null")
  }
  if (v.enabled && visibility === null) {
    throw new Error(
      "terminal manifest: an enabled upload with no visibility posture — visibility is never inferred",
    )
  }
  return { enabled: v.enabled, visibility }
}

/** The versioned identity block. Split out of the validator so the decode
 *  boundary stays readable and each refusal keeps its own message. */
const assertTerminalIdentity = (raw: Record<string, unknown>): void => {
  // The category error first, with the loudest message.
  if ("datasetFamily" in raw) {
    throw new Error(
      "terminal manifest: datasetFamily is FORBIDDEN on a Terminal-Bench manifest. Dataset family " +
        "is a SWE-only axis (verified | live | pro | promax); Terminal-Bench is selected by " +
        "benchmarkSuite. REFUSING the malformed identity rather than ignoring the extra key.",
    )
  }
  if (raw.schemaVersion !== TERMINAL_RUN_SCHEMA_VERSION) {
    throw new Error(
      `terminal manifest: schemaVersion must be ${TERMINAL_RUN_SCHEMA_VERSION} (got ${String(raw.schemaVersion)})`,
    )
  }
  if (raw.benchmarkSuite !== "terminal-bench") {
    throw new Error(`terminal manifest: benchmarkSuite must be "terminal-bench"`)
  }
  if (raw.benchmarkVersion !== "2.1") {
    throw new Error(`terminal manifest: benchmarkVersion must be "2.1"`)
  }
  if (raw.dataset !== TERMINAL_BENCH_DATASET) {
    throw new Error(
      `terminal manifest: dataset must be the canonical ${TERMINAL_BENCH_DATASET} (got ` +
        `${JSON.stringify(raw.dataset)}). A shorthand like "terminal-bench", "terminal-bench-2" ` +
        'or "latest" names no revision and can never be reconciled with an upstream submission.',
    )
  }
  if (raw.datasetRef !== TERMINAL_BENCH_DATASET_REF) {
    throw new Error(
      `terminal manifest: datasetRef must be the pinned ${TERMINAL_BENCH_DATASET_REF} (got ` +
        `${JSON.stringify(raw.datasetRef)}) — identity is never inferred and "latest" is not a ref.`,
    )
  }
}

/** The closed vocabularies: profile / arm / provider / sandbox. */
const assertTerminalVocabularies = (raw: Record<string, unknown>): void => {
  if (!isTerminalProfile(raw.profile)) {
    throw new Error(`terminal manifest: unknown profile ${JSON.stringify(raw.profile)}`)
  }
  if (raw.arm !== raw.profile) {
    throw new Error("terminal manifest: arm must equal profile (arms are never merged)")
  }
  if (!(TERMINAL_PROVIDERS as readonly string[]).includes(raw.provider as string)) {
    throw new Error(`terminal manifest: unknown provider ${JSON.stringify(raw.provider)}`)
  }
  if (!(TERMINAL_SANDBOXES as readonly string[]).includes(raw.sandbox as string)) {
    throw new Error(`terminal manifest: unknown sandbox ${JSON.stringify(raw.sandbox)}`)
  }
}

/** Standard budgets + the promotion posture. A nonstandard budget is not a
 *  degradation to report — it is a refusal, because such a run is not
 *  comparable with an official row. */
const assertStandardBudgetsAndPromotion = (raw: Record<string, unknown>): readonly string[] => {
  if (raw.timeoutMultiplier !== 1) {
    throw new Error(
      `terminal manifest: timeoutMultiplier must be exactly 1 (got ${String(raw.timeoutMultiplier)}). ` +
        "A stretched timeout is a NONSTANDARD run and is not comparable with an official row.",
    )
  }
  for (const field of [
    "agentTimeoutOverride",
    "verifierTimeoutOverride",
    "resourceOverrides",
  ] as const) {
    if (raw[field] !== null) {
      throw new Error(
        `terminal manifest: ${field} must be null (got ${JSON.stringify(raw[field])}). A resource or ` +
          "timeout override makes the run nonstandard and therefore not promotable.",
      )
    }
  }
  if (typeof raw.dirty !== "boolean") throw new Error("terminal manifest: dirty must be a boolean")
  if (typeof raw.promotable !== "boolean") {
    throw new Error("terminal manifest: promotable must be a boolean")
  }
  const promotionBlockers = strList(raw.promotionBlockers, "promotionBlockers")
  if (raw.promotable && (raw.dirty || promotionBlockers.length > 0)) {
    throw new Error(
      `terminal manifest: promotable is true but the run carries blockers ` +
        `(${[...(raw.dirty ? ["dirty-worktree"] : []), ...promotionBlockers].join(", ")}).`,
    )
  }
  return promotionBlockers
}

/**
 * Validate a serialized manifest into the typed shape. This is the decode
 * boundary a report reader / dashboard uses; it never CASTS and never infers an
 * identity from a neighbouring field.
 */
export const validateTerminalRunManifest = (raw: unknown): TerminalBenchRunManifest => {
  if (!isRecord(raw)) throw new Error("terminal manifest: must be an object")
  assertTerminalIdentity(raw)
  assertTerminalVocabularies(raw)
  const promotionBlockers = assertStandardBudgetsAndPromotion(raw)
  if (!isTerminalProfile(raw.profile)) throw new Error("terminal manifest: unknown profile")

  const agentVersion = str(raw.agentVersion, "agentVersion")
  assertAgentVersion(agentVersion)
  const versionSaysDirty = AGENT_VERSION_RE.exec(agentVersion)?.[3] !== undefined
  if (versionSaysDirty !== raw.dirty) {
    throw new Error(
      "terminal manifest: the agentVersion '.dirty' suffix disagrees with the recorded dirty " +
        "state — that suffix is what stops a development run presenting as the clean SHA.",
    )
  }

  const effortDecision = decodeEffortDecision(raw.reasoningEffortDecision)
  const reasoningEffort = str(raw.reasoningEffort, "reasoningEffort")
  if (effortDecision.delivered !== reasoningEffort) {
    throw new Error(
      "terminal manifest: reasoningEffort does not match the effort actually delivered to the " +
        "provider. The reported effort is the DELIVERED one, never the requested string.",
    )
  }

  return {
    schemaVersion: TERMINAL_RUN_SCHEMA_VERSION,
    benchmarkSuite: "terminal-bench",
    benchmarkVersion: "2.1",
    dataset: TERMINAL_BENCH_DATASET,
    datasetRef: TERMINAL_BENCH_DATASET_REF,
    harborVersion: str(raw.harborVersion, "harborVersion"),
    quantaSha: str(raw.quantaSha, "quantaSha"),
    dirty: raw.dirty,
    agentVersion,
    profile: raw.profile,
    model: str(raw.model, "model"),
    provider: raw.provider as TerminalProvider,
    reasoningEffort,
    reasoningEffortDecision: effortDecision,
    sandbox: raw.sandbox as TerminalSandbox,
    k: posInt(raw.k, "k"),
    concurrency: posInt(raw.concurrency, "concurrency"),
    timeoutMultiplier: 1,
    agentTimeoutOverride: null,
    verifierTimeoutOverride: null,
    resourceOverrides: null,
    taskSelection: decodeTaskSelection(raw.taskSelection),
    resolvedKnobs: decodeKnobs(raw.resolvedKnobs),
    timestamp: str(raw.timestamp, "timestamp"),
    arm: raw.profile,
    preset: str(raw.preset, "preset"),
    harborJobIds: strList(raw.harborJobIds, "harborJobIds"),
    sourcePaths: strList(raw.sourcePaths, "sourcePaths"),
    promotable: raw.promotable === true,
    promotionBlockers,
    upload: decodeUpload(raw.upload),
  }
}
