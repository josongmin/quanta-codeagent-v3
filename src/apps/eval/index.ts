#!/usr/bin/env bun

/**
 * `bun run eval <subcommand>` — Tier 0–5 verification harness.
 *
 * Subcommands:
 *   audit                          Tier 0 static coverage matrix
 *   synthetic [--usecase ID] [--all]   Tier 1 LLM-judged scenario runs
 *   grounding run [--mode raw|engine|assisted] [--suite canary|nightly|--corpus ...]
 *                                             Tier 2 structured grounding probe
 *   grounding compare/regress               Tier 2 run-to-run delta + regression gate
 *   public swebench-verified [--report PATH]   Tier 3 wraps bench-report
 *   trajectory classify --input DIR   Tier 4 label real sessions
 *   compare --scenario ID --usecase ID --agents quanta,claude-code   Tier 5 (stub)
 *   report                         render aggregate matrix to stdout
 *   classify "<text>"              ad-hoc one-off taxonomy classifier
 *
 * Provider selection mirrors `bun run bench`:
 *   QUANTA_PROVIDER=anthropic|openai (default: whichever key is set)
 *   QUANTA_MODEL / QUANTA_JUDGE_MODEL  override per role
 *
 * Exits 0 in all "no work to do / missing key" paths so a CI matrix entry that
 * has no API key configured does not break the build — it prints guidance.
 *
 * ── WHY `console.*` IS THE RIGHT SINK HERE (biome `suspicious/noConsole`) ────
 *
 * The repo-wide rule is `noConsole: "error"`, and `biome.json` carries an
 * override lowering it to `warn` for exactly this path. That override is
 * load-bearing, not a grandfathered leak, and this is its rationale:
 *
 *   1. This file is the eval CLI's COMPOSITION ROOT — the `#!/usr/bin/env bun`
 *      entrypoint that owns the process. `src/shared/terminal-io.ts` states the
 *      contract: "Non-app modules MUST NOT reach for `process.stdout` /
 *      `process.stderr` directly. The app/composition root registers the real
 *      terminal sinks." This file IS that root: it calls `setTerminalIo` with
 *      the real streams a few lines below. Terminal ownership is its job.
 *
 *   2. Human-readable stdout IS the product. `eval grounding report`,
 *      `compare`, `regress` and `report` emit markdown/JSON on stdout for a
 *      human or a pipe to consume; routing that through the structured
 *      `logger` would wrap the artifact in log envelopes and destroy it.
 *
 *   3. The stdout/stderr SPLIT is deliberate and must survive: the artifact
 *      goes to stdout (`console.log`), while headlines, usage errors,
 *      validation failures and gate verdicts go to stderr (`console.error`) —
 *      see every `console.log(out.markdown)` / `console.error(out.headline)`
 *      pair below. That is what makes `bun run eval ... > report.md` yield a
 *      clean report while diagnostics still reach the operator.
 *
 * Every `console.*` call in this file is one of those two categories: an
 * stdout artifact or an stderr diagnostic. NONE is a debug leftover. The single
 * non-console sink is `logger.error("eval: fatal", …)` at the bottom, which is
 * correct: an unhandled crash is an observability event, not CLI output.
 *
 * If you add a `console.*` here, it must fall in one of those two categories —
 * anything else (progress spam, debug traces) belongs in `logger`, or in the
 * library module that owns the work, which is NOT covered by this override.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { DEFAULT_MODEL, type LLMPort, type Provider, pickProvider, tryCreateLLM } from "@/llm"
import { errMessage, logger, setTerminalIo } from "@/shared"
import { runAudit } from "./audit"
import { isKnownAdapter, KNOWN_ADAPTERS, runCompare } from "./compare"
import {
  buildGroundingComparison,
  buildGroundingGateResult,
  buildGroundingRegressionResult,
  buildGroundingReport,
  buildGroundingRouteMatrixGateResult,
  GROUNDING_BUCKETS,
  GROUNDING_CORPORA,
  GROUNDING_GATE_PROFILES,
  GROUNDING_MODES,
  GROUNDING_REGRESSION_PROFILES,
  GROUNDING_SEVERITIES,
  isGroundingGateProfile,
  isGroundingRegressionProfile,
  isGroundingRouteMatrixName,
  readGroundingReplayDraft,
  resolveGroundingBaseline,
  runGrounding,
  runGroundingPreflightCheck,
  writeGroundingReplayDraft,
  writePromotedGroundingReplayCase,
} from "./grounding"
import { GROUNDING_AMBIGUITY_CLASSES } from "./grounding/schema"
import { runSwebenchAdapter } from "./public"
import { buildReport } from "./report"
import { ResultStore } from "./storage"
import { generateScenarios, runSynthetic } from "./synthetic"
import { classifyQuery } from "./taxonomy"
import { classifyTrajectories, freezeFixture, replayFixture } from "./trajectory"
import type { UseCaseId } from "./types"

setTerminalIo({
  stdout: (chunk) => {
    void process.stdout.write(chunk)
  },
  stderr: (chunk) => {
    void process.stderr.write(chunk)
  },
  stdoutIsTTY: process.stdout.isTTY,
  stderrIsTTY: process.stderr.isTTY,
})

// ── argv helpers ─────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)

const argValue = (flag: string): string | undefined => {
  const i = argv.indexOf(flag)
  if (i < 0 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}

const writeTextFile = (path: string, text: string): void => {
  const out = resolve(process.cwd(), path)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, text)
}

const readJsonFile = (path: string): unknown =>
  JSON.parse(readFileSync(resolve(process.cwd(), path), "utf8"))

const csvValues = (raw: string | undefined): readonly string[] | undefined => {
  if (raw === undefined) return undefined
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "")
  return values.length === 0 ? undefined : values
}

// ── tiny dotenv (no dep, first-wins; mirrors apps/bench) ─────────────────────

const unquote = (v: string): string =>
  (v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))
    ? v.slice(1, -1)
    : v

/** One `KEY=value` assignment from a dotenv file, or `null` for a line that
 *  carries none (blank, comment, or missing `=`).
 *
 *  A unit because "what counts as an assignment" is the whole of this dialect:
 *  the blank/comment skip, the optional `export ` prefix, and the quote
 *  stripping are one grammar, and `loadEnv` above only decides first-wins. */
