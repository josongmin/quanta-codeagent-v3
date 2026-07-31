/**
 * Repro-test preparation + selection-repro sources (pure code motion from
 * `driver.ts`, byte-identical). This module owns the SWE-bench reproduce-first
 * slice: parsing the `QUANTA_BENCH_REPRO_TEST` K knob, generating/executing
 * repro candidate tests, repro grounding, the canonical repro-hint messages,
 * and the validated repro-contract / selection-repro source builders. It has
 * NO dependency on the driver orchestration surface (only leaf sibling modules
 * + `@/agent` repro primitives), so it is directly unit-testable.
 */

import {
  executeReproTests,
  extractIssueHint,
  generateControlTests,
  generateReproTests,
  type ReproExecPort,
  type ReproTestConfig,
  type ReproTestSelection,
  type ReproWriteFilePort,
  selectReproTest,
} from "@/agent"
import type { ReproGroundingInput } from "@/agent/repro-test/generate"
import { REPRO_CANONICAL_BASENAME } from "@/agent/repro-test/scaffold-patterns"
import type { ReproTestCandidate } from "@/agent/repro-test/types"
import { extractIssueReproSeed } from "@/agent/verification-plan"
import { type LLMPort, laneLabeledPort } from "@/llm"
import type { BenchReproTestTelemetry, Instance, ReproGroundingTelemetry } from "../../types"
import { execArgv } from "../exec"
import type { BenchPosture } from "../knobs-bench"
import { assertEvidenceTextBlind, type LlmEvidencePacketStage } from "../llm-evidence-packet"
import { composePromptPrelude } from "../prompt-augment"
import { agentVisibleBenchVerifierCommand } from "../repo-local-verifier-command"
import { listTrackedPythonFiles } from "../repo-regression-discovery-adapter"
import { preferredReproExecRuntime, resolveReproAdapter } from "../repro-adapter"
import type { ReproArtifactKind, ReproArtifactSink } from "../repro-artifacts-sink"
import { reproValidationCmd } from "../repro-command"
import {
  buildLexicalReproGroundingPorts,
  inferIssueSourceFiles,
  type ReproGroundingPorts,
  retrieveExemplarSkeletons,
} from "../repro-grounding"

/**
 * Parse `QUANTA_BENCH_REPRO_TEST` to a positive integer K in [1, 40] (the
 * paper's upper bound). Returns `undefined` for every other shape (absent /
 * `"0"` / negative / non-integer / NaN / garbage / empty / whitespace) — the
 * gate is *strict* by design (K=0 is byte-identical to baseline, so wiring
 * it would only add overhead without measurement effect).
 *
 * Exported for direct unit + hellgate.
 *
 * Domain choices:
 *   - K>=1 — paper's `1` means greedy-only; we accept it (no temperature
 *     knob in our `LLMPort`, so K=1 is meaningful but the majority-vote
 *     degenerates).
 *   - K<=40 — paper cap; >40 is rejected to bound LLM cost.
 */
export const parseBenchReproTestK = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined
  const s = raw.trim()
  if (s === "") return undefined
  if (!/^-?\d+$/.test(s)) return undefined
  const n = Number(s)
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined
  if (n < 1 || n > 40) return undefined
  return n
}

