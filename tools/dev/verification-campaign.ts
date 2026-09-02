import { randomBytes } from "node:crypto"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { gatesForStage } from "./gate-manifest"
import {
  acquireTestShardLease,
  readCommittedRepositoryLeaseId,
  selectRepositoryLeaseIdentity,
  type TestShardLease,
  VERIFICATION_LEASE_OWNER_PID_ENV,
  VERIFICATION_LEASE_TOKEN_ENV,
} from "./test-shard-lease"
import { ShardProcessRegistry, terminationExitCode } from "./test-shard-lifecycle"
import { sharedVerificationCacheRoot } from "./verification-receipt"
import { probeExactVerificationReceipt } from "./verification-receipt-probe"

/**
 * Whole-campaign serializer for `bun run prepush` / `bun run test:ci`.
 *
 * The repository lease used to be acquired INSIDE the shard runner, so every
 * preflight gate (admission, typecheck, non-vacuity) from concurrent checkouts
 * ran unserialized, and prepush released the lane between its unit and
 * integration suites. This wrapper owns the lease for the ENTIRE campaign and
 * hands nested runners a token (owner-pid validated) so they never reacquire.
 *
 * Same-HEAD dedupe: for the exact `prepush --reuse-receipt` command, a valid
 * exact receipt short-circuits BEFORE the lease; any miss proceeds to the
 * lease, and the unchanged gate command probes AGAIN under the lease — so a
 * contender that waited behind a green same-HEAD campaign exits without
 * re-running a single gate.
 */

const REPO_ROOT = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
// Shared across worktrees, so "who is holding the verification lane" is
// answerable from ANY checkout waiting on it.
const LEASE_OWNER_SIDECAR = join(sharedVerificationCacheRoot(REPO_ROOT), "lease-owner.json")