const parseEnvLine = (raw: string): { key: string; value: string } | null => {
  let line = raw.trim()
  if (line === "" || line.startsWith("#")) return null
  if (line.startsWith("export ")) line = line.slice("export ".length).trimStart()
  const eq = line.indexOf("=")
  if (eq <= 0) return null
  return { key: line.slice(0, eq).trim(), value: unquote(line.slice(eq + 1).trim()) }
}

const loadEnv = (files: readonly string[]): void => {
  for (const f of files) {
    const p = resolve(process.cwd(), f)
    if (!existsSync(p)) continue
    for (const raw of readFileSync(p, "utf8").split("\n")) {
      const entry = parseEnvLine(raw)
      if (entry === null) continue
      if (process.env[entry.key] === undefined) process.env[entry.key] = entry.value
    }
  }
}

loadEnv([".env", ".env.local", ".env.dev"])

// ── provider pick + LLM construction (delegated to the shared @/llm factory) ──
// Provider precedence, per-provider key env vars, OPENAI_BASE_URL, and the
// canonical DEFAULT_MODEL all live in `@/llm` (OCP/DIP). `process.env` is the
// composition-root env view handed to the factory.

const resolveLLM = (
  role: "agent" | "judge" | "classifier",
): { llm: LLMPort; provider: Provider; model: string } | null => {
  const provider = pickProvider(process.env)
  const envKey =
    role === "judge"
      ? "QUANTA_JUDGE_MODEL"
      : role === "classifier"
        ? "QUANTA_CLASSIFIER_MODEL"
        : "QUANTA_MODEL"
  // `--model` > per-role model env > canonical DEFAULT_MODEL[provider] (the
  // factory fills the default when `model` is omitted).
  const modelArg = argValue("--model") ?? process.env[envKey]
  const llm = tryCreateLLM(provider, modelArg !== undefined ? { model: modelArg } : {}, process.env)
  if (llm === null) {
    console.error(`eval/${role}: ${provider.toUpperCase()}_API_KEY not set — skip ${role} step`)
    return null
  }
  const model = modelArg ?? DEFAULT_MODEL[provider]
  return { llm, provider, model }
}

// ── subcommands ──────────────────────────────────────────────────────────────

const cmdAudit = async (): Promise<number> => {
  const result = await runAudit()
  const matrix = result.matrix
  console.log(
    `audit run=${result.runId} leaves=${matrix.totals.total} ok=${matrix.totals.counts.ok} partial=${matrix.totals.counts.partial} no=${matrix.totals.counts.no} tbd=${matrix.totals.counts.tbd} (${result.durationMs}ms)`,
  )
  return 0
}

const cmdSynthetic = async (): Promise<number> => {
  const agent = resolveLLM("agent")
  if (agent === null) return 0
  const judge = resolveLLM("judge") ?? agent
  const usecase = argValue("--usecase") as UseCaseId | undefined
  const summary = await runSynthetic({
    agent: agent.llm,
    judge: judge.llm,
    ...(usecase !== undefined ? { usecase } : {}),
  })
  console.log(
    `synthetic run=${summary.runId} total=${summary.total} pass=${summary.counts.pass} partial=${summary.counts.partial} fail=${summary.counts.fail} err=${summary.counts.error} (${summary.durationMs}ms)`,
  )
  return 0
}

