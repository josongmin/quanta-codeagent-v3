/**
 * PMX-04 — the ONE ProMax Docker preflight. Implemented here, by the image
 * lifecycle owner, and used by BOTH the gold sentinel run and the model run.
 *
 * The ticket's ordering rationale: everything below happens BEFORE model tokens
 * are spent, because each check's failure mode is otherwise discovered as an
 * all-infra campaign — 170 instances of `NON_ZERO_EXIT` that look like a bad
 * agent rather than a bad box.
 *
 * ```text
 *   docker pull  <repo@sha256:…>          → pull_failed
 *   docker image inspect                  → inspect_failed / inspect_unparseable
 *     RepoDigests must contain the pin     → digest_mismatch
 *     Os/Architecture must be linux/amd64  → platform_unsupported
 *   docker run -d … tail -f /dev/null     → start_failed
 *   docker cp <probe> <c>:/tmp/…          → cp_failed
 *   docker exec -u root <c> bash -c …     → exec_failed
 *     sentinel path must be ABSENT         → sentinel_present
 *     the cp'd file must be PRESENT        → cp_failed
 *   docker rm -f <c>                      → cleanup_failed
 * ```
 *
 * ## Two deliberate non-actions
 *
 *  - the CACHED IMAGE is never removed. `docker rmi` / `image rm` / `prune` do
 *    not appear in this module: the pulled image IS the campaign's replay
 *    evidence, and upstream's own `--cleanup` flag is likewise never passed
 *    (see `invocation.ts`). Only the disposable CONTAINER is removed.
 *  - nothing is retried. A retry here would hide exactly the flakiness the
 *    receipt exists to record.
 *
 * ## Why the `docker run` shape mirrors upstream
 *
 * `test_run.py` starts its containers as
 * `docker run -d --name {c} {net_flags} {image} tail -f /dev/null`. Proving a
 * DIFFERENT shape can start would prove nothing about the evaluator, so the
 * disposable container uses the same one (minus the host-derived network flags,
 * which are the operator's, not the image's).
 *
 * ⚠️ SPEND SAFETY. The Docker boundary is the INJECTED {@link DockerPort}; this
 * module never constructs a spawn of its own, so a unit test cannot reach a real
 * daemon or registry by accident.
 */
import type { DockerSpawn } from "../images"
import { goldSentinelPath } from "./gold-sentinel"
import {
  PROMAX_REQUIRED_ARCHITECTURE,
  PROMAX_REQUIRED_OS,
  type ProMaxArtifactDigest,
  type ProMaxImageFault,
  type ProMaxImageFaultCode,
  type ProMaxImageFreezeReceipt,
  type ProMaxImageRecord,
  type ProMaxPreflightStage,
} from "./image-freeze"

/**
 * The injected Docker process boundary. Deliberately the SAME type the existing
 * harness image inventory uses (`harness/images.ts`) rather than a second
 * lookalike — one Docker port, one default spawn, one place to stub.
 */
export type DockerPort = DockerSpawn

/** What the freeze must resolve for one assigned instance. */
export interface ProMaxImageTarget {
  readonly instanceId: string
  /** The upstream MUTABLE tag from the corpus. Recorded; never pulled. */
  readonly sourceImageName: string
  /** `repo@sha256:…` the campaign pins and the derived golden carries. */
  readonly registryRepoDigest: string
}

export interface ProMaxImagePreflightInput {
  readonly campaignId: string
  readonly upstreamGitCommit: string
  readonly targets: readonly ProMaxImageTarget[]
  readonly docker: DockerPort
  /** Injected clock — `resolved_at` must be reproducible in a test. */
  readonly now: () => Date
  /** A small local file the `docker cp` proof ships into the container. */
  readonly probeFilePath: string
  readonly goldenSource: ProMaxArtifactDigest
  readonly goldenDerived: ProMaxArtifactDigest
  /** Override only for a name-collision workaround; defaults are deterministic. */
  readonly containerName?: (campaignId: string, instanceId: string) => string
}

