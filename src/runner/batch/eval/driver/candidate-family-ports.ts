/**
 * Candidate-FAMILY inference + selection PORT helpers (pure code motion from
 * `driver.ts`, byte-identical). Owns the repair-family preference/derivation
 * helpers (which co-edited file set a candidate belongs to), the structural
 * repair derivation (`deriveCandidateStructuralRepair`), the public-contract
 * family alias, and the regression / static-sanity selection port factories
 * (`makeSelectionRegressionPort` / `makeSelectionStaticSanityPort`). A leaf over
 * `./context-types` + selection siblings — no driver orchestration cycle.
 */

import { resolveOwnerSiblings } from "@/agent/closure"
import type { Instance } from "../../types"
import {
  type CandidateFamily,
  candidateFamilyCoverageMissing,
  isCoChangeFamily,
} from "../candidate-families"
import {
  buildMultisiteSteer,
  type ChaRepairTarget,
  findSiblingOverrideSites,
} from "../cha-multisite"
import { diffTouchedSymbols } from "../diff-touched-symbols"
import { exec } from "../exec"
import type { BenchPosture } from "../knobs-bench"
import { probePatchStaticSanity } from "../patch-static-sanity"
import { toRegressionGreen } from "../regression-oracle"
import { makeBenchRegressionOracle } from "../regression-oracle-adapter"
import { withCandidatePatch } from "../rematerialize"
import {
  buildSelectionStructuralPlan,
  withCandidateFamilyAuthorityContracts,
} from "../selection-assembly"
import type {
  Candidate,
  DerivedCandidateStructuralRepair,
  SelectionPorts,
} from "../selection-executor"
import { cleanUniqueList, readSandboxSource, stage1FilesOf } from "./context-types"

const betterRepairFamily = (
  candidateFiles: readonly string[],
  left: CandidateFamily | undefined,
  right: CandidateFamily,
): CandidateFamily => {
  if (left === undefined) return right
  const leftMissing = candidateFamilyCoverageMissing(left, candidateFiles).length
  const rightMissing = candidateFamilyCoverageMissing(right, candidateFiles).length
  if (rightMissing !== leftMissing) return rightMissing > leftMissing ? right : left
  if (right.ownerFiles.length !== left.ownerFiles.length)
    return right.ownerFiles.length > left.ownerFiles.length ? right : left
  return left
}

const familyFromChaRepairTarget = (target: ChaRepairTarget): CandidateFamily => ({
  familyId: "override-family",
  ownerFiles: cleanUniqueList([target.file, ...target.sites.map((site) => site.file)]),
  reason: `override-family (CHA sibling override): \`${target.method}\` overridden by sibling classes sharing a base`,
  seed: buildMultisiteSteer(target.method, target.sites),
  sourceEvidence: ["cha-multisite:python-ast"],
})

const preferredChaFamily = (
  candidateFiles: readonly string[],
  preferredTargets: readonly ChaRepairTarget[],
): CandidateFamily | undefined => {
  let best: CandidateFamily | undefined
  const matchingTargets = preferredTargets.filter((target) =>
    cleanUniqueList([target.file, ...target.sites.map((site) => site.file)]).some((file) =>
      candidateFiles.includes(file),
    ),
  )
  for (const target of matchingTargets) {
    const family = familyFromChaRepairTarget(target)
    if (candidateFamilyCoverageMissing(family, candidateFiles).length === 0) continue
    best = betterRepairFamily(candidateFiles, best, family)
  }
  return best
}

const structuralRepairFamilyFromSelection = (
  candidateFiles: readonly string[],
  candidateFamilies: readonly (CandidateFamily | undefined)[],
): CandidateFamily | undefined => {
  const families = candidateFamilies.filter(
    (family): family is CandidateFamily => family !== undefined,
  )
  if (families.length === 0) return undefined
  let bestMissing: CandidateFamily | undefined
  let fallback: CandidateFamily | undefined
  for (const family of families) {
    if (fallback === undefined) fallback = family
    if (!isCoChangeFamily(family.familyId)) continue
    if (candidateFamilyCoverageMissing(family, candidateFiles).length === 0) continue
    bestMissing = betterRepairFamily(candidateFiles, bestMissing, family)
  }
  return bestMissing ?? fallback
}

const deriveChaOverrideFamily = async (args: {
  readonly instance: Instance
  readonly candidate: Candidate
  readonly sandbox: string
  readonly preferredTargets?: readonly ChaRepairTarget[]
  readonly siblingMode: "path-hardcoded" | "general"
}): Promise<CandidateFamily | undefined> => {
  if (args.candidate.patch.trim() === "" || args.candidate.files.length === 0) return undefined
  let best = preferredChaFamily(args.candidate.files, args.preferredTargets ?? [])
  const touchedSymbols = diffTouchedSymbols(args.candidate.patch)
  if (touchedSymbols.length === 0) return best
  const chaExec = (cmd: string, cwd: string, timeoutMs: number) =>
    exec(
      cmd,
      cwd,
      timeoutMs,
      args.instance.localEnv !== undefined ? { localEnv: args.instance.localEnv } : undefined,
    )
  for (const targetFile of args.candidate.files) {
    for (const symbol of touchedSymbols) {
      const sites = await findSiblingOverrideSites({
        exec: chaExec,
        repoRoot: args.sandbox,
        targetRelFile: targetFile,
        method: symbol,
        siblingMode: args.siblingMode,
      })
      if (sites.length === 0) continue
      const family = familyFromChaRepairTarget({ file: targetFile, method: symbol, sites })
      if (candidateFamilyCoverageMissing(family, args.candidate.files).length === 0) continue
      best = betterRepairFamily(args.candidate.files, best, family)
    }
  }
  return best
}

