/**
 * LEAF — the ScaleAI Pro ON-BOX bootstrap, owned by the profile layer.
 *
 * aug-22 HIGH-4: this body lived in `remote/box-session/ec2-lifecycle.ts` (a
 * CONSUMER) behind a `datasetFamily !== "pro"` early-return
 * (`setupProHarnessIfNeeded`). That made the on-box bootstrap a FIFTH scattered
 * family branch the T4 registry did not cover at all, so a hypothetical family #4
 * still had to edit `bootstrapBox`. It is now the PRO profile's `setupBox` field;
 * `bootstrapBox` calls the profile and no longer knows what "pro" means.
 *
 * RFC jun-29 — Pro grading needs the ScaleAI harness (`swe_bench_pro_eval.py` +
 * per-instance `run_scripts/<id>/`) AND a Python env with its deps
 * (pandas/docker SDK/…), which the `swebench` shim does NOT have. Clone the
 * harness + build a dedicated venv ON the box. Idempotent (skips an existing
 * clone). The verifier reads QUANTA_SWEBENCH_PRO_PYTHON_BIN (set by the on-box
 * env prefix) to use this venv, not the swebench shim.
 *
 * Verified/Live profiles have a no-op `setupBox`, so their bootstraps are
 * byte-identical (no clone, no venv, not even an extra ssh round-trip).
 */
import type { BoxSetupInput } from "./types"

export const setupProHarness = async (input: BoxSetupInput): Promise<void> => {
  input.log(
    "[full-remote] Pro: cloning ScaleAI harness (scaleapi/SWE-bench_Pro-os) + grading venv…",
  )
  const clone = await input.ssh(
    "test -d ~/swebench-pro/.git || git clone --depth 1 https://github.com/scaleapi/SWE-bench_Pro-os ~/swebench-pro 2>&1 | tail -3",
  )
  if (clone.code !== 0) {
    throw new Error(
      `[full-remote] Pro harness clone failed (code ${clone.code}):\n${clone.stdout}${clone.stderr}`,
    )
  }
  // Dedicated venv with the harness deps (requirements.txt: pandas/tqdm/datasets/modal/docker/
  // huggingface_hub). modal is imported even in --use_local_docker mode, so install it too.
  const venv = await input.ssh(
    'set -o pipefail; export PATH="$HOME/.local/bin:$PATH"; ' +
      "uv venv ~/swebench-pro-venv --python 3.11 2>&1 | tail -2 && " +
      "uv pip install --python ~/swebench-pro-venv/bin/python pandas tqdm datasets docker huggingface_hub modal 2>&1 | tail -4",
  )
  if (venv.code !== 0) {
    throw new Error(
      `[full-remote] Pro grading venv setup failed (code ${venv.code}):\n${venv.stdout}${venv.stderr}`,
    )
  }
  input.log("[full-remote] Pro harness ready (~/swebench-pro + ~/swebench-pro-venv)")
}
