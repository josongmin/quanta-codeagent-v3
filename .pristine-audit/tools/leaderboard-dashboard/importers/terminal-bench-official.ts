/**
 * TB21-05 — the OFFICIAL Terminal-Bench 2.1 competitor importer.
 *
 * ## What it replaces
 *
 * `rawdata/tb-pertask.md` was a scraped Terminal-Bench **2.0** HuggingFace
 * matrix: per-task pass-rates for six submissions of a DIFFERENT benchmark
 * version, with no provenance beyond a prose header. Rendering it beside 2.1
 * receipts is the data contamination the cutover exists to end, so the file and
 * its parser are deleted rather than relabelled.
 *
 * This module reads the upstream repo's OWN
 * `leaderboard/submissions/<date>-<agent>.json` at a PINNED commit and
 * normalises the global metrics the leaderboard publishes.
 *
 * ## What it deliberately does NOT produce
 *
 * A per-task competitor matrix. The official submission's `trials` field is a
 * flat list of opaque trial UUIDs — there is no task mapping in it — so a
 * per-task external rate cannot be derived without an authoritative Hub/trial
 * import that does not exist yet. The payload therefore records
 * `perTaskAvailable: false` plus the reason, and the dashboard renders `—`. It
 * NEVER carries a 2.0 rate forward and never infers a task outcome from a global
 * metric.
 *
 * ## Trust boundary
 *
 * Everything in a submission file is EXTERNAL text. Two different defences apply
 * and they are not interchangeable:
 *
 *  - TEXT is sanitised (control characters stripped, length-capped) and stored
 *    UN-escaped, because the dashboard's `esc()` is the one HTML boundary and
 *    escaping twice renders `&amp;lt;script&amp;gt;` to the user.
 *  - URLs are SCHEME-CHECKED here, at import, because `esc()` does not neutralise
 *    `javascript:` inside an `href`. A URL that is not `https:` fails closed to
 *    the empty string — no link at all rather than a live hostile one.
 *
 * ## Operationally
 *
 * An explicit, offline refresh tool. It reads local files through injected
 * ports, touches no network, launches no Harbor, and writes exactly one
 * dashboard payload at `--out`. Dashboard startup only ever READS the payload it
 * produced, so serving the page stays network-free and deterministic.
 *
 *   bun run tools/leaderboard-dashboard/importers/terminal-bench-official.ts \
 *     --upstream-ref <40-hex-commit> \
 *     --submissions <dir of leaderboard/submissions/*.json> \
 *     --out tools/leaderboard-dashboard/rawdata/terminal-bench-official.json \
 *     [--dry-run]
 */
/** The dataset the 2.1 leaderboard grades against. Imported from the pinned
 *  dataset module so the comparison and our own runs can never name two
 *  different datasets. */
import { TERMINAL_BENCH_DATASET_REF } from "@/apps/bench/terminal/dataset"

/** The stored payload's schema. A payload without it is refused, so a pre-2.1
 *  competitor file can never be read as a 2.1 one. */
export const OFFICIAL_COMPARISON_SCHEMA_VERSION = "terminal-bench-official/v1"

/** The upstream leaderboard repository the submissions come from. */
export const UPSTREAM_REPO = "harbor-framework/terminal-bench-2-1"

/**
 * Refs that MOVE. A comparison snapshot pinned to one of these is not pinned at
 * all — the numbers on the dashboard would change without the file changing.
 *
 * NOTE on what this table actually owns: the GATE is the 40-hex check below (no
 * branch name is 40 hex, so every token here would be refused with or without
 * this list). What the list owns is the DIAGNOSTIC — an operator who typed
 * `--upstream-ref main` gets "that is a moving ref", not "that is not 40 hex".
 * Its rail asserts the distinct message for exactly that reason; a rail that
 * only asserted "it throws" would have been decorative.
 */
export const MUTABLE_REF_TOKENS: readonly string[] = ["main", "master", "latest", "head"]

/** Upstream commit shape: a full git object name. Nothing shorter is accepted —
 *  an abbreviated sha is ambiguous and a tag is mutable. */
const IMMUTABLE_REF_RE = /^[0-9a-f]{40}$/

/** The pass@k columns the upstream `metrics_schema` publishes. */
export const OFFICIAL_PASS_AT_KS = [2, 3, 4, 5] as const
export type OfficialPassAtK = (typeof OFFICIAL_PASS_AT_KS)[number]

const MAX_TEXT = 200
const MAX_URL = 500

/**
 * Refuse a mutable or malformed upstream ref. Returns the ref so a caller cannot
 * "validate" it and then use an unvalidated copy.
 */
