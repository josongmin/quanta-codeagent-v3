import { rm } from "node:fs/promises"
import { join } from "node:path"
import {
  extractIssueReproSeed,
  type IssueReproSeed,
} from "@/agent/verification-plan/extract-issue-repro"
import { reproRunArgv } from "../corpus/dataset"
import type { Instance } from "../types"
import { execArgv } from "./exec"
import { resetToBase, withCandidatePatch } from "./rematerialize"
import type { Candidate } from "./selection-executor"

const ISSUE_SMOKE_FILE = ".quanta-issue-smoke.py"

type SmokeExecPort = (
  argv: readonly string[],
  cwd: string,
  timeoutMs: number,
) => Promise<{ code: number; stdout: string; stderr: string }>

type SmokeWriteFilePort = (path: string, content: string) => Promise<void>
type SmokeRemoveFilePort = (path: string) => Promise<void>

export interface RunIssueSmokeScriptDeps {
  readonly exec?: SmokeExecPort
  readonly writeFile?: SmokeWriteFilePort
  readonly removeFile?: SmokeRemoveFilePort
}

const smokeExec =
  (instance: Pick<Instance, "localEnv">): SmokeExecPort =>
  (argv, cwd, timeoutMs) =>
    execArgv(argv, cwd, timeoutMs, {
      ...(instance.localEnv !== undefined ? { localEnv: instance.localEnv } : {}),
    })

const smokeArgv = (instance: Pick<Instance, "swebench">, scriptPath: string): readonly string[] =>
  instance.swebench?.repo !== undefined
    ? reproRunArgv(instance.swebench.repo, instance.swebench.version, scriptPath)
    : ["python3", scriptPath]

const defaultWriteFile: SmokeWriteFilePort = async (path, content) => {
  await Bun.write(path, content)
}

const defaultRemoveFile: SmokeRemoveFilePort = async (path) => {
  await rm(path, { force: true })
}

/**
 * Run the PUBLIC issue MWE as a cheap keep-green smoke. This is not a fix oracle:
 * exit 0 only means "the candidate did not break the public import/hot-path
 * smoke"; non-zero is a real negative signal, while setup/exec failures stay
 * fail-open (`null`).
 */
export const runIssueSmokeScript = async (
  instance: Pick<Instance, "localEnv" | "swebench">,
  sandbox: string,
  source: string,
  timeoutMs: number,
  deps: RunIssueSmokeScriptDeps = {},
): Promise<boolean | null> => {
  if (source.trim() === "") return null
  const path = join(sandbox, ISSUE_SMOKE_FILE)
  try {
    await (deps.writeFile ?? defaultWriteFile)(path, source)
  } catch {
    return null
  }
  try {
    const exec = deps.exec ?? smokeExec(instance)
    const r = await exec(smokeArgv(instance, path), sandbox, timeoutMs)
    return typeof r.code === "number" ? r.code === 0 : false
  } catch {
    return null
  } finally {
    await (deps.removeFile ?? defaultRemoveFile)(path).catch(() => {})
  }
}

export interface PrepareIssueSmokeSelectionPortDeps extends RunIssueSmokeScriptDeps {
  readonly runScript?: typeof runIssueSmokeScript
  readonly resetBase?: typeof resetToBase
  readonly rematerialize?: typeof withCandidatePatch
}

/**
 * Build an OPTIONAL verify-select hard gate from the public issue MWE.
 *
 * BASE-RED GATE (the executed-authority invariant). The issue-text extractor is a
 * precision-first HEURISTIC: its `hasCall` regex can mistake an "Expected output"
 * / setup block for an executable MWE. A wrong block that merely RUNS CLEAN on
 * base would, under the legacy base-GREEN gate, have manufactured a keep-green
 * veto — i.e. a regex guess granted EXECUTED authority over candidate selection.
 * That is forbidden: the extractor may only SEED.
 *
 * So authority is conferred ONLY when the extracted source REPRODUCES the public
 * failure on the base tree (base-RED — a proven oracle, the same bar `mwe-proof`
 * uses). A base-GREEN or non-reproducing source is NOT a proven oracle and yields
 * NO veto port (fail-open, `undefined`): the regex guess stays a seed. When a
 * base-red oracle exists, a candidate that makes it PASS scores `true`; one that
 * leaves it RED scores `false` (an EXECUTED veto of a proven oracle). Candidate-
 * side setup/probe failures degrade to `null` (fail-open).
 *
 * The extraction is routed through {@link extractIssueReproSeed} so the snippet is
 * type-tagged `provenance: "repro-seed"` at the boundary — it cannot be mistaken
 * for validated repro authority before the base-red gate runs.
 */
export const prepareIssueSmokeSelectionPort = async (
  instance: Pick<Instance, "problemStatement" | "localEnv" | "swebench">,
  sandbox: string,
  timeoutMs: number,
  deps: PrepareIssueSmokeSelectionPortDeps = {},
): Promise<((candidate: Candidate) => Promise<boolean | null>) | undefined> => {
  const source = extractIssueReproSeed(instance.problemStatement)?.code
  const baseCommit = instance.swebench?.baseCommit
  if (source === undefined || baseCommit === undefined) return undefined
  const reset = deps.resetBase ?? resetToBase
  const runInSandbox = (sb: string) =>
    (deps.runScript ?? runIssueSmokeScript)(instance, sb, source, timeoutMs, deps)
  if (!(await reset(sandbox, baseCommit, timeoutMs))) return undefined
  let restoredBase = true
  let baseRun: boolean | null = null
  try {
    baseRun = await runInSandbox(sandbox)
  } finally {
    restoredBase = await reset(sandbox, baseCommit, timeoutMs)
  }
  // BASE-RED GATE: only a source that REPRODUCED the failure on base (exit≠0 ⇒
  // `runIssueSmokeScript` returns false) is a proven oracle that may grant a veto.
  // A base-green run (true), an infra/exec failure (null), or a failed base
  // restore all yield NO authority — the regex guess remains seed-only.
  if (baseRun !== false || !restoredBase) return undefined
  const rematerialize = deps.rematerialize ?? withCandidatePatch
  return (candidate) =>
    rematerialize({
      sandbox,
      patch: candidate.patch,
      baseCommit,
      timeoutMs,
      probe: (sb) => runInSandbox(sb),
    })
}

