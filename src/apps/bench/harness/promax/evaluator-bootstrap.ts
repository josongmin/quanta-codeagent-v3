/**
 * PMX-04 — the on-box EVALUATOR BOOTSTRAP: a typed specification the ProMax
 * profile supplies at composition, plus PURE command builders.
 *
 * Nothing here executes anything. The whole point of building the plan as data
 * is that the ticket's requirements — "the EXACT manifest commit, never a
 * depth-1 checkout of moving `main`", "verify all three upstream file hashes ON
 * BOX before launch", "a dedicated Python environment", "Docker daemon
 * readiness, sufficient disk, and linux/amd64", "evaluator workers at 1" — are
 * then properties of a value that a test can inspect and REPLAY, rather than
 * properties of a shell script nobody can assert about.
 *
 * ## Why the checkout is fetch+detach rather than clone
 *
 * `git clone [--depth 1] <url>` lands on the remote's DEFAULT BRANCH. Upstream
 * is actively maintained and advertises a v2, so a campaign that cloned would
 * silently re-point its evaluator the moment `main` moved — and the resulting
 * report would still claim the frozen commit. The plan therefore never names a
 * branch at all: it fetches the pinned OBJECT, checks it out `--detach`, and
 * reads HEAD back so the pin is verified rather than assumed.
 *
 * ## Two concurrency axes, deliberately not one number
 *
 * `patchGenConcurrency` is how many agent tasks run in parallel (bounded by the
 * shared model rate limit). `evaluatorWorkers` is how many instances the pinned
 * `test_run.py` grades in parallel — and that one is PINNED AT 1: upstream drives
 * Docker through `subprocess.run(..., shell=True)` with per-instance container
 * names, and grading concurrency has a measured history of producing
 * false-negatives in this repo. It changes only after a measured concurrency
 * campaign, not because someone raised the other number.
 *
 * ## 🔴 THE CHECKOUT IS THE ANSWER KEY — absence, not path-hiding, is the defence
 *
 * Every row of `data/swe-bench-promax.json` carries `patch` and `test_patch`
 * BESIDE its public fields, and `data/eval.json` / `src/evaluation/test_run.py`
 * are the eval metadata and the evaluator. So materializing the pinned upstream
 * commit on a box IS materializing the answer key — invariant 3 ("gold patch,
 * test patch, eval script, golden output and derived image receipts never enter
 * the agent workspace, prompt, repo map, or index root") is violated in
 * SUBSTANCE by the checkout existing at all during the agent phase, whatever
 * path it lands at.
 *
 * Two things that look like defences and are NOT:
 *
 *  - **the checkout root.** `/opt/quanta/...` is outside `$HOME` and outside the
 *    workspace the repo-map walks, but the bench agent's `bash` tool is
 *    UNSANDBOXED on that box (a pre-existing architectural fact of
 *    `runner/batch/eval/sandbox.ts`, recorded here rather than papered over). A
 *    path the agent can `cat` is a filename, not a boundary.
 *  - **keeping the path/commit out of the agent's env.** Both are shipped to the
 *    box in plaintext production source and are printed by every dry-run, so
 *    withholding an env var buys exactly nothing. Do not re-add
 *    `QUANTA_PROMAX_UPSTREAM_ROOT`-style knobs under the belief that it does.
 *
 * The defence this module actually implements is ABSENCE: every command that
 * fetches, checks out, or hashes gold-bearing bytes is declared `phase:
 * "grader"` and `goldBearing: true`, and the executor refuses to run a
 * gold-bearing command in the agent phase. The agent phase is left with pure
 * capability probes (campaign root, free disk, docker platform) that name
 * neither the upstream URL, nor the pinned commit, nor the checkout root.
 */
import {
  PROMAX_V1_SNAPSHOT,
  PROMAX_V1_UPSTREAM_PATHS,
} from "@/apps/bench/promax/provenance/frozen-snapshot"
import type { PythonVersion } from "../../profiles/python-version"
import {
  describePythonFloorRefusal,
  formatPythonVersion,
  meetsPythonFloor,
} from "../../profiles/python-version"
import type { FamilyBootstrapCommand } from "../../profiles/types"
import { shq } from "../../remote/box-session/shell"
import { PROMAX_EVALUATOR_PYTHON_FLOOR } from "./evaluator-python"
import { PROMAX_REQUIRED_ARCHITECTURE, PROMAX_REQUIRED_OS } from "./image-freeze"

