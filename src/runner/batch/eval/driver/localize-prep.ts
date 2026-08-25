/**
 * Pre-agent LOCALIZATION + repair-ESCALATION prep (pure code motion from
 * `driver.ts`, byte-identical). Owns the Agentless issue-hint precompute
 * (`prepareIssueHint` + repo-candidate resolution + ranked-line parsing), the
 * CHA multisite sibling-override context (`resolveChaMultisiteContext` + its
 * python-method / steer helpers), the adaptive repair-escalation owner
 * resolvers, and the escalation-followup runner. It reads issue text + the repo
 * and returns hints/owners; the followup re-enters `prepareAttemptContext`
 * (injected default → runtime edge, no load-time cycle).
 */

import {
  type AgentlessLocalizeDeps,
  type AgentlessLocalizeResult,
  agentlessLocalize,
  composeIssueHint,
  extractIssueHint,
} from "@/agent"
import type { ObservationBundle } from "@/agent/observation/fragment"
import {
  extractFailureFacts,
  type FailureFactsExtraction,
  type FailureFactsIdentity,
  type LiveFailureObservation,
  type MetricEvent,
} from "@/agent/observation/metrics"
import { DEFAULT_SOURCE_AUTHORITY, gatherObservations } from "@/agent/observation/pipeline"
import { lspEnrichProvider } from "@/agent/observation/providers/lsp-enrich/provider"
import { agentlessProvider } from "@/agent/observation/render/agentless-provider"
import { renderObservations, renderObservationsLegacy } from "@/agent/observation/render/render"
import { decideEscalation, type EscalationDecision } from "@/agent/repair-escalation"
import type { LLMPort } from "@/llm"
import type { FailureTaxonomyFactsV1 } from "@/observability/failure-taxonomy"
import type { LocalizeBudgetValue } from "@/runner/knobs/knobs/localize-budget"
import { logger, normalizePublicIssueText } from "@/shared"
import { localizeTool } from "@/tool/localize"
import type { Instance, OwnerWideningTelemetry } from "../../types"
import {
  buildMultisiteSteer,
  type ChaRepairTarget,
  findEnclosingPythonMethod,
  findSiblingOverrideSites,
  type SiblingOverrideSite,
} from "../cha-multisite"
import { exec } from "../exec"
import { traceForwardLocalizeOwners } from "../forward-localize-trace"
import type { BenchPosture } from "../knobs-bench"
import { primaryRailRedAfterRepair } from "../repair-phase-policy"
import { prepareAttemptContext } from "./attempt-context"
import {
  cleanUniqueList,
  type Phase,
  type PreparedAttemptContext,
  type RunInstanceDeps,
} from "./context-types"
import type { IssueHintMode } from "./env-knob-parse"
import { enumerateRepoSources } from "./repo-source-scan"

