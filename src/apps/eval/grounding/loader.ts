import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { isGroundingFileId, resolveGroundingSpecificFileContext } from "./file-context"
import { resolveGroundingReferentContext } from "./referent-context"
import {
  parseGroundingCase,
  type GroundingCase,
  type GroundingCorpus,
  type GroundingHistoryEntry,
  type GroundingStateContract,
  type GroundingSuite,
} from "./schema"
import { stableJson } from "./stable-json"

const DEFAULT_CASES_ROOT = join(import.meta.dir, "cases")
const REQUIRED_CANARY_CRITICAL_BUCKETS = [
  "must_clarify",
  "stale_context_trap",
  "summary_equivalence",
  "wrong_thread_adversarial",
] as const

const listJson = (dir: string): readonly string[] => {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => join(dir, name))
    .sort()
}

export interface LoadGroundingCasesOpts {
  suite?: GroundingSuite
  corpus?: GroundingCorpus
  casesRoot?: string
}

const pairContract = (groundingCase: GroundingCase): unknown => ({
  usecase: groundingCase.usecase,
  targetUtterance: groundingCase.targetUtterance,
  gold: groundingCase.gold,
  severity: groundingCase.severity,
  mode: groundingCase.mode,
  cwd: groundingCase.cwd,
  memoryContext: groundingCase.memoryContext,
  workingState: groundingCase.workingState,
  repoRulesText: groundingCase.repoRulesText,
  contextChanges: groundingCase.contextChanges,
  candidateThreadIds: sortedUnique(groundingCase.candidateThreadIds),
  candidateReferentIds: sortedUnique(groundingCase.candidateReferentIds),
  ambiguityClass: groundingCase.ambiguityClass,
  blockingEligible: groundingCase.blockingEligible,
  sourceProvenance: groundingCase.sourceProvenance,
  humanAudit: groundingCase.humanAudit,
  stateContract:
    groundingCase.stateContract === undefined
      ? undefined
      : normalizeStateContract(groundingCase.stateContract),
})

const sortedUnique = (values: readonly string[] | undefined): readonly string[] | undefined =>
  values === undefined ? undefined : [...new Set(values)].sort()

const normalizeStateContract = (stateContract: GroundingStateContract): GroundingStateContract => {
  const visibleThreadIds = sortedUnique(stateContract.visibleThreadIds)
  const pausedThreadIds = sortedUnique(stateContract.pausedThreadIds)
  const candidateFileIds = sortedUnique(stateContract.candidateFileIds)
  const policyMarkers = sortedUnique(stateContract.policyMarkers)
  return {
    activeThreadId: stateContract.activeThreadId,
    ...(visibleThreadIds !== undefined ? { visibleThreadIds } : {}),
    ...(pausedThreadIds !== undefined ? { pausedThreadIds } : {}),
    ...(stateContract.latestToolResultId !== undefined
      ? { latestToolResultId: stateContract.latestToolResultId }
      : {}),
    ...(stateContract.latestToolName !== undefined ? { latestToolName: stateContract.latestToolName } : {}),
    ...(candidateFileIds !== undefined ? { candidateFileIds } : {}),
    ...(stateContract.primaryFileId !== undefined ? { primaryFileId: stateContract.primaryFileId } : {}),
    ...(policyMarkers !== undefined ? { policyMarkers } : {}),
  }
}

const hasStructuredHistoryMetadata = (entry: GroundingHistoryEntry): boolean =>
  entry.kind !== undefined ||
  entry.threadId !== undefined ||
  entry.referentId !== undefined ||
  entry.mentionedFileIds !== undefined ||
  entry.mentionedReferentIds !== undefined ||
  entry.toolName !== undefined ||
  entry.mentionedThreadIds !== undefined ||
  entry.policyMarkers !== undefined

const validateSpecificFileAuthority = (groundingCase: GroundingCase): void => {
  if (groundingCase.gold.scope !== "specific_file") return
  const resolved = resolveGroundingSpecificFileContext(groundingCase)
  if (groundingCase.gold.shouldClarify === true || groundingCase.gold.intent === "clarify_request") {
    if (!resolved.isAmbiguous && resolved.candidateFileIds.length < 2 && resolved.utteranceFileIds.length < 2) {
      throw new Error(
        `grounding case ${groundingCase.id} specific_file clarify cases must expose at least two candidate files`,
      )
    }
    return
  }
  if (groundingCase.gold.referentId === null || !isGroundingFileId(groundingCase.gold.referentId)) {
    throw new Error(`grounding case ${groundingCase.id} specific_file cases must use a file referentId`)
  }
  if (resolved.resolvedReferentId !== groundingCase.gold.referentId) {
    throw new Error(
      `grounding case ${groundingCase.id} specific_file authority must resolve gold.referentId`,
    )
  }
}