/** One upstream file whose bytes the campaign pinned. */
export interface ProMaxUpstreamFile {
  /** repo-relative path at the pinned commit. */
  readonly path: string
  readonly sha256: string
}

/** The bootstrap steps, in execution order. */
export const PROMAX_BOOTSTRAP_STEPS = [
  "gold-absence",
  "grader-container-absence",
  "campaign-root",
  "docker-ready",
  "disk",
  "python-floor",
  "checkout",
  "verify-hashes",
  "python-env",
  "gold-teardown",
] as const

export type ProMaxBootstrapStep = (typeof PROMAX_BOOTSTRAP_STEPS)[number]

/**
 * A ProMax bootstrap command. It IS a {@link FamilyBootstrapCommand} — the
 * profile hands the plan straight to the generic port with no re-mapping, which
 * is what makes the `phase` / `goldBearing` / `verifies` fields structurally
 * impossible to drop at the boundary (the earlier `{step, argv, purpose}`
 * projection silently discarded the digest expectation and left the gate
 * decorative).
 */
export interface ProMaxBootstrapCommand extends FamilyBootstrapCommand {
  readonly step: ProMaxBootstrapStep
}

/**
 * The typed bootstrap specification. Remote code CARRIES this; it does not
 * rediscover any of it (owner split: "remote does not rediscover family
 * behavior").
 */
export interface ProMaxEvaluatorBootstrapSpec {
  readonly family: "promax"
  readonly upstreamRepoUrl: string
  readonly upstreamGitCommit: string
  /** The three files PMX-00 froze: dataset, eval metadata, evaluator. */
  readonly upstreamFiles: readonly ProMaxUpstreamFile[]
  /**
   * Absolute on-box root of the CAMPAIGN — the (initially empty) directory the
   * checkout and the venv are created under.
   *
   * It is separate from {@link checkoutRoot} because the AGENT-phase probes need
   * a real directory to measure free disk on, and the checkout root must not
   * exist during the agent phase at all.
   */
  readonly campaignRoot: string
  /** Absolute on-box root the pinned commit is checked out into. GRADER phase
   *  only — it does not exist while the agent is running. */
  readonly checkoutRoot: string
  /** Absolute on-box root of the dedicated interpreter environment. */
  readonly venvRoot: string
  /** The interpreter that runs `test_run.py` — inside `venvRoot`, by construction. */
  readonly evaluatorPython: string
  /** The interpreter used to BUILD the environment. */
  readonly systemPython: string
  /**
   * The MINIMUM interpreter version the pinned evaluator can run on, carried as
   * typed spec data so a box that would fail is refused before it is
   * provisioned rather than after.
   *
   * It is not an input: the floor is a property of the pinned evaluator's bytes
   * (PMX-00), so a caller has no business choosing it. See
   * {@link PROMAX_EVALUATOR_PYTHON_FLOOR} for the derivation.
   */
  readonly minPythonVersion: PythonVersion
  /** PINNED at 1 until a measured concurrency campaign changes it. */
  readonly evaluatorWorkers: 1
  /** The OTHER axis: agent patch generation. Never the same knob. */
  readonly patchGenConcurrency: number
  readonly requiredPlatform: { readonly os: string; readonly architecture: string }
  readonly minFreeDiskBytes: number
}

/**
 * Headroom for the image set. ProMax's 170 upstream images are full toolchain
 * environments across seven languages, so the grading box needs room for the
 * pulled layers plus each disposable container's writable layer. 300 GiB is the
 * observed working size of this repo's bench boxes, recorded here as a
 * REFUSAL floor rather than a silent assumption.
 */
export const PROMAX_MIN_FREE_DISK_BYTES = 300 * 1024 ** 3

export interface BuildProMaxBootstrapSpecInput {
  readonly campaignRoot: string
  readonly checkoutRoot: string
  readonly venvRoot: string
  /** Agent-side concurrency. Positive integer; the grader stays at 1 regardless. */
  readonly patchGenConcurrency: number
  readonly systemPython?: string
  readonly minFreeDiskBytes?: number
}