export interface PrepareIssueHintDeps {
  /** Bench's main LLM port. The Agentless localizer reuses it (no separate
   *  cheaper-model wiring — adds one ~800-token call per instance, which is
   *  negligible against a 30-turn agent budget). */
  readonly llm: LLMPort
  /** Override for `enumerateRepoSources` — tests inject a deterministic
   *  fileTree. Production wiring uses `enumerateRepoSources(sandbox)`. */
  readonly fileTree?: () => Promise<string[]>
  /** Override for the localizer itself — tests inject a mock that returns a
   *  predetermined `AgentlessLocalizeResult`. Production wiring uses the real
   *  `agentlessLocalize`. */
  readonly localize?: (
    problemStatement: string,
    deps: AgentlessLocalizeDeps,
  ) => Promise<AgentlessLocalizeResult>
  /** Soft timeout (ms) for the LLM localization call. On expiry the wiring
   *  falls back to the regex extractor. Default 30_000. */
  readonly timeoutMs?: number
  /** jun-22 config-extraction: agentless localizer breadth dials (topK /
   *  maxTreeChars / maxFiles). Sourced from `posture.localizeBudget`; omitted
   *  fields keep their hardcoded defaults. */
  readonly localizeBudget?: LocalizeBudgetValue
  /** Resolved posture bit from the SAME bench projection that chose `mode`.
   *  Required so issue-hint prep never re-reads ambient env. */
  readonly issueHintExpectedActual: boolean
  /** jul-6 S3 — when NOT false, render the agentless hint through the observation
   *  kernel (`<quanta_observations>`). `false` ⇒ legacy `composeAgentlessHint`
   *  (byte-identical). Absent ⇒ ON (the posture default). */
  readonly renderObservations?: boolean
  /** jul-6 S3 — when NOT false, add the LSP-enrich provider (symbol/contract
   *  resolution over the candidate files) to the pipeline. Graceful no-op when no
   *  language server is available. Absent ⇒ ON (the posture default). */
  readonly lspPrefetch?: boolean
  /** jul-6 S4 observe seam (optional, no-op by default) — the merged observation
   *  bundle for this instance, handed over BEFORE it is rendered so the caller can
   *  attribute providers / feed usage metrics. Pure observation; does not affect
   *  the returned hint. */
  readonly onObservationBundle?: (bundle: ObservationBundle) => void
  /** T-201 observer seam (optional, no-op by default). When the agentless
   *  localizer produces ranked candidate files, they are handed here BEFORE
   *  being collapsed into the hint string — so the caller can build a
   *  FaultEvidencePacket from the SAME localization pass (no second LLM call).
   *  Pure observation: does not affect the returned hint. Fires only in
   *  agentless mode with a non-empty result. */
  readonly onCandidates?: (files: readonly string[]) => void
  /** F1 observe seam (optional, no-op by default). Fires ONCE in agentless mode
   *  after the file-tree is built + candidates resolved, carrying the file-tree
   *  build + localize outcome (tree file count, whether truncation fired, ranked
   *  candidate count). Lets the driver emit a `localize` trace so post-mortem
   *  localization RCA is no longer blind to a truncation-dropped gold file. Pure
   *  observation: does not affect the returned hint. NOT fired in `off`/`regex`
   *  mode (no agentless tree was built). */
  readonly onLocalize?: (data: {
    readonly treeFileCount: number
    readonly truncated: boolean
    readonly truncatedChars?: number
    readonly rankedCandidateCount: number
  }) => void
  /** RFC-07 G3 — bundle-live failure-facts seam (optional, no-op by default, same
   *  gate class as `onObservationBundle`). Present ⇒ the live-seam adapter derives
   *  a versioned `FailureTaxonomyFactsV1` from THIS attempt's live bundle and
   *  routes it to the caller. Pure observation: does NOT affect the returned hint
   *  and does NOT persist (G4 owns the canonical per-attempt result). */
  readonly failureFacts?: FailureFactsWiring
}

/** The explicit `unavailable` arm of {@link FailureFactsExtraction} the seam
 *  surfaces (incomplete/mismatched identity) — never a best-effort partial. */
export type FailureFactsUnavailable = Extract<FailureFactsExtraction, { kind: "unavailable" }>

/**
 * Bundle-live failure-facts WIRING. Carries the EXACT identity binding (never
 * inferred) plus the sinks the live-seam adapter routes to. `expected` is the
 * caller's attempt identity + source digest (bound at attempt start via
 * `computeFailureSourceDigest`); `capturedUnder` is the run/attempt the
 * observation was actually recorded under. `events` is the OPTIONAL in-memory
 * trajectory slice for the count facts — ABSENT at the pre-agent localize seam
 * (counts unavailable), supplied by an authoritative producer later (G6); NEVER
 * re-read from disk (§G3 stop rule).
 */
export interface FailureFactsWiring {
  readonly expected: FailureFactsIdentity
  readonly capturedUnder: LiveFailureObservation["capturedUnder"]
  readonly events?: readonly MetricEvent[] | undefined
  /** Sink for a successfully-extracted, identity-matched fact record. */
  readonly onFacts: (facts: FailureTaxonomyFactsV1) => void
  /** Sink for an explicit unavailable outcome. NOT a fallback — the caller
   *  decides what to do (G4 persists it). */
  readonly onUnavailable: (outcome: FailureFactsUnavailable) => void
}

/**
 * Bundle-live failure-facts ADAPTER: derive facts from ONE live observation and
 * route them to the wiring's sinks. This is the ONLY runtime CALL of the G3
 * extractor at the live seam — deleting the `extractFailureFacts(...)` call below
 * makes the live-seam integration RED (a bare import is insufficient). It reads
 * only the in-memory bundle + event slice (§G3: no offline trajectory read, no
 * bundle-field reconstruction) and never persists.
 */
