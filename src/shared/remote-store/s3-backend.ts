/**
 * {@link RemoteBackend} backed by S3 via the `aws` CLI — NO `@aws-sdk/*`
 * dependency (this repo drives AWS through the cli, mirroring
 * `src/apps/bench/remote/ec2.ts`). The cli runner is injected so the whole
 * surface is unit-testable offline; the default runner is the only real effect.
 *
 *   put  → `aws s3 cp - s3://<bucket>/<path>`   (body on stdin; S3 is LWW)
 *   get  → `aws s3 cp s3://<bucket>/<path> -`   (exit≠0 ⇒ missing ⇒ undefined)
 *   list → `aws s3 ls s3://<bucket>/<prefix> --recursive`  (parse key column)
 *
 * `aws s3 ls --recursive` prints `<date> <time> <size> <key>` where <key> is
 * ALREADY the full path after the bucket — exactly what put/get expect — so we
 * take the 4th column verbatim (key may contain spaces, so we slice past the
 * first three whitespace-delimited fields rather than `.split` blindly).
 */
import type { RemoteBackend } from "./backend"

export interface RunAwsResult {
  readonly stdout: string
  readonly exitCode: number
  /** Captured stderr — used to distinguish not-found from transport failure. */
  readonly stderr?: string
}

export type RunAws = (args: readonly string[], stdin?: string) => Promise<RunAwsResult>

export interface S3BackendOptions {
  readonly bucket: string
  readonly region?: string
  readonly runAws?: RunAws
  /** Kill + throw if a single `aws` invocation runs longer than this. Default 60s. */
  readonly timeoutMs?: number
  /**
   * §17 packet R — server-side-encryption mode for every PUT. Default
   * {@link DEFAULT_SSE} (`AES256`, SSE-S3).
   *
   * The uploads here carry replay cassettes and run artifacts, which contain the
   * full LLM request: system prompt, messages, file contents the agent read, and
   * tool outputs. Encryption at rest was previously whatever the bucket happened
   * to default to — fine on a bucket with default encryption configured, silent
   * plaintext on one without. Asking EXPLICITLY makes the property a function of
   * this code rather than of a bucket someone else set up.
   *
   * Set to `"aws:kms"` (with a bucket-level key) for CMK-managed buckets. There
   * is deliberately no "off": a caller that wants no encryption can configure the
   * bucket, not silently weaken every producer.
   */
  readonly sse?: string
  /** Required by SSE-KMS callers to pin writes to one customer-managed key. */
  readonly sseKmsKeyId?: string
}

/** SSE-S3. Universally available, needs no key configuration, and is what a
 *  correctly-configured bucket would apply anyway — so this is a floor, not a
 *  behavior change, for buckets that already had default encryption. */
const DEFAULT_SSE = "AES256"

const DEFAULT_AWS_TIMEOUT_MS = 60_000

/**
 * Default cli runner — argv array (no shell ⇒ no injection), body on stdin.
 * CAPTURES stderr (so callers can tell NoSuchKey from a creds/network failure)
 * and enforces a timeout: a hung `aws` is killed and the call throws rather than
 * blocking the resume/load path forever. Mirrors `src/apps/bench/remote/ec2.ts`.
 */
export const makeDefaultRunAws =
  (timeoutMs: number): RunAws =>
  async (args, stdin) => {
    const proc = Bun.spawn(["aws", ...args], {
      stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        proc.kill()
      } catch {
        // best-effort: a kill failure must not mask the timeout error below
      }
    }, timeoutMs)
    try {
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      const exitCode = await proc.exited
      if (timedOut) {
        throw new Error(
          `[s3-backend] aws ${args.join(" ")} timed out after ${timeoutMs}ms (killed)`,
        )
      }
      return { stdout, exitCode, stderr }
    } finally {
      clearTimeout(timer)
    }
  }

/** Pull the FULL key (4th column onward) from one `aws s3 ls --recursive` line. */
const keyFromLsLine = (line: string): string | undefined => {
  const trimmed = line.trim()
  if (trimmed === "") return undefined
  // Columns: date time size key — split off exactly the first three fields,
  // keep the remainder intact (the key itself may contain spaces).
  const m = /^\S+\s+\S+\s+\S+\s+(.+)$/.exec(trimmed)
  return m?.[1]
}

/** Stderr signatures that mean the object genuinely does not exist (≠ transport). */
const NOT_FOUND_RE = /NoSuchKey|Not Found|does not exist|404/i

export const s3Backend = (opts: S3BackendOptions): RemoteBackend => {
  const runAws = opts.runAws ?? makeDefaultRunAws(opts.timeoutMs ?? DEFAULT_AWS_TIMEOUT_MS)
  const regionArgs: readonly string[] = opts.region !== undefined ? ["--region", opts.region] : []
  const uri = (path: string): string => `s3://${opts.bucket}/${path}`
  const sseArgs: readonly string[] = ["--sse", opts.sse ?? DEFAULT_SSE]
  const kmsArgs: readonly string[] =
    opts.sseKmsKeyId !== undefined ? ["--sse-kms-key-id", opts.sseKmsKeyId] : []

  return {
    async put(path, body) {
      // `--sse` on the WRITE only; reads need no flag (S3 decrypts SSE-S3
      // transparently), which is why `get` is asserted to stay unchanged.
      const res = await runAws(
        [...regionArgs, "s3", "cp", "-", uri(path), ...sseArgs, ...kmsArgs],
        body,
      )
      if (res.exitCode !== 0) {
        // A swallowed PUT failure silently loses durability — throw so the
        // producer can mark the run degraded (fail-closed).
        throw new Error(
          `[s3-backend] put ${path} failed (exit ${res.exitCode}): ${res.stderr ?? ""}`,
        )
      }
    },
    async get(path) {
      const res = await runAws([...regionArgs, "s3", "cp", uri(path), "-"])
      if (res.exitCode === 0) return res.stdout
      // Distinguish genuine not-found from transport failure. Per the backend
      // contract, get returns undefined ONLY for a missing key; any other
      // non-zero exit (creds/network/throttle/access-denied) is a transport
      // failure and MUST throw — never masquerade as "not found".
      const stderr = res.stderr ?? ""
      if (NOT_FOUND_RE.test(stderr)) return undefined
      throw new Error(`[s3-backend] get ${path} failed (exit ${res.exitCode}): ${stderr}`)
    },
    async list(prefix) {
      const res = await runAws([...regionArgs, "s3", "ls", uri(prefix), "--recursive"])
      if (res.exitCode !== 0) return []
      const keys: string[] = []
      for (const line of res.stdout.split("\n")) {
        const k = keyFromLsLine(line)
        if (k !== undefined) keys.push(k)
      }
      return keys
    },
  }
}