export interface PrepareReproTestDeps {
  /** Bench's main LLM port. Reused (no separate model wiring — adds ~K
   *  small calls per instance, bounded by `parseBenchReproTestK`). */
  readonly llm: LLMPort
  /** Override for the generator. Tests inject a deterministic K-stream;
   *  production uses {@link generateReproTests}. */
  readonly generate?: typeof generateReproTests
  /** G2 paired-control: override for the env-health CONTROL generator. Tests
   *  inject a deterministic control-source stream; production uses
   *  {@link generateControlTests}. Only invoked when {@link pairedControl} is on. */
  readonly generateControl?: typeof generateControlTests
  /** Override for the executor. Tests inject a Map-backed mock; production
   *  wraps `execArgv` + a file-write port. */
  readonly execute?: typeof executeReproTests
  /** Override for the selector. Tests can swap to deterministic; production
   *  uses {@link selectReproTest}. */
  readonly select?: typeof selectReproTest
  /** Injected file writer for the candidate scripts. Production wraps
   *  `Bun.write`; tests inject a Map-backed shim. */
  readonly writeFile?: ReproWriteFilePort
  /** Injected exec port. Production: `execArgv` from `./exec.ts`. */
  readonly exec?: ReproExecPort
  /** jun-19 #10999 under-fix lever: when `true`, the repro prompt gets the
   *  ADVERSARIAL-coverage block (boundary / must-reject / don't-copy-suggested-
   *  fix), so a shallow happy-path patch keeps the repro RED. Default-OFF ⇒
   *  byte-identical prompt. Sourced from `benchOptIns().adversarialRepro`. */
  readonly adversarial?: boolean
  /** jun-22 config-extraction: per-repro-script exec timeout (ms). Sourced from
   *  `posture.reproExecTimeoutMs`; undefined ⇒ the 60s `DEFAULT_EXEC_TIMEOUT_MS`. */
  readonly reproExecTimeoutMs?: number
  /** G2 paired-control gate. When `true`, the admission filter
   *  ({@link selectReproTest}) tightens to `reproduced && baseControl ===
   *  "green"`, rejecting env/import-broken false-reds. Sourced from
   *  `posture.pairedControl`; undefined/false ⇒ byte-identical legacy filter. */
  readonly pairedControl?: boolean
  /** A1 (jun-28): per-candidate repro artifact sink. When present, EVERY generated
   *  candidate (canonical + hardening) is persisted before the unselected ones are
   *  discarded — durable RCA evidence. Observe-only; absent ⇒ no-op (default-OFF,
   *  byte-identical). Built by the bench app under the run's observe dir (full-remote
   *  tarball) and gated by the `reproArtifacts` opt-in. */
  readonly reproArtifactSink?: ReproArtifactSink
  /** jun-29 GROUNDING gate. When `true`, the repro prompt is grounded with the
   *  SETUP SKELETONS of relevant existing tests (no-leak: bodies elided) so the
   *  model copies the repo's fixture pattern instead of hand-rolling framework
   *  setup. Sourced from `posture.reproGrounding`; undefined/false ⇒ no retrieval,
   *  byte-identical prompt. */
  readonly reproGrounding?: boolean
  /** Injected grounding ports (tests). Production builds the LEXICAL adapter from
   *  the sandbox; a future semantica `CodeIntelligencePort` adapter fills the same
   *  port. Only consulted when {@link reproGrounding} is on. */
  readonly groundingPorts?: ReproGroundingPorts
  /** Source files the issue is about (localization output). When absent and
   *  grounding is on, the driver infers them lexically from the issue × tracked
   *  files ({@link inferIssueSourceFiles}). Empty inference ⇒ exemplar retrieval
   *  is inert (byte-identical). */
  readonly groundingSourceFiles?: readonly string[]
}

/** Per-instance reproduction-script filename written into the sandbox. The agent's user
 *  message references this exact path. Sourced from the repro-scaffold SSOT (RFC Phase 1b) so
 *  the canonical name has ONE definition across hint / hygiene / strip / rematerialize. */
export const REPRO_FILE_NAME = REPRO_CANONICAL_BASENAME

/** User-message block appended (before the existing base text) when a repro
 *  test was successfully selected. The command is rendered from the same
 *  project-env repro SSOT as validation; never hand the agent ambiguous
 *  bare-`python` instructions. */
export const reproHintMessage = (command: string): string =>
  [
    "A reproduction script has been placed at `reproduce_issue.py` in the sandbox.",
    `After your fix, run \`${command}\` under the project env.`,
    "It must go green: all assertions pass and the process exits 0.",
    "A failing assertion or non-zero exit means the bug is still present or the repro could not run cleanly.",
    "If it fails with TypeError/AttributeError/wrong argument count, inspect existing source/tests and fix the reproducer call shape before treating it as bug proof.",
  ].join("\n")

/** Compatibility/default hint for non-SWE fixtures. SWE-bench call sites use
 *  `reproHintForInstance` so the hint includes `uv run --with-editable`. */
export const REPRO_HINT_MESSAGE = reproHintMessage("python3 -s reproduce_issue.py")

export const reproValidationCmdForInstance = (instance: Instance, scriptPath: string): string => {
  const repo = instance.swebench?.repo
  const version = instance.swebench?.version
  const adapter = resolveReproAdapter(instance)
  if (repo !== undefined && adapter !== null) {
    return adapter.buildValidationCmd({
      repo,
      version,
      scriptPath,
      ...preferredReproExecRuntime(instance, scriptPath),
    })
  }
  return reproValidationCmd({ repo, version, scriptPath })
}

const reproHintForInstance = (instance: Instance): string =>
  reproHintMessage(reproValidationCmdForInstance(instance, REPRO_FILE_NAME))

export interface PrepareReproTestDetailedResult {
  readonly selection: ReproTestSelection | null
  readonly telemetry: BenchReproTestTelemetry
}

const countReproduced = (samples: readonly { outcome: string }[]): number =>
  samples.filter((s) => s.outcome === "reproduced").length

export const selectionTelemetry = (selection: ReproTestSelection): BenchReproTestTelemetry => {
  const samples = selection.samples.length
  const reproducedCount = selection.reproducedCount
  if (selection.selected !== null) {
    return { installed: false, reason: "not_installed", samples, reproducedCount }
  }
  // jun-18 DIAGNOSTIC (observe-only): surface WHY 0% base-red reproduction.
  const diag = {
    sampleOutcomes: selection.samples.map((s) => s.outcome),
    sampleStdoutTail: (selection.samples[0]?.stdout ?? "").slice(-400),
    sampleStderrTail: (selection.samples[0]?.stderr ?? "").slice(-500),
  }
  if (samples > 0 && selection.samples.every((sample) => sample.outcome === "exec_failed")) {
    return { installed: false, reason: "execution_failed", samples, reproducedCount, ...diag }
  }
  return { installed: false, reason: "no_reproduced_candidate", samples, reproducedCount, ...diag }
}

