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
import type { FamilyBootstrapCommand } from "../../profiles/types"
import { PROMAX_REQUIRED_ARCHITECTURE, PROMAX_REQUIRED_OS } from "./image-freeze"

/** One upstream file whose bytes the campaign pinned. */
export interface ProMaxUpstreamFile {
  /** repo-relative path at the pinned commit. */
  readonly path: string
  readonly sha256: string
}

/** The bootstrap steps, in execution order. */
export const PROMAX_BOOTSTRAP_STEPS = [
  "campaign-root",
  "docker-ready",
  "disk",
  "checkout",
  "verify-hashes",
  "python-env",
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
    evaluatorWorkers: 1,
    patchGenConcurrency: n,
    requiredPlatform: { os: PROMAX_REQUIRED_OS, architecture: PROMAX_REQUIRED_ARCHITECTURE },
    minFreeDiskBytes: input.minFreeDiskBytes ?? PROMAX_MIN_FREE_DISK_BYTES,
  }
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
): readonly ProMaxBootstrapCommand[] => {
  const root = spec.checkoutRoot
  const at = (...argv: string[]): string[] => ["git", "-C", root, ...argv]
  const commit = spec.upstreamGitCommit

  // ---- AGENT PHASE ---- pure capability probes. Gold-free by construction:
  // the campaign root is a directory the agent phase CREATES EMPTY, so naming it
  // reveals nothing (nothing is in it) and the checkout that fills it is below.
  const probes: ProMaxBootstrapCommand[] = [
    {
      step: "campaign-root",
      phase: "agent",
      goldBearing: false,
      argv: ["mkdir", "-p", spec.campaignRoot],
      purpose: "create the EMPTY campaign root so the disk probe has a real mount to measure",
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
  ]

  // ---- GRADER PHASE ---- everything that touches the answer key.
  const checkout: ProMaxBootstrapCommand[] = [
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

  const verify: ProMaxBootstrapCommand[] = spec.upstreamFiles.map((file) => ({
    step: "verify-hashes" as const,
    phase: "grader" as const,
    // It READS the gold-bearing file to hash it.
    goldBearing: true,
    argv: ["sha256sum", `${root}/${file.path}`],
    purpose: `hash ${file.path} on-box; the campaign refuses unless it equals ${file.sha256}`,
    verifies: { path: file.path, absolutePath: `${root}/${file.path}`, sha256: file.sha256 },
  }))

  return [
    ...probes,
    ...checkout,
    ...verify,
    {
      step: "python-env",
      phase: "grader",
      goldBearing: false,
      argv: [spec.systemPython, "-m", "venv", spec.venvRoot],
      purpose: "a DEDICATED interpreter for the pinned evaluator, isolated from the agent's",
    },
    {
      step: "python-env",
      phase: "grader",
      goldBearing: false,
      argv: [spec.evaluatorPython, "--version"],
      purpose: "prove the dedicated interpreter is executable before the campaign relies on it",
    },
  ]
}

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
