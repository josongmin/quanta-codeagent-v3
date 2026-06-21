import { rm } from "node:fs/promises"
import { join } from "node:path"
import { extractIssueRepro } from "@/agent/verification-plan/extract-issue-repro"
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

const smokeArgv = (
  instance: Pick<Instance, "swebench">,
  scriptPath: string,
): readonly string[] =>
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
 * Only a MWE that is already green on the base tree becomes smoke authority.
 * That keeps this signal strictly "don't break the public hot path", not a
 * misleading fix oracle. Candidate-side setup/probe failures degrade to `null`.
 */
export const prepareIssueSmokeSelectionPort = async (
  instance: Pick<Instance, "problemStatement" | "localEnv" | "swebench">,
  sandbox: string,
  timeoutMs: number,
  deps: PrepareIssueSmokeSelectionPortDeps = {},
): Promise<((candidate: Candidate) => Promise<boolean | null>) | undefined> => {
  const source = extractIssueRepro(instance.problemStatement)?.code
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
  if (baseGreen !== true || !restoredBase) return undefined
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