type ReproSamples = Awaited<ReturnType<typeof executeReproTests>>

const disabledReproResult = (
  reason: "disabled" | "empty_problem" | "unsupported_language",
): PrepareReproTestDetailedResult => ({
  selection: null,
  telemetry: { installed: false, reason },
})

const failedReproResult = (
  reason: "generation_failed" | "generation_empty" | "execution_failed",
): PrepareReproTestDetailedResult => ({
  selection: null,
  telemetry: { installed: false, reason, samples: 0, reproducedCount: 0 },
})

const buildReproExecPort = (instance: Instance, deps: PrepareReproTestDeps) =>
  deps.exec ??
  ((argv, cwd, timeoutMs) =>
    execArgv(argv, cwd, timeoutMs, {
      ...(instance.localEnv !== undefined ? { localEnv: instance.localEnv } : {}),
    }))

/** Result of {@link generateReproCandidateTests}: the tagged symptom candidates
 *  plus the OPTIONAL G2 paired-control sources (env-health probes). The controls
 *  are SHARED across every symptom candidate of this instance — they certify the
 *  exec env, not any single symptom. Empty/absent ⇒ the legacy path (no controls
 *  threaded ⇒ `baseControl` stays undefined ⇒ byte-identical). */
interface ReproCandidateGeneration {
  readonly candidates: readonly ReproTestCandidate[]
  readonly controlSources: readonly string[]
}

/** jun-23 canonical/hardening split. The CANONICAL set is the submit-gate
 *  oracle (plain core-symptom contract); the optional HARDENING set is advisory
 *  (adversarial coverage for tie-break / repair seeding, NEVER the submit gate).
 *  Each returned candidate is tagged with its {@link ReproTestKind}.
 *
 *  G2 (jun-24): when `deps.pairedControl` is on, ALSO synthesise env-health
 *  CONTROL tests (public issue/repo only, NEVER gold) via {@link
 *  generateControlTests}. These are returned as `controlSources` so the executor
 *  can run them on the base tree and populate `baseControl` — the field the
 *  admission gate branches on. Default-OFF ⇒ `controlSources` is `[]` and the
 *  whole path is byte-identical to the legacy (no-control) generation. */
const generateReproCandidateTests = async (
  instance: Instance,
  deps: PrepareReproTestDeps,
  config: ReproTestConfig,
  grounding: ReproGroundingInput = {},
): Promise<ReproCandidateGeneration | null> => {
  try {
    // SEED-ONLY: the issue-text extractor is a precision-first HEURISTIC guess at
    // the repro (its `hasCall` regex can mistake an "Expected output" block for an
    // executable MWE). We therefore consume it via the SEED-tagged variant and
    // hand it to the LLM generator ONLY as grounding — it never executes as an
    // oracle on its own. The AUTHORITATIVE repro is what the generator synthesises
    // and the base-red gate (selectReproTest / baseValidatedRed) validates below.
    const mwe = extractIssueReproSeed(instance.problemStatement)?.code
    const gen = deps.generate ?? generateReproTests
    // Phase lane → recorded as metadata.lane so every repro-generation turn (incl.
    // the paired-control pass) groups under one authoritative "repro" band in the
    // viewer. Pure label decorator — replay-neutral, behavior byte-identical.
    const reproLlm = laneLabeledPort(deps.llm, "repro")
    // jun-29: splice grounding ONLY when it carries content, so an empty (off /
    // no-retrieval) grounding is byte-identical to the un-grounded base.
    const hasGrounding =
      grounding.exemplarSkeletons !== undefined || grounding.issueSignatures !== undefined
    const base = {
      issue: instance.problemStatement,
      llm: reproLlm,
      config,
      ...(mwe !== undefined ? { mwe } : {}),
      ...(hasGrounding ? { grounding } : {}),
    }
    const canonical = (await gen({ ...base, kind: "canonical" })).map(
      (source): ReproTestCandidate => ({ kind: "canonical", source }),
    )
    // G2: env-health control sources. Generated ONLY when the gate is on — when
    // off this call is skipped entirely so the LLM-call count + outputs are
    // byte-identical to the legacy path.
    const controlSources =
      deps.pairedControl === true
        ? await (deps.generateControl ?? generateControlTests)({
            issue: instance.problemStatement,
            llm: reproLlm,
            config,
          })
        : []
    if (deps.adversarial !== true) return { candidates: canonical, controlSources }
    // Advisory hardening set: a SEPARATE generation pass with the over-strict
    // adversarial prompt. Kept distinct so it can never reach the submit gate.
    const hardening = (await gen({ ...base, kind: "hardening" })).map(
      (source): ReproTestCandidate => ({ kind: "hardening", source }),
    )
    return { candidates: [...canonical, ...hardening], controlSources }
  } catch {
    return null
  }
}

