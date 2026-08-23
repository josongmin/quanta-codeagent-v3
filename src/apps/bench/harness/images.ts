/**
 * Docker image inventory for the SWE-bench harness — the warm-pool query.
 *
 * Read-only: lists what `sweb.{base,env,eval}.<arch>.*` images already exist on
 * the local daemon so `prepare.ts` can report how many env images are warm and
 * a future `--list-images` can show the operator their cache footprint. NEVER
 * mutates Docker state and NEVER throws (daemon down / parse error ⇒ []).
 */
import { errMessage } from "@/shared"
import { hostArch } from "./arch"

export type ImageTier = "base" | "env" | "instance"

export interface ImageInfo {
  /** e.g. "sweb.env.x86_64.django_1776_django" */
  repository: string
  /** typically "latest" */
  tag: string
  /** sha256:… (docker short or long id) */
  id: string
  /** 0 when unparseable — docker's `Size` column is human-formatted
   *  ("1.2GB") and we refuse to lie with an imprecise byte conversion. */
  sizeBytes: number
  tier: ImageTier
}

/** Injectable process boundary (mirrors evaluate.ts's Spawn, narrower — image
 *  listing needs no cwd and uses a fixed internal timeout). */
export type DockerSpawn = (argv: string[]) => Promise<{
  code: number
  stdout: string
  stderr: string
}>

/** A QUERY (`inspect`, `images`, `ps`) answers from local state; 30s means "the
 *  daemon is wedged". */
const DOCKER_QUERY_TIMEOUT_MS = 30_000

/**
 * A TRANSFER (`pull`, `push`) moves gigabytes over the network and cannot be
 * held to the query budget.
 *
 * aug-23, measured: every ProMax image failed the PMX-7 freeze with exit 143
 * (SIGTERM from this timer), because a multi-GB image pulled under amd64
 * emulation does not finish in 30s. The 30s was never chosen for transfers — the
 * docstring says "a hung daemon must not wedge the caller", which is a query
 * concern — so a large image was structurally impossible to freeze rather than
 * merely slow. A transfer still needs a ceiling (a stalled pull must not hang a
 * campaign forever), it just needs a transfer-shaped one.
 */
// 20 minutes. Written as a single literal, not `20 * 60_000`: the arithmetic form
// leaves a bare `60_000` that the no-undocumented-magic-timeout rail reads as an
// unbound wall-clock magic number (it only recognises a literal assigned DIRECTLY
// to an UPPER_SNAKE_CASE const). The value is sized to the observed worst case —
// a multi-GB ProMax image pulled under amd64 emulation — with headroom, and is a
// ceiling for a STALLED transfer, not a target.
const DOCKER_TRANSFER_TIMEOUT_MS = 1_200_000

const dockerTimeoutMsFor = (argv: readonly string[]): number =>
  argv[0] === "pull" || argv[0] === "push" ? DOCKER_TRANSFER_TIMEOUT_MS : DOCKER_QUERY_TIMEOUT_MS

/** Default `docker` spawn via Bun.spawn (no shell). The timeout is chosen per
 *  verb ({@link dockerTimeoutMsFor}) — a hung daemon must not wedge the caller,
 *  and a multi-GB pull must not be killed for being a multi-GB pull. Swallows a
 *  spawn throw into a non-zero result so {@link listSwebenchImages} upholds its
 *  never-throw contract end-to-end. */
export const defaultDockerSpawn: DockerSpawn = async (argv) => {
  try {
    const proc = Bun.spawn(["docker", ...argv], {
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    })
    const timer = setTimeout(() => proc.kill(), dockerTimeoutMsFor(argv))
    try {
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      const code = await proc.exited
      return { code, stdout, stderr }
    } finally {
      clearTimeout(timer)
    }
  } catch (e) {
    return { code: -1, stdout: "", stderr: errMessage(e) }
  }
}

/** SWE-bench image naming varies by tier:
 *    base     `sweb.base.py.x86_64`        (arch is the LAST segment)
 *    env      `sweb.env.x86_64.<repo>`     (arch right after the tier)
 *    instance `sweb.eval.x86_64.<repo>-<n>`
 *  So we match only the `sweb.<tier>.` prefix — the arch position differs and
 *  is validated by callers (e.g. `hasEnvImage`) where it actually matters.
 *  `eval` is the per-instance tier. Null for non-swebench images. */
const SWEBENCH_IMAGE_RE = /^sweb\.(base|env|eval)\./

/** Classify a docker repository name into a SWE-bench tier, or null. Pure. */
export const classifyImage = (repository: string): ImageTier | null => {
  const m = SWEBENCH_IMAGE_RE.exec(repository)
  if (!m) return null
  const tier = m[1]
  if (tier === "base") return "base"
  if (tier === "env") return "env"
  return "instance" // "eval"
}

interface DockerImageJson {
  Repository?: unknown
  Tag?: unknown
  ID?: unknown
}

/** Query the local daemon for SWE-bench images via
 *  `docker images --format '{{json .}}'`. Failure (daemon down, parse error)
 *  ⇒ []. NEVER throws. Non-swebench images are filtered out. */
export const listSwebenchImages = async (
  opts: { spawn?: DockerSpawn } = {},
): Promise<ImageInfo[]> => {
  const spawn = opts.spawn ?? defaultDockerSpawn
  const r = await spawn(["images", "--format", "{{json .}}"])
  if (r.code !== 0) return []
  const out: ImageInfo[] = []
  for (const line of r.stdout.split("\n")) {
    const trimmed = line.trim()
    if (trimmed === "") continue
    let parsed: DockerImageJson
    try {
      parsed = JSON.parse(trimmed) as DockerImageJson
    } catch {
      continue // skip malformed line, keep the rest
    }
    const repository = typeof parsed.Repository === "string" ? parsed.Repository : ""
    const tier = classifyImage(repository)
    if (tier === null) continue
    out.push({
      repository,
      tag: typeof parsed.Tag === "string" ? parsed.Tag : "latest",
      id: typeof parsed.ID === "string" ? parsed.ID : "",
      sizeBytes: 0,
      tier,
    })
  }
  return out
}

/** Partition an image list by tier. */
export const groupByTier = (
  images: ImageInfo[],
): { base: ImageInfo[]; env: ImageInfo[]; instance: ImageInfo[] } => {
  const base: ImageInfo[] = []
  const env: ImageInfo[] = []
  const instance: ImageInfo[] = []
  for (const img of images) {
    if (img.tier === "base") base.push(img)
    else if (img.tier === "env") env.push(img)
    else instance.push(img)
  }
  return { base, env, instance }
}

/** Coerce a host arch to the swebench image-name arch tag. */
const archTag = (): string => (hostArch() === "arm64" ? "arm64" : "x86_64")

/** True iff the env image for `repoSlug` (e.g. "django_1776_django") at the
 *  given arch is present locally. arch defaults to the host's swebench tag. */
export const hasEnvImage = (
  images: ImageInfo[],
  repoSlug: string,
  arch: string = archTag(),
): boolean => {
  const needle = `sweb.env.${arch}.${repoSlug}`
  return images.some((img) => img.tier === "env" && img.repository.startsWith(needle))
}