const validateSpecificReferentAuthority = (groundingCase: GroundingCase): void => {
  if (groundingCase.gold.scope !== "specific_subthread" && groundingCase.gold.scope !== "latest_tool_result") return
  const resolved = resolveGroundingReferentContext(groundingCase)
  if (groundingCase.gold.shouldClarify === true) {
    if (!resolved.isAmbiguous && resolved.candidateReferentIds.length < 2) {
      throw new Error(
        `grounding case ${groundingCase.id} ambiguous referent cases must expose at least two candidate referents`,
      )
    }
    return
  }
  if (groundingCase.gold.referentId === null) {
    throw new Error(`grounding case ${groundingCase.id} ${groundingCase.gold.scope} cases must use a referentId`)
  }
  if (resolved.resolvedReferentId !== groundingCase.gold.referentId) {
    throw new Error(
      `grounding case ${groundingCase.id} ${groundingCase.gold.scope} authority must resolve gold.referentId`,
    )
  }
}

const validateStateContract = (groundingCase: GroundingCase): void => {
  const stateContract = groundingCase.stateContract
  if (stateContract === undefined) return
  if (stateContract.activeThreadId !== groundingCase.gold.activeThreadId) {
    throw new Error(
      `grounding case ${groundingCase.id} stateContract.activeThreadId must equal gold.activeThreadId`,
    )
  }
  const visibleThreadIds = sortedUnique(stateContract.visibleThreadIds)
  const pausedThreadIds = sortedUnique(stateContract.pausedThreadIds)
  if (
    stateContract.activeThreadId !== null &&
    visibleThreadIds !== undefined &&
    !visibleThreadIds.includes(stateContract.activeThreadId)
  ) {
    throw new Error(
      `grounding case ${groundingCase.id} stateContract.visibleThreadIds must include activeThreadId`,
    )
  }
  if (
    visibleThreadIds !== undefined &&
    pausedThreadIds !== undefined &&
    pausedThreadIds.some((threadId) => !visibleThreadIds.includes(threadId))
  ) {
    throw new Error(
      `grounding case ${groundingCase.id} stateContract.pausedThreadIds must be a subset of visibleThreadIds`,
    )
  }
  if (
    groundingCase.gold.scope === "latest_tool_result" &&
    stateContract.latestToolResultId !== undefined &&
    groundingCase.gold.referentId !== stateContract.latestToolResultId
  ) {
    throw new Error(
      `grounding case ${groundingCase.id} stateContract.latestToolResultId must equal gold.referentId for latest_tool_result cases`,
    )
  }
}

const validateCandidateAuthority = (groundingCase: GroundingCase): void => {
  const candidateThreads = sortedUnique(groundingCase.candidateThreadIds)
  const candidateReferents = sortedUnique(groundingCase.candidateReferentIds)
  if (
    candidateThreads !== undefined &&
    groundingCase.gold.activeThreadId !== null &&
    groundingCase.gold.shouldClarify !== true &&
    !candidateThreads.includes(groundingCase.gold.activeThreadId)
  ) {
    throw new Error(
      `grounding case ${groundingCase.id} candidateThreadIds must include gold.activeThreadId when not clarifying`,
    )
  }
  if (
    candidateReferents !== undefined &&
    groundingCase.gold.referentId !== null &&
    groundingCase.gold.shouldClarify !== true &&
    !candidateReferents.includes(groundingCase.gold.referentId)
  ) {
    throw new Error(
      `grounding case ${groundingCase.id} candidateReferentIds must include gold.referentId when not clarifying`,
    )
  }
}

const validateAmbiguityAuthority = (groundingCase: GroundingCase): void => {
  const ambiguityClass = groundingCase.ambiguityClass ?? "none"
  const candidateThreads = sortedUnique(groundingCase.candidateThreadIds) ?? []
  const candidateReferents = sortedUnique(groundingCase.candidateReferentIds) ?? []
  const candidateFiles = sortedUnique(groundingCase.stateContract?.candidateFileIds) ?? []
  switch (ambiguityClass) {
    case "none":
      return
    case "thread":
      if (candidateThreads.length < 2) {
        throw new Error(`grounding case ${groundingCase.id} thread ambiguity requires at least two candidateThreadIds`)
      }
      return
    case "file":
      if (candidateFiles.length + candidateReferents.filter(isGroundingFileId).length < 2) {
        throw new Error(`grounding case ${groundingCase.id} file ambiguity requires at least two candidate files`)
      }
      return
    case "subthread":
    case "tool_result":
      if (candidateReferents.length < 2) {
        throw new Error(`grounding case ${groundingCase.id} ${ambiguityClass} ambiguity requires at least two candidateReferentIds`)
      }
      return
  }
}

const validateBlockingGovernance = (
  groundingCase: GroundingCase,
  corpus: GroundingCorpus,
): void => {
  if (groundingCase.blockingEligible !== true) return
  if (!corpus.startsWith("replay_") && !corpus.startsWith("adversarial_")) return
  if (groundingCase.humanAudit?.status !== "reviewed") {
    throw new Error(
      `grounding case ${groundingCase.id} blocking replay/adversarial fixtures require humanAudit.status=reviewed`,
    )
  }
}