const executeReproCandidateTests = async (
  candidates: readonly ReproTestCandidate[],
  controlSources: readonly string[],
  instance: Instance,
  sandbox: string,
  deps: PrepareReproTestDeps,
  config: ReproTestConfig,
): Promise<ReproSamples | null> => {
  const reproRepo = instance.swebench?.repo
  const reproVersion = instance.swebench?.version
  // RFC jun-29 Phase 2b: route repro exec through the per-language adapter PLUS the preferred
  // runtime for this instance. Verified/Live Python stay host-byte-identical; Pro Python with a
  // clean image ref upgrades to `docker run ... python -s <script>` inside the instance image.
  // Unsupported language (Pro non-Python) ⇒ adapter null ⇒ FAIL-CLOSED (no fake pytest on a
  // Go/JS tree). The repo-undefined branch is preserved verbatim (non-SWE-bench fixtures keep
  // execute.ts's bare `[python, path]` default — NOT the adapter's `-s` form).
  const reproAdapter = resolveReproAdapter(instance)
  if (reproAdapter === null) return null
  const buildArgv =
    reproRepo !== undefined
      ? (scriptPath: string) => [
          ...reproAdapter.buildExecArgv({
            repo: reproRepo,
            version: reproVersion,
            scriptPath,
            ...preferredReproExecRuntime(instance, scriptPath),
          }),
        ]
      : undefined
  // G2 paired-control: when controls were generated (gate ON), attach the SAME
  // env-health control set to EVERY symptom candidate by position. The executor
  // runs them on the base tree and folds the verdict into each sample's
  // `baseControl`. Empty controls ⇒ omit the field entirely (byte-identical
  // legacy `executeReproTests` call — no `controlTests` key).
  const controlTests = controlSources.length > 0 ? candidates.map(() => controlSources) : undefined
  try {
    const samples = await (deps.execute ?? executeReproTests)({
      tests: candidates.map((c) => c.source),
      repoRoot: sandbox,
      exec: buildReproExecPort(instance, deps),
      writeFile:
        deps.writeFile ??
        (async (path: string, content: string): Promise<void> => {
          await Bun.write(path, content)
        }),
      readFile: async (path: string): Promise<string> => Bun.file(path).text(),
      config,
      ...(controlTests !== undefined ? { controlTests } : {}),
      ...(buildArgv !== undefined ? { buildArgv } : {}),
    })
    // jun-23 split: carry each candidate's KIND onto its sample by positional
    // alignment (executeReproTests returns one sample per input, in order). This
    // is what lets the driver route ONLY canonical reproducing sources into the
    // submit-gate oracle (calibration + proof gate) and keep hardening advisory.
    const final = samples.map((s, i) => ({ ...s, kind: candidates[i]?.kind ?? "canonical" }))
    // A1 (jun-28): persist EVERY candidate (canonical + hardening) before the
    // unselected ones evaporate — durable RCA evidence. Observe-only + best-effort:
    // a sink failure never changes the returned samples (wrapped). No-op when no
    // sink is injected (default-OFF, byte-identical).
    await persistReproArtifacts(deps.reproArtifactSink, instance.id, final)
    return final
  } catch {
    return null
  }
}

/** A1 persistence: write one artifact dir per repro candidate (per-kind index)
 *  via the injected sink. Best-effort + observe-only — swallows its own errors so
 *  persistence can NEVER fail the repro path. No-op when `sink` is undefined. */
const persistReproArtifacts = async (
  sink: ReproArtifactSink | undefined,
  instanceId: string,
  samples: ReproSamples,
): Promise<void> => {
  if (sink === undefined) return
  const perKind: Record<string, number> = {}
  for (const s of samples) {
    const kind: ReproArtifactKind = s.kind === "hardening" ? "hardening" : "canonical"
    const index = perKind[kind] ?? 0
    perKind[kind] = index + 1
    try {
      await sink.persist({
        instanceId,
        index,
        kind,
        source: s.source,
        stdout: s.stdout,
        stderr: s.stderr ?? "",
        outcome: s.outcome,
        ...(s.execFailure !== undefined ? { execFailure: s.execFailure } : {}),
        ...(s.sidecarReport !== undefined ? { sidecar: s.sidecarReport } : {}),
      })
    } catch {
      // observe-only: a write failure must never disturb the repro pipeline.
    }
  }
}

/** Per-instance grounding-retrieval timeout (git ls-files / file reads). */
const GROUNDING_TIMEOUT_MS = 30_000

/**
 * Compute the repro-prompt GROUNDING (jun-29). Default-OFF (`reproGrounding`
 * unset) ⇒ `{}` (no I/O, byte-identical prompt). When on, build the lexical ports
 * (unless injected), infer the issue's source files when the caller did not supply
 * them, and retrieve exemplar skeletons. Never throws (the orchestrator degrades
 * any port failure to `{}`); a flaky retrieval can never fail repro generation.
 */