/** Where the `docker cp` proof lands inside the disposable container. */
export const PROMAX_PREFLIGHT_CP_TARGET = "/tmp/quanta-preflight-probe.txt"

/** The evaluator applies patches under upstream's hard-coded repo path. */
const UPSTREAM_TESTBED = "/testbed"

const SENTINEL_MARKER = "QUANTA_SENTINEL"
const CP_MARKER = "QUANTA_CP"

/** FNV-1a over the campaign id — a short, stable, filename-safe discriminator. */
const shortHash = (input: string): string => {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, "0")
}

/**
 * The disposable container's name. DETERMINISTIC (so the argv a campaign ran is
 * reproducible from its receipt) and campaign-scoped (so two campaigns on one
 * box cannot collide on a name and `rm -f` each other's container).
 */
export const proMaxPreflightContainerName = (campaignId: string, instanceId: string): string =>
  `qpmx_${shortHash(campaignId)}_${instanceId.replace(/[^A-Za-z0-9_.-]/g, "_")}`

/**
 * The in-container probe. One `bash -c` that answers both questions the ticket
 * asks — is the campaign-unique gold-sentinel target path ABSENT, and did the
 * `docker cp` actually land — via explicit markers, so a silent no-op cannot
 * read as success.
 */
export const proMaxPreflightProbeScript = (campaignId: string): string => {
  const sentinel = `${UPSTREAM_TESTBED}/${goldSentinelPath(campaignId)}`
  return (
    `if [ -e '${sentinel}' ]; then echo ${SENTINEL_MARKER}=PRESENT; ` +
    `else echo ${SENTINEL_MARKER}=ABSENT; fi; ` +
    `if [ -f '${PROMAX_PREFLIGHT_CP_TARGET}' ]; then echo ${CP_MARKER}=OK; ` +
    `else echo ${CP_MARKER}=MISSING; fi`
  )
}

interface InspectFacts {
  readonly id: string
  readonly os: string
  readonly architecture: string
  readonly repoDigests: readonly string[]
}

const parseInspect = (stdout: string): InspectFacts | undefined => {
  const line = stdout.split("\n").find((l) => l.trim() !== "")
  if (line === undefined) return undefined
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const v = value as Record<string, unknown>
  if (typeof v.Id !== "string" || typeof v.Os !== "string" || typeof v.Architecture !== "string") {
    return undefined
  }
  const digests = Array.isArray(v.RepoDigests)
    ? v.RepoDigests.filter((d): d is string => typeof d === "string")
    : []
  return { id: v.Id, os: v.Os, architecture: v.Architecture, repoDigests: digests }
}

/** One instance's preflight outcome: a record, faults, or both (cleanup). */
interface InstanceOutcome {
  readonly record?: ProMaxImageRecord
  readonly faults: readonly ProMaxImageFault[]
}

const fault = (args: {
  readonly instanceId: string
  readonly code: ProMaxImageFaultCode
  readonly stage: ProMaxPreflightStage
  readonly message: string
  readonly argv: readonly string[]
  readonly exitCode: number
}): ProMaxImageFault => ({
  instance_id: args.instanceId,
  code: args.code,
  stage: args.stage,
  message: args.message,
  argv: args.argv,
  exit_code: args.exitCode,
})

const truncate = (s: string, n = 240): string => (s.length <= n ? s : `${s.slice(0, n)}…`)

const detailOf = (r: { stdout: string; stderr: string }): string =>
  truncate([r.stderr.trim(), r.stdout.trim()].filter((s) => s !== "").join(" | "))

/**
 * Remove the disposable container. Returns a `cleanup_failed` fault rather than
 * throwing — a container that outlived its preflight is a real operator problem
 * (it holds the image and a name) but it must not erase the image record that
 * was already earned.
 */
const cleanupContainer = async (
  docker: DockerPort,
  instanceId: string,
  container: string,
): Promise<readonly ProMaxImageFault[]> => {
  const argv = ["rm", "-f", container]
  const r = await docker(argv)
  if (r.code === 0) return []
  return [
    fault({
      instanceId,
      code: "cleanup_failed",
      stage: "cleanup",
      message: `could not remove disposable container ${container}: ${detailOf(r)}`,
      argv,
      exitCode: r.code,
    }),
  ]
}