const requireAbsolute = (value: string, label: string): string => {
  if (typeof value !== "string" || !value.startsWith("/")) {
    throw new Error(
      `bench: promax bootstrap ${label}="${value}" must be an ABSOLUTE on-box path — a ` +
        "cwd-relative campaign path cannot be replayed from a report.",
    )
  }
  return value.replace(/\/+$/, "")
}

export const buildProMaxBootstrapSpec = (
  input: BuildProMaxBootstrapSpecInput,
): ProMaxEvaluatorBootstrapSpec => {
  const campaignRoot = requireAbsolute(input.campaignRoot, "campaignRoot")
  const checkoutRoot = requireAbsolute(input.checkoutRoot, "checkoutRoot")
  const venvRoot = requireAbsolute(input.venvRoot, "venvRoot")
  if (!checkoutRoot.startsWith(`${campaignRoot}/`)) {
    throw new Error(
      `bench: promax bootstrap checkoutRoot="${checkoutRoot}" must live UNDER campaignRoot ` +
        `"${campaignRoot}". The agent phase creates the campaign root EMPTY and measures disk on ` +
        "it; if the gold-bearing checkout landed elsewhere the disk gate would measure the wrong " +
        "filesystem and the absence claim would cover the wrong directory.",
    )
  }
  const n = input.patchGenConcurrency
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(
      `bench: promax bootstrap patchGenConcurrency must be a positive integer, got ${String(n)}. ` +
        "It is the AGENT axis; the grader stays at 1 either way, so a bad value here must fail " +
        "rather than silently collapse the two.",
    )
  }
  return {
    family: "promax",
    upstreamRepoUrl: PROMAX_V1_SNAPSHOT.upstream_repo_url,
    upstreamGitCommit: PROMAX_V1_SNAPSHOT.upstream_git_commit,
    upstreamFiles: Object.freeze([
      { path: PROMAX_V1_UPSTREAM_PATHS.dataset, sha256: PROMAX_V1_SNAPSHOT.dataset_sha256 },
      { path: PROMAX_V1_UPSTREAM_PATHS.evalMeta, sha256: PROMAX_V1_SNAPSHOT.eval_sha256 },
      { path: PROMAX_V1_UPSTREAM_PATHS.evaluator, sha256: PROMAX_V1_SNAPSHOT.evaluator_sha256 },
    ]),
    campaignRoot,
    checkoutRoot,
    venvRoot,
    evaluatorPython: `${venvRoot}/bin/python`,
    systemPython: input.systemPython ?? "python3",
    // Not an input, and not defaulted: the pinned evaluator decides it.
    minPythonVersion: PROMAX_EVALUATOR_PYTHON_FLOOR.minimum,
    evaluatorWorkers: 1,
    patchGenConcurrency: n,
    requiredPlatform: { os: PROMAX_REQUIRED_OS, architecture: PROMAX_REQUIRED_ARCHITECTURE },
    minFreeDiskBytes: input.minFreeDiskBytes ?? PROMAX_MIN_FREE_DISK_BYTES,
  }
}

/**
 * ---- AGENT PHASE ---- pure capability probes, and the whole set of them.
 *
 * Gold-free by construction: the campaign root is a directory the agent phase
 * CREATES EMPTY, so naming it reveals nothing (nothing is in it), and the
 * checkout that fills it belongs to the grader phase.
 *
 * Split out of {@link buildProMaxBootstrapPlan} so each phase has one owner and
 * neither grows past the size ratchet as probes are added.
 */
/**
 * The three GOLD-ABSENCE probes, split out of {@link agentPhaseProbes} — they
 * were two thirds of it, and each carries the measurement that made it exist.
 * Grouped because they answer ONE question ("is the answer key reachable from
 * this box?") in three ways that a single `test` cannot: a symlink at the root
 * survives teardown and then reads as absent, `test ! -e` is TRUE on EACCES so
 * an unreadable campaign root reported CLEAN, and a stopped grader CONTAINER
 * still holds the tree. Fail-closed, first, before anything is materialized.
 */