const computeReproGrounding = async (
  instance: Instance,
  sandbox: string,
  deps: PrepareReproTestDeps,
): Promise<ReproGroundingInput> => {
  if (deps.reproGrounding !== true) return {}
  // List tracked files ONCE (reused for source inference AND the lexical adapter
  // — C6 audit closed a double `git ls-files`). Skipped when ports are injected
  // (tests) since the lexical adapter is then unused.
  const tracked =
    deps.groundingPorts === undefined
      ? await listTrackedPythonFiles(sandbox, GROUNDING_TIMEOUT_MS).catch(() => [])
      : []
  const sourceFiles =
    deps.groundingSourceFiles ?? inferIssueSourceFiles(instance.problemStatement, tracked)
  const ports =
    deps.groundingPorts ??
    buildLexicalReproGroundingPorts({
      sandbox,
      timeoutMs: GROUNDING_TIMEOUT_MS,
      trackedFiles: tracked,
      sourceFiles,
    })
  // Issue symbols for the signature block (lexical extraction from the source
  // files above). Empty ⇒ collectSignatures no-ops ⇒ no signature block.
  const issueSymbols = extractIssueHint(instance.problemStatement).symbols
  return retrieveExemplarSkeletons({
    enabled: true,
    sourceFiles,
    ...(issueSymbols.length > 0 ? { issueSymbols } : {}),
    ports,
  })
}

/** Observe-only grounding-engagement summary for telemetry. Returned ONLY when
 *  the knob was on (so OFF telemetry is byte-identical). `engaged` distinguishes
 *  "injected ≥1 skeleton/signature" from "ran but lexical inference whiffed". */
const groundingTelemetry = (
  on: boolean,
  grounding: ReproGroundingInput,
): ReproGroundingTelemetry | undefined => {
  if (!on) return undefined
  const exemplars = grounding.exemplarSkeletons?.length ?? 0
  const signatures = grounding.issueSignatures?.length ?? 0
  return { engaged: exemplars > 0 || signatures > 0, exemplars, signatures }
}

export const prepareReproTestDetailed = async (
  instance: Instance,
  sandbox: string,
  k: number | undefined,
  deps: PrepareReproTestDeps,
): Promise<PrepareReproTestDetailedResult> => {
  if (k === undefined || k < 1) {
    return disabledReproResult("disabled")
  }
  if (typeof instance.problemStatement !== "string" || instance.problemStatement.length === 0) {
    return disabledReproResult("empty_problem")
  }
  if (instance.swebench?.repoLanguage !== undefined && resolveReproAdapter(instance) === null) {
    return disabledReproResult("unsupported_language")
  }
  const config: ReproTestConfig = {
    samples: k,
    ...(deps.reproExecTimeoutMs !== undefined ? { execTimeoutMs: deps.reproExecTimeoutMs } : {}),
  }
  const select = deps.select ?? selectReproTest
  // jun-18 closure repro-install lever: when the issue body embeds a confidently
  // EXECUTABLE Minimal Working Example (the author's own reproduction), seed the
  // generation with it so the model wraps that KNOWN-reproducing code in the
  // sentinel scaffold instead of guessing a reproduction from prose. Fail-closed:
  // `extractIssueReproSeed` returns undefined for anything ambiguous, in which case
  // `mwe` is omitted and the generate prompt is byte-identical to the prior path.
  const grounding = await computeReproGrounding(instance, sandbox, deps)
  // Observe-only grounding telemetry, attached to EVERY post-grounding return so
  // the A/B can tell "engaged" from "ran-but-whiffed". Absent when off ⇒ telemetry
  // byte-identical to the pre-feature path.
  const gt = groundingTelemetry(deps.reproGrounding === true, grounding)
  const withG = (r: PrepareReproTestDetailedResult): PrepareReproTestDetailedResult =>
    gt === undefined ? r : { ...r, telemetry: { ...r.telemetry, grounding: gt } }
  const generated = await generateReproCandidateTests(instance, deps, config, grounding)
  if (generated === null) return withG(failedReproResult("generation_failed"))
  const tests = generated.candidates
  if (tests.length === 0) return withG(failedReproResult("generation_empty"))
  // Run each repro under the SAME project env the testCmd uses. A bare
  // `python3 <script>` on the box host cannot import the target project (it is
  // not pip-installed there), so without this every Agentless repro hit
  // ModuleNotFoundError and the primary rail never fired. For SWE-bench
  // instances, build a `uv run --with-editable . python <script>` argv keyed on the
  // repo's python version; non-SWE-bench fixtures keep the bare python3 default.
  const samples = await executeReproCandidateTests(
    tests,
    generated.controlSources,
    instance,
    sandbox,
    deps,
    config,
  )
  if (samples === null) return withG(failedReproResult("execution_failed"))
  // G2 paired-control: thread the gate into the admission filter. When on, the
  // selector rejects reproducing samples whose paired controls did not pass on
  // base (env/import-broken false-reds). Default-OFF ⇒ legacy filter.
  const selection = select(samples, { pairedControl: deps.pairedControl === true })
  const telemetry: BenchReproTestTelemetry =
    samples.length > 0
      ? selectionTelemetry(selection)
      : {
          installed: false,
          reason: "no_reproduced_candidate",
          samples: 0,
          reproducedCount: countReproduced(samples),
        }
  return withG({ selection, telemetry })
}

