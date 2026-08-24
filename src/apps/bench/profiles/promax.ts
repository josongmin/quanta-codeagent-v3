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
 * ## Which ports REFUSE, and which are now LIVE
 *
 * PMX-04 wired the remote lane: `admitBox` admits, `setupBox` is a deliberate
 * no-op (the declared bootstrap does the provisioning), preflight keeps only its
 * corpus checks, and `boxGrade` / `parseBoxGradeVerdicts` grade the chunk ON THE
 * BOX with the pinned evaluator. This section described all three as refusing
 * until then.
 *
 * Two ports still refuse, and both are load-bearing rather than placeholders:
 *
 *  - `gradeEvaluator` refuses LOCAL grading, because the only alternatives are
 *    the official `swebench` harness (which would look ProMax ids up in SWE-bench
 *    Verified) and the ScaleAI Pro harness (invariant 1). "No caller may reach
 *    the Verified or Scale Pro grader by fallback" is the ticket's goal.
 *  - `harnessSpec` refuses, because the `swebench` pip package and the
 *    `swebench`/`starryzhang` image namespaces are not ProMax's grader at all.
 *    Returning the stock spec would make a ProMax box byte-indistinguishable
 *    from a Verified one in the harness axis — exactly the silent Verified route
 *    the DoD says an injected wrong family must not produce.
 *
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

import { readFileSync } from "node:fs"
import { serializeOfficialGradeReceipt } from "@/runner/batch/eval/official-grade"
import { errMessage } from "@/shared"
import { PROMAX_EVALUATOR_ID, PROMAX_EVALUATOR_RELATIVE_PATH } from "../harness/promax"
import { buildProMaxOfficialGradeReceipt } from "../harness/promax/adapter"
import { buildProMaxBoxGradeCommand } from "../harness/promax/box-grade"
import { projectProMaxGradedInstances } from "../harness/promax/chunk-verdicts"
import { serializeProMaxPredictions } from "../harness/promax/invocation"
import { ProMaxSampleError, selectProMaxSampleIds } from "../promax/corpus"
import { PROMAX_V1_SNAPSHOT } from "../promax/provenance/frozen-snapshot"
import {
  PROMAX_BUNDLE_ROOT_ENV,
  PROMAX_PYTHON_ENV,
  PROMAX_SAMPLE_ENV,
  proMaxPlanNotes,
  resolveProMaxSettings,
} from "../promax/settings"
import { shq } from "../remote/box-session/shell"
import {
  PROMAX_ONBOX_CHECKOUT_ROOT,
  PROMAX_ONBOX_VENV_ROOT,
  proMaxRemoteBootstrap,
} from "./promax-bootstrap"
import { promaxFamilyCorpusReader } from "./promax-corpus"
import { assertProMaxDatasetShape } from "./promax-dataset-shape"
import type { DatasetFamilyProfile } from "./types"

/** The Hugging Face id of the ProMax corpus. Named so that NOTHING downstream
 *  falls back to `princeton-nlp/SWE-bench_Verified` for a ProMax run. */
export const PROMAX_DATASET_NAME = "swe-bench-promax/SWE-Bench-ProMax"

const PINNED = PROMAX_V1_SNAPSHOT.upstream_git_commit

/**
 * PMX-04 — the FROZEN PORTABLE preset a ProMax remote run uses when the operator
 * named none.
 *
 * Named rather than inlined because the ticket's rule is about EXPLICITNESS:
 * *"PMX integration smoke uses an explicitly frozen portable preset; it never
 * inherits the repo default implicitly."* The repo default
 * (`agentless-v3-thin-strict`) requires LIVE LSP grounding, the remote box proves
 * only `pyright-langserver`, and ProMax spans C / C++ / Go / Java / Python /
 * Rust / TypeScript — so inheriting it would make six of the seven languages
 * refuse to launch, and the one that did launch would silently be the only
 * language in the "cross-language" headline.
 *
 * `agentless-v1` is the LSP-OPTIONAL baseline: portable across all seven
 * languages, and identical to the default Pro already declares for the same
 * reason. An explicit operator selection still wins (see `preset.ts`) — this is a
 * default, not a lock.
 */
