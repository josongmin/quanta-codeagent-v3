import { defsInSource, type OwnerSibling } from "@/agent/closure"
import { extractIssueHint } from "@/agent/issue-hint"
import { normalizePublicIssueText } from "@/shared"
import type { BenchReproTestTelemetry } from "../types"
import {
  buildCandidateFamilyBundleFromWitness,
  withStaticWitnessFamilies,
} from "./candidate-families"
import type { BenchPosture } from "./knobs-bench"
import {
  buildSelectionGenerationPrompt,
  buildSelectionOwnerEvidence,
  type LlmEvidencePacket,
  type SelectionGenerationPromptInput,
  type VerificationTargetFact,
} from "./llm-evidence-packet"
import { mergeSelectionContractBundles } from "./public-contract-bundle"
import type { SelectionContractBundle } from "./public-contract-types"
import { renderContractAuthorityLabel } from "./public-contract-types"
import { buildSelectionInputs, normalizeSelectionPaths } from "./selection-executor"
import { buildAstStaticWitnesses, staticWitnessLanguageDiagnostics } from "./static-witness-adapter"
import { buildStaticWitnessContracts } from "./static-witness-contracts"

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const issueMentionsSymbol = (issueText: string, symbol: string): boolean =>
  new RegExp(`\\b${escapeRegex(symbol)}\\b`).test(issueText)

export const buildSelectionCandidateFamilyBundle = (args: {
  readonly problemStatement: string
  readonly ownerCandidates: readonly string[]
  readonly ownerResolved: readonly OwnerSibling[] | undefined
  readonly readSource: (relFile: string) => string | null
}) => {
  const problemStatement = normalizePublicIssueText(args.problemStatement) ?? args.problemStatement
  const symbolOwners = args.ownerCandidates.flatMap((file) => {
    const source = args.readSource(file)
    if (source === null) return []
    const symbols = defsInSource(source).filter((symbol) =>
      issueMentionsSymbol(problemStatement, symbol),
    )
    return symbols.length === 0 ? [] : [{ file, symbols }]
  })
  return buildCandidateFamilyBundleFromWitness({
    symbolOwners,
    ownerResolved: args.ownerResolved ?? [],
  })
}

export const withCandidateFamilyAuthorityContracts = (
  publicContracts: SelectionContractBundle | undefined,
  _candidateFamilyBundle: ReturnType<typeof buildSelectionCandidateFamilyBundle> | undefined,
): SelectionContractBundle | undefined =>
  // Candidate families are structural search hints only. They may seed
  // localization/generation/repair, but they do not mint required contracts
  // without executable public proof.
  publicContracts

export interface SelectionStructuralPlanArgs {
  readonly problemStatement: string
  readonly sandbox: string
  readonly selectionOwnerCandidates: readonly string[]
  readonly ownerResolved: readonly OwnerSibling[] | undefined
  readonly publicContracts: SelectionContractBundle | undefined
  readonly n: number
  readonly readSource: (rel: string) => string | null
}

export const buildSelectionStructuralPlan = (args: SelectionStructuralPlanArgs) => {
  const normalizedOwnerCandidates = normalizeSelectionPaths(
    args.selectionOwnerCandidates,
    args.sandbox,
  )
  const staticWitnessInput = {
    problemStatement: args.problemStatement,
    ownerCandidates: normalizedOwnerCandidates,
    ...(args.ownerResolved !== undefined ? { ownerResolved: args.ownerResolved } : {}),
    readSource: args.readSource,
  }
  const staticWitnesses = buildAstStaticWitnesses(staticWitnessInput)
  const staticWitnessDiagnostics = staticWitnessLanguageDiagnostics(staticWitnessInput)
  const candidateFamilyBundle = withStaticWitnessFamilies(
    buildSelectionCandidateFamilyBundle({
      problemStatement: args.problemStatement,
      ownerCandidates: normalizedOwnerCandidates,
      ownerResolved: args.ownerResolved,
      readSource: args.readSource,
    }),
    staticWitnesses,
  )
  const selectionAuthorityContracts = withCandidateFamilyAuthorityContracts(
    args.publicContracts,
    candidateFamilyBundle,
  )
  const advisoryPromptContracts = mergeSelectionContractBundles(selectionAuthorityContracts, {
    contracts: buildStaticWitnessContracts(staticWitnesses),
  })
  const selectionInputs = buildSelectionInputs({
    n: args.n,
    ownerCandidates: normalizedOwnerCandidates,
    sandbox: args.sandbox,
    ...(candidateFamilyBundle !== undefined ? { candidateFamilies: candidateFamilyBundle } : {}),
  })
  return {
    advisoryPromptContracts,
    candidateFamilyBundle,
    normalizedOwnerCandidates,
    selectionAuthorityContracts,
    selectionInputs,
    staticWitnesses,
    staticWitnessDiagnostics,
  }
}