export const deriveLiveFailureFacts = (
  bundle: ObservationBundle,
  wiring: FailureFactsWiring,
): void => {
  const observation: LiveFailureObservation = {
    bundle,
    capturedUnder: wiring.capturedUnder,
    ...(wiring.events !== undefined ? { events: wiring.events } : {}),
  }
  const extraction = extractFailureFacts(observation, wiring.expected)
  if (extraction.kind === "extracted") wiring.onFacts(extraction.facts)
  else wiring.onUnavailable(extraction)
}

/** Seam guard: run the bundle-live failure-facts adapter only when a wiring is
 *  present. Kept as its OWN unit so the (default-OFF) branch lives here rather
 *  than inflating `prepareIssueHint`; an absent wiring is a byte-identical no-op. */
const emitLiveFailureFacts = (
  bundle: ObservationBundle,
  wiring: FailureFactsWiring | undefined,
): void => {
  if (wiring !== undefined) deriveLiveFailureFacts(bundle, wiring)
}

const DEFAULT_PREPARE_TIMEOUT_MS = 30_000
// CHA-multisite breadth defaults (jun-25 magic-number removal). These are NOT a
// frozen ceiling on outcome: they are overridable via the existing
// `localize-budget` knob (`posture.localizeBudget`), and the per-file localize
// row count reuses the localizer's documented `topK` default so the analyzer
// scans the SAME ranked rows the one-shot localizer ranks (single SSOT).
const DEFAULT_CHA_MULTISITE_FILES = 3
const DEFAULT_LOCALIZE_TOP_K = 5

/** Resolve the # of localized candidate files to give CHA sibling analysis.
 *  Overridable via `localize-budget` (`chafiles=N`); default mirrors the prior
 *  literal, now documented config rather than a hidden constant. */
const chaMultisiteFileBudget = (budget: LocalizeBudgetValue | undefined): number =>
  budget?.chaMultisiteFiles ?? DEFAULT_CHA_MULTISITE_FILES

/** Resolve the per-file localize `max_results`. Reuses the localizer's own
 *  `topK` (how many ranked rows the one-shot localizer surfaces) so the
 *  CHA-multisite scan is tied to the SAME breadth dial rather than a separate
 *  frozen number. Overridable via `localize-budget` (`topk=N`). */
const chaLocalizeMaxResults = (budget: LocalizeBudgetValue | undefined): number =>
  budget?.topK ?? DEFAULT_LOCALIZE_TOP_K

const rerouteLocalizedOwnerSurface = (
  prepared: Pick<PreparedAttemptContext, "localizeCandidates" | "ownerResolved" | "closureSession">,
): readonly string[] =>
  cleanUniqueList([
    ...prepared.localizeCandidates,
    ...(prepared.ownerResolved?.map((owner) => owner.file) ?? []),
    ...(prepared.closureSession?.bundle.evidence.candidates.map((c) => c.file) ?? []),
  ])

const ownerWideningTelemetryOf = (args: {
  readonly owners: readonly string[]
  readonly sources: readonly ("repair_escalation" | "forward_localize")[]
  readonly path: OwnerWideningTelemetry["path"]
}): OwnerWideningTelemetry | undefined =>
  args.owners.length === 0
    ? undefined
    : { owners: args.owners, sources: args.sources, path: args.path }

export const adaptiveRepairEscalationDecision = (args: {
  readonly prepared: Pick<
    PreparedAttemptContext,
    "posture" | "closureSession" | "ownerResolved" | "primaryRailStep"
  >
  readonly phase: Pick<Phase, "validated" | "primaryFalseGreen">
}): EscalationDecision | undefined => {
  if (!args.prepared.posture.repairEscalation || args.prepared.closureSession === undefined) {
    return undefined
  }
  return decideEscalation({
    candidates: args.prepared.closureSession.bundle.evidence.candidates.map((c) => ({
      file: c.file,
      score: c.score,
      sources: c.sources,
    })),
    primaryRailRedAfterRepair: primaryRailRedAfterRepair(
      args.prepared.primaryRailStep,
      args.phase.validated,
      args.phase.primaryFalseGreen,
    ),
    siblingFiles: args.prepared.ownerResolved?.map((o) => o.file) ?? [],
  })
}