type LoadGroundingReport = (runId: string) => ReturnType<typeof buildGroundingReport>

/** A validated CLI flag: the value, or the message to print before exiting 1. */
type FlagParse<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string }

/** The closed-set selectors of `eval grounding run` — which fixtures to load
 *  and which probe shape to run them under. */
interface GroundingSelectors {
  readonly suite?: "canary" | "nightly"
  readonly corpus?: (typeof GROUNDING_CORPORA)[number]
  readonly mode?: (typeof GROUNDING_MODES)[number]
}

/**
 * Validate `--suite` / `--corpus` / `--mode` against their closed sets.
 *
 * A unit because each of the three is only meaningful as a member of its set,
 * and every one reaches {@link runGrounding} through a cast — validating them
 * in one place is what makes those casts true rather than hopeful. Reports the
 * FIRST offending flag, in declaration order, exactly as the inline guards did.
 */
const parseGroundingSelectors = (): FlagParse<GroundingSelectors> => {
  const suite = argValue("--suite")
  const corpus = argValue("--corpus")
  const mode = argValue("--mode")
  if (suite !== undefined && suite !== "canary" && suite !== "nightly")
    return { ok: false, message: "--suite must be canary or nightly" }
  if (
    corpus !== undefined &&
    !GROUNDING_CORPORA.includes(corpus as (typeof GROUNDING_CORPORA)[number])
  )
    return { ok: false, message: `--corpus must be one of ${GROUNDING_CORPORA.join(", ")}` }
  if (mode !== undefined && !GROUNDING_MODES.includes(mode as (typeof GROUNDING_MODES)[number]))
    return { ok: false, message: `--mode must be one of ${GROUNDING_MODES.join(", ")}` }
  return {
    ok: true,
    value: {
      ...(suite !== undefined ? { suite } : {}),
      ...(corpus !== undefined ? { corpus: corpus as (typeof GROUNDING_CORPORA)[number] } : {}),
      ...(mode !== undefined ? { mode: mode as (typeof GROUNDING_MODES)[number] } : {}),
    },
  }
}

/**
 * Read an optional integer flag with a floor, or report it invalid.
 *
 * A unit because `--limit` and `--concurrency` differ only in that floor: one
 * parser stops the two from drifting into subtly different notions of "a valid
 * integer" (NaN, `1.5`, and a negative are rejected for both).
 */
const parseIntFlag = (flag: string, min: number): FlagParse<number | undefined> => {
  const raw = argValue(flag)
  if (raw === undefined) return { ok: true, value: undefined }
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < min)
    return { ok: false, message: `invalid ${flag} ${raw}` }
  return { ok: true, value }
}

const groundingRun = async (storeDir: string | undefined): Promise<number> => {
  const selectors = parseGroundingSelectors()
  if (!selectors.ok) {
    console.error(`eval grounding run: ${selectors.message}`)
    return 1
  }
  // Read once. The spread used to call `argValue("--case")` twice — once to test
  // it, once to use it — and assert the second read non-null, which only holds
  // because the reader is pure. A local makes the guard and the value the same
  // fact instead of two hopefully-agreeing calls.
  const caseId = argValue("--case")
  const limit = parseIntFlag("--limit", 0)
  if (!limit.ok) {
    console.error(`eval grounding run: ${limit.message}`)
    return 1
  }
  const concurrency = parseIntFlag("--concurrency", 1)
  if (!concurrency.ok) {
    console.error(`eval grounding run: ${concurrency.message}`)
    return 1
  }
  const agent = resolveLLM("agent")
  if (agent === null) return 0
  const summary = await runGrounding({
    llm: agent.llm,
    ...selectors.value,
    ...(storeDir !== undefined ? { storeDir } : {}),
    ...(caseId !== undefined ? { caseId } : {}),
    ...(limit.value !== undefined ? { limit: limit.value } : {}),
    ...(concurrency.value !== undefined ? { concurrency: concurrency.value } : {}),
  })
  const jsonOut = argValue("--json-out")
  if (jsonOut !== undefined) writeTextFile(jsonOut, `${JSON.stringify(summary, null, 2)}\n`)
  console.log(
    `grounding run=${summary.runId} corpus=${summary.corpus} mode=${summary.mode} total=${summary.total} pass=${summary.counts.pass} partial=${summary.counts.partial} fail=${summary.counts.fail} err=${summary.counts.error} concurrency=${summary.concurrency} (${summary.durationMs}ms)`,
  )
  return 0
}

