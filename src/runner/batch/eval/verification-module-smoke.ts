/**
 * Public module-smoke verification fallback for ClosureSession / VerificationPlan.
 *
 * When no validated repro exists and owner-near pytest discovery is empty, the
 * instance's repo-local verifier (`testCmd`) is still the broadest public
 * executable rail available. We admit it as a `module-smoke` fallback ONLY when
 * it is a real command (not the dataset `true` sentinel) and record whether it
 * was observed RED on the current tree so repair admission can distinguish
 * "known red rail" from "present but never proved red".
 */

import type { Instance } from "../types"
import { exec } from "./exec"
import { publicRepoLocalVerifierCommand } from "./repo-local-verifier-command"
import { localTestCmdPassed } from "./verdict"

export type VerificationPrimaryBaseState = "red" | "green" | "unavailable"

export interface DiscoverVerificationModuleSmokeArgs {
  readonly instance: Pick<Instance, "testCmd" | "localEnv" | "swebench">
  readonly sandbox: string
  readonly timeoutMs: number
}

export interface DiscoverVerificationModuleSmokeDeps {
  readonly probeBaseCommand?: typeof probeModuleSmokeOnCurrentTree
}

export interface VerificationModuleSmokePlan {
  readonly commands: readonly string[]
  /** Base-tree verdict of the PRIMARY module-smoke candidate (the repo-local
   *  verifier fallback when no repro/owner-test rail validated red). */
  readonly primaryBaseState: VerificationPrimaryBaseState
}

const toPrimaryBaseState = (verdict: boolean | null): VerificationPrimaryBaseState =>
  verdict === true ? "green" : verdict === false ? "red" : "unavailable"

/** Run the repo-local verifier command on the CURRENT sandbox tree (no reset)
 *  and classify it with the SAME pass/fail semantics as the official local
 *  `verify()` path. */
export const probeModuleSmokeOnCurrentTree = async (
  args: DiscoverVerificationModuleSmokeArgs,
): Promise<boolean | null> => {
  const cmd = publicRepoLocalVerifierCommand(args.instance)
  if (cmd === undefined) return null
  const result = await exec(cmd, args.sandbox, args.timeoutMs, {
    ...(args.instance.localEnv !== undefined ? { localEnv: args.instance.localEnv } : {}),
  }).catch(() => null)
  if (result === null) return null
  return localTestCmdPassed({
    exitCode: result.code,
    logTail: `${result.stdout}\n${result.stderr}`,
  })
}

export const discoverVerificationModuleSmokePlan = async (
  args: DiscoverVerificationModuleSmokeArgs,
  deps: DiscoverVerificationModuleSmokeDeps = {},
): Promise<VerificationModuleSmokePlan> => {
  const cmd = publicRepoLocalVerifierCommand(args.instance)
  if (cmd === undefined) {
    return { commands: [], primaryBaseState: "unavailable" }
  }
  const verdict = await (deps.probeBaseCommand ?? probeModuleSmokeOnCurrentTree)(args)
  return {
    commands: [cmd],
    primaryBaseState: toPrimaryBaseState(verdict),
  }
}