/**
 * Expose the public issue MWE as a repro SEED (T-SMK-04), NOT a smoke gate.
 *
 * This is the clean-path consumer: the extracted snippet is auxiliary evidence
 * that may seed repro generation/selection. It carries `provenance: "repro-seed"`
 * so a downstream consumer cannot mistake "extracted from issue text" for
 * "validated repro authority". A false-positive extraction has no veto power —
 * a seed only earns admissibility weight once it survives a real repro run and
 * enters the validated repro set (where repro consensus decides).
 */
export const seedFromIssueSmoke = (
  instance: Pick<Instance, "problemStatement">,
): IssueReproSeed | undefined => extractIssueReproSeed(instance.problemStatement)

/**
 * Auxiliary issue-smoke telemetry for ONE candidate (T-SMK-04).
 *
 * `wouldReject` records the LEGACY veto decision (base green + candidate broke
 * the public MWE) WITHOUT acting on it — it is observe-only telemetry, recorded
 * separately from any admissibility effect. The driver maps these onto
 * `aux.issueSmoke.{baseGreen,patchedGreen,wouldReject}`; nothing here returns a
 * boolean the selector treats as a hard veto.
 */
export interface IssueSmokeAux {
  /** Was the public MWE green on the BASE tree? `null` = setup/exec fail-open. */
  readonly baseGreen: boolean | null
  /** Was the public MWE green AFTER applying the candidate? `null` = fail-open. */
  readonly patchedGreen: boolean | null
  /**
   * Would the LEGACY standalone smoke gate have vetoed this candidate? True iff
   * base was green and the patched run went non-green. Recorded as evidence
   * ONLY — it has no admissibility effect in the clean path.
   */
  readonly wouldReject: boolean
}

/** Per-candidate aux probe: telemetry only, never a veto boolean. */
export type IssueSmokeAuxPort = (candidate: Candidate) => Promise<IssueSmokeAux>

/**
 * Build an AUXILIARY-ONLY issue-smoke probe (T-SMK-04 demotion).
 *
 * Same execution as {@link prepareIssueSmokeSelectionPort} — run the public MWE
 * on base, then per-candidate after rematerialising the patch — but the result
 * is TELEMETRY ({@link IssueSmokeAux}), not a `boolean|null` the selector feeds
 * into `smokeGreen`. The legacy veto verdict survives only as the observe-only
 * `wouldReject` field, so a candidate that fails standalone issue smoke is NOT
 * made inadmissible: the driver can wire this without granting smoke any clean
 * hard-veto path.
 *
 * Returns `undefined` (no probe) when there is no extractable MWE / baseCommit,
 * or when base setup fails — base setup failure stays fail-open exactly as the
 * gate variant does. When base did not run green, the probe is still returned
 * (so its aux telemetry — `baseGreen` other than `true` — is recorded) but it
 * never reports `wouldReject`, since the legacy gate only ever vetoed on a
 * base-green MWE.
 */
export const prepareIssueSmokeAux = async (
  instance: Pick<Instance, "problemStatement" | "localEnv" | "swebench">,
  sandbox: string,
  timeoutMs: number,
  deps: PrepareIssueSmokeSelectionPortDeps = {},
): Promise<IssueSmokeAuxPort | undefined> => {
  // SEED-tagged extraction (observe-only path — this probe never returns a veto
  // boolean, only telemetry, so it carries no executed authority regardless).
  const source = extractIssueReproSeed(instance.problemStatement)?.code
  const baseCommit = instance.swebench?.baseCommit
  if (source === undefined || baseCommit === undefined) return undefined
  const reset = deps.resetBase ?? resetToBase
  const runInSandbox = (sb: string) =>
    (deps.runScript ?? runIssueSmokeScript)(instance, sb, source, timeoutMs, deps)
  if (!(await reset(sandbox, baseCommit, timeoutMs))) return undefined
  let restoredBase = true
  let baseGreen: boolean | null = null
  try {
    baseGreen = await runInSandbox(sandbox)
  } finally {
    restoredBase = await reset(sandbox, baseCommit, timeoutMs)
  }
  // Base setup failure stays fail-open: no aux probe, no admissibility effect.
  if (!restoredBase) return undefined
  const rematerialize = deps.rematerialize ?? withCandidatePatch
  return async (candidate) => {
    const patchedGreen = await rematerialize<boolean | null>({
      sandbox,
      patch: candidate.patch,
      baseCommit,
      timeoutMs,
      probe: (sb) => runInSandbox(sb),
    })
    // The legacy gate only vetoed when base was green AND the candidate broke the
    // public hot path. We RECORD that verdict; we never act on it.
    const wouldReject = baseGreen === true && patchedGreen === false
    return { baseGreen, patchedGreen, wouldReject }
  }
}