const groundingPreflight = async (): Promise<number> => {
  const agent = resolveLLM("agent")
  if (agent === null) return 0
  const out = await runGroundingPreflightCheck(agent.llm)
  const jsonOut = argValue("--json-out")
  const payload = {
    provider: out.provider ?? null,
    model: out.model ?? null,
    surfaceId: out.surfaceId ?? null,
    transportId: out.transportId ?? null,
    authMode: out.authMode ?? null,
    durationMs: out.durationMs,
    ok: out.error === undefined && out.decision !== undefined,
    error: out.error ?? null,
    errorKind: out.errorKind ?? null,
    rawText: out.rawText,
  }
  if (jsonOut !== undefined) writeTextFile(jsonOut, `${JSON.stringify(payload, null, 2)}\n`)
  console.log(JSON.stringify(payload, null, 2))
  return payload.ok ? 0 : 1
}

const groundingReport = (loadGroundingReport: LoadGroundingReport): number => {
  const runId = argValue("--run-id")
  if (runId === undefined) {
    console.error("eval grounding report: --run-id <id> is required")
    return 1
  }
  const out = loadGroundingReport(runId)
  const markdownOut = argValue("--markdown-out")
  const jsonOut = argValue("--json-out")
  if (markdownOut !== undefined) writeTextFile(markdownOut, out.markdown)
  if (jsonOut !== undefined) writeTextFile(jsonOut, `${JSON.stringify(out.report, null, 2)}\n`)
  console.log(out.markdown)
  console.error(out.headline)
  return 0
}

const groundingBaseline = (store: ResultStore): number => {
  const candidateRunId = argValue("--candidate")
  if (candidateRunId === undefined) {
    console.error("eval grounding baseline: --candidate <id> is required")
    return 1
  }
  const out = resolveGroundingBaseline(candidateRunId, store.readRunSummaries("grounding"))
  const jsonOut = argValue("--json-out")
  if (jsonOut !== undefined) writeTextFile(jsonOut, `${JSON.stringify(out, null, 2)}\n`)
  console.log(
    `grounding baseline candidate=${candidateRunId} status=${out.status}${out.baselineRunId !== undefined ? ` baseline=${out.baselineRunId}` : ""} reason=${out.reason}`,
  )
  return 0
}

const groundingRouteMatrixGate = (
  routeMatrix: string,
  loadGroundingReport: LoadGroundingReport,
): number => {
  if (!isGroundingRouteMatrixName(routeMatrix)) {
    console.error("eval grounding gate: --route-matrix must name a known matrix")
    return 1
  }
  const runIds = csvValues(argValue("--run-ids"))
  if (runIds === undefined || runIds.length === 0) {
    console.error("eval grounding gate: --run-ids <id1,id2,...> is required with --route-matrix")
    return 1
  }
  const profile = argValue("--profile")
  if (profile === undefined || !isGroundingGateProfile(profile)) {
    console.error(
      `eval grounding gate: --profile must be one of ${GROUNDING_GATE_PROFILES.join(", ")}`,
    )
    return 1
  }
  const reports = runIds.map((runId) => loadGroundingReport(runId).report)
  const gate = buildGroundingRouteMatrixGateResult(reports, routeMatrix, profile)
  const markdownOut = argValue("--markdown-out")
  const jsonOut = argValue("--json-out")
  if (markdownOut !== undefined) writeTextFile(markdownOut, gate.markdown)
  if (jsonOut !== undefined) writeTextFile(jsonOut, `${JSON.stringify(gate.result, null, 2)}\n`)
  if (gate.result.failures.length === 0) {
    console.error(`grounding route-matrix gate passed: matrix=${routeMatrix}`)
    return 0
  }
  console.error(`grounding route-matrix gate failed: matrix=${routeMatrix}`)
  for (const failure of gate.result.failures) {
    console.error(`- ${failure.kind}:${failure.cellId} ${failure.message}`)
  }
  return 1
}

const groundingGate = (loadGroundingReport: LoadGroundingReport): number => {
  const routeMatrix = argValue("--route-matrix")
  if (routeMatrix !== undefined) {
    return groundingRouteMatrixGate(routeMatrix, loadGroundingReport)
  }
  const runId = argValue("--run-id")
  if (runId === undefined) {
    console.error("eval grounding gate: --run-id <id> is required")
    return 1
  }
  const profile = argValue("--profile")
  if (profile === undefined || !isGroundingGateProfile(profile)) {
    console.error(
      `eval grounding gate: --profile must be one of ${GROUNDING_GATE_PROFILES.join(", ")}`,
    )
    return 1
  }
  const out = loadGroundingReport(runId)
  const gate = buildGroundingGateResult(out.report, profile)
  const markdownOut = argValue("--markdown-out")
  const jsonOut = argValue("--json-out")
  if (markdownOut !== undefined) writeTextFile(markdownOut, gate.markdown)
  if (jsonOut !== undefined) writeTextFile(jsonOut, `${JSON.stringify(gate.result, null, 2)}\n`)
  if (gate.result.failures.length === 0) {
    console.error(`grounding gate passed: profile=${profile} runId=${runId}`)
    return 0
  }
  console.error(`grounding gate failed: profile=${profile} runId=${runId}`)
  for (const failure of gate.result.failures) {
    console.error(`- ${failure.metric}: expected ${failure.expected}, got ${failure.actual}`)
  }
  return 1
}

