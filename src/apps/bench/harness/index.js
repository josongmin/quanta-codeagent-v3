/**
 * Bench harness slice barrel — the single import surface for code outside the
 * `harness/` directory. Slice purity (RFC §3.1): consumers (`python-swebench.ts`,
 * the top-level `index.ts`) import from `./harness`, not into individual files.
 *
 * Scope (intentional): the SSOT for Docker image lifecycle / official grading
 * config. Holds the answer to "which `--cache_level / --clean / --max_workers
 * / --namespace` flags do we pass when invoking `swebench.harness.run_evaluation`."
 * Lives outside python-swebench.ts so the argv builder can stay pure and
 * config-driven, with operators tuning via runtime-config env vars instead of
 * source edits.
 */
// Re-export the legacy evaluate surface so callers (runner.ts, bench/index.ts)
// can import everything they need from a single `./harness` barrel.
// The actual implementation still lives in `../python-swebench.ts`; the
// barrel hides that path so the harness slice is the operator-visible name.
export { buildArgv, defaultSpawn, evaluateWithPythonSwebench, isPythonSwebenchAvailable, SWEBENCH_VERIFIED_DATASET, } from "../python-swebench";
export { defaultNamespace, hostArch } from "./arch";
export { computeMaxWorkers, harnessFlags, resolveHarnessConfig, } from "./config";
export { classifyImage, defaultDockerSpawn, groupByTier, hasEnvImage, listSwebenchImages, } from "./images";
export { prepareImages, } from "./prepare";