const runContainerProofs = async (args: {
  readonly docker: DockerPort
  readonly campaignId: string
  readonly target: ProMaxImageTarget
  readonly container: string
  readonly probeFilePath: string
}): Promise<readonly ProMaxImageFault[]> => {
  const { docker, target, container } = args
  const cpArgv = ["cp", args.probeFilePath, `${container}:${PROMAX_PREFLIGHT_CP_TARGET}`]
  const cp = await docker(cpArgv)
  if (cp.code !== 0) {
    return [
      fault({
        instanceId: target.instanceId,
        code: "cp_failed",
        stage: "cp",
        message: `docker cp into ${container} failed: ${detailOf(cp)}`,
        argv: cpArgv,
        exitCode: cp.code,
      }),
    ]
  }

  const script = proMaxPreflightProbeScript(args.campaignId)
  const execArgv = ["exec", "-u", "root", container, "bash", "-c", script]
  const exec = await docker(execArgv)
  if (exec.code !== 0) {
    return [
      fault({
        instanceId: target.instanceId,
        code: "exec_failed",
        stage: "exec",
        message: `docker exec in ${container} failed: ${detailOf(exec)}`,
        argv: execArgv,
        exitCode: exec.code,
      }),
    ]
  }
  const out = exec.stdout
  const sentinelPresent = out.includes(`${SENTINEL_MARKER}=PRESENT`)
  const sentinelAbsent = out.includes(`${SENTINEL_MARKER}=ABSENT`)
  const cpOk = out.includes(`${CP_MARKER}=OK`)
  const cpMissing = out.includes(`${CP_MARKER}=MISSING`)
  if (!(sentinelPresent || sentinelAbsent) || !(cpOk || cpMissing)) {
    return [
      fault({
        instanceId: target.instanceId,
        code: "exec_failed",
        stage: "exec",
        message: `docker exec exited 0 but emitted neither ${SENTINEL_MARKER} nor ${CP_MARKER} markers — the probe did not run: ${truncate(out)}`,
        argv: execArgv,
        exitCode: exec.code,
      }),
    ]
  }
  if (cpMissing) {
    return [
      fault({
        instanceId: target.instanceId,
        code: "cp_failed",
        stage: "cp",
        message: `docker cp exited 0 but ${PROMAX_PREFLIGHT_CP_TARGET} is not present inside ${container}`,
        argv: cpArgv,
        exitCode: cp.code,
      }),
    ]
  }
  if (sentinelPresent) {
    return [
      fault({
        instanceId: target.instanceId,
        code: "sentinel_present",
        stage: "exec",
        message: `the campaign-unique gold-sentinel target ${goldSentinelPath(args.campaignId)} already exists under ${UPSTREAM_TESTBED} in this image — the sentinel patch could APPLY and the gold preflight would be vacuous`,
        argv: execArgv,
        exitCode: exec.code,
      }),
    ]
  }
  return []
}