export const assertImmutableUpstreamRef = (raw: unknown): string => {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error(
      "terminal-bench-official: --upstream-ref is required and must be an immutable 40-hex commit",
    )
  }
  const ref = raw.trim()
  if (MUTABLE_REF_TOKENS.includes(ref.toLowerCase())) {
    throw new Error(
      `terminal-bench-official: "${ref}" is a MOVING ref; a committed comparison snapshot ` +
        "requires an immutable 40-hex commit",
    )
  }
  if (!IMMUTABLE_REF_RE.test(ref)) {
    throw new Error(
      `terminal-bench-official: ${JSON.stringify(ref)} is not an immutable 40-hex upstream ` +
        "commit (an abbreviated sha or a tag is not pinned)",
    )
  }
  return ref
}

// ── external-field validation ────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * External free text → storable text. Control characters (including the ones a
 * terminal would interpret) are removed and the result is length-capped; markup
 * is left ALONE so the page's `esc()` stays the single escaping boundary.
 */
export const sanitizeExternalText = (value: unknown, at: string, max = MAX_TEXT): string => {
  if (typeof value !== "string") {
    throw new Error(`terminal-bench-official: ${at} must be a string (got ${typeof value})`)
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  const stripped = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim()
  return stripped.slice(0, max)
}

const optionalText = (value: unknown, at: string, max = MAX_TEXT): string =>
  value === undefined || value === null ? "" : sanitizeExternalText(value, at, max)

/**
 * External URL → storable URL, or `""`.
 *
 * ONLY `https:` survives. This is the check `esc()` cannot do for us: escaping
 * `javascript:alert(1)` leaves it a perfectly functional href.
 */
export const sanitizeExternalUrl = (value: unknown, at: string): string => {
  if (typeof value !== "string") return ""
  const raw = value.trim().slice(0, MAX_URL)
  if (raw === "") return ""
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return ""
  }
  if (parsed.protocol !== "https:") return ""
  // Re-serialise from the parsed URL so the stored string cannot contain
  // anything the parser did not accept as part of a URL.
  return sanitizeExternalText(parsed.toString(), at, MAX_URL)
}

const requiredNumber = (row: Record<string, unknown>, key: string, at: string): number => {
  const value = row[key]
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(
      `terminal-bench-official: ${at}.${key} is required and must be a finite number ` +
        `(got ${JSON.stringify(value)}) — an official metric is never defaulted`,
    )
  }
  return value
}