const goldAbsenceProbes = (spec: ProMaxEvaluatorBootstrapSpec): ProMaxBootstrapCommand[] => {
  const root = spec.checkoutRoot
  return [
    {
      // 🔴 FIRST, and fail-closed. Absence is the WHOLE defence, and until this
      // command existed it was ASSUMED: the grader phase created the
      // gold-bearing checkout and nothing ever removed it, so the second chunk
      // on a warm box started its agent phase on a box that still held the
      // answer key — and every later assertion about absence was a statement
      // about the PLAN, not about the box. A non-zero exit here means the tree
      // EXISTS; the executor refuses the whole bootstrap on it (aug-22 A-A).
      step: "gold-absence",
      phase: "agent",
      // It creates nothing and reads no answer-key bytes — it asserts there are
      // none. Naming the root is what a probe IS; see `absenceProbe`.
      goldBearing: false,
      // `test ! -e` alone was not an absence proof, in two MEASURED ways — so the
      // step is three commands. The executor runs a step's commands in order and
      // refuses on the first non-zero, which says what one `test` could not, and
      // keeps every token in plain argv rather than hiding it in an `sh -c`
      // string that no argv guard can see.
      //
      //  · A symlink planted at the root survives the teardown (`rm -rf` unlinks
      //    the LINK, never the target tree) and then reads as ABSENT, so the gold
      //    stays readable while both defences report success.
      //  · `test ! -e` is TRUE on EACCES, so a campaign root this user cannot
      //    read reported CLEAN. "I could not look" is not "it is not there" —
      //    the rule the grader-container probe was already rewritten for.
      // "IF it exists, it must be readable" — NOT "it must exist": this runs
      // BEFORE `campaign-root` creates the directory. `test ! -e` answers CLEAN
      // on EACCES, so an unreadable campaign root made the absence probe below
      // assert nothing. Its own step because it names no gold-bearing path.
      argv: ["test", "!", "-d", spec.campaignRoot, "-o", "-r", spec.campaignRoot],
      purpose:
        "if the campaign root exists it must be READABLE, or absence cannot be asserted about " +
        "anything inside it — `test ! -e` answers CLEAN on EACCES",
    },
    {
      step: "gold-absence",
      phase: "agent",
      goldBearing: false,
      // ONE `test`, two conditions. `test ! -e` alone is FALSE for a dangling
      // symlink, and MEASURED: `rm -rf <symlink>` unlinks the LINK and leaves
      // the target tree whole, so a link the previous chunk's agent planted
      // survives the teardown and then reads as absent — the answer key stays
      // readable while every gate reports success. `-a ! -L` closes that, and
      // keeps the whole proof in a single declared probe.
      argv: ["test", "!", "-e", root, "-a", "!", "-L", root],
      purpose:
        "REFUSE to start the agent phase on a box that still carries the gold-bearing upstream " +
        "checkout, or a SYMLINK standing in for it (a prior chunk's grader phase, or a teardown " +
        "that failed)",
      absenceProbe: { absolutePath: root },
    },
    {
      // The checkout is not the only answer-key state a grade leaves behind.
      // Read from the pinned evaluator's own source (hash-verified, so it cannot
      // drift without the pin changing):
      //
      //   run_single_patch → `docker run -d --name {container_name} …`
      //                      `docker cp {patch_file} {container_name}:/tmp/patch.diff`
      //   container_name   = f"{role}_{uuid4().hex[:6]}", role ∈ {"m", "g"}
      //   finally          → `subprocess.run(f"docker rm -f {container_name}", …)`
      //
      // So it reaps its own containers — best-effort, with the result unchecked.
      // Killed mid-run, or against a wedged daemon, `m_*` / `g_*` containers
      // survive, and a `g_*` container is the one the GOLDEN patch and the test
      // patch were copied into. A STOPPED container is still `docker cp`-able by
      // anything on the box, including the next chunk's unsandboxed agent.
      //
      // IMAGES are deliberately NOT probed: `--cleanup` is never passed because
      // they are the campaign's replay evidence, and the golden patch is applied
      // inside a container rather than committed back to the image — so an image
      // is not answer-key state.
      //
      // A PROBE, not a reaper: refusing is honest when state we cannot fully
      // account for is present, and inventing a cleanup for a third party's
      // container lifecycle would be guessing at it.
      step: "grader-container-absence",
      phase: "agent",
      goldBearing: false,
      // `out=$(…) || exit 1`, NOT `test -z "$(…)"`. A command substitution captures
      // only stdout, so a MISSING docker or a wedged daemon produced an empty
      // string and `test -z ""` SUCCEEDED. Measured on a real shell: docker
      // absent → exit 0; daemon unreachable → exit 0; containers present → 1.
      // The probe reported "clean" in the exact scenario its own purpose names
      // ("killed mid-run, or against a wedged daemon") — and it runs BEFORE
      // `docker-ready`, so readiness is not even established yet. Same class as
      // the pgrep probe fixed earlier: a failed probe is not an answer.
      argv: [
        "sh",
        "-c",
        'out=$(docker ps -aq --filter name=^m_ --filter name=^g_) || exit 1; test -z "$out"',
      ],
      purpose:
        "REFUSE to start the agent phase while the pinned evaluator's own grader containers " +
        "survive — a `g_*` container had the GOLDEN patch and the test patch copied into it, " +
        "and a stopped container is still readable with `docker cp`",
    },
  ]
}

