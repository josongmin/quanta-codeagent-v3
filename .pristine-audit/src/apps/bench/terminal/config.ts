/**
 * TB21-03 — the ONE typed Terminal-Bench run config, resolved EXACTLY ONCE at
 * the bench composition root (`commands/terminal.ts`).
 *
 * ── What this module replaces ────────────────────────────────────────────────
 *
 * Terminal-Bench 2.0 was driven by `tools/tb-smoke/*.sh`: knobs were `export`ed
 * into the ambient shell, harbor argv was assembled by string concatenation, and
 * the report's `knobs.preset` was free text. Two measurement lies follow
 * structurally from that shape:
 *
 *   1. a stale `export QUANTA_TB_VERIFY_GATE=1` silently joins a "baseline" arm;
 *   2. nothing reconciles the recorded preset with what the brain received.
 *
 * The repair is ownership: argv + the PROFILE decide every knob value, the
 * ambient env decides NONE of them, and the resolved table is what both the
 * manifest and the `--ae` delivery are built from. Lower layers may read the env
 * OBJECT they are handed; nothing below this module re-reads `process.env` to
 * override a decision made here.
 *
 * ── What this module does NOT own ────────────────────────────────────────────
 *
 *  - the suite discriminator — imported from BFND-01 (`../benchmark-suite`);
 *  - the dataset identity — imported from TB21-04 (`./dataset`);
 *  - the knob VALUE vocabulary — imported from the existing knob registries
 *    (`@/config/knob-inventory` + `@/shared/runtime-config-knobs`). This module
 *    SELECTS and RECORDS registered knobs; it is not a second env schema, and an
 *    unregistered key is a validation error rather than a new knob;
 *  - reasoning-effort deliverability — imported from `@/llm`, which pins the
 *    accepted set to the vendored provider SDK.
 *
 * `datasetFamily` is a SWE-only axis and cannot appear anywhere in this file.
 */
import { allInventoryKnobs } from "@/config/knob-inventory"
import {
  decideReasoningEffort,
  describeReasoningEffortDecision,
  isReasoningEffortHonest,
  type ReasoningEffortSurface,
} from "@/llm"
import { isFalsyToken, isTruthyToken } from "@/shared"
import { allRuntimeConfigKnobs } from "@/shared/runtime-config-knobs"
import { type BenchRunConfig, resolveBenchmarkRunConfig } from "../benchmark-suite"
import { readDatasetFamilySelector } from "../run-config"
import { canaryTaskIds } from "./canary"
import { MIN_TRIALS_PER_TASK } from "./dataset"

// ── closed vocabularies ──────────────────────────────────────────────────────

/** The two INDEPENDENTLY SCORED arms. `control` is the explicit comparison arm;
 *  the backlog forbids ever unioning them into one number. */
export const TERMINAL_PROFILES = ["control", "quanta-full"] as const
export type TerminalProfile = (typeof TERMINAL_PROFILES)[number]
export const isTerminalProfile = (raw: unknown): raw is TerminalProfile =>
  typeof raw === "string" && (TERMINAL_PROFILES as readonly string[]).includes(raw)

/** Provider identities we can honestly claim on a leaderboard row. Each maps to
 *  exactly one reasoning-effort SURFACE, so effort deliverability is decided
 *  against the real wire rather than against a label. */
export const TERMINAL_PROVIDERS = ["openai", "chatgpt-oauth", "anthropic"] as const
export type TerminalProvider = (typeof TERMINAL_PROVIDERS)[number]

/** EXHAUSTIVE map — a new provider is a COMPILE error here, not a silent
 *  fall-through to the openai surface (which would let an undeliverable effort
 *  through the honesty gate). */
const PROVIDER_EFFORT_SURFACE: Record<TerminalProvider, ReasoningEffortSurface> = {
  openai: "openai-responses",
  "chatgpt-oauth": "chatgpt-oauth",
  anthropic: "anthropic-messages",
}

/** Harbor `-e/--env` environment types we can actually doctor. Deliberately a
 *  SUBSET of harbor's enum: claiming support for a backend whose availability we
 *  cannot check would make the doctor's "selected sandbox availability" check a
 *  decoration. */
export const TERMINAL_SANDBOXES = ["docker", "daytona", "modal"] as const
export type TerminalSandbox = (typeof TERMINAL_SANDBOXES)[number]