/**
 * Pre-agent reproduction-test generation + selection + sandbox install.
 *
 * Returns the selected test source (to be saved as `reproduce_issue.py`)
 * and the full selection record. Returns `null` when:
 *   - K is absent / invalid (env-gate)
 *   - the instance has no problem statement
 *   - every sample's outcome was non-"reproduced" (LLM couldn't synthesise
 *     a working reproducer)
 *
 * The function NEVER throws; on internal failure (LLM stream error, exec
 * exception) the worst outcome is `null` and the agent runs without the
 * hint — byte-identical to the K=undefined path.
 */
export const prepareReproTest = async (
  instance: Instance,
  sandbox: string,
  k: number | undefined,
  deps: PrepareReproTestDeps,
): Promise<ReproTestSelection | null> => {
  const detailed = await prepareReproTestDetailed(instance, sandbox, k, deps)
  return detailed.selection
}

/**
 * Wire `prepareReproTest` + `Bun.write` into a single `runInstance` helper.
 * Default-OFF: when `QUANTA_BENCH_REPRO_TEST` is unset/invalid OR no candidate
 * reproduces, returns `undefined` — the agent runs without the hint
 * (byte-identical to the pre-feature path).
 *
 * Extracted from `runInstance` to keep its cognitive complexity under the
 * biome ceiling. The wiring is exactly:
 *   K = parseBenchReproTestK(env)
 *   if K invalid ⇒ undefined
 *   selection = prepareReproTest(K)
 *   if no selection ⇒ undefined
 *   write `<sandbox>/reproduce_issue.py` ⇒ on success return the project-env repro hint
 *   on disk write failure ⇒ undefined (byte-identical to K-unset)
 */
interface InstallReproTestResult {
  readonly hint: string | undefined
  readonly telemetry: BenchReproTestTelemetry | undefined
  /** #2 repro-vote: the CANONICAL scripts that REPRODUCED the bug on the
   *  un-patched tree (outcome === "reproduced", kind canonical). Re-run on the
   *  patched tree + majority-voted by the K-of-N RESOLVED gate when the
   *  `repro-vote` knob is on. Empty/absent ⇒ no vote (byte-identical legacy gate).
   *  jun-23 split: canonical-only — the submit-gate set. */
  readonly reproSources?: readonly string[]
  /** Advisory HARDENING reproducing scripts (jun-23 split). Tie-break / repair
   *  seeding only — NEVER the submit gate. */
  readonly hardeningReproSources?: readonly string[]
}

const writeFailedTelemetry = (base: BenchReproTestTelemetry): BenchReproTestTelemetry => ({
  installed: false,
  reason: "write_failed",
  ...(base.samples !== undefined ? { samples: base.samples } : {}),
  ...(base.reproducedCount !== undefined ? { reproducedCount: base.reproducedCount } : {}),
  // jun-29: preserve grounding engagement telemetry across the rebuild (else the
  // A/B can't read it on the write-failed path).
  ...(base.grounding !== undefined ? { grounding: base.grounding } : {}),
})

/** The CANONICAL reproducing sources — the SUBMIT-GATE oracle set (jun-23
 *  split). A sample with no `kind` is treated as canonical (legacy single-set
 *  path ⇒ byte-identical to the pre-split behavior). Hardening reproes are
 *  EXCLUDED here so they can never reach the proof gate / calibration. */
export const reproducingReproSources = (
  selection: ReproTestSelection | null | undefined,
): readonly string[] =>
  selection?.samples
    .filter((s) => s.outcome === "reproduced" && (s.kind ?? "canonical") === "canonical")
    .map((s) => s.source) ?? []

/** The advisory HARDENING reproducing sources (jun-23 split). Advisory only —
 *  tie-break / repair seeding — NEVER the submit gate. */
const reproducingHardeningSources = (
  selection: ReproTestSelection | null | undefined,
): readonly string[] =>
  selection?.samples
    .filter((s) => s.outcome === "reproduced" && s.kind === "hardening")
    .map((s) => s.source) ?? []

const VALIDATED_REPRO_CONTRACT_SCRIPT_LIMIT = 2
const VALIDATED_REPRO_CONTRACT_SOURCE_LIMIT = 1_200
const boundValidatedReproSource = (source: string): string => {
  const trimmed = source.trim()
  if (trimmed.length <= VALIDATED_REPRO_CONTRACT_SOURCE_LIMIT) return trimmed
  const suffix = "\n# ...[truncated]"
  const head = trimmed.slice(0, Math.max(0, VALIDATED_REPRO_CONTRACT_SOURCE_LIMIT - suffix.length))
  // Cut on a LINE boundary, not mid-token: a mid-line slice yields syntactically
  // broken Python that we'd then present to the model as an executable "contract".
  // Keep only whole lines when the retained head contains a newline (>=0 so a
  // newline anywhere is preferred over a mid-token cut). A single >limit line with
  // NO newline is inherently lossy — keep the bounded head (clearly marked
  // truncated) rather than dropping the evidence entirely.
  const lastNewline = head.lastIndexOf("\n")
  const safe = lastNewline >= 0 ? head.slice(0, lastNewline) : head
  return `${safe}${suffix}`
}