const agentPhaseProbes = (spec: ProMaxEvaluatorBootstrapSpec): ProMaxBootstrapCommand[] => {
  return [
    ...goldAbsenceProbes(spec),
    {
      step: "campaign-root",
      phase: "agent",
      goldBearing: false,
      // MEASURED on a real box: a plain `mkdir -p /opt/quanta/promax` fails with
      // "cannot create directory '/opt/quanta': Permission denied". The bench
      // runs as `ubuntu`; `/opt` is root-owned. So the ProMax lane could never
      // get past this step on any box — it just needed a launch to find out.
      //
      // The ROOT stays where it is. `/opt` was never an isolation boundary (the
      // agent's bash is unsandboxed, so "outside $HOME" is a filename, not a
      // fence, and the real defences are the absence probe and the teardown).
      // What it buys is hygiene: the answer-key checkout is not in the agent's
      // own working tree, where a repo-map root or a stray `ls` reaches it. That
      // is worth one privileged mkdir on a box we own and destroy.
      //
      // CHOWNed to the running user in the same command, because every later
      // step — the checkout, the venv, the teardown — writes there as that user;
      // creating it as root and stopping would just move the failure downstream.
      argv: [
        "sh",
        "-c",
        // shq-QUOTED, not merely validated. `requireAbsolute` checks the shape
        // of the path; it is not a shell quoter, and inside an `sh -c` string an
        // unquoted path is one space or `$` away from meaning something else.
        // The two other `sh -c` steps here quote their interpolations; these two
        // were the exception.
        `sudo mkdir -p ${shq(spec.campaignRoot)} && ` +
          `sudo chown "$(id -u):$(id -g)" ${shq(spec.campaignRoot)}`,
      ],
      purpose:
        "create the EMPTY campaign root, owned by the bench user, so the disk probe has a real mount to measure",
    },
    {
      step: "docker-ready",
      phase: "agent",
      goldBearing: false,
      argv: ["docker", "info", "--format", "{{.OSType}}/{{.Architecture}}"],
      purpose: "prove the daemon is up AND report its platform in one round-trip",
    },
    {
      step: "disk",
      phase: "agent",
      goldBearing: false,
      argv: ["df", "-Pk", spec.campaignRoot],
      purpose: "free space on the campaign root, in 1K blocks (POSIX-portable output)",
    },
    {
      // 🔴 AGENT phase, deliberately — this is a pure capability probe that
      // names no upstream URL, no commit and no checkout root, so it is
      // gold-free by construction and belongs with the other fail-fast checks.
      //
      // It probes the SYSTEM interpreter, the one that BUILDS the venv below,
      // because `python3 -m venv` produces a venv of whatever version ran it: a
      // 3.9 system python yields a 3.9 evaluator environment. Checking only the
      // built venv would be refusing AFTER provisioning, and refusing after an
      // agent run has been paid for is the expensive half of the same mistake.
      step: "python-floor",
      phase: "agent",
      goldBearing: false,
      argv: [spec.systemPython, "--version"],
      purpose:
        `prove the system interpreter can run the pinned evaluator (>=${formatPythonVersion(spec.minPythonVersion)}) ` +
        "BEFORE the box is provisioned or an agent run is paid for",
      pythonFloor: PROMAX_EVALUATOR_PYTHON_FLOOR,
    },
  ]
}

