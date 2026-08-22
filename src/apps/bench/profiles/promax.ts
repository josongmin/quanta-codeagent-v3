/**
 * PMX-01 — THE `promax` dataset-family profile. One object; the registry's only
 * ProMax entry; no `family === "promax"` branch anywhere else.
 *
 * SWE-Bench-ProMax is a sibling of ScaleAI's `pro`, never an alias: different
 * corpus (170 rows across C/C++/Go/Java/Python/Rust/TypeScript), different
 * prediction contract (a JSON ARRAY of `{instance_id, model_patch}`), a
 * different, PINNED evaluator (`src/evaluation/test_run.py` at
 * `77041028…`), different images, and different result semantics (a four-state
 * projection over `model`/`golden`, not a boolean `passed`). Packet invariant 1
 * therefore forbids the two sharing a grader or a report partition, and every
 * port below is written so that a fallback into another family's machinery is
 * impossible rather than merely unlikely.
 *
 * ## Why three of these ports REFUSE instead of returning a value
 *
 * PMX-01 makes ProMax *routable*. PMX-03 froze the evaluator adapter, and PMX-04
 * owns the live remote/Docker execution — neither is wired into a run yet. The
 * honest encoding of "routable but not yet executable" is a loud refusal at the
 * exact seam, not a plausible-looking value:
 *
 *  - `gradeEvaluator` refuses, because the only alternatives are the official
 *    `swebench` harness (which would look ProMax ids up in SWE-bench Verified)
 *    and the ScaleAI Pro harness (invariant 1). "No caller may reach the
 *    Verified or Scale Pro grader by fallback" is the ticket's goal statement.
 *  - `harnessSpec` refuses, because the `swebench` pip package and the
 *    `swebench`/`starryzhang` image namespaces are not ProMax's grader at all.
 *    Returning the stock spec would make a ProMax box byte-indistinguishable
 *    from a Verified one in the harness axis — i.e. exactly the silent Verified
 *    route the DoD says an injected wrong family must not produce.
 *  - `setupBox` refuses, because the frozen bundle is intentionally NOT in git
 *    and PMX-00 forbids searching for or downloading one.
 *
 * These refusals are load-bearing, not placeholders: they are what make
 * "`--dataset-family promax` cannot silently produce a Verified/Pro result" true
 * TODAY, and PMX-04 replaces them with real behavior without any consumer
 * changing.
 *
 * ## What is REAL here
 *
 *  - the public projection (`parseRow`) — invariant 3's floor;
 *  - the preflight — refuses a mislabeled corpus AND a gold-bearing chunk;
 *  - the on-box env prefix — carries ProMax's frozen evaluator PIN to the box,
 *    and deliberately NOT the grader-bundle root (aug-22 G2: that prefix is the
 *    AGENT phase's environment, and the bundle is gold-bearing);
 *  - the plan notes — surface the frozen pin + bundle root on a dry-run;
 *  - the report partition key — distinct from `pro` by construction.
 */
import { PROMAX_V1_SNAPSHOT } from "../promax/provenance/frozen-snapshot"
import {
  PROMAX_BUNDLE_ROOT_ENV,
  PROMAX_PYTHON_ENV,
  proMaxPlanNotes,
  resolveProMaxSettings,
} from "../promax/settings"
import { shq } from "../remote/box-session/shell"
import { promaxFamilyCorpusReader } from "./promax-corpus"
import { assertProMaxDatasetShape } from "./promax-dataset-shape"
import type { DatasetFamilyProfile } from "./types"

/** The Hugging Face id of the ProMax corpus. Named so that NOTHING downstream
 *  falls back to `princeton-nlp/SWE-bench_Verified` for a ProMax run. */
export const PROMAX_DATASET_NAME = "swe-bench-promax/SWE-Bench-ProMax"

const PINNED = PROMAX_V1_SNAPSHOT.upstream_git_commit

/** The one place the "not wired yet" boundary is spelled, so all three refusals
 *  point the operator at the same ticket rather than three different stories. */
const refuse = (what: string, why: string): never => {
  throw new Error(
    `bench: dataset-family=promax — ${what} is not wired yet (PMX-04 owns live ProMax ` +
      `execution; the pinned evaluator is upstream ${PINNED.slice(0, 12)}). ${why} ` +
      "REFUSING to fall back to the SWE-bench Verified or ScaleAI Pro path — ProMax and Pro " +
      "share neither a grader nor a report partition.",
  )
}

