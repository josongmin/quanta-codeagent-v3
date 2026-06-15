/**
 * T4 — per-instance env pre-preparation (fail-fast).
 *
 * When the instance carries a `setupCmd`, run it in the sandbox copy BEFORE
 * the agent. This is the structural fix for Type-F (verify-loop stuck on env):
 * the harness prepares the environment, the agent never has to. The command is
 * the task author's responsibility to keep HOST-CLEAN (e.g. a per-instance
 * venv created inside `sandbox`); the runner never installs against the host
 * Python/global env. If setup exits non-zero we fail-fast with a DISTINCT
 * `env_prep_failed` verdict and DO NOT run the agent — handing a half-prepared
 * env to the agent is exactly the failure this prevents.
 */
import type { Instance } from "../types"
import { exec } from "./exec"

export type EnvPrepResult = { ok: true } | { ok: false; code: number; stderr: string }

/** Returns `{ok:true}` when there is no `setupCmd` OR setup exits 0; otherwise
 *  `{ok:false}` with the exit code + (truncated) stderr for the caller to
 *  shape into an `env_prep_failed` InstanceResult. Never throws. */
export const runEnvPrep = async (
  instance: Instance,
  sandbox: string,
  timeoutMs: number,
): Promise<EnvPrepResult> => {
  if (!instance.setupCmd) return { ok: true }
  const setup = await exec(instance.setupCmd, sandbox, timeoutMs, {
    ...(instance.localEnv !== undefined ? { localEnv: instance.localEnv } : {}),
  })
  if (setup.code === 0) return { ok: true }
  return { ok: false, code: setup.code, stderr: setup.stderr }
}
