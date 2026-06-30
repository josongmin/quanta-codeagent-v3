import {
  assembleClosureBundle,
  buildPatchHygiene,
  buildPrimaryRailStep,
  type ClosureBundle,
  type ClosureBundleInput,
  type PatchHygieneReport,
  type PrimaryRailStep,
  renderClosurePrompt,
} from "@/agent/closure"
import { extractIssueHint } from "@/agent/issue-hint"
import { extractIssueDeclaredExpected, type IssueDeclaredExpected } from "@/agent/verification-plan"

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

type BuildClosureSessionArgs = {
  problemStatement: string
  stage1Files: readonly Stage1RankedFile[]
  issueFiles?: readonly string[]
  ownerResolved?: readonly { file: string; forSymbol: string }[]
  /** SCAFF-03 — structural owner candidates digested from typed-relation static
   *  witnesses. They stay advisory in clean owner admission; omitted/empty ⇒ no
   *  witness owner evidence (byte-identical to before SCAFF-03). */
  witnessOwners?: readonly { file: string; forSymbol?: string }[]
  reproScript?: { cmd: string; baseValidatedRed: boolean; pytestReportPath?: string }
  ownerNearTests?: readonly string[]
  /** Base-tree RED proof for the PRIMARY owner-test fallback rail. */
  ownerNearPrimaryBaseValidatedRed?: boolean
  /** Public repo-local verifier fallback (module-smoke rail). */
  touchedModuleSmoke?: readonly string[]
  /** Base-tree RED proof for the PRIMARY module-smoke fallback rail. */
  moduleSmokePrimaryBaseValidatedRed?: boolean
  posture: ClosureSessionPosture
  /** T-OWN-12: opt into rule-based clean owner admission (authoritative/advisory
   *  lattice, no additive score). Default/omitted ⇒ legacy scored behavior,
   *  byte-identical to research mode. */
  ownerClean?: boolean
}

const sessionIssueFilesOf = (args: BuildClosureSessionArgs): readonly string[] =>
  args.issueFiles ?? extractIssueHint(args.problemStatement).files

const sessionWitnessOwnersOf = (
  args: BuildClosureSessionArgs,
): ClosureBundleInput["evidence"]["witnessOwners"] =>
  args.ownerClean === true && args.witnessOwners && args.witnessOwners.length > 0
    ? args.witnessOwners
    : undefined

const closureBundleInputOf = (args: {
  readonly session: BuildClosureSessionArgs
  readonly issueDeclaredExpected: IssueDeclaredExpected | undefined
  readonly issueFiles: readonly string[]
}): ClosureBundleInput => {
  const witnessOwners = sessionWitnessOwnersOf(args.session)
  return {
    evidence: {
      issueText: args.session.problemStatement,
      stage1Files: args.session.stage1Files,
      ...(args.issueFiles.length > 0 ? { issueFiles: args.issueFiles } : {}),
      ...(args.session.ownerResolved !== undefined
        ? { ownerResolved: args.session.ownerResolved }
        : {}),
      // SCAFF-03: witness owners feed ONLY the rule-based CLEAN path as advisory
      // structural evidence. In legacy/research mode (ownerClean falsy) they are
      // withheld so the scored owner packet stays BYTE-IDENTICAL (T-OWN-12
      // "research unchanged").
      ...(witnessOwners !== undefined ? { witnessOwners } : {}),
    },
    ...(args.session.ownerClean === true ? { ownerClean: true } : {}),
    plan: {
      ...(args.session.reproScript !== undefined ? { reproScript: args.session.reproScript } : {}),
      ...(args.session.ownerNearTests !== undefined && args.session.ownerNearTests.length > 0
        ? { ownerNearTests: args.session.ownerNearTests }
        : {}),
      ...(args.session.ownerNearPrimaryBaseValidatedRed === true
        ? { ownerNearPrimaryBaseValidatedRed: true }
        : {}),
      ...(args.session.touchedModuleSmoke !== undefined && args.session.touchedModuleSmoke.length > 0
        ? { touchedModuleSmoke: args.session.touchedModuleSmoke }
        : {}),
      ...(args.session.moduleSmokePrimaryBaseValidatedRed === true
        ? { moduleSmokePrimaryBaseValidatedRed: true }
        : {}),
      ...(args.issueDeclaredExpected !== undefined
        ? { issueDeclaredExpected: args.issueDeclaredExpected }
        : {}),
    },
    gate: {
      // `stakes` (crossFile / destructive / patchFileCount) are PRE-PATCH
      // UNKNOWABLE at session assembly: the gate runs BEFORE the agent writes a
      // single hunk, so the eventual patch's file count, cross-file spread, and
      // destructiveness do not yet exist. We deliberately do NOT fabricate them
      // — pinning them neutral keeps highStakes(s) honest (false until a real
      // post-patch stakes signal is wired) rather than guessing high/low. The
      // live anti-under-verify axis is `uncertainty`, which assembleClosureBundle
      // OR-derives from REAL owner-admission evidence (coverageExpectation !==
      // "single-site" ⇒ uncertain), so the verify-vs-commit gate is NOT reduced
      // to a repro-availability check — it still routes ambiguous/owner-family
      // localizations to `verify`. Because both stakes fields here are neutral,
      // the gate's `structure` LSP source (which needs crossFile||unresolvedSymbols)
      // is unreachable FROM THIS SITE today; that source stays live for callers
      // that supply real structural signals — it is intentionally inert here, not
      // dead in gate-decision.
      stakes: { patchFileCount: 1, crossFile: false, destructive: false },
      uncertainty: { sampleDisagreement: false, unresolvedSymbols: false },
      signal: {
        // GateDecision's `reproAvailable` bit is the practical "cheap execution
        // rail already exists" signal. Base-red owner-test / module-smoke
        // fallback rails are the same class of external execution evidence for
        // commit-vs-verify purposes.
        reproAvailable:
          args.session.reproScript?.baseValidatedRed === true ||
          args.session.ownerNearPrimaryBaseValidatedRed === true ||
          args.session.moduleSmokePrimaryBaseValidatedRed === true,
        lspAvailable: args.session.posture.lspNav,
      },
      issueProvidesFix: args.issueDeclaredExpected !== undefined,
    },
  }
}

const closureHintOf = (args: {
  readonly bundle: ClosureBundle
  readonly session: BuildClosureSessionArgs
}): string | undefined =>
  args.session.posture.faultEvidence
    ? renderClosurePrompt(
        args.bundle.owner,
        (args.session.ownerResolved ?? []).map((o) => o.file),
      )
    : undefined

export const buildClosureSession = (args: BuildClosureSessionArgs): ClosureSessionState => {
  const issueDeclaredExpected = extractIssueDeclaredExpected(args.problemStatement)
  const issueFiles = sessionIssueFilesOf(args)
  const input = closureBundleInputOf({ session: args, issueDeclaredExpected, issueFiles })
  const bundle = assembleClosureBundle(input)
  const primaryRailStep = args.posture.primaryRail
    ? buildPrimaryRailStep(bundle.plan.primaryRail)
    : undefined
  // Pass the feeder's resolved sibling files so the round-0 hint can list every
  // co-change site (WS2 widen at round 0 — the round that always runs).
  const closureHint = closureHintOf({ bundle, session: args })
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
