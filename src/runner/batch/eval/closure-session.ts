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

export const buildClosureSession = (args: {
  problemStatement: string
  stage1Files: readonly Stage1RankedFile[]
  issueFiles?: readonly string[]
  ownerResolved?: readonly { file: string; forSymbol: string }[]
  /** SCAFF-03 — authoritative owner files digested from typed-relation static
   *  witnesses (see `witnessAuthoritativeOwners`). Omitted/empty ⇒ no witness
   *  owners (byte-identical to before SCAFF-03). */
  witnessOwners?: readonly { file: string; forSymbol?: string }[]
  reproScript?: { cmd: string; baseValidatedRed: boolean }
  posture: ClosureSessionPosture
  /** T-OWN-12: opt into rule-based clean owner admission (authoritative/advisory
   *  lattice, no additive score). Default/omitted ⇒ legacy scored behavior,
   *  byte-identical to research mode. */
  ownerClean?: boolean
}): ClosureSessionState => {
  const issueDeclaredExpected = extractIssueDeclaredExpected(args.problemStatement)
  const issueFiles = args.issueFiles ?? extractIssueHint(args.problemStatement).files
  const input: ClosureBundleInput = {
    evidence: {
      issueText: args.problemStatement,
      stage1Files: args.stage1Files,
      ...(issueFiles.length > 0 ? { issueFiles } : {}),
      ...(args.ownerResolved !== undefined ? { ownerResolved: args.ownerResolved } : {}),
      // SCAFF-03: witness owners feed ONLY the rule-based CLEAN path. In legacy/
      // research mode (ownerClean falsy) they are withheld so the scored owner
      // packet stays BYTE-IDENTICAL — a `static-witness` source would otherwise
      // perturb legacy score/corroboration (T-OWN-12 "research unchanged").
      ...(args.ownerClean === true && args.witnessOwners && args.witnessOwners.length > 0
        ? { witnessOwners: args.witnessOwners }
        : {}),
    },
    ...(args.ownerClean === true ? { ownerClean: true } : {}),
    plan: {
      ...(args.reproScript !== undefined ? { reproScript: args.reproScript } : {}),
      ...(issueDeclaredExpected !== undefined ? { issueDeclaredExpected } : {}),
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
  // Pass the feeder's resolved sibling files so the round-0 hint can list every
  // co-change site (WS2 widen at round 0 — the round that always runs).
  const closureHint = args.posture.faultEvidence
    ? renderClosurePrompt(
        bundle.owner,
        (args.ownerResolved ?? []).map((o) => o.file),
      )
    : undefined
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