export const selectionGenerationEnvCaveats = (args: {
  readonly reproHint: string | undefined
  readonly reproTest: BenchReproTestTelemetry | undefined
}): readonly string[] => {
  if (args.reproHint !== undefined && args.reproHint.trim() !== "") return []
  const repro = args.reproTest
  if (repro === undefined || repro.installed) return []
  switch (repro.reason) {
    case "not_installed":
      return [
        "public repro helper is unavailable in this runtime; no executable public repro command is attached",
      ]
    case "generation_failed":
      return [
        "public repro helper synthesis failed before execution; no executable public repro command is attached",
      ]
    case "generation_empty":
      return [
        "public repro helper synthesis produced no runnable script; no executable public repro command is attached",
      ]
    case "write_failed":
      return [
        "public repro helper could not be written into the sandbox; no executable public repro command is attached",
      ]
    case "execution_failed":
      return [
        "attempted public repro helper failed to execute on the base environment; no executable public repro command is attached",
      ]
    case "no_reproduced_candidate":
      return [
        "generated public repro helpers did not reproduce on the base environment; no executable public repro command is attached",
      ]
    default:
      return []
  }
}

const mergeSelectionHint = (
  closureHint: string | undefined,
  seed: string | undefined,
): string | undefined => {
  if (seed === undefined) return closureHint
  return closureHint === undefined ? seed : `${closureHint}\n\n${seed}`
}

const contractFactsFromBundle = (
  contracts: SelectionContractBundle | undefined,
): NonNullable<SelectionGenerationPromptInput["contracts"]> =>
  contracts?.contracts.map((contract) => ({
    contractId: contract.contractId,
    authority: renderContractAuthorityLabel(contract),
    satisfied: "unknown" as const,
  })) ?? []

export interface SelectionPromptAssemblyArgs {
  readonly verifySelectProofRequired: boolean
  readonly selectorMode: BenchPosture["selectorMode"]
  readonly problemStatement: string
  readonly ownerEvidence: SelectionGenerationPromptInput["ownerEvidence"]
  readonly promptContracts: SelectionContractBundle | undefined
  readonly baseValidatedRed: boolean | null
  readonly verificationTarget?: VerificationTargetFact
  readonly reproHint?: string
  readonly validatedReproScripts: readonly string[]
  readonly existingTestExpectations: readonly string[]
  readonly closureHint?: string
  readonly envCaveats: readonly string[]
  readonly staticWitnessDiagnostics: NonNullable<
    SelectionGenerationPromptInput["staticWitnessDiagnostics"]
  >
  readonly recordLlmEvidencePacket?: (packet: LlmEvidencePacket) => void
}

export const cleanSelectionPromptEnabled = (args: SelectionPromptAssemblyArgs): boolean =>
  args.verifySelectProofRequired && args.selectorMode === "clean"

export const selectionGenerationPromptInput = (
  args: SelectionPromptAssemblyArgs,
  seed: string | undefined,
): SelectionGenerationPromptInput => ({
  problemStatement: args.problemStatement,
  ownerEvidence: args.ownerEvidence,
  contracts: contractFactsFromBundle(args.promptContracts),
  baseValidatedRed: args.baseValidatedRed,
  ...(args.verificationTarget !== undefined ? { verificationTarget: args.verificationTarget } : {}),
  ...(args.reproHint !== undefined ? { reproCommand: args.reproHint } : {}),
  ...(args.validatedReproScripts.length > 0
    ? { validatedReproScripts: args.validatedReproScripts }
    : {}),
  ...(args.existingTestExpectations.length > 0
    ? { existingTestExpectations: args.existingTestExpectations }
    : {}),
  ...(args.closureHint !== undefined ? { closureHint: args.closureHint } : {}),
  ...(args.envCaveats.length > 0 ? { envCaveats: args.envCaveats } : {}),
  ...(args.staticWitnessDiagnostics.length > 0
    ? { staticWitnessDiagnostics: args.staticWitnessDiagnostics }
    : {}),
  ...(seed !== undefined ? { seed } : {}),
  ...(args.recordLlmEvidencePacket !== undefined
    ? { recordLlmEvidencePacket: args.recordLlmEvidencePacket }
    : {}),
})

