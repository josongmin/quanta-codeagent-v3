import { exec } from "./exec";
/** Returns `{ok:true}` when there is no `setupCmd` OR setup exits 0; otherwise
 *  `{ok:false}` with the exit code + (truncated) stderr for the caller to
 *  shape into an `env_prep_failed` InstanceResult. Never throws. */
export const runEnvPrep = async (instance, sandbox, timeoutMs) => {
    if (!instance.setupCmd)
        return { ok: true };
    const setup = await exec(instance.setupCmd, sandbox, timeoutMs);
    if (setup.code === 0)
        return { ok: true };
    return { ok: false, code: setup.code, stderr: setup.stderr };
};