export type KnobValue = boolean | number | string

/** The terminal-local best-of-N knob. It is runtime-dead (retirement SR-6) and
 *  Harbor owns trials through `-k`; a second sampling layer would silently
 *  multiply cost and destroy the pass@k denominator. */
export const TERMINAL_BEST_OF_N_KNOB = "QUANTA_TB_BEST_OF_N"

// ── the profile tables ───────────────────────────────────────────────────────

/**
 * Both profiles declare the SAME key set — an OFF knob is RECORDED as `false`/
 * `0`, never omitted. "Absent" and "explicitly off" look identical in a report
 * that only lists what was on, and that ambiguity is exactly what made the 2.0
 * reports unauditable.
 *
 * Every key here is proven to reach the brain by `config.test.ts`, which feeds
 * the delivered env to the brain's OWN resolvers (`gateOn`,
 * `resolveOracleLoopRounds`, `resolveTrajectoryOn`, `resolveMaxTurnsFromEnv`,
 * `resolveStreamCap`). The ticket's stop rule is enforced there: a knob that
 * cannot be observed flipping the brain does not belong in a profile label.
 */
const SHARED_BASE = {
  // Lever #1 is a BASE CAPABILITY for this benchmark, not a lever: Terminal-Bench
  // tasks are install/build tasks, and the frozen SWE `R-ENV` install prohibition
  // made the brain refuse them outright (jul-02 box measurement: 0/5 → 4/5 on the
  // install-refusal set). Both arms therefore carry it, so `control` remains a
  // real comparison rather than a study of whether the agent may use `apt`.
  QUANTA_TB_ENV_OWNED: true,
  // DEFAULT-ON in the knob inventory; recorded explicitly so a report never has
  // to guess which default was in force.
  QUANTA_TB_TRAJECTORY: true,
  QUANTA_TB_STREAM_CAP: 8192,
} as const satisfies Readonly<Record<string, KnobValue>>

export const TERMINAL_PROFILE_KNOBS: Readonly<
  Record<TerminalProfile, Readonly<Record<string, KnobValue>>>
> = {
  control: {
    ...SHARED_BASE,
    QUANTA_TB_VERIFY_GATE: false,
    QUANTA_TB_OUTPUT_CONTRACT: false,
    QUANTA_TB_SELF_TEST: false,
    QUANTA_TB_ORACLE_LOOP: 0,
    QUANTA_TB_WRITE_TOOL: false,
    QUANTA_MAX_TURNS: 30,
  },
  "quanta-full": {
    ...SHARED_BASE,
    QUANTA_TB_VERIFY_GATE: true,
    QUANTA_TB_OUTPUT_CONTRACT: true,
    QUANTA_TB_SELF_TEST: true,
    QUANTA_TB_ORACLE_LOOP: 2,
    QUANTA_TB_WRITE_TOOL: true,
    QUANTA_MAX_TURNS: 60,
  },
}

// ── the knob registries are the VALUE AUTHORITY (RU-7) ───────────────────────

const KNOB_KINDS: ReadonlyMap<string, string> = new Map<string, string>([
  ...allInventoryKnobs().map((k) => [k.envKey, k.kind] as const),
  ...allRuntimeConfigKnobs().map((k) => [k.envKey, k.kind] as const),
])

/** Every knob key the existing registries declare. This module NEVER adds a
 *  knob; it selects from here, so an unregistered key is a validation error. */
export const REGISTERED_KNOB_KEYS: ReadonlySet<string> = new Set(KNOB_KINDS.keys())

/** Encode a resolved knob value for the env wire. Booleans use the canonical
 *  gate vocabulary (`1`/`0`), which every `gateOn` reader accepts. */
export const encodeKnobValue = (value: KnobValue): string =>
  typeof value === "boolean" ? (value ? "1" : "0") : String(value)