export const composeSelectionAgentHint = (
  args: SelectionPromptAssemblyArgs,
  seed: string | undefined,
): string | undefined =>
  cleanSelectionPromptEnabled(args)
    ? buildSelectionGenerationPrompt(selectionGenerationPromptInput(args, seed))
    : mergeSelectionHint(args.closureHint, seed)

export interface SelectionEvidenceContextArgs {
  readonly problemStatement: string
  readonly sandbox: string
  readonly n: number
  readonly ownerCandidates: readonly string[]
  readonly ownerResolved: readonly OwnerSibling[] | undefined
  readonly publicContracts: SelectionContractBundle | undefined
  readonly verifySelectRegression: BenchPosture["verifySelectRegression"]
  readonly baseValidatedRed: boolean
  readonly reproHint: string | undefined
  readonly reproTest: BenchReproTestTelemetry | undefined
  readonly verificationTarget: VerificationTargetFact | undefined
  readonly oracleFailureRepairSeed: string | undefined
  readonly existingTestExpectations: readonly string[]
  readonly readSource: (rel: string) => string | null
}

export interface SelectionEvidenceContext {
  readonly normalizedOwnerCandidates: readonly string[]
  readonly selectionInputs: ReturnType<typeof buildSelectionInputs>
  readonly staticWitnesses: ReturnType<typeof buildAstStaticWitnesses>
  readonly candidateFamilyBundle: ReturnType<typeof buildSelectionCandidateFamilyBundle>
  readonly selectionAuthorityContracts: SelectionContractBundle | undefined
  readonly advisoryPromptContracts: SelectionContractBundle | undefined
  readonly selectionOwnerEvidence: SelectionGenerationPromptInput["ownerEvidence"]
  readonly verificationTarget: VerificationTargetFact | undefined
  readonly existingTestExpectations: readonly string[]
  readonly staticWitnessDiagnostics: NonNullable<
    SelectionGenerationPromptInput["staticWitnessDiagnostics"]
  >
  readonly selectionBaseValidatedRed: boolean | null
  readonly generationEnvCaveats: readonly string[]
  readonly oracleFailureRepairSeed: string | undefined
}

export const prepareSelectionEvidenceContext = (
  args: SelectionEvidenceContextArgs,
): SelectionEvidenceContext => {
  const structural = buildSelectionStructuralPlan({
    problemStatement: args.problemStatement,
    sandbox: args.sandbox,
    selectionOwnerCandidates: args.ownerCandidates,
    ownerResolved: args.ownerResolved,
    publicContracts: args.publicContracts,
    n: args.n,
    readSource: args.readSource,
  })
  return {
    normalizedOwnerCandidates: structural.normalizedOwnerCandidates,
    selectionInputs: structural.selectionInputs,
    staticWitnesses: structural.staticWitnesses,
    candidateFamilyBundle: structural.candidateFamilyBundle,
    selectionAuthorityContracts: structural.selectionAuthorityContracts,
    advisoryPromptContracts: structural.advisoryPromptContracts,
    selectionOwnerEvidence: buildSelectionOwnerEvidence({
      ownerFiles: structural.selectionInputs.ownerFiles,
      issueSymbols: extractIssueHint(args.problemStatement).symbols,
      staticWitnesses: structural.staticWitnesses,
      readSource: args.readSource,
    }),
    verificationTarget: args.verificationTarget,
    existingTestExpectations: args.existingTestExpectations,
    staticWitnessDiagnostics: structural.staticWitnessDiagnostics,
    selectionBaseValidatedRed:
      args.verifySelectRegression === "discovered" ? null : args.baseValidatedRed,
    generationEnvCaveats: selectionGenerationEnvCaveats({
      reproHint: args.reproHint,
      reproTest: args.reproTest,
    }),
    oracleFailureRepairSeed: args.oracleFailureRepairSeed,
  }
}