const groundingScaffoldReplay = (): number => {
  const source = argValue("--source")
  const id = argValue("--id")
  const targetUtterance = argValue("--target-utterance")
  const bucket = argValue("--bucket")
  const severity = argValue("--severity")
  const outPath = argValue("--out")
  if (
    source === undefined ||
    id === undefined ||
    targetUtterance === undefined ||
    bucket === undefined ||
    severity === undefined ||
    outPath === undefined
  ) {
    console.error(
      "eval grounding scaffold-replay: --source, --id, --target-utterance, --bucket, --severity, --out are required",
    )
    return 1
  }
  if (!(GROUNDING_BUCKETS as readonly string[]).includes(bucket)) {
    console.error(
      `eval grounding scaffold-replay: --bucket must be one of ${GROUNDING_BUCKETS.join(", ")}`,
    )
    return 1
  }
  if (!(GROUNDING_SEVERITIES as readonly string[]).includes(severity)) {
    console.error(
      `eval grounding scaffold-replay: --severity must be one of ${GROUNDING_SEVERITIES.join(", ")}`,
    )
    return 1
  }
  const sessionSnapshotPath = argValue("--session-snapshot")
  const stateJsonPath = argValue("--state-json")
  const candidateThreadIds = csvValues(argValue("--candidate-threads"))
  const candidateReferentIds = csvValues(argValue("--candidate-referents"))
  const ambiguityClass = argValue("--ambiguity-class")
  if (
    ambiguityClass !== undefined &&
    !(GROUNDING_AMBIGUITY_CLASSES as readonly string[]).includes(ambiguityClass)
  ) {
    console.error(
      `eval grounding scaffold-replay: --ambiguity-class must be one of ${GROUNDING_AMBIGUITY_CLASSES.join(", ")}`,
    )
    return 1
  }
  const scaffoldOpts: Parameters<typeof writeGroundingReplayDraft>[0] = {
    source,
    id,
    targetUtterance,
    bucket: bucket as (typeof GROUNDING_BUCKETS)[number],
    severity: severity as (typeof GROUNDING_SEVERITIES)[number],
    outPath,
  }
  if (sessionSnapshotPath !== undefined) scaffoldOpts.sessionSnapshotPath = sessionSnapshotPath
  if (stateJsonPath !== undefined) scaffoldOpts.stateContract = readJsonFile(stateJsonPath) as never
  if (candidateThreadIds !== undefined) scaffoldOpts.candidateThreadIds = candidateThreadIds
  if (candidateReferentIds !== undefined) scaffoldOpts.candidateReferentIds = candidateReferentIds
  if (ambiguityClass !== undefined)
    scaffoldOpts.ambiguityClass = ambiguityClass as (typeof GROUNDING_AMBIGUITY_CLASSES)[number]
  const result = writeGroundingReplayDraft(scaffoldOpts)
  const jsonOut = argValue("--json-out")
  const payload = {
    outPath: result.outPath,
    id: result.draft.id,
    source: result.draft.sourceProvenance,
  }
  if (jsonOut !== undefined) writeTextFile(jsonOut, `${JSON.stringify(payload, null, 2)}\n`)
  console.log(`grounding scaffold-replay wrote ${result.outPath}`)
  return 0
}

/**
 * The reviewer stamp a promoted replay fixture carries, or `undefined` when the
 * operator named neither reviewer nor review time.
 *
 * A unit because supplying EITHER half is what marks the fixture reviewed — the
 * `status: "reviewed"` flag and the two identifying fields are one attestation,
 * and splitting them lets a fixture claim review with neither field set.
 */
const reviewerStamp = (
  reviewer: string | undefined,
  reviewedAt: string | undefined,
): { status: "reviewed"; reviewer?: string; reviewedAt?: string } | undefined =>
  reviewer !== undefined || reviewedAt !== undefined
    ? {
        status: "reviewed" as const,
        ...(reviewer !== undefined ? { reviewer } : {}),
        ...(reviewedAt !== undefined ? { reviewedAt } : {}),
      }
    : undefined