const coerceKnobValue = (key: string, raw: string): KnobValue => {
  const kind = KNOB_KINDS.get(key)
  if (kind === undefined) {
    throw new Error(
      `terminal: "${key}" is an UNREGISTERED knob — the existing knob inventory / runtime-config ` +
        "registry is the value authority, and Terminal-Bench does not mint a second env schema. " +
        "Register it there (with a real readSite) before selecting it in a profile.",
    )
  }
  if (kind === "bool") {
    if (isTruthyToken(raw)) return true
    if (isFalsyToken(raw)) return false
    throw new Error(`terminal: ${key}=${JSON.stringify(raw)} is not a boolean knob value`)
  }
  if (kind === "int") {
    const n = Number(raw)
    if (!Number.isInteger(n))
      throw new Error(`terminal: ${key}=${JSON.stringify(raw)} is not an integer`)
    return n
  }
  if (kind === "float") {
    const n = Number(raw)
    if (!Number.isFinite(n))
      throw new Error(`terminal: ${key}=${JSON.stringify(raw)} is not a number`)
    return n
  }
  return raw
}

/** Refuse a knob table that would put a SECOND sampling layer under Harbor's
 *  `-k`. Exported so the manifest validator enforces the same rule on a decoded
 *  manifest, not just on a freshly-resolved config. */
export const assertNoTerminalBestOfN = (
  knobs: Readonly<Record<string, KnobValue>>,
  where: string,
): void => {
  const raw = knobs[TERMINAL_BEST_OF_N_KNOB]
  if (raw === undefined) return
  const enabled =
    typeof raw === "number" ? raw > 1 : typeof raw === "boolean" ? raw : Number(raw) > 1
  if (!enabled) return
  throw new Error(
    `terminal: ${TERMINAL_BEST_OF_N_KNOB} is enabled in ${where}, but Harbor owns benchmark ` +
      "trials through `-k` and the quanta brain stays ONE clean attempt. A terminal-local " +
      "best-of-N under a Harbor k is a second sampling layer: it multiplies cost and makes the " +
      "pass@k denominator meaningless. Remove the knob (retirement SR-6).",
  )
}

/** Refuse any key the registries do not declare. */
export const assertKnobsRegistered = (
  knobs: Readonly<Record<string, KnobValue>>,
  where: string,
): void => {
  const orphans = Object.keys(knobs).filter((k) => !REGISTERED_KNOB_KEYS.has(k))
  if (orphans.length > 0) {
    throw new Error(
      `terminal: ${where} carries unregistered knob(s) ${orphans.join(", ")} — every knob must be ` +
        "declared in the existing inventory / runtime-config registry.",
    )
  }
}

// ── pure argv reading (no ambient process.argv, no ambient process.env) ───────

/**
 * Read a value flag in BOTH `--flag value` and `--flag=value` forms.
 *
 * LAST occurrence wins. That is deliberate and differs from the generic
 * `argValue` (which takes the first): these flags are composed — a package alias
 * or a wrapper supplies a base argv and the operator appends an override on the
 * command line. First-wins would silently discard the override the operator
 * typed, which for `--model` / `--effort` is a mis-attributed paid run.
 *
 * A flag with no value (last token, or followed by another flag) THROWS rather
 * than reading back as absent — a typed-but-valueless selector must never
 * silently become the default.
 */
const flagValue = (argv: readonly string[], flag: string): string | undefined => {
  const pref = `${flag}=`
  let found: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]
    if (tok === flag) {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith("-")) {
        throw new Error(`terminal: ${flag} requires a value`)
      }
      found = next
      i++
      continue
    }
    if (tok?.startsWith(pref) === true) found = tok.slice(pref.length)
  }
  return found
}

const flagValues = (argv: readonly string[], flag: string): readonly string[] => {
  const out: string[] = []
  const pref = `${flag}=`
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]
    if (tok === flag) {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith("-")) {
        throw new Error(`terminal: ${flag} requires a value`)
      }
      out.push(next)
      i++
      continue
    }
    if (tok?.startsWith(pref) === true) out.push(tok.slice(pref.length))
  }
  return out
}

const hasFlagIn = (argv: readonly string[], flag: string): boolean => argv.includes(flag)

const requiredFlag = (argv: readonly string[], flag: string, why: string): string => {
  const v = flagValue(argv, flag)
  if (v === undefined || v.trim() === "") {
    throw new Error(
      `terminal: ${flag} is REQUIRED for a paid Terminal-Bench run (${why}). A run that cannot ` +
        "name its own configuration cannot be reconciled with a leaderboard row.",
    )
  }
  return v.trim()
}

const positiveInt = (raw: string | undefined, flag: string, fallback: number): number => {
  if (raw === undefined) return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`terminal: ${flag} must be a positive integer (got ${JSON.stringify(raw)})`)
  }
  return n
}