/**
 * ---- GRADER PHASE, part 1 ---- the pinned checkout.
 *
 * `git init` + fetch-by-object-id + detached checkout, never a clone: a clone
 * would take the remote's default branch, which is a MOVING ref. Split out of
 * {@link buildProMaxBootstrapPlan} for the same reason as the probes — one
 * owner per phase, and no phase grows past the size ratchet as steps are added.
 */
const graderCheckout = (spec: ProMaxEvaluatorBootstrapSpec): ProMaxBootstrapCommand[] => {
  const root = spec.checkoutRoot
  const commit = spec.upstreamGitCommit
  /** Every git command runs `-C <root>`, so no step depends on the process cwd. */
  const at = (...argv: string[]): string[] => ["git", "-C", root, ...argv]
  return [
    {
      // 🔴 BEFORE anything is materialized. `git init` FOLLOWS a symlink, and
      // `rm -rf <symlink>` later unlinks the link while leaving the target tree
      // whole — MEASURED — so a link planted at the checkout root during the
      // agent phase makes the answer key land somewhere the teardown never
      // touches and no absence probe ever looks. The probe cannot catch this
      // after the fact: once the link is unlinked the root really is absent.
      // The only place it can be refused is here, before the gold exists.
      step: "checkout",
      phase: "grader",
      goldBearing: true,
      argv: ["test", "!", "-L", root],
      purpose:
        "REFUSE to materialize the answer key through a SYMLINK — it would place the checkout " +
        "outside the path the teardown removes and the absence probe inspects",
    },
    {
      step: "checkout",
      phase: "grader",
      goldBearing: false,
      argv: ["git", "init", "-q", root],
      purpose: "create an empty repository — never a clone, which would take the default branch",
    },
    {
      step: "checkout",
      phase: "grader",
      goldBearing: false,
      argv: at("remote", "add", "origin", spec.upstreamRepoUrl),
      purpose: "bind the frozen upstream remote",
    },
    {
      step: "checkout",
      phase: "grader",
      // The moment the answer key lands on the box.
      goldBearing: true,
      argv: at("fetch", "--no-tags", "origin", commit),
      purpose: "fetch the pinned OBJECT by id; no branch name is ever named",
    },
    {
      step: "checkout",
      phase: "grader",
      goldBearing: true,
      argv: at("checkout", "--detach", commit),
      purpose: "check the pinned commit out DETACHED so no symbolic ref can move under the run",
    },
    {
      step: "checkout",
      phase: "grader",
      goldBearing: true,
      argv: at("rev-parse", "--verify", `${commit}^{commit}`),
      purpose: "read the pin back — the checkout is verified, not assumed",
    },
  ]
}

/**
 * ---- GRADER PHASE, part 2 ---- on-box hash verification of the pinned files.
 * One `sha256sum` per upstream file; the campaign refuses unless each equals
 * the frozen digest, so the checkout is verified rather than assumed.
 */
const graderVerifyHashes = (spec: ProMaxEvaluatorBootstrapSpec): ProMaxBootstrapCommand[] => {
  const root = spec.checkoutRoot
  return spec.upstreamFiles.map((file) => ({
    step: "verify-hashes" as const,
    phase: "grader" as const,
    // It READS the gold-bearing file to hash it.
    goldBearing: true,
    argv: ["sha256sum", `${root}/${file.path}`],
    purpose: `hash ${file.path} on-box; the campaign refuses unless it equals ${file.sha256}`,
    verifies: { path: file.path, absolutePath: `${root}/${file.path}`, sha256: file.sha256 },
  }))
}

/**
 * ---- GRADER PHASE, part 3 + TEARDOWN ---- the dedicated evaluator interpreter,
 * then the answer key UNMADE. The venv deliberately survives (it holds no
 * answer-key bytes and rebuilding one per chunk is cost without a defence);
 * only the gold-bearing checkout is removed.
 */