const groundingPromoteReplay = (): number => {
  const draftPath = argValue("--draft")
  const goldJson = argValue("--gold-json")
  const corpus = argValue("--corpus")
  const outPath = argValue("--out")
  if (
    draftPath === undefined ||
    goldJson === undefined ||
    corpus === undefined ||
    outPath === undefined
  ) {
    console.error(
      "eval grounding promote-replay: --draft, --gold-json, --corpus, --out are required",
    )
    return 1
  }
  if (corpus !== "replay_critical" && corpus !== "replay_nightly") {
    console.error(
      "eval grounding promote-replay: --corpus must be replay_critical or replay_nightly",
    )
    return 1
  }
  const blockingEligibleRaw = argValue("--blocking-eligible")
  const humanAudit = reviewerStamp(argValue("--reviewer"), argValue("--reviewed-at"))
  const result = writePromotedGroundingReplayCase({
    draft: readGroundingReplayDraft(draftPath),
    gold: readJsonFile(goldJson) as never,
    corpus,
    ...(blockingEligibleRaw !== undefined
      ? { blockingEligible: blockingEligibleRaw === "true" }
      : {}),
    ...(humanAudit !== undefined ? { humanAudit } : {}),
    outPath,
  })
  const jsonOut = argValue("--json-out")
  const payload = {
    outPath: result.outPath,
    id: result.fixture.id,
    corpus: result.fixture.corpus ?? corpus,
    source: result.fixture.sourceProvenance ?? null,
    humanAudit: result.fixture.humanAudit ?? null,
  }
  if (jsonOut !== undefined) writeTextFile(jsonOut, `${JSON.stringify(payload, null, 2)}\n`)
  console.log(`grounding promote-replay wrote ${result.outPath}`)
  return 0
}

const groundingCompare = (loadGroundingReport: LoadGroundingReport): number => {
  const baselineRunId = argValue("--baseline")
  const candidateRunId = argValue("--candidate")
  if (baselineRunId === undefined || candidateRunId === undefined) {
    console.error("eval grounding compare: --baseline <id> and --candidate <id> are required")
    return 1
  }
  const out = buildGroundingComparison(
    loadGroundingReport(baselineRunId).report,
    loadGroundingReport(candidateRunId).report,
  )
  const markdownOut = argValue("--markdown-out")
  const jsonOut = argValue("--json-out")
  if (markdownOut !== undefined) writeTextFile(markdownOut, out.markdown)
  if (jsonOut !== undefined) {
    writeTextFile(jsonOut, `${JSON.stringify(out.comparison, null, 2)}\n`)
  }
  console.log(out.markdown)
  console.error(out.headline)
  return 0
}

const groundingRegress = (loadGroundingReport: LoadGroundingReport): number => {
  const baselineRunId = argValue("--baseline")
  const candidateRunId = argValue("--candidate")
  if (baselineRunId === undefined || candidateRunId === undefined) {
    console.error("eval grounding regress: --baseline <id> and --candidate <id> are required")
    return 1
  }
  const profile = argValue("--profile")
  if (profile === undefined || !isGroundingRegressionProfile(profile)) {
    console.error(
      `eval grounding regress: --profile must be one of ${GROUNDING_REGRESSION_PROFILES.join(", ")}`,
    )
    return 1
  }
  const out = buildGroundingComparison(
    loadGroundingReport(baselineRunId).report,
    loadGroundingReport(candidateRunId).report,
  )
  const markdownOut = argValue("--markdown-out")
  const jsonOut = argValue("--json-out")
  const regression = buildGroundingRegressionResult(out.comparison, profile)
  if (markdownOut !== undefined) writeTextFile(markdownOut, regression.markdown)
  if (jsonOut !== undefined)
    writeTextFile(jsonOut, `${JSON.stringify(regression.result, null, 2)}\n`)
  if (regression.result.failures.length === 0) {
    console.error(
      `grounding regress passed: profile=${profile} baseline=${baselineRunId} candidate=${candidateRunId}`,
    )
    return 0
  }
  console.error(
    `grounding regress failed: profile=${profile} baseline=${baselineRunId} candidate=${candidateRunId}`,
  )
  for (const failure of regression.result.failures) {
    console.error(`- ${failure.kind}: ${failure.message}`)
  }
  return 1
}

const cmdGrounding = async (): Promise<number> => {
  const sub = argv[1]
  const storeDir = argValue("--store-dir")
  const store = new ResultStore({
    ...(storeDir !== undefined ? { dir: storeDir } : {}),
  })
  const loadGroundingReport: LoadGroundingReport = (runId) =>
    buildGroundingReport(store.readRunRecords(runId), runId, store.readRunSummary(runId))
  switch (sub) {
    case "run":
      return groundingRun(storeDir)
    case "preflight":
      return groundingPreflight()
    case "report":
      return groundingReport(loadGroundingReport)
    case "baseline":
      return groundingBaseline(store)
    case "gate":
      return groundingGate(loadGroundingReport)
    case "scaffold-replay":
      return groundingScaffoldReplay()
    case "promote-replay":
      return groundingPromoteReplay()
    case "compare":
      return groundingCompare(loadGroundingReport)
    case "regress":
      return groundingRegress(loadGroundingReport)
    default:
      console.error(
        "eval grounding: subcommand must be one of: run, preflight, report, baseline, gate, compare, regress, scaffold-replay, promote-replay",
      )
      return 1
  }
}