// ── the resolved config ──────────────────────────────────────────────────────

export interface ReasoningEffortRecord {
  /** What the operator asked for, verbatim. */
  readonly requested: string
  /** What the provider will actually receive; `null` when nothing is sent. */
  readonly delivered: string | null
  /** The `@/llm` decision arm. Only `delivered` / `absent` may start a paid run. */
  readonly kind: "absent" | "delivered" | "rejected" | "unsupported"
}

export interface TerminalTaskSelection {
  readonly ids: readonly string[]
  readonly purpose: "oracle" | "canary"
}

export interface TerminalUploadPosture {
  readonly enabled: boolean
  readonly visibility: "public" | "private" | null
}

export interface TerminalRunConfig {
  /** The BFND-01 branch, resolved ONCE. Carries no `datasetFamily` by shape. */
  readonly suite: BenchRunConfig
  readonly profile: TerminalProfile
  readonly model: string
  readonly provider: TerminalProvider
  readonly effort: ReasoningEffortRecord
  readonly sandbox: TerminalSandbox
  readonly k: number
  readonly concurrency: number
  readonly taskSelection: "full" | TerminalTaskSelection
  readonly outputRoot: string
  readonly upload: TerminalUploadPosture
  /** Clean-SHA promotion mode. A dirty tree makes this FAIL, never downgrade. */
  readonly promote: boolean
  readonly dryRun: boolean
  readonly resolvedKnobs: Readonly<Record<string, KnobValue>>
}

const DEFAULT_OUTPUT_ROOT = "harbor-jobs"

const resolveUpload = (argv: readonly string[]): TerminalUploadPosture => {
  const upload = hasFlagIn(argv, "--upload")
  const pub = hasFlagIn(argv, "--public")
  const priv = hasFlagIn(argv, "--private")
  if (pub && priv) {
    throw new Error(
      "terminal: --public and --private are both set; pick one, they are not a ladder",
    )
  }
  if (!upload) {
    if (pub || priv) {
      throw new Error("terminal: --public/--private requires --upload (harbor refuses it too)")
    }
    return { enabled: false, visibility: null }
  }
  if (!pub && !priv) {
    throw new Error(
      "terminal: --upload requires an EXPLICIT --public or --private. Visibility of a benchmark " +
        "run is never inferred: guessing private hides a submission, guessing public publishes a " +
        "trajectory that was not cleared for it.",
    )
  }
  return { enabled: true, visibility: pub ? "public" : "private" }
}

const resolveTaskSelection = (argv: readonly string[]): "full" | TerminalTaskSelection => {
  const raw = flagValue(argv, "--tasks")
  if (raw === undefined) return "full"
  if (raw !== "oracle" && raw !== "canary") {
    throw new Error(
      `terminal: --tasks accepts only "oracle" or "canary" (got ${JSON.stringify(raw)}). A ` +
        "free-form include set produces a partial run that looks like a score; oracle/canary are " +
        "the two revision-bound subsets, and everything else is the full 89-task dataset.",
    )
  }
  return { ids: canaryTaskIds(raw), purpose: raw }
}

const resolveEffort = (
  argv: readonly string[],
  provider: TerminalProvider,
): ReasoningEffortRecord => {
  const requested = requiredFlag(
    argv,
    "--effort",
    "the leaderboard keys a submission on (agent, agent_version, model, reasoning_effort)",
  )
  const decision = decideReasoningEffort(requested, PROVIDER_EFFORT_SURFACE[provider])
  if (!isReasoningEffortHonest(decision)) {
    throw new Error(`terminal: ${describeReasoningEffortDecision(decision)}`)
  }
  return {
    requested,
    delivered: decision.kind === "delivered" ? decision.effort : null,
    kind: decision.kind,
  }
}

const resolveKnobs = (
  profile: TerminalProfile,
  argv: readonly string[],
): Readonly<Record<string, KnobValue>> => {
  const knobs: Record<string, KnobValue> = { ...TERMINAL_PROFILE_KNOBS[profile] }
  for (const override of flagValues(argv, "--knob")) {
    const eq = override.indexOf("=")
    if (eq <= 0) {
      throw new Error(`terminal: --knob expects KEY=VALUE (got ${JSON.stringify(override)})`)
    }
    const key = override.slice(0, eq)
    knobs[key] = coerceKnobValue(key, override.slice(eq + 1))
  }
  assertKnobsRegistered(knobs, "the resolved profile")
  assertNoTerminalBestOfN(knobs, "the resolved profile")
  return knobs
}

