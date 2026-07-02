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
  composeAgentlessHint,
  composeIssueHint,
  extractIssueHint,
} from "@/agent"
import { decideEscalation, type EscalationDecision } from "@/agent/repair-escalation"
import type { LLMPort } from "@/llm"
import type { LocalizeBudgetValue } from "@/runner/knobs/knobs/localize-budget"
import { normalizePublicIssueText } from "@/shared"
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
  /** T-201 observer seam (optional, no-op by default). When the agentless
   *  localizer produces ranked candidate files, they are handed here BEFORE
   *  being collapsed into the hint string — so the caller can build a
   *  FaultEvidencePacket from the SAME localization pass (no second LLM call).
   *  Pure observation: does not affect the returned hint. Fires only in
   *  agentless mode with a non-empty result. */
  readonly onCandidates?: (files: readonly string[]) => void
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
  const fileTree = deps.fileTree ?? (async () => enumerateRepoSources(sandbox))
  let repoFilesPromise: Promise<string[]> | undefined
  const readFileTree = async (): Promise<string[]> => {
    repoFilesPromise ??= fileTree()
    return repoFilesPromise
  }
  const regexFallback = async (): Promise<string> => {
    const hint = extractIssueHint(problemStatement, extractOpts)
    if (hint.files.length > 0) {
      const repoFiles = await readFileTree().catch(() => [])
      const resolved = resolveIssueHintRepoCandidates(hint.files, repoFiles)
      if (resolved.length > 0) deps.onCandidates?.(resolved)
    }
    return composeIssueHint(hint)
  }
  // Empty problem statement ⇒ regex also yields "" ⇒ byte-identical.
  if (typeof problemStatement !== "string" || problemStatement.length === 0) {
    return regexFallback()
  }
  const localize = deps.localize ?? agentlessLocalize
  const timeoutMs = deps.timeoutMs ?? DEFAULT_PREPARE_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutP = new Promise<AgentlessLocalizeResult>((resolve) => {
    timer = setTimeout(() => resolve({ files: [], rationales: [], rawResponse: "" }), timeoutMs)
  })
  let result: AgentlessLocalizeResult
  try {
    result = await Promise.race([
      localize(problemStatement, {
        llm: deps.llm,
        fileTree: readFileTree,
        ...(deps.localizeBudget ?? {}),
      }),
      timeoutP,
    ])
  } catch {
    // localize threw (the function itself catches; this is belt-and-braces)
    return regexFallback()
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  if (result.files.length === 0) {
    // Localize gave up — fall back to regex so the bench still gets SOME
    // hint when an issue body contains explicit paths.
    return regexFallback()
  }
  // T-201: surface the ranked candidates to the observer (no-op when unset) so a
  // FaultEvidencePacket can be built from THIS localization pass — never a second
  // LLM call. Pure observation; the returned hint is unchanged.
  deps.onCandidates?.(result.files)
  return composeAgentlessHint(result)
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
