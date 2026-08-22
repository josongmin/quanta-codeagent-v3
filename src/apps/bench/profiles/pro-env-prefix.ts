/**
 * LEAF — the family-AGNOSTIC ScaleAI Pro on-box env prefix builder, owned by the
 * profile layer.
 *
 * aug-22 HIGH-4: this body lived in `remote/box-session.ts` (a CONSUMER) behind a
 * `family === "pro"` wrapper (`buildProEnv`), and the registry imported it BACK
 * from that consumer. The family gate is now the PRO profile's `onBoxEnvPrefix`
 * field; box-session calls the profile and no longer knows what "pro" means.
 *
 * PURE — deterministic over the given env + on-box dataset path.
 *
 * WHY the override forward exists as a tested seam: QUANTA_SWEBENCH_PRO_DOCKERHUB_USERNAME
 * and QUANTA_SWEBENCH_PRO_MODEL_NAME are read by buildProGradeVerifier
 * (python-verifier-wiring.ts) to override the verifier defaults (jefzda / quanta).
 * They are NOT `QUANTA_BENCH_*`-prefixed and are NOT in FORWARD_EXTRA_ENV, so
 * without this they are SILENTLY DROPPED on the box — a fork whose Pro images live
 * under a different DockerHub user would have every image-pull fail (all-infra)
 * while the local operator's override is ignored. Forwarded ONLY when set so an
 * unset var stays absent (byte-identical).
 */
import { shq } from "../remote/box-session/shell"

export const buildProEnvPrefix = (env: NodeJS.ProcessEnv, datasetPath: string): string => {
  // `~` expands only when it starts a shell word. Inside `KEY='~/…'` it remains
  // literal, and the on-box Node process then resolves it as `<cwd>/~/…`.
  // Convert our home-relative chunk paths to an absolute shell-expanded value.
  const rawSamplePath = datasetPath.startsWith("~/")
    ? `"$HOME/${datasetPath.slice(2)}"`
    : shq(datasetPath)
  let proEnv =
    `QUANTA_SWEBENCH_PRO_HARNESS_DIR="$HOME/swebench-pro" ` +
    `QUANTA_SWEBENCH_PRO_PYTHON_BIN="$HOME/swebench-pro-venv/bin/python" ` +
    `QUANTA_SWEBENCH_PRO_RAW_SAMPLE_PATH=${rawSamplePath} `
  if (env.QUANTA_SWEBENCH_PRO_DOCKERHUB_USERNAME)
    proEnv += `QUANTA_SWEBENCH_PRO_DOCKERHUB_USERNAME=${shq(env.QUANTA_SWEBENCH_PRO_DOCKERHUB_USERNAME)} `
  if (env.QUANTA_SWEBENCH_PRO_MODEL_NAME)
    proEnv += `QUANTA_SWEBENCH_PRO_MODEL_NAME=${shq(env.QUANTA_SWEBENCH_PRO_MODEL_NAME)} `
  return proEnv
}
