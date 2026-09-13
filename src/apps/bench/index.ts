/**
 * `bun run bench` — SWE-bench Verified harness skeleton + Best-of-N.
 *
 * Composition only (RFC §4 apps/bench): wires the corpus adapter, the runner,
 * and the Best-of-N sampler around a real agent. Targets RFC §1.1 (single
 * trajectory 50% → Best-of-N 70%); the real Python swebench integration is the
 * documented seam in swebench.ts and intentionally out of scope here.
 *
 * THIS FILE is the thin local-run ENTRY: it owns the tiny dotenv shim's
 * activation, the terminal-IO binding, the public-API re-export surface, and
 * the `import.meta.main` OTel-boot direct-invoke path. The actual `runMain`
 * composition (CLI-arg parsing, env defaulting, run-id seeding, mode selection,
 * Best-of-N, artifact + observe finalization) lives in the cohesive sibling
 * `./run-main.ts` and is re-exported below for byte-identical importers.
 *
 * Env / argv:
 *   --swebench <file> | QUANTA_SWEBENCH_DATASET    official dataset JSONL
 *                                                  (takes precedence over --corpus)
 *   --predictions <path>                           predictions out (default ./predictions.jsonl)
 *   --report <path>                                report out (default ./bench-report.json)
 *   --corpus <dir> | QUANTA_SWEBENCH_CORPUS_ROOT   corpus root
 *   --n <int>                                      Best-of-N (default 1)
 *   --limit <int>                                  cap instances
 *   --instance <substr>                            select by id substring
 *                                                  (applied before --limit)
 *   --prepare-images                               pre-build SWE-bench env
 *                                                  images for selected
 *                                                  instances and EXIT (warm
 *                                                  cache for the next run;
 *                                                  requires --swebench)
 *   --dry-run                                      load+count+print plan, NO LLM
 *   --list-presets                                 print bench presets + exit
 *   QUANTA_BENCH_PRESET=<name>                     posture preset (value, NOT
 *                                                  on/off). When unset at the
 *                                                  execution surface, live
 *                                                  runs default to the current
 *                                                  base profile
 *                                                  (`agentless-v3-thin-strict`).
 *                                                  Individual QUANTA_BENCH_*
 *                                                  override. QUANTA_BENCH_SOTA=1
 *                                                  = alias for agentless-v1.
 *   --model <id> | QUANTA_MODEL                    model id
 *   QUANTA_PROVIDER / ANTHROPIC_API_KEY / OPENAI_API_KEY  provider pick
 *   QUANTA_SWEBENCH_PYTHON=1                        grade via official Python
 *                                                  harness when available
 *   --dataset-name <id|jsonl> |                    grading dataset for the
 *     QUANTA_SWEBENCH_DATASET_NAME                  Python harness. Default:
 *                                                   princeton-nlp/SWE-bench_Verified
 *                                                   (decoupled from --swebench,
 *                                                   which is the tasks input)
 *
 * Official-harness tuning (only used when QUANTA_SWEBENCH_PYTHON=1; flow
 * through `harness/config.ts → resolveHarnessConfig()`):
 *   QUANTA_SWEBENCH_CACHE_LEVEL    none|base|env|instance — image tiers that
 *                                  survive the run. Default: env (keep base+
 *                                  per-repo env images warm; reused by
 *                                  subsequent instances).
 *   QUANTA_SWEBENCH_CLEAN          true|false — remove images above cache
 *                                  level after the run. Default: false.
 *   QUANTA_SWEBENCH_MAX_WORKERS    positive int — instance-eval parallelism.
 *                                  Default: min(4, 75%cores). Override on
 *                                  beefy hosts (e.g. =8) for larger batches.
 *   QUANTA_SWEBENCH_NAMESPACE      swebench|none|<other> — image registry
 *                                  namespace. Default: arch-aware (arm64 ⇒
 *                                  "swebench" pull, x64 ⇒ "none" local
 *                                  build). Set "none" to force local build,
 *                                  "swebench" to force prebuilt pull.
 *   QUANTA_SWEBENCH_FORCE_REBUILD  true|false — ignore cached images and
 *                                  rebuild. Default: false.
 *   QUANTA_SWEBENCH_PYTHON_BIN     explicit python interpreter path (e.g.
 *                                  /opt/homebrew/bin/python3.11). Default:
 *                                  probe `python` then `python3` on PATH.
 *
 * Never crashes when keys are absent — prints guidance and exits 0.
 */

