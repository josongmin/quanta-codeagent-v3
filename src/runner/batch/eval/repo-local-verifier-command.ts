import { gateOn } from "@/shared"
import type { Instance } from "../types"

export const DATASET_VERIFIER_EXPOSE_ENV = "QUANTA_BENCH_EXPOSE_DATASET_VERIFIER"

const NOOP_TEST_COMMANDS = new Set(["", "true"])

const normalizedTestCmdOf = (instance: Pick<Instance, "testCmd">): string | undefined => {
  const cmd = instance.testCmd.trim()
  return NOOP_TEST_COMMANDS.has(cmd) ? undefined : cmd
}

/** Recognize our OWN FAIL_TO_PASS-derived verifier shape. This is hidden oracle
 *  material for SWE-bench instances and must not silently become a "public"
 *  verification rail. */
export const isSynthesizedDatasetVerifierCommand = (cmd: string): boolean =>
  cmd.includes("PYTEST_ADDOPTS=") || cmd.includes(" pytest -x --no-header")

/** Public-only verifier command. Hidden dataset verifiers are never admissible
 *  as module-smoke or other public verification rails. */
export const publicRepoLocalVerifierCommand = (
  instance: Pick<Instance, "testCmd" | "swebench">,
): string | undefined => {
  const cmd = normalizedTestCmdOf(instance)
  if (cmd === undefined) return undefined
  if (instance.swebench !== undefined && isSynthesizedDatasetVerifierCommand(cmd)) return undefined
  return cmd
}

/** Agent-visible verifier command. SWE-bench's synthesized hidden verifier stays
 *  hidden by default, but an explicit operator opt-in may surface it in the
 *  prompt/test-runner plane for diagnostics. */
export const agentVisibleBenchVerifierCommand = (
  instance: Pick<Instance, "testCmd" | "swebench">,
  env: Record<string, string | undefined>,
): string | undefined => {
  const cmd = normalizedTestCmdOf(instance)
  if (cmd === undefined) return undefined
  if (
    instance.swebench !== undefined &&
    isSynthesizedDatasetVerifierCommand(cmd) &&
    !gateOn(env, DATASET_VERIFIER_EXPOSE_ENV)
  ) {
    return undefined
  }
  return cmd
}