export const validatedReproContractSeed = (
  sources: readonly string[],
  stage: LlmEvidencePacketStage = "candidate_generation",
): string | undefined => {
  assertEvidenceTextBlind(stage, sources)
  const nonEmptySources = sources.map(boundValidatedReproSource).filter((source) => source !== "")
  const boundedSources = nonEmptySources.slice(0, VALIDATED_REPRO_CONTRACT_SCRIPT_LIMIT)
  if (boundedSources.length === 0) return undefined
  const scripts = boundedSources
    .map((source, i) =>
      [`Validated reproduction script ${i + 1}:`, "```python", source, "```"].join("\n"),
    )
    .join("\n\n")
  const omitted = nonEmptySources.length - boundedSources.length
  return [
    "The following reproduction script(s) were generated from the public issue and executed on the base tree; each failed there and therefore reproduced the bug.",
    // Evidence-toned, NOT an absolute "must pass" mandate: these are LLM-generated
    // SYMPTOM reproducers, not the hidden grading tests. Over-stating their
    // authority invites reward-hacking the self-generated oracle. Fix the ROOT
    // CAUSE described in the issue; a correct fix should also make them PASS /
    // exit 0, but do not contort the patch merely to satisfy a script.
    "Treat them as strong public evidence of the bug's observable behavior. Prioritize fixing the root cause from the issue; a correct fix should make them pass cleanly (all assertions green / exit 0), but do not add unrelated design surface just to pass a single script.",
    ...(omitted > 0
      ? [
          `Omitted ${omitted} additional validated reproduction script(s) to keep the prompt compact.`,
        ]
      : []),
    scripts,
  ].join("\n\n")
}

export const validatedReproRepairSeed = (sources: readonly string[]): string | undefined => {
  const contract = validatedReproContractSeed(sources, "repair_seed")
  if (contract === undefined) return undefined
  return [
    contract,
    "Use this as repair guidance only after candidate selection has already shown every candidate unresolved.",
  ].join("\n\n")
}

export const selectionReproPrepK = (
  posture: Pick<BenchPosture, "verifySelectN" | "verifySelectRepro" | "reproTestK">,
): number | undefined => {
  if (posture.verifySelectN === undefined) return undefined
  if (posture.verifySelectRepro === undefined || posture.verifySelectRepro === "off")
    return undefined
  return posture.reproTestK ?? posture.verifySelectN
}

export const prepareSelectionReproSources = async (
  instance: Instance,
  sandbox: string,
  llm: LLMPort,
  posture: Pick<
    BenchPosture,
    | "verifySelectN"
    | "verifySelectRepro"
    | "reproTestK"
    | "adversarialRepro"
    | "reproExecTimeoutMs"
    | "pairedControl"
    | "reproGrounding"
  >,
  deps: Omit<PrepareReproTestDeps, "llm" | "adversarial"> = {},
): Promise<{
  readonly telemetry: BenchReproTestTelemetry | undefined
  readonly hint: string | undefined
  /** CANONICAL reproducing sources — the submit-gate oracle set. */
  readonly reproSources: readonly string[]
  /** Advisory HARDENING reproducing sources — tie-break / repair seeding only. */
  readonly hardeningReproSources: readonly string[]
}> => {
  const reproK = selectionReproPrepK(posture)
  if (reproK === undefined)
    return { telemetry: undefined, hint: undefined, reproSources: [], hardeningReproSources: [] }
  const detail = await prepareReproTestDetailed(instance, sandbox, reproK, {
    ...deps,
    llm,
    ...(posture.adversarialRepro === true ? { adversarial: true } : {}),
    ...(posture.reproExecTimeoutMs !== undefined
      ? { reproExecTimeoutMs: posture.reproExecTimeoutMs }
      : {}),
    ...(posture.pairedControl === true ? { pairedControl: true } : {}),
    ...(posture.reproGrounding === true ? { reproGrounding: true } : {}),
  })
  const reproSources = reproducingReproSources(detail.selection)
  const hardeningReproSources = reproducingHardeningSources(detail.selection)
  if (detail.selection?.selected === null || detail.selection?.selected === undefined) {
    return {
      telemetry: detail.telemetry,
      hint: undefined,
      reproSources,
      hardeningReproSources,
    }
  }
  const path = `${sandbox}/${REPRO_FILE_NAME}`
  try {
    const writeFile =
      deps.writeFile ??
      (async (p: string, c: string): Promise<void> => {
        await Bun.write(p, c)
      })
    await writeFile(path, detail.selection.selected)
    return {
      telemetry: {
        installed: true,
        path,
        samples: detail.selection.samples.length,
        reproducedCount: detail.selection.reproducedCount,
        // jun-29: carry grounding engagement onto the installed-success telemetry
        // (prepareReproTestDetailed attached it via withG; this rebuild must NOT
        // drop it, or the A/B reads no grounding on the reproduced path).
        ...(detail.telemetry.grounding !== undefined
          ? { grounding: detail.telemetry.grounding }
          : {}),
      },
      hint: reproHintForInstance(instance),
      reproSources,
      hardeningReproSources,
    }
  } catch {
    return {
      telemetry: writeFailedTelemetry(detail.telemetry),
      hint: undefined,
      reproSources,
      hardeningReproSources,
    }
  }
}