const cmdPublic = async (): Promise<number> => {
  const bench = argv[1]
  if (bench !== "swebench-verified") {
    console.error("eval public: only 'swebench-verified' is wired in this iteration")
    return 1
  }
  const reportPath = argValue("--report")
  const summary = await runSwebenchAdapter(reportPath !== undefined ? { reportPath } : {})
  console.log(
    `public run=${summary.runId} total=${summary.total} pass=${summary.counts.pass} fail=${summary.counts.fail} (${summary.durationMs}ms)`,
  )
  return 0
}

const cmdTrajectoryClassify = async (): Promise<number> => {
  const input = argValue("--input")
  if (input === undefined) {
    console.error("eval trajectory classify: --input <dir> is required")
    return 1
  }
  const cls = resolveLLM("classifier")
  if (cls === null) return 0
  const summary = await classifyTrajectories({ llm: cls.llm, inputDir: input })
  console.log(
    `trajectory run=${summary.runId} total=${summary.total} classified=${summary.classified} unrecognised=${summary.unrecognised} no-meta=${summary.noMeta} classifier-errors=${summary.classifierErrors} (${summary.durationMs}ms)`,
  )
  return 0
}

const cmdTrajectoryReplay = async (): Promise<number> => {
  const fixture = argValue("--fixture")
  if (fixture === undefined) {
    console.error("eval trajectory replay: --fixture <jsonl> is required")
    return 1
  }
  const agent = resolveLLM("agent")
  if (agent === null) return 0
  const result = await replayFixture({ llm: agent.llm, fixture })
  console.log(
    `replay run=${result.runId} verdict=${result.verdict} matched=${result.diff?.matched ?? "n/a"} diverged=${result.diff?.divergedEvents ?? "n/a"} turns=${result.originalTurns}→${result.replayTurns} (${result.durationMs}ms)`,
  )
  return 0
}

const cmdTrajectoryFreeze = async (): Promise<number> => {
  const source = argValue("--source")
  const usecase = argValue("--usecase")
  const prompt = argValue("--prompt")
  if (source === undefined || usecase === undefined) {
    console.error("eval trajectory freeze: --source <jsonl> and --usecase <id> required")
    return 1
  }
  const result = freezeFixture({
    source,
    usecase,
    ...(prompt !== undefined ? { prompt } : {}),
  })
  if (result === null) {
    console.error(
      "eval trajectory freeze: source has no .meta.json sidecar and no --prompt provided",
    )
    return 1
  }
  console.log(`frozen ${result.fixturePath}\n  meta ${result.metaPath}`)
  return 0
}

const cmdTrajectory = async (): Promise<number> => {
  const sub = argv[1]
  switch (sub) {
    case "classify":
      return cmdTrajectoryClassify()
    case "replay":
      return cmdTrajectoryReplay()
    case "freeze":
      return cmdTrajectoryFreeze()
    default:
      console.error("eval trajectory: subcommand must be one of: classify, replay, freeze")
      return 1
  }
}

const cmdCompare = async (): Promise<number> => {
  const scenarioId = argValue("--scenario")
  const usecase = argValue("--usecase") as UseCaseId | undefined
  const agentsRaw = argValue("--agents") ?? "quanta,claude-code"
  if (scenarioId === undefined || usecase === undefined) {
    console.error(
      "eval compare: --scenario, --usecase required (--agents defaults quanta,claude-code)",
    )
    return 1
  }
  // Trim each token: `--agents "quanta, claude-code"` (space after comma)
  // would otherwise route `" claude-code"` to the unknown-adapter branch.
  const agents = agentsRaw
    .split(",")
    .map((a) => a.trim())
    .filter((a) => a !== "")
  // Validate ALL adapter names up front — silent skip on a typo was the bug.
  const unknown = agents.filter((a) => !isKnownAdapter(a))
  if (unknown.length > 0) {
    console.error(
      `eval compare: unknown adapter(s) [${unknown.join(", ")}] — known: ${KNOWN_ADAPTERS.join(", ")}`,
    )
    return 1
  }
  if (agents.length < 2) {
    console.error("eval compare: --agents needs at least 2 entries to form a matchup")
    return 1
  }
  const agent = resolveLLM("agent")
  if (agent === null) return 0
  const judge = resolveLLM("judge") ?? agent
  const summary = await runCompare({
    quantaLlm: agent.llm,
    judgeLlm: judge.llm,
    scenarioId,
    usecase,
    agents,
  })
  console.log(
    `compare run=${summary.runId} ran=[${summary.agentsRan.join(",")}] skipped=[${summary.agentsSkipped.map((s) => `${s.agent}(${s.reason})`).join(", ")}] matchups=${summary.matchups.length} (${summary.durationMs}ms)`,
  )
  for (const m of summary.matchups) {
    const winner = m.winnerIndex === -1 ? "tie" : m.winnerIndex === 0 ? m.a : m.b
    console.log(`  ${m.a} vs ${m.b} → ${winner}${m.note !== "" ? ` (${m.note})` : ""}`)
  }
  return 0
}