/**
 * The `--dataset-family` refusal, callable on its own.
 *
 * `resolveTerminalRunConfig` performs the same check as part of resolving the
 * suite branch, but the nested command dispatcher needs it BEFORE it knows which
 * action was asked for: a SWE-only axis on `terminal canary` is the same
 * category error as on `terminal run`, and it must not be reported as "unknown
 * action". Both call sites route through the ONE BFND-01 resolver, so there is
 * a single owner of the rule.
 */
export const assertNoSweDatasetFamilySelector = (
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): void => {
  resolveBenchmarkRunConfig({
    subcommand: "terminal",
    argvFamily: readDatasetFamilySelector(argv),
    env,
  })
}

/**
 * Resolve the ONE typed Terminal-Bench run config.
 *
 * `env` is a PARAMETER, never `process.env`: the ambient environment is consulted
 * for exactly two things — the SWE family selector (so it can be REFUSED) and an
 * enabled `QUANTA_TB_BEST_OF_N` (so it can be REFUSED). It never supplies a
 * value, so an operator's stale export cannot join an arm.
 */
export const resolveTerminalRunConfig = (input: {
  readonly argv: readonly string[]
  readonly env: NodeJS.ProcessEnv
}): TerminalRunConfig => {
  const { argv, env } = input

  // BFND-01 — the suite branch, resolved once. This is also the ONE place a
  // `--dataset-family` selector (argv OR env) is refused for Terminal-Bench.
  const suite = resolveBenchmarkRunConfig({
    subcommand: "terminal",
    argvFamily: readDatasetFamilySelector(argv),
    env,
  })

  // The ambient best-of-N knob is a REFUSAL input, not a value input.
  const ambientBestOfN = env[TERMINAL_BEST_OF_N_KNOB]
  if (ambientBestOfN !== undefined) {
    assertNoTerminalBestOfN(
      { [TERMINAL_BEST_OF_N_KNOB]: coerceKnobValue(TERMINAL_BEST_OF_N_KNOB, ambientBestOfN) },
      "the ambient environment",
    )
  }

  const profileRaw = requiredFlag(
    argv,
    "--profile",
    "control and product arms are scored separately",
  )
  if (!isTerminalProfile(profileRaw)) {
    throw new Error(
      `terminal: unknown terminal profile ${JSON.stringify(profileRaw)}; expected one of ` +
        `${TERMINAL_PROFILES.join(", ")}.`,
    )
  }

  const providerRaw = flagValue(argv, "--provider") ?? "openai"
  if (!(TERMINAL_PROVIDERS as readonly string[]).includes(providerRaw)) {
    throw new Error(
      `terminal: unknown provider ${JSON.stringify(providerRaw)}; expected one of ` +
        `${TERMINAL_PROVIDERS.join(", ")}.`,
    )
  }
  const provider = providerRaw as TerminalProvider

  const sandboxRaw = flagValue(argv, "--sandbox") ?? "docker"
  if (!(TERMINAL_SANDBOXES as readonly string[]).includes(sandboxRaw)) {
    throw new Error(
      `terminal: unknown sandbox ${JSON.stringify(sandboxRaw)}; expected one of ` +
        `${TERMINAL_SANDBOXES.join(", ")}.`,
    )
  }

  return {
    suite,
    profile: profileRaw,
    model: requiredFlag(argv, "--model", "a run that cannot name its model cannot be attributed"),
    provider,
    effort: resolveEffort(argv, provider),
    sandbox: sandboxRaw as TerminalSandbox,
    k: positiveInt(flagValue(argv, "--k"), "--k", MIN_TRIALS_PER_TASK),
    concurrency: positiveInt(flagValue(argv, "--concurrency"), "--concurrency", 1),
    taskSelection: resolveTaskSelection(argv),
    outputRoot: flagValue(argv, "--out") ?? DEFAULT_OUTPUT_ROOT,
    upload: resolveUpload(argv),
    promote: hasFlagIn(argv, "--promote"),
    dryRun: hasFlagIn(argv, "--dry-run"),
    resolvedKnobs: resolveKnobs(profileRaw, argv),
  }
}