export const PROMAX_FROZEN_PORTABLE_PRESET = "agentless-v1"

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
  remoteDefaultPreset: PROMAX_FROZEN_PORTABLE_PRESET,
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

  // layer 3b′ — ADMISSION. ProMax's lane is wired, so this admits.
  //
  // It admits rather than checking something because the port can see nothing to
  // check: `FamilyAdmissionInput` carries only `log` — no env, no cfg, and
  // deliberately no ssh (aug-22 A-C: admission must be unable to mutate a box on
  // its way to a decision). Every ProMax precondition that CAN be decided has
  // inputs, and lives where those inputs are:
  //
  //   - corpus shape + gold-leak checks → `preflight`, which also runs BEFORE
  //     the box is provisioned, so a bad corpus still costs no box;
  //   - the pinned checkout and its on-box digest verification → the DECLARED
  //     bootstrap, executed by the generic fail-closed executor (including the
  //     warm-box gate, which refuses a reused box carrying no bootstrap rather
  //     than assuming the pin was proved);
  //   - keeping grader material off the agent box → `onBoxEnvPrefix`, which
  //     emits the upstream COMMIT and never the bundle ROOT.
  //
  // What made this refusal load-bearing until now was the S2 rail: a family that
  // materializes answer-key bytes in its grader phase must not admit a box while
  // no production caller executes that phase, because the declared teardown then
  // never runs and the key survives into the next chunk's agent phase. That
  // caller now exists (`runFamilyBoxGrade`), and the teardown is bound to it.
  admitBox: () => {},

  // layer 3c — extra imperative ON-BOX setup. ProMax needs none: its pinned
  // checkout, venv and digest verification are the DECLARED bootstrap's
  // commands, executed and receipted by the generic executor. Repeating them
  // here would be a second provisioning path no receipt describes.
  //
  // Still NOT a bundle fetch, and that is the true half of the old refusal: the
  // frozen bundle is gold-bearing, so it must never land on the box the agent
  // runs on. The grader phase materializes the pinned upstream instead — inside
  // a window whose teardown removes it — and the agent phase proves its absence
  // before the agent starts.
  setupBox: async () => {},

  // layer 3d — PMX-04. ProMax grades with its OWN pinned evaluator, inside the
  // grader window, from a SECOND on-box invocation.
  //
  // Its presence is what splits the chunk in two, and the split is a correctness
  // requirement: the grader phase materializes the answer key, and the agent
  // must run while it is absent — the agent phase carries an `absenceProbe` that
  // proves exactly that. One invocation cannot satisfy both.
  //
  // Every path resolves inside the materialized checkout (see `box-grade.ts`),
  // so the key is read from the window and destroyed with it.
  boxGrade: (input) => {
    const built = buildProMaxBoxGradeCommand({
      checkoutRoot: PROMAX_ONBOX_CHECKOUT_ROOT,
      venvRoot: PROMAX_ONBOX_VENV_ROOT,
      predictionsPath: input.predictionsPath,
      outputPath: input.outputPath,
    })
    if (!built.ok) {
      throw new Error(
        `bench: dataset-family=promax — cannot build the on-box grade command: ` +
          built.failures.map((f) => `[${f.code}] ${f.message}`).join("; "),
      )
    }
    return { command: built.command, argv: built.argv, cwd: built.cwd }
  },

  // layer 3e — PMX-04. The chunk's verdicts come from the evaluator's own
  // pass-rate document, NOT from the bench report: that report is written by a
  // patch-gen-only pass, in which every instance is an explicit "harness not
  // wired" infra error by construction. It reports official STATES; the remote
  // layer decides how those land in its four legacy arrays.
  // layer 3d′ — PMX-04. The box writes JSONL; the pinned evaluator does
  // `json.load` and needs ProMax's JSON ARRAY. Routing the conversion through
  // the family's OWN serializer is what matters here — it is not a reformat:
  // `serializeProMaxPredictions` carries the duplicate-id and blank-id refusals
  // (a duplicate row is what lets the strongest-bucket precedence promote
  // whichever copy said `success`), and the explicit two-field projection that
  // keeps a gold-bearing `patch` field out of the file the evaluator reads. Both
  // were reachable only from the local gate until this existed.
  prepareBoxGradePredictions: (text) => {
    const rows = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .map((line, i) => {
        let row: { instance_id?: unknown; model_patch?: unknown }
        try {
          row = JSON.parse(line) as { instance_id?: unknown; model_patch?: unknown }
        } catch (e) {
          throw new Error(
            `bench: dataset-family=promax — on-box predictions line ${i + 1} is not JSON: ${errMessage(e)}`,
          )
        }
        if (typeof row.instance_id !== "string" || row.instance_id.trim() === "") {
          throw new Error(
            `bench: dataset-family=promax — on-box predictions line ${i + 1} has no usable instance_id`,
          )
        }
        // An ABSENT patch is a malformed row; an EMPTY one is a real outcome and
        // must reach the evaluator as a model miss rather than be guessed away.
        if (typeof row.model_patch !== "string") {
          throw new Error(
            `bench: dataset-family=promax — on-box predictions line ${i + 1} ` +
              `(${row.instance_id}) has no model_patch string`,
          )
        }
        return { instanceId: row.instance_id, modelPatch: row.model_patch }
      })
    const serialized = serializeProMaxPredictions(rows)
    if (!serialized.ok) {
      throw new Error(
        `bench: dataset-family=promax — REFUSING to grade the box's predictions: ` +
          serialized.failures.map((f) => `[${f.code}] ${f.message}`).join("; "),
      )
    }
    return serialized.json
  },

  parseBoxGradeVerdicts: projectProMaxGradedInstances,

  // layer 3f — PMX-04. The grade's REPLAYABLE record. Without it a ProMax run's
  // only trace was a terminal summary line: no argv, no hash, no per-instance
  // verdicts — and the receipt layer's `evaluatorSha256` guard, which exists so a
  // receipt names the bytes that produced its verdicts, applied to a shape this
  // path never produced.
  //
  // Composed from the SAME builder the local gate uses, so the two cannot drift
  // into describing the same evaluator differently.
  buildBoxGradeReceipt: (input) => {
    const built = buildProMaxOfficialGradeReceipt({
      assignedInstanceIds: input.assignedInstanceIds,
      evaluator: {
        evaluatorId: PROMAX_EVALUATOR_ID,
        upstreamCommit: PINNED,
        evaluatorPath: `${PROMAX_ONBOX_CHECKOUT_ROOT}/${PROMAX_EVALUATOR_RELATIVE_PATH}`,
        evaluatorSha256: input.evaluatorSha256,
        cwd: input.cwd,
        argv: input.argv,
      },
      run: {
        exitCode: input.exitCode,
        stdout: input.stdout,
        stderr: input.stderr,
        outputJsonText: input.artifactText,
        outputPath: input.artifactPath,
      },
    } as Parameters<typeof buildProMaxOfficialGradeReceipt>[0])
    if (!built.ok) {
      throw new Error(
        "bench: dataset-family=promax — the on-box grade produced no valid receipt: " +
          built.failures.map((f) => `[${f.code}] ${f.message}`).join("; "),
      )
    }
    return serializeOfficialGradeReceipt(built.receipt)
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
  },

  // layer 6 — MANIFEST-DRIVEN SELECTION (PMX-06 / aug-22 G4). The sample
  // manifests have been WRITTEN since PMX-02 and never READ, so "this campaign
  // is PMX-7" was an unverifiable claim about whatever `--instance` said. With
  // this port the manifest is the authority: the ids, their ORDER, and the
  // digest that seals them.
  //
  // Unset knob ⇒ `undefined` ⇒ the generic selection path is byte-identical.
  // Set ⇒ fail-closed on every manifest/corpus disagreement (see
  // `selectProMaxSampleIds`); it NEVER degrades to "run everything".
  resolveSelection: (input) => {
    const { samplePath } = resolveProMaxSettings(input.env)
    if (samplePath === undefined) return undefined
    let manifestText: string
    try {
      manifestText = readFileSync(samplePath, "utf8")
    } catch (err) {
      throw new ProMaxSampleError(
        `[${input.surface}] promax sample manifest: ${samplePath} could not be read ` +
          `(${errMessage(err)}). REFUSING to fall back to the ` +
          `whole corpus — ${PROMAX_SAMPLE_ENV} names the set this campaign claims to run.`,
      )
    }
    return selectProMaxSampleIds({
      manifestText,
      manifestPath: samplePath,
      availableInstanceIds: input.rows.map((row) => row.instanceId),
      surface: input.surface,
    })
  },

  // layer 7 — the REMOTE BOOTSTRAP specification (PMX-04). The typed value box
  // provisioning CARRIES: the pinned checkout plan, the dedicated interpreter,
  // the platform/disk gates, and the grader worker count. Every semantic
  // decision inside it belongs to `harness/promax/evaluator-bootstrap.ts`; this
  // profile only selects the on-box layout.
  remoteBootstrap: proMaxRemoteBootstrap,

  // dry-run visibility — which frozen bundle a launch would use, plus what the
  // box would be bootstrapped into.
  planNotes: (cfg) => [...proMaxPlanNotes(cfg.promax), ...proMaxRemoteBootstrap(cfg).planNotes],
}