const cmdGenerate = async (): Promise<number> => {
  const usecase = argValue("--usecase") as UseCaseId | undefined
  const countRaw = argValue("--count")
  if (usecase === undefined) {
    console.error("eval generate: --usecase <id> is required")
    return 1
  }
  const count = countRaw !== undefined ? Number.parseInt(countRaw, 10) : 5
  if (!Number.isFinite(count) || count <= 0) {
    console.error(`eval generate: invalid --count ${countRaw}`)
    return 1
  }
  const agent = resolveLLM("agent")
  if (agent === null) return 0
  const result = await generateScenarios({ llm: agent.llm, usecase, count })
  console.log(
    `generate usecase=${usecase} accepted=${result.accepted.length} rejected=${result.rejected.length}`,
  )
  for (const a of result.accepted) console.log(`  + ${a.path}`)
  for (const r of result.rejected) console.log(`  - ${r.reason}`)
  return 0
}

const cmdReport = async (): Promise<number> => {
  const out = buildReport()
  console.log(out.markdown)
  console.error(out.headline)
  return 0
}

const cmdClassify = async (): Promise<number> => {
  const text = argv[1]
  if (text === undefined || text === "") {
    console.error("eval classify: pass the query as a single argument")
    return 1
  }
  const cls = resolveLLM("classifier")
  if (cls === null) return 0
  const result = await classifyQuery(text, { llm: cls.llm })
  console.log(
    JSON.stringify({ id: result.id, confidence: result.confidence, alt: result.alt }, null, 2),
  )
  return 0
}

const HELP = `quanta eval — verification harness (Tier 0..5)

  audit                                      Tier 0 static coverage
  synthetic [--usecase ID]                   Tier 1 LLM-judged scenarios
  grounding run [--mode raw|engine|assisted] [--suite canary|nightly|--corpus CORPUS]
                                             Tier 2 structured context-grounding probe
  grounding preflight                        Tier 2 provider/route/parser health check
  grounding report --run-id ID               Tier 2 grounding metrics report
  grounding baseline --candidate ID          Tier 2 resolve latest comparable baseline
  grounding gate --run-id ID --profile canary
                                             Tier 2 grounding release gate
  grounding gate --route-matrix primary-openai --run-ids ID,ID --profile canary
                                             Tier 2 route-matrix release gate
  grounding compare --baseline ID --candidate ID
                                             Tier 2 run-to-run grounding delta
  grounding regress --baseline ID --candidate ID --profile strict
                                             Tier 2 fail-closed regression gate
  grounding scaffold-replay --source JSONL --out PATH
                                             Tier 2 replay draft scaffold (gold-blind)
  grounding promote-replay --draft PATH --gold-json PATH --corpus replay_critical|replay_nightly --out PATH
                                             Tier 2 replay draft promotion to runnable fixture
                                             add --store-dir DIR to isolate run storage
  generate --usecase ID [--count N]          Tier 1 auto-generate scenarios (LLM)
  public swebench-verified [--report PATH]   Tier 3 wraps bench-report.json
  trajectory classify --input DIR            Tier 4 label real sessions
  trajectory replay --fixture <jsonl>        Tier 4 re-execute a fixture + diff
  trajectory freeze --source <jsonl> --usecase ID [--prompt TEXT]
                                             Tier 4 promote a session to fixture
  compare --scenario ID --usecase ID [--agents quanta,claude-code,...]
                                             Tier 5 head-to-head + pairwise judge
  report                                     render aggregate matrix
  classify "<text>"                          ad-hoc taxonomy classifier
`

const main = async (): Promise<number> => {
  const sub = argv[0]
  switch (sub) {
    case "audit":
      return cmdAudit()
    case "synthetic":
      return cmdSynthetic()
    case "grounding":
      return cmdGrounding()
    case "generate":
      return cmdGenerate()
    case "public":
      return cmdPublic()
    case "trajectory":
      return cmdTrajectory()
    case "compare":
      return cmdCompare()
    case "report":
      return cmdReport()
    case "classify":
      return cmdClassify()
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP)
      return 0
    default:
      console.error(`unknown subcommand: ${sub}`)
      console.error(HELP)
      return 1
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    logger.error("eval: fatal", { error: errMessage(e) })
    process.exit(1)
  })