/** Post-phase adaptive widen seam: when a repair-capable posture leaves the
 *  primary rail red and the escalation decision says the attempt is structurally
 *  incomplete, feed those owner files into the NEXT reroute pass as additional
 *  localized owners. This turns the prior report-only decision into a real
 *  adaptive widening input without giving it submit authority. */
export const adaptiveRepairEscalationOwners = (args: {
  readonly prepared: Pick<
    PreparedAttemptContext,
    "posture" | "closureSession" | "ownerResolved" | "primaryRailStep"
  >
  readonly phase: Pick<Phase, "validated" | "primaryFalseGreen">
}): readonly string[] => {
  const decision = adaptiveRepairEscalationDecision(args)
  return decision?.escalate ? cleanUniqueList(decision.owners) : []
}

/** Repair-escalation feeds the NEXT prepare pass, which rebuilds closure/owner
 *  state from scratch. Filter only against the current stage-1 localized files:
 *  owners already present there would be re-derived anyway, but ownerResolved /
 *  closure-session-only siblings still need to be re-seeded explicitly. */
export const repairEscalationFollowupOwners = (args: {
  readonly prepared: Pick<
    PreparedAttemptContext,
    "localizeCandidates" | "posture" | "closureSession" | "ownerResolved" | "primaryRailStep"
  >
  readonly phase: { readonly validated?: boolean; readonly primaryFalseGreen?: boolean }
}): readonly string[] => {
  const alreadySeeded = new Set(cleanUniqueList(args.prepared.localizeCandidates))
  return adaptiveRepairEscalationOwners(args).filter((owner) => !alreadySeeded.has(owner))
}

export const adaptiveNextPassOwners = async (args: {
  readonly prepared: Pick<
    PreparedAttemptContext,
    "localizeCandidates" | "posture" | "closureSession" | "ownerResolved" | "primaryRailStep"
  >
  readonly phase: {
    readonly patch: string
    readonly validated?: boolean
    readonly primaryFalseGreen?: boolean
  }
  readonly forwardLocalize: boolean
  readonly sandbox: string
  readonly timeoutMs: number
}): Promise<{
  readonly owners: readonly string[]
  readonly telemetry: OwnerWideningTelemetry | undefined
}> => {
  const escalationOwners = repairEscalationFollowupOwners(args)
  const forwardLocalizeOwners = args.forwardLocalize
    ? await traceForwardLocalizeOwners({
        patch: args.phase.patch,
        sandbox: args.sandbox,
        timeoutMs: args.timeoutMs,
        alreadyLocalized: rerouteLocalizedOwnerSurface(args.prepared),
      })
    : []
  const owners = cleanUniqueList([...escalationOwners, ...forwardLocalizeOwners])
  return {
    owners,
    telemetry: ownerWideningTelemetryOf({
      owners,
      sources: [
        ...(escalationOwners.length > 0 ? (["repair_escalation"] as const) : []),
        ...(forwardLocalizeOwners.length > 0 ? (["forward_localize"] as const) : []),
      ],
      path: "adaptive_reroute",
    }),
  }
}

export const maybeRunRepairEscalationFollowup = async <
  P extends {
    readonly patch: string
    readonly validated?: boolean
    readonly primaryFalseGreen?: boolean
  },
>(args: {
  readonly instance: Instance
  readonly deps: RunInstanceDeps
  readonly sandbox: string
  readonly signal: AbortSignal
  readonly prepared: PreparedAttemptContext
  readonly phase: P
  readonly runPhase: (prepared: PreparedAttemptContext) => Promise<P>
  readonly prepare?: typeof prepareAttemptContext
}): Promise<{
  readonly prepared: PreparedAttemptContext
  readonly phase: P
  readonly reran: boolean
  readonly widenedOwners: readonly string[]
  readonly telemetry: OwnerWideningTelemetry | undefined
}> => {
  const widenedOwners = repairEscalationFollowupOwners(args)
  if (widenedOwners.length === 0) {
    return {
      prepared: args.prepared,
      phase: args.phase,
      reran: false,
      widenedOwners,
      telemetry: undefined,
    }
  }
  const prepare = args.prepare ?? prepareAttemptContext
  const nextPrepared = await prepare(
    args.instance,
    args.sandbox,
    args.deps,
    args.signal,
    args.prepared.posture,
    args.prepared.state,
    widenedOwners,
  )
  const nextPhase = await args.runPhase(nextPrepared)
  return {
    prepared: nextPrepared,
    phase: nextPhase,
    reran: true,
    widenedOwners,
    telemetry: ownerWideningTelemetryOf({
      owners: widenedOwners,
      sources: ["repair_escalation"],
      path: "single_pass_followup",
    }),
  }
}