import { installWorkspaceTrustAuthority, TRUST_EVERY_FOLDER } from "@/agent/workspace-trust"
import { errMessage, logger } from "@/shared"
import { routeBenchTerminalIo } from "./entry-bootstrap"
import { bootBenchOtelExport } from "./otel"
import { currentBenchExitFn, runMain } from "./run-main"

// Public API re-export — the `runMain` composition + its test seams live in the
// cohesive sibling `./run-main.ts`. Importers of `@/apps/bench` (writeArtifacts,
// repairConfigFromArg, applyBenchEnvDefaults, runMain, the exit seams) keep the
// original byte-compatible surface.
export {
  __resetBenchExitForTest,
  applyBenchEnvDefaults,
  type ExitFn,
  type MainDeps,
  repairConfigFromArg,
  runMain,
  writeArtifacts,
} from "./run-main"

// Re-export the bench-native trajectory record/replay surface so importers of
// `@/apps/bench` (e.g. tests/unit/bench-trajectory-record-wiring.test.ts) keep
// the original byte-compatible public API after the split into ./trajectory.
export { maybeRecordTrajectory, maybeReplayTrajectory } from "./trajectory"

routeBenchTerminalIo()

// Gate the top-level `runMain()` so importing this module (e.g. from
// `tests/unit/bench-write-artifacts.test.ts` for `writeArtifacts`) does NOT
// trigger the CLI entry point. Bun sets `import.meta.main` only for the file
// the runtime started from; unit tests start from `bun test` and never match.
if (import.meta.main) {
  // Workspace trust (`@/agent/workspace-trust`): this harness runs agents in trees it
  // created itself and executes their code anyway (dataset checkouts and their tests), so
  // every folder it works in is trusted — language-server grounding stays on.
  installWorkspaceTrustAuthority(TRUST_EVERY_FOLDER)
  // OTLP span export (ADR-0268) — boot wire for the bench process when invoked
  // directly (legacy `bun run src/apps/bench/index.ts …`). Uses the SHARED boot
  // seam (same as cli.ts) so this entry also auto-issues a run id + prints the
  // deep-link — previously it attached WITHOUT auto-issuing, so direct-invoke
  // runs streamed with no `quanta.run.id` and the `?run=` link was dead.
  // Installed here (not in `runMain`) so the tested `runMain(deps)` stays env-pure;
  // Default-OFF no-op unless QUANTA_OTEL_ENDPOINT is set.
  const { otelExport, runId: benchRunId, traceLink } = bootBenchOtelExport(process.env)
  if (traceLink !== undefined) logger.info(`[otel] run ${benchRunId} live trace → ${traceLink}`)
  // `beforeExit` is not a one-shot shutdown hook: starting async work there
  // makes the event loop non-empty and Bun may emit it again. A final OTLP
  // flush launched with `void` therefore had no single owner and could keep a
  // finished remote run alive after its report had landed. Await teardown once,
  // after the command settles, before invoking the exit seam.
  void (async () => {
    let failed = false
    try {
      await runMain()
    } catch (e) {
      failed = true
      logger.error(`bench fatal: ${errMessage(e)}`)
    } finally {
      await otelExport.teardown()
    }
    if (failed) {
      // Top-level fatal still goes through the injectable exit binding so a
      // test that started the CLI with a no-op exit observes the failing code.
      currentBenchExitFn()(1)
    }
  })()
}