export const installReproTestHint = async (
  instance: Instance,
  sandbox: string,
  posture: Pick<
    BenchPosture,
    "reproTestK" | "adversarialRepro" | "pairedControl" | "reproGrounding"
  >,
  llm: LLMPort,
  reproArtifactSink?: ReproArtifactSink,
): Promise<InstallReproTestResult> => {
  const reproK = posture.reproTestK
  if (reproK === undefined) return { hint: undefined, telemetry: undefined }
  const preparation = await prepareReproTestDetailed(instance, sandbox, reproK, {
    llm,
    ...(posture.adversarialRepro === true ? { adversarial: true } : {}),
    ...(posture.pairedControl === true ? { pairedControl: true } : {}),
    ...(posture.reproGrounding === true ? { reproGrounding: true } : {}),
    ...(reproArtifactSink !== undefined ? { reproArtifactSink } : {}),
  })
  const { selection, telemetry } = preparation
  if (selection === null || selection.selected === null) return { hint: undefined, telemetry }
  // #2 repro-vote: keep EVERY CANONICAL reproducing script (not just the selected
  // winner) so the validation-time K-of-N RESOLVED vote can re-run the whole
  // submit-gate set. jun-23 split: hardening reproes are kept SEPARATE (advisory).
  const reproSources = reproducingReproSources(selection)
  const hardeningReproSources = reproducingHardeningSources(selection)
  const path = `${sandbox}/${REPRO_FILE_NAME}`
  try {
    await Bun.write(path, selection.selected)
    return {
      hint: reproHintForInstance(instance),
      reproSources,
      hardeningReproSources,
      telemetry: {
        installed: true,
        path,
        samples: selection.samples.length,
        reproducedCount: selection.reproducedCount,
        // jun-29: preserve grounding engagement (else the A/B reads None on the
        // installed-success path — the canary symptom).
        ...(telemetry.grounding !== undefined ? { grounding: telemetry.grounding } : {}),
      },
    }
  } catch {
    return {
      hint: undefined,
      reproSources,
      hardeningReproSources,
      telemetry: writeFailedTelemetry(telemetry),
    }
  }
}

/**
 * Pure composer for the repro-hint block placement.
 *
 * Agent prompt order (top → bottom):
 *   <issue-hint>             (optional, default-OFF)
 *   <REPRO_HINT_MESSAGE>     (optional, default-OFF — this slice)
 *   <base task>
 *   <SWEBENCH_DIRECTIVE>     (already inside baseText for swebench instances)
 *   <seedMsg>                (only on repair rounds ≥1, appended by caller)
 *
 * Inputs:
 *   - `hint`        — issue-hint block (`""` when default-OFF)
 *   - `hintedBase`  — `hint + "\n\n" + baseText` when hint non-empty; else
 *                     `baseText`. Caller pre-computes (this preserves the
 *                     byte-identical pre-feature path when reproHint is "").
 *   - `baseText`    — the raw base task text (with SWEBENCH_DIRECTIVE).
 *   - `reproHint`   — the repro directive line, or `undefined` / `""` to skip.
 *
 * Returns:
 *   - `hintedBase` (byte-identical to pre-feature) when reproHint is empty.
 *   - `${hint}\n\n${reproHint}\n\n${baseText}` when hint present + repro
 *     present.
 *   - `${reproHint}\n\n${baseText}` when only repro present.
 *
 * Extracted to keep `buildConfig`'s cognitive complexity under the biome
 * ceiling. Pure — exported for direct unit testing.
 */
export const composeWithReproHint = (
  hint: string,
  hintedBase: string,
  baseText: string,
  reproHint: string | undefined,
): string =>
  reproHint === undefined || reproHint === ""
    ? hintedBase
    : composePromptPrelude({ issueHint: hint, reproHint, baseText })

export const repoLocalVerifierHint = (instance: Instance): string => {
  const testCmd = agentVisibleBenchVerifierCommand(instance, process.env)
  if (instance.swebench === undefined || testCmd === undefined) return ""
  return [
    `Repository-local verifier for this task: ${testCmd}`,
    "When running repo tests, prefer this command (or a narrower variant of it) over bare host-global pytest/python.",
  ].join("\n")
}