const normalizeIssuePathCandidate = (raw: string): string => {
  let value = raw.trim().replaceAll("\\", "/")
  while (value.startsWith("./")) value = value.slice(2)
  while (value.startsWith("/")) value = value.slice(1)
  return value
}

const uniqueRepoSuffixMatch = (
  extractedPath: string,
  repoFiles: readonly string[],
): string | undefined => {
  const normalized = normalizeIssuePathCandidate(extractedPath)
  if (normalized === "") return undefined
  const repoSet = new Set(repoFiles)
  if (repoSet.has(normalized)) return normalized
  const parts = normalized.split("/").filter((part) => part !== "")
  for (let start = 1; start < parts.length; start += 1) {
    const suffix = parts.slice(start).join("/")
    const matches = repoFiles.filter((file) => file === suffix || file.endsWith(`/${suffix}`))
    if (matches.length === 1) return matches[0]
  }
  return undefined
}

const resolveIssueHintRepoCandidates = (
  extractedFiles: readonly string[],
  repoFiles: readonly string[],
): readonly string[] =>
  cleanUniqueList(
    extractedFiles.flatMap((file) => {
      const resolved = uniqueRepoSuffixMatch(file, repoFiles)
      return resolved === undefined ? [] : [resolved]
    }),
  )

/** Compute the hint string to PREPEND onto the user message, deciding
 *  between the new Agentless LLM path and the legacy regex path based on
 *  `mode`.
 *
 *    - mode `"off"`          ⇒ empty string (byte-identical sentinel)
 *    - mode `"regex"`        ⇒ legacy synchronous extractor (byte-identical
 *                              with the pre-feature single-arg buildConfig)
 *    - mode `"agentless"`    ⇒ async LLM localization. On any failure
 *                              (timeout, stream error, zero files in tree,
 *                              empty parse result) falls back to regex —
 *                              i.e. the worst case of agentless mode is
 *                              still a non-degenerate hint.
 *
 *  This function never throws — every failure path lands on a regex
 *  fallback (or `""` when regex also returns empty). */
/** The regex route: extract the hint, and — only when it actually named files —
 *  resolve them against the repo tree so the observer sees REAL candidates.
 *
 *  WHY THIS IS A UNIT: `prepareIssueHint`'s cost was never its length. It is a
 *  three-mode dispatcher, and its two fallback closures were declared INLINE,
 *  so every guard inside them paid a nesting surcharge for sitting in a nested
 *  arrow. This one is reached from THREE distinct routes (empty statement,
 *  localizer threw, localizer returned nothing) — it was always a unit; it just
 *  was not spelled as one. Hoisted to module scope, its two guards cost their
 *  face value.
 *
 *  `onCandidates` is taken as a PARAMETER rather than read off `deps` inside,
 *  so the narrowing survives the call boundary. */
const regexIssueHintFallback = async (
  problemStatement: string,
  extractOpts: { readonly withExpectedActual: boolean },
  readFileTree: () => Promise<string[]>,
  onCandidates: ((files: readonly string[]) => void) | undefined,
): Promise<string> => {
  const hint = extractIssueHint(problemStatement, extractOpts)
  if (hint.files.length > 0) {
    const repoFiles = await readFileTree().catch(() => [])
    const resolved = resolveIssueHintRepoCandidates(hint.files, repoFiles)
    if (resolved.length > 0) onCandidates?.(resolved)
  }
  return composeIssueHint(hint)
}

/** Build the ONCE-ONLY repo file-tree reader.
 *
 *  WHY THIS IS A UNIT: the memo (`repoFilesPromise`) exists purely so the tree
 *  is enumerated at most once per attempt no matter which of the three readers
 *  asks for it. Wrapping the mutable cell in a factory keeps `let`'s
 *  definite-assignment analysis with the code that owns it, and lets the reader
 *  be passed to the hoisted helpers as a plain function. */