const graderPythonEnvAndTeardown = (
  spec: ProMaxEvaluatorBootstrapSpec,
): ProMaxBootstrapCommand[] => {
  const root = spec.checkoutRoot
  return [
    {
      step: "python-env",
      phase: "grader",
      goldBearing: false,
      // MEASURED on a real box: `python3 -m venv` fails on Ubuntu with "the
      // virtual environment was not created successfully because ensurepip is
      // not available", because the distro ships `python3` without it. So the
      // grader phase could never build its interpreter — on any box, every time.
      //
      // `uv` is already there (cloud-init installs bun+uv), so this adds no
      // provisioning, and it creates the environment without ensurepip.
      // `--python 3.11` PINS an interpreter above the evaluator's PEP 604 floor
      // instead of inheriting whatever `python3` happens to be — which is exactly
      // the remedy the floor's own refusal message recommends.
      //
      // Nothing is installed into it: the pinned evaluator imports only stdlib
      // (os, json, uuid, tempfile, subprocess, re, argparse, shlex,
      // concurrent.futures), so a bare interpreter IS the requirement.
      // `$HOME/.local/bin/uv`, not a bare `uv`. MEASURED: the bare form failed
      // with `bash: line 1: uv: command not found` (exit 127) — cloud-init
      // installs uv to ~/.local/bin and a bootstrap command runs over a NON-LOGIN
      // ssh, which has no such PATH. Every other uv/pyright call in this repo
      // already spells it out (`$HOME/.local/bin/uvx`, `~/.local/bin/uv tool
      // install`); this was the one place that relied on PATH.
      //
      // Via `sh -c` so `$HOME` expands: bootstrap argv is shq-QUOTED, so neither
      // `~` nor `$HOME` would expand on their own, and hardcoding `/home/ubuntu`
      // would bake in the AMI's user where nothing else does.
      argv: ["sh", "-c", `"$HOME"/.local/bin/uv venv --python 3.11 ${shq(spec.venvRoot)}`],
      purpose: "a DEDICATED interpreter for the pinned evaluator, isolated from the agent's",
    },
    {
      step: "python-env",
      phase: "grader",
      goldBearing: false,
      argv: [spec.evaluatorPython, "--version"],
      purpose:
        "prove the dedicated interpreter is executable AND at least " +
        `${formatPythonVersion(spec.minPythonVersion)} before the campaign relies on it`,
      // The floor is re-checked on the BUILT venv, not only on the system
      // interpreter that was probed in the agent phase: the two can differ (a
      // pre-existing venv, a box whose `python3` moved between phases), and the
      // interpreter that actually runs the evaluator is this one.
      pythonFloor: PROMAX_EVALUATOR_PYTHON_FLOOR,
    },
    // ---- TEARDOWN ---- what the grader phase materialized, UNMADE.
    //
    // The venv is deliberately NOT removed: it holds no answer-key bytes, and
    // rebuilding an interpreter per chunk is cost without a defence. Only the
    // checkout — which IS the answer key — goes.
    {
      step: "gold-teardown",
      phase: "teardown",
      // It operates ON answer-key bytes, so it stays out of the agent phase by
      // the same cross-check that keeps the checkout out: the agent phase is
      // where absence is PROVEN, never where it is arranged.
      goldBearing: true,
      // The teardown removes; the next chunk's absence probe VERIFIES. Splitting
      // a symlink refusal in here as well was tried and reverted: it bought
      // nothing the probe does not already refuse, and it put a second
      // gold-root-naming command into the agent-free teardown phase.
      argv: ["rm", "-rf", root],
      purpose:
        "REFUSE to 'remove' a symlink: `rm -rf` would unlink it and leave the answer key whole",
    },
    {
      step: "gold-teardown",
      phase: "teardown",
      goldBearing: true,
      argv: ["rm", "-rf", root],
      purpose:
        "remove the gold-bearing upstream checkout at the end of the grader phase, so the NEXT " +
        "chunk's agent phase starts on a box that does not hold the answer key",
    },
  ]
}

/**
 * The ordered bootstrap plan, in TWO PHASES.
 *
 * `agent` first: capability probes that must fail fast, BEFORE an agent run is
 * paid for — the campaign root exists, the daemon is up and on the right
 * platform, the disk has headroom. None of them names the upstream URL, the
 * pinned commit, or the checkout root, because none of them may hint at, let
 * alone materialize, gold.
 *
 * `grader` second: the pinned checkout, its hash verification, and the dedicated
 * evaluator interpreter. These run only once model patches are captured, and the
 * executor refuses to run the gold-bearing ones in the agent phase.
 *
 * Every command is argv; nothing is a shell string, so there is no quoting layer
 * for a path to escape through.
 */