export const deriveCandidateStructuralRepair = async (args: {
  readonly instance: Instance
  readonly candidate: Candidate
  readonly sandbox: string
  readonly signal: AbortSignal
  readonly preferredTargets?: readonly ChaRepairTarget[]
  readonly siblingMode?: "path-hardcoded" | "general"
}): Promise<DerivedCandidateStructuralRepair | undefined> => {
  if (args.candidate.files.length === 0) return undefined
  const ownerResolved = await resolveOwnerSiblings()({
    stage1Files: stage1FilesOf(args.candidate.files),
    issueText: args.instance.problemStatement,
    cwd: args.sandbox,
    readSource: (rel) => readSandboxSource(args.sandbox, rel),
    signal: args.signal,
  })
  const selectionOwnerCandidates = cleanUniqueList([
    ...args.candidate.files,
    ...ownerResolved.map((owner) => owner.file),
  ])
  const structural = buildSelectionStructuralPlan({
    problemStatement: args.instance.problemStatement,
    sandbox: args.sandbox,
    selectionOwnerCandidates,
    ownerResolved,
    publicContracts: undefined,
    n: 2,
    readSource: (rel) => readSandboxSource(args.sandbox, rel),
  })
  const chaFamily = await deriveChaOverrideFamily({
    ...args,
    siblingMode: args.siblingMode ?? "path-hardcoded",
  })
  const plannedStructuralFamily = structuralRepairFamilyFromSelection(
    args.candidate.files,
    structural.selectionInputs.candidateFamilies,
  )
  const family =
    chaFamily === undefined
      ? plannedStructuralFamily
      : betterRepairFamily(args.candidate.files, plannedStructuralFamily, chaFamily)
  if (family === undefined && structural.advisoryPromptContracts === undefined) return undefined
  return {
    ...(family !== undefined ? { family } : {}),
    ...(structural.advisoryPromptContracts !== undefined
      ? { advisoryContracts: structural.advisoryPromptContracts }
      : {}),
  }
}

export const withCandidateFamilyPublicContracts = withCandidateFamilyAuthorityContracts

export const makeSelectionRegressionPort = (args: {
  readonly verifySelectRegression: BenchPosture["verifySelectRegression"]
  readonly discoveredRegressionPort: SelectionPorts["regression"] | undefined
  readonly instance: Instance
  readonly sandbox: string
  readonly timeoutMs: number
}): NonNullable<SelectionPorts["regression"]> => {
  return (candidate) => {
    // FAIL-CLOSED (jun-22): unset ⇒ `off`. The hidden PASS_TO_PASS branch below
    // reads the grader's answer-key regression set, so it must require an EXPLICIT
    // opt-in (the `gold`/`pass-to-pass` mode). Previously `undefined` fell through
    // to it AND escaped the contamination tagger — a one-forgotten-preset-line
    // answer-key leak. Now only an explicit non-off/non-discovered mode reaches it.
    if (args.verifySelectRegression === "off" || args.verifySelectRegression === undefined)
      return Promise.resolve(null)
    if (args.verifySelectRegression === "discovered") {
      return args.discoveredRegressionPort?.(candidate) ?? Promise.resolve(null)
    }
    const tests = args.instance.swebench?.passToPass ?? []
    if (tests.length === 0) return Promise.resolve(null)
    return withCandidatePatch({
      sandbox: args.sandbox,
      patch: candidate.patch,
      baseCommit: args.instance.swebench?.baseCommit,
      ...(args.instance.swebench?.repo !== undefined ? { repo: args.instance.swebench.repo } : {}),
      timeoutMs: args.timeoutMs,
      probe: async (sb) => {
        const r = await makeBenchRegressionOracle(
          undefined,
          args.instance.localEnv !== undefined ? { localEnv: args.instance.localEnv } : {},
        )
          .run({ tests, sandbox: sb })
          .catch(() => null)
        return toRegressionGreen(tests, r)
      },
    })
  }
}

export const makeSelectionStaticSanityPort = (args: {
  readonly sandbox: string
  readonly baseCommit: string | undefined
  readonly timeoutMs: number
}): NonNullable<SelectionPorts["staticSanity"]> => {
  return (candidate) =>
    withCandidatePatch({
      sandbox: args.sandbox,
      patch: candidate.patch,
      baseCommit: args.baseCommit,
      timeoutMs: args.timeoutMs,
      probe: (sb) =>
        probePatchStaticSanity({
          cwd: sb,
          files: candidate.files,
          timeoutMs: args.timeoutMs,
          patch: candidate.patch,
        }),
    }).catch(() => null)
}