export const PROMAX_PROFILE: DatasetFamilyProfile = {
  family: "promax",
  // Distinct from `pro` BY CONSTRUCTION; the registry refuses a duplicate key.
  reportPartitionKey: "promax",
  verifierLabel: `SWE-bench ProMax pinned upstream evaluator (test_run.py @ ${PINNED.slice(0, 12)})`,
  // Never let a ProMax run be defaulted onto the Verified dataset name.
  defaultDatasetName: PROMAX_DATASET_NAME,
  // ProMax spans seven languages while the strict remote box proves only Pyright,
  // so — exactly as for Pro — the LSP-optional baseline is the honest default
  // when the operator chose no preset. Explicit selections still win (preset.ts).
  remoteDefaultPreset: "agentless-v1",
  // ProMax does NOT grade through the ScaleAI Pro dep-builder. Saying `true` here
  // would hand ProMax the `QUANTA_SWEBENCH_PRO_*` harness knobs, which the ticket
  // explicitly forbids reusing.
  gradesWithProHarness: false,

  // layer 1 — the corpus READER. Owns THREE things no other family needs and no
  // consumer may re-derive: the official JSON-ARRAY format, the PUBLIC projection
  // that keeps gold off `Instance` (invariant 3, and it holds on the LOCAL path
  // where no preflight runs), and a gold-free `sourceLine` so a chunk slice
  // cannot ship gold to the box the agent runs on.
  readCorpus: promaxFamilyCorpusReader,

  // layer 2 — the grade port. Refuses; never another family's harness.
  gradeEvaluator: () => async () =>
    refuse(
      "local grading",
      "ProMax is graded by running the PINNED upstream evaluator against the frozen bundle " +
        `(${PROMAX_BUNDLE_ROOT_ENV} / ${PROMAX_PYTHON_ENV}), not by the swebench harness.`,
    ),

  // layer 3a — the swebench harness build. Inapplicable ⇒ refuse.
  harnessSpec: () =>
    refuse(
      "the swebench pip-spec / image namespace",
      "ProMax runs its own pinned evaluator and its own upstream images; the `swebench` " +
        "package and the `swebench`/`starryzhang` namespaces are not its grader.",
    ),

  // layer 3b — the ON-BOX env prefix. REAL, and deliberately NARROW.
  //
  // ⚠️ PHASE. This prefix is prepended to the on-box BENCH command — the AGENT
  // phase. Invariant 3's second half ("gold patch, test patch, eval script,
  // golden output and derived image receipts never enter the agent workspace,
  // prompt, repo map, or index root") therefore governs what may appear here.
  //
  // aug-22 G2: it used to forward `QUANTA_PROMAX_BUNDLE_ROOT` (and the grader
  // interpreter) across the SSH boundary. The frozen bundle is GOLD-BEARING —
  // every ProMax row carries `patch` and `test_patch` beside its public fields —
  // so handing the agent process that path is a contamination vector by
  // construction: one `cat`, one repo-map root, one shell tool away from gold,
  // and unprovable afterwards. Removed.
  //
  // What remains is the frozen upstream COMMIT: an identity pin, not a location,
  // so it cannot be dereferenced into anything. The bundle root and its
  // interpreter belong to the GRADER phase, which runs outside the agent
  // workspace/jail and receives them out of band (PMX-04 owns that transport —
  // note `setupBox` below still refuses precisely because the bundle must not be
  // fetched onto the agent box at all).
  onBoxEnvPrefix: (input) => {
    // Still RESOLVED (not skipped) so an operator's malformed ProMax knob fails
    // closed at this boundary exactly as it does at the composition root; the
    // resolved grader-phase values are simply not emitted into the agent env.
    const settings = resolveProMaxSettings(input.env)
    return `QUANTA_PROMAX_UPSTREAM_COMMIT=${shq(settings.upstreamCommit)} `
  },

  // layer 3c — on-box bootstrap. Refuses; the bundle is deliberately not fetchable.
  setupBox: async () => {
    refuse(
      "the on-box ProMax bootstrap",
      `The frozen bundle is not in git and must not be downloaded on demand (PMX-00). ` +
        `Provision it out of band and point ${PROMAX_BUNDLE_ROOT_ENV} at the verified root.`,
    )
  },

  // layer 4 — preflight. REAL and fail-closed, and it runs BEFORE a box is
  // provisioned on both the full-remote and pool roots.
  //
  // Two steps, in this order, because preflight's job in this codebase is
  // literally "refuse locally rather than discover it as an all-infra remote
  // slice":
  //   1. the corpus shape + gold-leak checks (they also apply to whatever PMX-04
  //      eventually ships, so they are the durable part);
  //   2. the un-wired-lane refusal. `setupBox` and `harnessSpec` also refuse, but
  //      those fire AFTER `RunInstances` — an operator would have paid for a box
  //      before learning ProMax cannot run yet. This makes the refusal free.
  preflight: (input) => {
    assertProMaxDatasetShape({
      rows: input.readRows(),
      ...(input.instanceIds !== undefined ? { instanceIds: input.instanceIds } : {}),
      surface: input.surface,
    })
    refuse(
      `the REMOTE ProMax lane (${input.surface})`,
      "The corpus checks above passed, so the refusal is the LANE, not this dataset. " +
        "Refused here, before RunInstances, so no box is spent learning it.",
    )
  },

  // dry-run visibility — which frozen bundle a launch would use.
  planNotes: (cfg) => proMaxPlanNotes(cfg.promax),
}