export const buildProMaxBootstrapPlan = (
  spec: ProMaxEvaluatorBootstrapSpec,
): ProMaxBootstrapCommand[] => [
  ...agentPhaseProbes(spec),
  ...graderCheckout(spec),
  ...graderVerifyHashes(spec),
  ...graderPythonEnvAndTeardown(spec),
]

/**
 * What a bootstrap RUN observed on the box. Supplied by the caller, because
 * running commands is an effect and this module stays pure.
 */
export interface ProMaxBootstrapObservation {
  /** `docker info --format '{{.OSType}}/{{.Architecture}}'` stdout, trimmed. */
  readonly dockerInfo: string
  readonly freeDiskBytes: number
  readonly headCommit: string
  readonly detached: boolean
  /** repo-relative upstream path → observed sha256. */
  readonly fileHashes: Readonly<Record<string, string>>
  /**
   * What the box's evaluator interpreter reported, or `null` when nothing
   * readable came back.
   *
   * REQUIRED rather than optional: this classifier answers "may the box
   * proceed", and an omitted interpreter check is the exact shape of the gap
   * that let a 3.9 box through. An absent observation is a PROBLEM below, never
   * a skipped check.
   */
  readonly pythonVersion: PythonVersion | null
}

/**
 * Classify a bootstrap observation. Returns operator-facing problem strings —
 * EMPTY means the box may proceed. Fail-closed: an ABSENT hash observation is a
 * problem, not a skipped check.
 */
export const evaluateProMaxBootstrapReadiness = (
  spec: ProMaxEvaluatorBootstrapSpec,
  observed: ProMaxBootstrapObservation,
): readonly string[] => {
  const problems: string[] = []
  const wanted = `${spec.requiredPlatform.os}/${spec.requiredPlatform.architecture}`
  const seen = observed.dockerInfo.trim()
  if (seen !== wanted) {
    problems.push(
      `promax bootstrap: docker daemon reports platform "${seen}", but the pinned evaluator's ` +
        `images are ${wanted}. REFUSING — a mismatched box produces all-infra results.`,
    )
  }
  if (!(observed.freeDiskBytes >= spec.minFreeDiskBytes)) {
    problems.push(
      `promax bootstrap: free disk on ${spec.campaignRoot} is ${observed.freeDiskBytes} byte(s), ` +
        `below the ${spec.minFreeDiskBytes}-byte floor the image set needs. REFUSING.`,
    )
  }
  if (
    observed.pythonVersion === null ||
    !meetsPythonFloor(observed.pythonVersion, spec.minPythonVersion)
  ) {
    problems.push(
      `promax bootstrap: ${describePythonFloorRefusal({
        label: "evaluator interpreter",
        executable: spec.evaluatorPython,
        observed: observed.pythonVersion,
        floor: PROMAX_EVALUATOR_PYTHON_FLOOR,
      })}`,
    )
  }
  if (!observed.detached) {
    problems.push(
      `promax bootstrap: the upstream checkout at ${spec.checkoutRoot} is on a symbolic ref, not ` +
        "DETACHED — a moving ref can re-point the evaluator mid-campaign.",
    )
  } else if (observed.headCommit !== spec.upstreamGitCommit) {
    problems.push(
      `promax bootstrap: the upstream checkout HEAD is ${observed.headCommit}, not the pinned ` +
        `${spec.upstreamGitCommit}.`,
    )
  }
  for (const file of spec.upstreamFiles) {
    const got = observed.fileHashes[file.path]
    if (got === undefined) {
      problems.push(
        `promax bootstrap: no on-box hash was observed for ${file.path} — an unverified upstream ` +
          "file may not be graded against (packet invariant 4).",
      )
      continue
    }
    if (got !== file.sha256) {
      problems.push(
        `promax bootstrap: ${file.path} hashes to ${got} on-box, not the frozen ${file.sha256}.`,
      )
    }
  }
  return problems
}