const optionalNumber = (row: Record<string, unknown>, key: string): number | null => {
  const value = row[key]
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

const displayOf = (value: unknown, at: string): { label: string; url: string } => {
  if (typeof value === "string") return { label: sanitizeExternalText(value, at), url: "" }
  if (!isRecord(value)) return { label: "", url: "" }
  return {
    label: optionalText(value.label, `${at}.label`),
    url: sanitizeExternalUrl(value.url, `${at}.url`),
  }
}

// ── the normalized row ───────────────────────────────────────────────────────

/** ONE upstream submission, normalized. Every field is either a checked value or
 *  an explicit empty/`null` — nothing here is inferred. */
export interface OfficialSubmissionRow {
  /** Stable id = the upstream file name (unique per submission upstream). */
  readonly id: string
  readonly agentLabel: string
  readonly agentOrgLabel: string
  readonly agentUrl: string
  readonly agentVersion: string
  readonly modelLabel: string
  readonly modelName: string
  readonly modelOrgLabel: string
  readonly modelUrl: string
  readonly reasoningEffort: string
  readonly date: string
  readonly displayDate: string
  readonly accuracy: number
  readonly accuracyStderr: number
  readonly displayAccuracy: string
  readonly nTrials: number
  readonly passAtK: Readonly<Record<OfficialPassAtK, number>>
  readonly uncachedInputTokens: number | null
  readonly cachedInputTokens: number | null
  readonly outputTokens: number | null
  readonly totalCostUsd: number | null
  readonly displayTotalCostUsd: string
  readonly avgTrialDurationSec: number | null
  /** The upstream reward-hack metric (percentage points deducted). */
  readonly rewardHacks: number | null
  readonly displayRewardHacks: string
  /** Where the reward-hack judgement is documented upstream. */
  readonly rewardHacksUrl: string
  /** How many trials the upstream judge disqualified. */
  readonly disqualifiedTrials: number
  /** The upstream PR that landed this submission. */
  readonly submissionUrl: string
  readonly sourceFile: string
  readonly sourceUrl: string
}

export interface NormalizeOpts {
  readonly sourceFile: string
  readonly upstreamRef: string
}

const submissionUrlFor = (upstreamRef: string, sourceFile: string): string =>
  `https://github.com/${UPSTREAM_REPO}/blob/${upstreamRef}/leaderboard/submissions/${sourceFile}`

/** One upstream `leaderboard/submissions/*.json` → one normalized row. PURE. */
export const normalizeOfficialSubmission = (
  raw: unknown,
  opts: NormalizeOpts,
): OfficialSubmissionRow => {
  const ref = assertImmutableUpstreamRef(opts.upstreamRef)
  if (!isRecord(raw)) {
    throw new Error(`terminal-bench-official: ${opts.sourceFile} is not a JSON object`)
  }
  const metrics = raw.metrics
  if (!isRecord(metrics)) {
    throw new Error(`terminal-bench-official: ${opts.sourceFile} has no metrics object`)
  }
  const metadata = isRecord(raw.metadata) ? raw.metadata : {}
  const filter = isRecord(raw.source_filter) ? raw.source_filter : {}

  const agent = displayOf(metadata.agent_display, "metadata.agent_display")
  const agentOrg = displayOf(metadata.agent_org, "metadata.agent_org")
  const model = displayOf(metadata.model_display, "metadata.model_display")
  const modelOrg = displayOf(metadata.model_org, "metadata.model_org")
  const pr = displayOf(metadata.pr_url, "metadata.pr_url")
  const hacks = displayOf(metrics.display_reward_hacks, "metrics.display_reward_hacks")

  const passAtK = {} as Record<OfficialPassAtK, number>
  for (const k of OFFICIAL_PASS_AT_KS) {
    passAtK[k] = requiredNumber(metrics, `pass_at_${k}`, "metrics")
  }

  const disqualified = Array.isArray(raw.disqualified_trials) ? raw.disqualified_trials.length : 0

  return {
    id: opts.sourceFile,
    agentLabel: agent.label,
    agentOrgLabel: agentOrg.label,
    agentUrl: agent.url,
    agentVersion: optionalText(filter.agent_version, "source_filter.agent_version"),
    modelLabel: model.label,
    modelName: optionalText(filter.model_name, "source_filter.model_name"),
    modelOrgLabel: modelOrg.label,
    modelUrl: model.url,
    reasoningEffort: optionalText(
      metadata.reasoning_effort ?? filter.reasoning_effort,
      "metadata.reasoning_effort",
    ),
    date: optionalText(metadata.date, "metadata.date"),
    displayDate: optionalText(metadata.display_date, "metadata.display_date"),
    accuracy: requiredNumber(metrics, "accuracy", "metrics"),
    accuracyStderr: requiredNumber(metrics, "accuracy_stderr", "metrics"),
    displayAccuracy: optionalText(metrics.display_accuracy, "metrics.display_accuracy"),
    nTrials: requiredNumber(metrics, "n_trials", "metrics"),
    passAtK,
    uncachedInputTokens: optionalNumber(metrics, "uncached_input_tokens"),
    cachedInputTokens: optionalNumber(metrics, "cached_input_tokens"),
    outputTokens: optionalNumber(metrics, "output_tokens"),
    totalCostUsd: optionalNumber(metrics, "total_cost_usd"),
    displayTotalCostUsd: optionalText(
      metrics.display_total_cost_usd,
      "metrics.display_total_cost_usd",
    ),
    avgTrialDurationSec: optionalNumber(metrics, "avg_trial_duration_sec"),
    rewardHacks: optionalNumber(metrics, "reward_hacks"),
    displayRewardHacks: hacks.label,
    rewardHacksUrl: hacks.url,
    disqualifiedTrials: disqualified,
    submissionUrl: pr.url,
    sourceFile: opts.sourceFile,
    sourceUrl: submissionUrlFor(ref, opts.sourceFile),
  }
}

// ── the stored payload ───────────────────────────────────────────────────────

export interface OfficialComparisonPayload {
  readonly schemaVersion: typeof OFFICIAL_COMPARISON_SCHEMA_VERSION
  readonly upstreamRepo: string
  /** The IMMUTABLE upstream commit the submissions were read at. */
  readonly upstreamRef: string
  readonly upstreamUrl: string
  /** The pinned dataset the submissions were graded against. */
  readonly datasetRef: string
  readonly refreshedAt: string
  readonly submissions: readonly OfficialSubmissionRow[]
  /**
   * FALSE, always, until an authoritative per-trial Hub import exists. Kept as a
   * DATA field rather than an assumption so the dashboard renders `—` for the
   * external per-task column instead of a stale 2.0 number.
   */
  readonly perTaskAvailable: boolean
  readonly perTaskOmittedReason: string
}

const PER_TASK_OMITTED_REASON =
  "the official submission JSON lists trial ids only (no task mapping), so no authoritative " +
  "per-task competitor rate exists at this upstream ref"

export interface BuildComparisonInput {
  readonly upstreamRef: string
  readonly datasetRef: string
  readonly refreshedAt: string
  readonly submissions: readonly OfficialSubmissionRow[]
}

export const buildOfficialComparison = (input: BuildComparisonInput): OfficialComparisonPayload => {
  const upstreamRef = assertImmutableUpstreamRef(input.upstreamRef)
  if (typeof input.datasetRef !== "string" || !input.datasetRef.startsWith("sha256:")) {
    throw new Error(
      "terminal-bench-official: a comparison payload requires the pinned sha256 dataset ref",
    )
  }
  return {
    schemaVersion: OFFICIAL_COMPARISON_SCHEMA_VERSION,
    upstreamRepo: UPSTREAM_REPO,
    upstreamRef,
    upstreamUrl: `https://github.com/${UPSTREAM_REPO}/tree/${upstreamRef}/leaderboard/submissions`,
    datasetRef: input.datasetRef,
    refreshedAt: input.refreshedAt,
    // Deterministic order so a re-run produces byte-identical bytes.
    submissions: [...input.submissions].sort((a, b) => a.sourceFile.localeCompare(b.sourceFile)),
    perTaskAvailable: false,
    perTaskOmittedReason: PER_TASK_OMITTED_REASON,
  }
}

/**
 * THE read boundary for the stored payload. Fails CLOSED to `null`: a wrong
 * version, a mutable ref, or a malformed body means the dashboard shows no
 * competitor column at all, never a half-trusted one.
 */
export const decodeOfficialComparison = (raw: unknown): OfficialComparisonPayload | null => {
  if (!isRecord(raw)) return null
  if (raw.schemaVersion !== OFFICIAL_COMPARISON_SCHEMA_VERSION) return null
  if (!Array.isArray(raw.submissions)) return null
  try {
    const upstreamRef = assertImmutableUpstreamRef(raw.upstreamRef)
    const submissions = raw.submissions.map((row, index) => {
      if (!isRecord(row)) throw new Error(`submissions[${index}] is not an object`)
      const passAtKRaw = isRecord(row.passAtK) ? row.passAtK : {}
      const passAtK = {} as Record<OfficialPassAtK, number>
      for (const k of OFFICIAL_PASS_AT_KS) {
        passAtK[k] = requiredNumber(passAtKRaw, String(k), `submissions[${index}].passAtK`)
      }
      return {
        id: sanitizeExternalText(row.id, `submissions[${index}].id`),
        agentLabel: optionalText(row.agentLabel, "agentLabel"),
        agentOrgLabel: optionalText(row.agentOrgLabel, "agentOrgLabel"),
        agentUrl: sanitizeExternalUrl(row.agentUrl, "agentUrl"),
        agentVersion: optionalText(row.agentVersion, "agentVersion"),
        modelLabel: optionalText(row.modelLabel, "modelLabel"),
        modelName: optionalText(row.modelName, "modelName"),
        modelOrgLabel: optionalText(row.modelOrgLabel, "modelOrgLabel"),
        modelUrl: sanitizeExternalUrl(row.modelUrl, "modelUrl"),
        reasoningEffort: optionalText(row.reasoningEffort, "reasoningEffort"),
        date: optionalText(row.date, "date"),
        displayDate: optionalText(row.displayDate, "displayDate"),
        accuracy: requiredNumber(row, "accuracy", `submissions[${index}]`),
        accuracyStderr: requiredNumber(row, "accuracyStderr", `submissions[${index}]`),
        displayAccuracy: optionalText(row.displayAccuracy, "displayAccuracy"),
        nTrials: requiredNumber(row, "nTrials", `submissions[${index}]`),
        passAtK,
        uncachedInputTokens: optionalNumber(row, "uncachedInputTokens"),
        cachedInputTokens: optionalNumber(row, "cachedInputTokens"),
        outputTokens: optionalNumber(row, "outputTokens"),
        totalCostUsd: optionalNumber(row, "totalCostUsd"),
        displayTotalCostUsd: optionalText(row.displayTotalCostUsd, "displayTotalCostUsd"),
        avgTrialDurationSec: optionalNumber(row, "avgTrialDurationSec"),
        rewardHacks: optionalNumber(row, "rewardHacks"),
        displayRewardHacks: optionalText(row.displayRewardHacks, "displayRewardHacks"),
        rewardHacksUrl: sanitizeExternalUrl(row.rewardHacksUrl, "rewardHacksUrl"),
        disqualifiedTrials: optionalNumber(row, "disqualifiedTrials") ?? 0,
        submissionUrl: sanitizeExternalUrl(row.submissionUrl, "submissionUrl"),
        sourceFile: optionalText(row.sourceFile, "sourceFile"),
        sourceUrl: sanitizeExternalUrl(row.sourceUrl, "sourceUrl"),
      } satisfies OfficialSubmissionRow
    })
    return {
      schemaVersion: OFFICIAL_COMPARISON_SCHEMA_VERSION,
      upstreamRepo: optionalText(raw.upstreamRepo, "upstreamRepo"),
      upstreamRef,
      upstreamUrl: sanitizeExternalUrl(raw.upstreamUrl, "upstreamUrl"),
      datasetRef: sanitizeExternalText(raw.datasetRef, "datasetRef"),
      refreshedAt: optionalText(raw.refreshedAt, "refreshedAt", 64),
      submissions,
      perTaskAvailable: raw.perTaskAvailable === true,
      perTaskOmittedReason: optionalText(raw.perTaskOmittedReason, "perTaskOmittedReason", 500),
    }
  } catch {
    return null
  }
}

// ── the offline refresh CLI ──────────────────────────────────────────────────

/** Every effect the refresh performs, injected. There is deliberately no network
 *  port and no process-spawn port: the tool cannot reach either. */
export interface OfficialImportPorts {
  readonly listDir: (dir: string) => readonly string[]
  readonly readText: (file: string) => string
  readonly writeText: (file: string, text: string) => void
  readonly write: (line: string) => void
  readonly now: () => string
}

const argOf = (argv: readonly string[], flag: string): string | undefined => {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}

const USAGE = [
  "usage: terminal-bench-official --upstream-ref <40-hex-commit> --submissions <dir> --out <file> [--dry-run]",
  "  an OFFLINE refresh: reads local submission JSON only, never the network, never Harbor.",
].join("\n")

/**
 * Run the refresh. Returns a process exit code; every effect goes through
 * {@link OfficialImportPorts}, so a test observes exactly what it did.
 */
export const runOfficialImport = (argv: readonly string[], ports: OfficialImportPorts): number => {
  const dryRun = argv.includes("--dry-run")
  const submissionsDir = argOf(argv, "--submissions")
  const out = argOf(argv, "--out")
  let upstreamRef: string
  try {
    // Refused BEFORE anything is read or written.
    upstreamRef = assertImmutableUpstreamRef(argOf(argv, "--upstream-ref"))
  } catch (error) {
    ports.write(error instanceof Error ? error.message : String(error))
    ports.write(USAGE)
    return 2
  }
  if (submissionsDir === undefined || out === undefined) {
    ports.write("terminal-bench-official: --submissions and --out are required")
    ports.write(USAGE)
    return 2
  }

  const files = [...ports.listDir(submissionsDir)]
    .filter((name) => name.endsWith(".json"))
    .sort((a, b) => a.localeCompare(b))
  const submissions: OfficialSubmissionRow[] = []
  for (const name of files) {
    const text = ports.readText(`${submissionsDir}/${name}`)
    submissions.push(
      normalizeOfficialSubmission(JSON.parse(text) as unknown, { sourceFile: name, upstreamRef }),
    )
  }

  const payload = buildOfficialComparison({
    upstreamRef,
    datasetRef: TERMINAL_BENCH_DATASET_REF,
    refreshedAt: ports.now(),
    submissions,
  })
  const json = `${JSON.stringify(payload, null, 2)}\n`

  ports.write(
    `terminal-bench-official: ${submissions.length} submission(s) at ${UPSTREAM_REPO}@${upstreamRef}`,
  )
  for (const row of payload.submissions) {
    ports.write(`  ${row.sourceFile} — ${row.agentLabel} / ${row.modelLabel} — ${row.accuracy}%`)
  }
  if (dryRun) {
    ports.write(`--dry-run: would write ${json.length} bytes to ${out}`)
    return 0
  }
  ports.writeText(out, json)
  ports.write(`wrote ${out}`)
  return 0
}

/* c8 ignore start — the composition root; every behaviour above is port-injected. */
if (import.meta.main) {
  const { readdirSync, readFileSync, writeFileSync } = await import("node:fs")
  process.exit(
    runOfficialImport(process.argv.slice(2), {
      listDir: (dir) => readdirSync(dir),
      readText: (file) => readFileSync(file, "utf8"),
      writeText: (file, text) => writeFileSync(file, text),
      write: (line) => process.stdout.write(`${line}\n`),
      now: () => new Date().toISOString(),
    }),
  )
}
/* c8 ignore stop */