const preflightOneInstance = async (args: {
  readonly input: ProMaxImagePreflightInput
  readonly target: ProMaxImageTarget
}): Promise<InstanceOutcome> => {
  const { input, target } = args
  const docker = input.docker
  const id = target.instanceId
  const ref = target.registryRepoDigest

  const pullArgv = ["pull", ref]
  const pull = await docker(pullArgv)
  if (pull.code !== 0) {
    return {
      faults: [
        fault({
          instanceId: id,
          code: "pull_failed",
          stage: "pull",
          message: `docker pull ${ref} failed: ${detailOf(pull)}`,
          argv: pullArgv,
          exitCode: pull.code,
        }),
      ],
    }
  }

  const inspectArgv = ["image", "inspect", "--format", "{{json .}}", ref]
  const inspect = await docker(inspectArgv)
  if (inspect.code !== 0) {
    return {
      faults: [
        fault({
          instanceId: id,
          code: "inspect_failed",
          stage: "inspect",
          message: `docker image inspect ${ref} failed: ${detailOf(inspect)}`,
          argv: inspectArgv,
          exitCode: inspect.code,
        }),
      ],
    }
  }
  const facts = parseInspect(inspect.stdout)
  if (facts === undefined) {
    return {
      faults: [
        fault({
          instanceId: id,
          code: "inspect_unparseable",
          stage: "inspect",
          message: `docker image inspect ${ref} did not emit a JSON object with Id/Os/Architecture: ${truncate(inspect.stdout)}`,
          argv: inspectArgv,
          exitCode: inspect.code,
        }),
      ],
    }
  }

  if (!facts.repoDigests.includes(ref)) {
    return {
      faults: [
        fault({
          instanceId: id,
          code: "digest_mismatch",
          stage: "verify",
          message: `reference ${ref} resolved to repo digest(s) [${facts.repoDigests.join(", ")}], which do not include the campaign pin ${ref}`,
          argv: inspectArgv,
          exitCode: inspect.code,
        }),
      ],
    }
  }

  if (facts.os !== PROMAX_REQUIRED_OS || facts.architecture !== PROMAX_REQUIRED_ARCHITECTURE) {
    return {
      faults: [
        fault({
          instanceId: id,
          code: "platform_unsupported",
          stage: "verify",
          message: `image platform is ${facts.os}/${facts.architecture}; the pinned ProMax evaluator requires ${PROMAX_REQUIRED_OS}/${PROMAX_REQUIRED_ARCHITECTURE}`,
          argv: inspectArgv,
          exitCode: inspect.code,
        }),
      ],
    }
  }

  const container = (input.containerName ?? proMaxPreflightContainerName)(input.campaignId, id)
  const runArgv = ["run", "-d", "--name", container, ref, "tail", "-f", "/dev/null"]
  const run = await docker(runArgv)
  if (run.code !== 0) {
    return {
      faults: [
        fault({
          instanceId: id,
          code: "start_failed",
          stage: "start",
          message: `could not start a disposable container from ${ref}: ${detailOf(run)}`,
          argv: runArgv,
          exitCode: run.code,
        }),
        ...(await cleanupContainer(docker, id, container)),
      ],
    }
  }

  const proofFaults = await runContainerProofs({
    docker,
    campaignId: input.campaignId,
    target,
    container,
    probeFilePath: input.probeFilePath,
  })
  const cleanupFaults = await cleanupContainer(docker, id, container)
  if (proofFaults.length > 0) return { faults: [...proofFaults, ...cleanupFaults] }

  return {
    record: {
      instance_id: id,
      source_image_name: target.sourceImageName,
      registry_repo_digest: ref,
      local_image_id: facts.id,
      os: facts.os,
      architecture: facts.architecture,
      resolved_at: input.now().toISOString(),
    },
    faults: cleanupFaults,
  }
}

/**
 * Run the preflight over every assigned instance and return the freeze receipt.
 *
 * SERIAL by construction. Concurrency here would interleave `docker pull` on a
 * box whose disk headroom is the binding constraint, and the ticket's rule is
 * that grader-side concurrency stays at 1 until a measured campaign changes it.
 */
export const runProMaxImagePreflight = async (
  input: ProMaxImagePreflightInput,
): Promise<ProMaxImageFreezeReceipt> => {
  const images: ProMaxImageRecord[] = []
  const faults: ProMaxImageFault[] = []
  for (const target of input.targets) {
    const outcome = await preflightOneInstance({ input, target })
    if (outcome.record !== undefined) images.push(outcome.record)
    faults.push(...outcome.faults)
  }
  return {
    receipt_version: 1,
    campaign_id: input.campaignId,
    upstream_git_commit: input.upstreamGitCommit,
    required_platform: { os: PROMAX_REQUIRED_OS, architecture: PROMAX_REQUIRED_ARCHITECTURE },
    golden_source: input.goldenSource,
    golden_derived: input.goldenDerived,
    images,
    faults,
    ok: faults.length === 0,
  }
}
