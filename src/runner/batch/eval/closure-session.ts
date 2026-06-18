import {
  assembleClosureBundle,
  buildPatchHygiene,
  buildPrimaryRailStep,
  renderClosurePrompt,
  type ClosureBundle,
  type ClosureBundleInput,
  type PatchHygieneReport,
  type PrimaryRailStep,
} from "@/agent/closure"
import { extractIssueHint } from "@/agent/issue-hint"
import {
  extractIssueDeclaredExpected,
  type IssueDeclaredExpected,
} from "@/agent/verification-plan"

export interface ClosureSessionPosture {
  lspNav: boolean
  primaryRail: boolean
  faultEvidence: boolean
}

export interface Stage1RankedFile {
  file: string
  score: number
}

export interface ClosureSessionState {
  input: ClosureBundleInput
  bundle: ClosureBundle
  issueDeclaredExpected?: IssueDeclaredExpected
  primaryRailStep?: PrimaryRailStep
  closureHint?: string
}

export const buildClosureSession = (args: {
  problemStatement: string
  stage1Files: readonly Stage1RankedFile[]
  issueFiles?: readonly string[]
  ownerResolved?: readonly { file: string; forSymbol: string }[]
  reproScript?: { cmd: string; baseValidatedRed: boolean }
  posture: ClosureSessionPosture
}): ClosureSessionState => {
  const issueDeclaredExpected = extractIssueDeclaredExpected(args.problemStatement)
  const issueFiles = args.issueFiles ?? extractIssueHint(args.problemStatement).files
  const input: ClosureBundleInput = {
    evidence: {
      issueText: args.problemStatement,
      stage1Files: args.stage1Files,
      ...(issueFiles.length > 0 ? { issueFiles } : {}),
      ...(args.ownerResolved !== undefined ? { ownerResolved: args.ownerResolved } : {}),
    },
    plan: {
      ...(args.reproScript !== undefined ? { reproScript: args.reproScript } : {}),
      ...(issueDeclaredExpected !== undefined ? { issueDeclaredExpected } : {}),
    },
    gate: {
      stakes: { patchFileCount: 1, crossFile: false, destructive: false },
      uncertainty: { sampleDisagreement: false, unresolvedSymbols: false },
      signal: {
        reproAvailable: args.reproScript?.baseValidatedRed === true,
        lspAvailable: args.posture.lspNav,
      },
      issueProvidesFix: issueDeclaredExpected !== undefined,
    },
  }
  const bundle = assembleClosureBundle(input)
  const primaryRailStep = args.posture.primaryRail
    ? buildPrimaryRailStep(bundle.plan.primaryRail)
    : undefined
  const closureHint = args.posture.faultEvidence ? renderClosurePrompt(bundle.owner) : undefined
  return {
    input,
    bundle,
    ...(issueDeclaredExpected !== undefined ? { issueDeclaredExpected } : {}),
    ...(primaryRailStep !== undefined ? { primaryRailStep } : {}),
    ...(closureHint !== undefined && closureHint !== "" ? { closureHint } : {}),
  }
}

export const buildPhasePatchHygiene = (
  patch: string,
  ownerHint: string | undefined,
): PatchHygieneReport =>
  buildPatchHygiene(patch, {
    ...(ownerHint !== undefined ? { ownerFiles: [ownerHint] } : {}),
  })