const capture = (args: readonly string[]): { readonly code: number; readonly text: string } => {
  const result = Bun.spawnSync([...args], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" })
  return {
    code: result.exitCode ?? 1,
    text: `${result.stdout.toString()}${result.stderr.toString()}`,
  }
}

// Bun consumes the conventional `--` before the script observes argv. Keep
// accepting it for alternate launchers, but treat the remaining argv as the
// command instead of requiring an invisible separator.
const rawArgs = process.argv.slice(2)
const command = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs
if (command.length === 0) {
  process.stderr.write("usage: verification-campaign.ts -- <command> [args...]\n")
  process.exit(2)
}

const isExactPrepushReuse =
  basename(command[0] ?? "") === "bun" &&
  command[1] === "run" &&
  command[2] === "tools/dev/gate.ts" &&
  command[3] === "prepush" &&
  command.slice(4).includes("--reuse-receipt")

// A valid receipt means there is no campaign to serialize. Any miss/error
// proceeds to the lease, and the unchanged gate command probes again under the
// lease before executing gate 1.
if (isExactPrepushReuse) {
  try {
    const probe = probeExactVerificationReceipt(REPO_ROOT, gatesForStage("prepush"))
    if (probe.ok) {
      process.stdout.write(
        `[verification] REUSED exact receipt before repository lease head=${probe.head} path=${probe.path}\n`,
      )
      process.exit(0)
    }
    process.stdout.write(
      `[verification] receipt not reusable before repository lease (${probe.reason}); acquiring lease\n`,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stdout.write(
      `[verification] receipt probe failed closed before repository lease (${message}); acquiring lease\n`,
    )
  }
}

const remote = capture(["git", "remote", "get-url", "origin"])
const commonDir = capture(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"])
const identity = selectRepositoryLeaseIdentity({
  repositoryId: readCommittedRepositoryLeaseId(REPO_ROOT),
  remote,
  commonDir,
  cwd: REPO_ROOT,
})

/**
 * ONE termination path, installed before anything can be signalled.
 *
 * The first version swapped `terminate` from a wait-aborting stub to the real
 * drainer after the lease was acquired, and a signal landing in that window
 * was SWALLOWED — the default disposition was already replaced, so Ctrl-C did
 * nothing at all. This handler is correct in every phase instead: aborting the
 * wait is a no-op once the lease is held, cancelling an empty registry is a
 * no-op before the child is spawned, and releasing an unheld lease is a no-op
 * via the optional chain.
 */
const waitAborter = new AbortController()
// Generous SIGTERM grace: a nested shard runner drains its own detached worker
// groups on SIGTERM (bounded ~10s per group); killing it early would re-create
// the orphan class this wrapper exists to close.
const registry = new ShardProcessRegistry({ termGraceMs: 60_000, killGraceMs: 10_000 })
let lease: TestShardLease | undefined
let sidecarWritten = false
let terminating = false

const removeOwnerSidecar = (): void => {
  if (!sidecarWritten) return
  rmSync(LEASE_OWNER_SIDECAR, { force: true })
}

const terminate = (signal: NodeJS.Signals): void => {
  if (terminating) return
  terminating = true
  waitAborter.abort()
  process.stderr.write(`[verification] SIGNAL ${signal}; cancelling campaign process tree\n`)
  void (async () => {
    const outcome = await registry.cancelAll()
    if (!outcome.drained) {
      process.stderr.write(
        `[verification] WARN campaign group(s) survived SIGKILL: ${outcome.survivors.join(", ")}\n`,
      )
    }
    removeOwnerSidecar()
    lease?.release()
    process.exit(terminationExitCode(signal))
  })()
}
process.on("SIGINT", () => terminate("SIGINT"))
process.on("SIGTERM", () => terminate("SIGTERM"))

lease = await acquireTestShardLease({
  identity,
  signal: waitAborter.signal,
  onWait: (port, elapsedMs) =>
    process.stdout.write(
      `[verification] WAIT repository lease port=${port} elapsed=${Math.round(elapsedMs / 1_000)}s; ` +
        "another checkout owns the verification lane\n",
    ),
})

process.stdout.write(`[verification] LEASE acquired port=${lease.port} scope=whole-campaign\n`)

// Diagnostic sidecar only — never an authority. The kernel-owned port is the
// lease; this file answers "who is holding the lane and since when" while the
// port alone answers nothing.
const writeOwnerSidecar = (): void => {
  try {
    mkdirSync(dirname(LEASE_OWNER_SIDECAR), { recursive: true })
    writeFileSync(
      LEASE_OWNER_SIDECAR,
      `${JSON.stringify({
        schema: "quanta.verification-lease-owner.v1",
        pid: process.pid,
        port: lease.port,
        head: capture(["git", "rev-parse", "HEAD"]).text.trim(),
        command: command.join(" "),
        startedAt: new Date().toISOString(),
      })}\n`,
      { mode: 0o600 },
    )
    sidecarWritten = true
  } catch {
    // Diagnostics must never fail a campaign.
  }
}
writeOwnerSidecar()

try {
  const handle = registry.spawnWorker({
    cmd: command,
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      [VERIFICATION_LEASE_TOKEN_ENV]: randomBytes(32).toString("hex"),
      [VERIFICATION_LEASE_OWNER_PID_ENV]: String(process.pid),
    },
    stdoutFd: 1,
    stderrFd: 2,
    // The gate runner is what an operator interacts with; spawning it without
    // stdin (the lifecycle default for test workers) would hand every gate an
    // EOF instead of the terminal.
    stdin: "inherit",
  })
  const exit = await handle.exited
  process.exitCode = exit.code ?? 1
} finally {
  const outcome = await registry.cancelAll()
  if (!outcome.drained) {
    process.stderr.write(
      `[verification] WARN campaign group(s) survived SIGKILL: ${outcome.survivors.join(", ")}\n`,
    )
  }
  removeOwnerSidecar()
  lease?.release()
}