const validateSummaryEquivalencePairs = (cases: readonly GroundingCase[]): void => {
  const pairs = new Map<string, Map<"raw" | "summary", GroundingCase>>()
  for (const groundingCase of cases) {
    if (groundingCase.pairId === undefined) continue
    const role = groundingCase.pairRole as "raw" | "summary"
    if (role === "summary" && groundingCase.bucket !== "summary_equivalence") {
      throw new Error(
        `grounding pair ${groundingCase.pairId} summary case must use summary_equivalence bucket: ${groundingCase.id}`,
      )
    }
    const group = pairs.get(groundingCase.pairId) ?? new Map<"raw" | "summary", GroundingCase>()
    if (group.has(role)) {
      throw new Error(
        `grounding pair ${groundingCase.pairId} has duplicate ${role} case: ${groundingCase.id}`,
      )
    }
    group.set(role, groundingCase)
    pairs.set(groundingCase.pairId, group)
  }
  for (const [pairId, group] of pairs) {
    const raw = group.get("raw")
    const summary = group.get("summary")
    if (raw === undefined || summary === undefined) {
      throw new Error(`grounding pair ${pairId} must contain exactly one raw and one summary case`)
    }
    if (!raw.history.some(hasStructuredHistoryMetadata) || !summary.history.some(hasStructuredHistoryMetadata)) {
      throw new Error(`grounding pair ${pairId} must expose structured history metadata on both sides`)
    }
    if (stableJson(pairContract(raw)) !== stableJson(pairContract(summary))) {
      throw new Error(`grounding pair ${pairId} raw/summary contract mismatch`)
    }
  }
}

const validateCriticalBucketGovernance = (
  cases: readonly GroundingCase[],
  corpus: GroundingCorpus,
): void => {
  if (corpus !== "canary" && corpus !== "nightly") return
  const criticalBuckets = new Set(
    cases
      .filter((groundingCase) => groundingCase.severity === "critical")
      .map((groundingCase) => groundingCase.bucket),
  )
  for (const bucket of REQUIRED_CANARY_CRITICAL_BUCKETS) {
    if (!criticalBuckets.has(bucket)) {
      throw new Error(`grounding ${corpus} corpus missing critical ${bucket} case`)
    }
  }
}

const validateGroundingCases = (
  cases: readonly GroundingCase[],
  corpus: GroundingCorpus,
): void => {
  for (const groundingCase of cases) {
    validateStateContract(groundingCase)
    validateSpecificFileAuthority(groundingCase)
    validateSpecificReferentAuthority(groundingCase)
    validateCandidateAuthority(groundingCase)
    validateAmbiguityAuthority(groundingCase)
    validateBlockingGovernance(groundingCase, corpus)
  }
  validateSummaryEquivalencePairs(cases)
  validateCriticalBucketGovernance(cases, corpus)
}

const resolveCorpus = (opts: LoadGroundingCasesOpts): GroundingCorpus => {
  if (opts.corpus !== undefined) return opts.corpus
  return opts.suite ?? "canary"
}

const dirsForCorpus = (
  root: string,
  corpus: GroundingCorpus,
): readonly string[] => {
  switch (corpus) {
    case "canary":
      return [join(root, "canary")]
    case "nightly":
      return [join(root, "canary"), join(root, "nightly")]
    case "replay_critical":
      return [join(root, "replay_critical")]
    case "replay_nightly":
      return [join(root, "replay_critical"), join(root, "replay_nightly")]
    case "adversarial_canary":
      return [join(root, "adversarial_canary")]
    case "adversarial_nightly":
      return [join(root, "adversarial_canary"), join(root, "adversarial_nightly")]
  }
}

export const loadGroundingCases = (opts: LoadGroundingCasesOpts): readonly GroundingCase[] => {
  const root = opts.casesRoot ?? DEFAULT_CASES_ROOT
  const corpus = resolveCorpus(opts)
  const dirs = dirsForCorpus(root, corpus)
  const seen = new Set<string>()
  const out: GroundingCase[] = []
  for (const dir of dirs) {
    if (existsSync(dir) && !statSync(dir).isDirectory()) {
      throw new Error(`grounding cases path is not a directory: ${dir}`)
    }
    for (const file of listJson(dir)) {
      const parsed = parseGroundingCase(JSON.parse(readFileSync(file, "utf8")))
      if (parsed.corpus !== undefined && parsed.corpus !== corpus) {
        throw new Error(
          `grounding case ${parsed.id} corpus mismatch: fixture=${parsed.corpus} loader=${corpus}`,
        )
      }
      if (seen.has(parsed.id)) throw new Error(`duplicate grounding case id: ${parsed.id}`)
      seen.add(parsed.id)
      out.push({
        ...parsed,
        corpus,
      })
    }
  }
  validateGroundingCases(out, corpus)
  return out
}