const memoizedFileTree = (fileTree: () => Promise<string[]>): (() => Promise<string[]>) => {
  let repoFilesPromise: Promise<string[]> | undefined
  return async (): Promise<string[]> => {
    repoFilesPromise ??= fileTree()
    return repoFilesPromise
  }
}

/** Race the localizer against the soft timeout, always clearing the timer.
 *
 *  WHY THIS IS A UNIT: timer creation, the race, and the `finally` cleanup are
 *  one indivisible resource protocol — splitting them anywhere else leaks a
 *  `setTimeout`. Returns `undefined` for "the localizer THREW" so the caller
 *  keeps ownership of the fallback decision (the timeout arm is NOT a throw: it
 *  resolves to an empty result, which routes through the empty-files branch
 *  exactly as before). */
const raceLocalizeWithTimeout = async (
  problemStatement: string,
  readFileTree: () => Promise<string[]>,
  deps: PrepareIssueHintDeps,
): Promise<AgentlessLocalizeResult | undefined> => {
  const localize = deps.localize ?? agentlessLocalize
  const timeoutMs = deps.timeoutMs ?? DEFAULT_PREPARE_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutP = new Promise<AgentlessLocalizeResult>((resolve) => {
    timer = setTimeout(() => resolve({ files: [], rationales: [], rawResponse: "" }), timeoutMs)
  })
  try {
    return await Promise.race([
      localize(problemStatement, {
        llm: deps.llm,
        fileTree: readFileTree,
        ...(deps.localizeBudget ?? {}),
      }),
      timeoutP,
    ])
  } catch {
    // localize threw (the function itself catches; this is belt-and-braces)
    return undefined
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** F1 trace payload for one localize pass.
 *
 *  WHY THIS IS A UNIT: it is four independent "absent ⇒ safe default" reads of
 *  the SAME optional `result.tree`, i.e. one decision ("what did the tree look
 *  like?") spelled four times. `result.tree` is absent only on the timeout path
 *  (the injected timeout result carries no tree); when absent we still report
 *  the ranked count with a zeroed tree so the trace is never silently omitted. */
type LocalizeTraceData = Parameters<NonNullable<PrepareIssueHintDeps["onLocalize"]>>[0]

const localizeTraceOf = (result: AgentlessLocalizeResult): LocalizeTraceData => ({
  treeFileCount: result.tree?.fileCount ?? 0,
  truncated: result.tree?.truncated ?? false,
  ...(result.tree?.truncatedChars !== undefined
    ? { truncatedChars: result.tree.truncatedChars }
    : {}),
  rankedCandidateCount: result.files.length,
})

/** The observation providers for this pass.
 *
 *  agentless (LLM localizer) seeds owners from the issue; LSP-enrich
 *  (default-ON, graceful no-op without a server) refines them to symbols +
 *  contracts. lsp-prefetch outranks agentless in DEFAULT_SOURCE_AUTHORITY, so a
 *  confirmed symbol owner wins.
 *
 *  WHY THIS IS A UNIT: the LSP provider rides ONLY when BOTH knobs are on. With
 *  render OFF the hint MUST reproduce the legacy agentless `## Issue Hints`
 *  BYTE-IDENTICALLY — letting LSP symbol-owners leak into the legacy render
 *  would silently change the "off" output (jul-6 hellgate G3). Naming the rule
 *  once is what keeps that two-knob conjunction from being restated. */
const observationProvidersFor = (
  result: AgentlessLocalizeResult,
  sandbox: string,
  deps: PrepareIssueHintDeps,
) => {
  const providers = [agentlessProvider(result)]
  if (deps.renderObservations !== false && deps.lspPrefetch !== false) {
    providers.push(lspEnrichProvider(result.files, sandbox))
  }
  return providers
}

export const prepareIssueHint = async (
  instance: Instance,
  sandbox: string,
  mode: IssueHintMode,
  deps: PrepareIssueHintDeps,
): Promise<string> => {
  if (mode === "off") return ""
  const problemStatement =
    normalizePublicIssueText(instance.problemStatement) ?? instance.problemStatement
  const extractOpts = { withExpectedActual: deps.issueHintExpectedActual }
  if (mode === "regex") {
    return composeIssueHint(extractIssueHint(problemStatement, extractOpts))
  }
  // mode === "agentless"
  const readFileTree = memoizedFileTree(
    deps.fileTree ?? (async () => enumerateRepoSources(sandbox)),
  )
  // Every failure route below lands here — the worst case of agentless mode is
  // still a non-degenerate regex hint.
  const fallback = (): Promise<string> =>
    regexIssueHintFallback(problemStatement, extractOpts, readFileTree, deps.onCandidates)
  // Empty problem statement ⇒ regex also yields "" ⇒ byte-identical.
  if (typeof problemStatement !== "string" || problemStatement.length === 0) {
    return fallback()
  }
  const result = await raceLocalizeWithTimeout(problemStatement, readFileTree, deps)
  if (result === undefined) return fallback()
  // F1 — emit the file-tree build + localize outcome BEFORE the empty-files
  // fallback branches, so the trace fires even when localize gave up (the case
  // most likely to be a truncation-dropped gold file).
  deps.onLocalize?.(localizeTraceOf(result))
  if (result.files.length === 0) {
    // Localize gave up — fall back to regex so the bench still gets SOME
    // hint when an issue body contains explicit paths.
    return fallback()
  }
  // T-201: surface the ranked candidates to the observer (no-op when unset) so a
  // FaultEvidencePacket can be built from THIS localization pass — never a second
  // LLM call. Pure observation; the returned hint is unchanged.
  deps.onCandidates?.(result.files)
  // jul-6 S3 — route the live hint through the observation kernel. OFF (posture
  // `renderObservations === false`) ⇒ `renderObservationsLegacy` is byte-identical
  // to `composeAgentlessHint(result)` (S3 proven). ON ⇒ the `<quanta_observations>`
  // render (routing-hint framing + anti_signals). agentlessProvider ignores ctx, so
  // the bundle — and thus the OFF byte-identity — is independent of the ctx passed.
  const bundle = await gatherObservations(
    observationProvidersFor(result, sandbox, deps),
    { cwd: sandbox, issueText: problemStatement, repoFiles: await readFileTree().catch(() => []) },
    { authority: DEFAULT_SOURCE_AUTHORITY },
  )
  // observe-only telemetry (S4 seed): which providers actually contributed this
  // instance — confirms LSP-enrich fired (`lsp-prefetch` in contributors) vs the
  // agentless-only fallback, and how many owners survived the merge.
  logger.info("observation: bundle", {
    contributors: bundle.contributors,
    owners: bundle.owners.length,
    lspHarvested: bundle.contributors.includes("lsp-prefetch"),
  })
  deps.onObservationBundle?.(bundle)
  // RFC-07 G3 — derive versioned failure-facts from the SAME live bundle. No-op
  // when unwired (byte-identical); observe-only, never persisted here.
  emitLiveFailureFacts(bundle, deps.failureFacts)
  return deps.renderObservations === false
    ? renderObservationsLegacy(bundle)
    : renderObservations(bundle)
}

/** Parse ranked `path:line` rows from the localize tool output. Group headers,
 *  malformed rows, and duplicate lines are ignored. */
export const parseLocalizeRankedLines = (output: string): readonly number[] => {
  const seen = new Set<number>()
  const out: number[] = []
  for (const row of output.split("\n")) {
    const m = row.match(/^\s{2}.+?:(\d+)\s{2}/)
    if (!m) continue
    const line = Number(m[1])
    if (!Number.isInteger(line) || line < 1 || seen.has(line)) continue
    seen.add(line)
    out.push(line)
  }
  return out
}

const runScopedLocalize = async (args: {
  readonly sandbox: string
  readonly targetRelFile: string
  readonly query: string
  readonly maxResults: number
  readonly timeoutMs?: number
}): Promise<string | undefined> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), args.timeoutMs ?? DEFAULT_PREPARE_TIMEOUT_MS)
  let result: { ok: boolean; output: string } | undefined
  try {
    for await (const event of localizeTool.execute(
      {
        query: args.query,
        path: args.targetRelFile,
        max_results: args.maxResults,
      },
      { cwd: args.sandbox, signal: controller.signal },
    )) {
      if (event.type === "result") result = event.result
    }
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
  return result?.ok === true ? result.output : undefined
}

const resolveLocalizedPythonMethods = async (args: {
  readonly sandbox: string
  readonly targetRelFile: string
  readonly query: string
  readonly maxResults: number
}): Promise<readonly string[]> => {
  if (!args.targetRelFile.endsWith(".py")) return []
  const output = await runScopedLocalize(args)
  if (output === undefined) return []
  const methods: string[] = []
  const seen = new Set<string>()
  for (const line of parseLocalizeRankedLines(output)) {
    const method = await findEnclosingPythonMethod({
      exec,
      repoRoot: args.sandbox,
      targetRelFile: args.targetRelFile,
      line,
      timeoutMs: DEFAULT_PREPARE_TIMEOUT_MS,
    })
    if (method === undefined || seen.has(method)) continue
    seen.add(method)
    methods.push(method)
  }
  return methods
}

const betterChaSteerCandidate = (
  left: { method: string; sites: readonly SiblingOverrideSite[] } | undefined,
  right: { method: string; sites: readonly SiblingOverrideSite[] },
): { method: string; sites: readonly SiblingOverrideSite[] } => {
  if (left === undefined) return right
  if (right.sites.length !== left.sites.length) {
    return right.sites.length > left.sites.length ? right : left
  }
  const rightOverrides = right.sites.filter((site) => site.role !== "backend-contract").length
  const leftOverrides = left.sites.filter((site) => site.role !== "backend-contract").length
  if (rightOverrides !== leftOverrides) return rightOverrides > leftOverrides ? right : left
  return left
}

/** jun-25: map the CHA-general posture flag to the analyzer's sibling-mode. OFF
 *  ⇒ legacy django path hardcode (byte-identical); ON ⇒ structural superset. */
const chaSiblingModeOf = (posture: BenchPosture): "path-hardcoded" | "general" =>
  posture.chaMultisiteGeneral ? "general" : "path-hardcoded"

const bestChaSteerCandidateForFile = async (args: {
  readonly sandbox: string
  readonly targetRelFile: string
  readonly query: string
  readonly siblingMode: "path-hardcoded" | "general"
  readonly maxResults: number
}): Promise<ChaRepairTarget | undefined> => {
  const methods = await resolveLocalizedPythonMethods(args)
  let best: { method: string; sites: readonly SiblingOverrideSite[] } | undefined
  for (const method of methods) {
    const sites = await findSiblingOverrideSites({
      exec,
      repoRoot: args.sandbox,
      targetRelFile: args.targetRelFile,
      method,
      siblingMode: args.siblingMode,
      timeoutMs: DEFAULT_PREPARE_TIMEOUT_MS,
    })
    if (sites.length === 0) continue
    best = betterChaSteerCandidate(best, { method, sites })
  }
  return best === undefined
    ? undefined
    : {
        file: args.targetRelFile,
        method: best.method,
        sites: best.sites,
      }
}

export const resolveChaMultisiteContext = async (args: {
  readonly instance: Instance
  readonly sandbox: string
  readonly posture: BenchPosture
  readonly localizeCandidates: readonly string[]
}): Promise<{
  readonly steer: string | undefined
  readonly repairTargets: readonly ChaRepairTarget[]
}> => {
  if (!args.posture.chaMultisiteSteer || args.instance.swebench === undefined) {
    return { steer: undefined, repairTargets: [] }
  }
  const query =
    normalizePublicIssueText(args.instance.problemStatement) ?? args.instance.problemStatement
  if (typeof query !== "string" || query.trim() === "") {
    return { steer: undefined, repairTargets: [] }
  }
  const maxFiles = chaMultisiteFileBudget(args.posture.localizeBudget)
  const maxResults = chaLocalizeMaxResults(args.posture.localizeBudget)
  const candidates = cleanUniqueList(args.localizeCandidates)
    .filter((file) => file.endsWith(".py"))
    .filter((_, index) => index < maxFiles)
  const siblingMode = chaSiblingModeOf(args.posture)
  const repairTargets: ChaRepairTarget[] = []
  let steer: string | undefined
  for (const targetRelFile of candidates) {
    const best = await bestChaSteerCandidateForFile({
      sandbox: args.sandbox,
      targetRelFile,
      query,
      siblingMode,
      maxResults,
    })
    if (best !== undefined) {
      repairTargets.push(best)
      if (steer === undefined) steer = buildMultisiteSteer(best.method, best.sites)
    }
  }
  return { steer, repairTargets }
}
