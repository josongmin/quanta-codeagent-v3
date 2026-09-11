import { randomBytes } from "node:crypto"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describeQuietBoxWait, quietBoxBudgetMs, waitForQuietBox } from "./box-load"
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
import { ADMISSION_DEADLINE_ENV } from "./verification-admission"
import {
  buildCampaignReceipt,
  type CampaignOutcome,
  sampleCampaignHost,
  writeCampaignReceipt,
} from "./verification-campaign-receipt"
import { sharedVerificationCacheRoot } from "./verification-receipt"
import { probeExactVerificationReceipt } from "./verification-receipt-probe"
import { tierFromGateCommand } from "./verification-tier"

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
// Diagnostic history, one file per campaign outcome. Never read to decide
// whether to re-run — that is the exact receipt's job.
const CAMPAIGN_RECEIPT = join(sharedVerificationCacheRoot(REPO_ROOT), "last-campaign.json")

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
const verificationTier = tierFromGateCommand(command)
const TEST_STRESS_ENV = "QUANTA_TEST_STRESS"

/** Long enough for this repository's own 30-chunk suite to decay out of the
 *  1-minute average; past that the load is foreign and waiting buys nothing. */
const CAMPAIGN_QUIET_BOX_BUDGET_MS = 180_000

const campaignStartedAtMs = Date.now()
const hostAtStart = sampleCampaignHost()
/**
 * Resolve a git ref, or `null` if git could not.
 *
 * `capture` concatenates stdout AND stderr and never throws, so the previous
 * `capture(...).text.trim()` returned git's four-line `fatal: ambiguous
 * argument 'origin/main'` as if it were an OID whenever the ref was absent — a
 * fresh clone, a detached CI checkout, or a repository whose default branch is
 * not `origin/main`. Every `try/catch` around it was therefore dead code, and
 * the documented "null when there is no such ref" was unreachable.
 *
 * The shape check is deliberate and not paranoia: a ref that resolves must give
 * 40 hex characters, and anything else is a message, not an object name.
 */
const readRefOrNull = (ref: string): string | null => {
  const result = capture(["git", "rev-parse", ref])
  if (result.code !== 0) return null
  const value = result.text.trim()
  return /^[0-9a-f]{40}$/.test(value) ? value : null
}

/** HEAD must resolve; a campaign over a repository git cannot read is not a
 *  campaign. Throws rather than inventing a value. */
const readHead = (): string => {
  const head = readRefOrNull("HEAD")
  if (head === null) throw new Error("[verification] git cannot resolve HEAD in this checkout")
  return head
}

/**
 * HEAD as it was when this campaign got IN LINE for the repository lease.
 *
 * Kept separate from the HEAD it actually runs over. The wrapper can wait behind
 * another checkout for a long time — its own WAIT line reports elapsed seconds —
 * and anything landing in that window used to overwrite nothing: the single
 * capture happened before the wait, so the receipt described a state the run
 * never saw.
 */
const queuedHead = readHead()
let campaignHead = queuedHead
/** The comparison base, frozen WITH the head so local and hosted admission look
 *  at the same commit range. `null` when there is no such ref (a fresh clone,
 *  a detached CI checkout). */
let campaignBaseOid: string | null = readRefOrNull("origin/main")

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
      campaignHead = probe.head
      writeCampaignReceipt(
        CAMPAIGN_RECEIPT,
        buildCampaignReceipt({
          pid: process.pid,
          head: campaignHead,
          // This path never waited, so queued and running HEAD are the same by
          // construction — recorded explicitly rather than left to be inferred.
          queuedHead,
          endHead: campaignHead,
          baseOid: campaignBaseOid,
          headMovedInQueue: false,
          command: command.join(" "),
          verificationTier,
          // No lane was taken: that IS the outcome being recorded.
          leasePort: null,
          leaseWaitMs: 0,
          startedAtMs: campaignStartedAtMs,
          finishedAtMs: Date.now(),
          outcome: "reused",
          exitCode: 0,
          drained: true,
          survivingGroups: [],
          hostAtStart,
          hostAtEnd: sampleCampaignHost(),
        }),
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
let leaseWaitMs = 0

/** HEAD at exit, or `null` if git cannot answer. A receipt field must never be
 *  the reason a campaign fails. */
const currentHeadOrNull = (): string | null => readRefOrNull("HEAD")

/** One place that turns "what just happened" into the campaign receipt. */
const recordCampaign = (input: {
  readonly outcome: CampaignOutcome
  readonly exitCode: number | null
  readonly cancellationReason?: string
  readonly drained: boolean
  readonly survivingGroups: readonly number[]
}): void => {
  writeCampaignReceipt(
    CAMPAIGN_RECEIPT,
    buildCampaignReceipt({
      pid: process.pid,
      head: campaignHead,
      queuedHead,
      endHead: currentHeadOrNull(),
      baseOid: campaignBaseOid,
      headMovedInQueue: campaignHead !== queuedHead,
      command: command.join(" "),
      verificationTier,
      leasePort: lease?.port ?? null,
      leaseWaitMs,
      startedAtMs: campaignStartedAtMs,
      finishedAtMs: Date.now(),
      outcome: input.outcome,
      exitCode: input.exitCode,
      ...(input.cancellationReason === undefined
        ? {}
        : { cancellationReason: input.cancellationReason }),
      drained: input.drained,
      survivingGroups: input.survivingGroups,
      hostAtStart,
      hostAtEnd: sampleCampaignHost(),
    }),
  )
}

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
    recordCampaign({
      outcome: "terminated",
      exitCode: terminationExitCode(signal),
      cancellationReason: `signal:${signal}`,
      drained: outcome.drained,
      survivingGroups: outcome.survivors,
    })
    removeOwnerSidecar()
    lease?.release()
    process.exit(terminationExitCode(signal))
  })()
}
process.on("SIGINT", () => terminate("SIGINT"))
process.on("SIGTERM", () => terminate("SIGTERM"))

const leaseWaitStartedAtMs = Date.now()
lease = await acquireTestShardLease({
  identity,
  signal: waitAborter.signal,
  onWait: (port, elapsedMs) =>
    process.stdout.write(
      `[verification] WAIT repository lease port=${port} elapsed=${Math.round(elapsedMs / 1_000)}s; ` +
        "another checkout owns the verification lane\n",
    ),
})

leaseWaitMs = Date.now() - leaseWaitStartedAtMs

process.stdout.write(
  `[verification] LEASE acquired port=${lease.port} scope=whole-campaign ` +
    `lease_wait_ms=${leaseWaitMs}\n`,
)

// RE-FREEZE. Everything above happened while another checkout owned the lane.
// The gates below run over whatever HEAD is NOW, so that is the head the receipt
// must describe; `queuedHead` keeps the old value so the move is visible instead
// of silently replaced.
campaignHead = readHead()
campaignBaseOid = readRefOrNull("origin/main")
if (campaignHead !== queuedHead) {
  process.stdout.write(
    `[verification] HEAD MOVED while waiting for the lease: queued=${queuedHead} ` +
      `running=${campaignHead} (waited ${Math.round(leaseWaitMs / 1_000)}s)\n`,
  )
}

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
        head: campaignHead,
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

/**
 * Start on a box that is not oversubscribed, or say plainly that we did not.
 *
 * TWICE IN ONE DAY, on this machine, by processes that had nothing to do with
 * this repository: forty orphaned busy-loop shells another session left running
 * for nine and a half hours held a 16-core box at load 52, and an abandoned
 * watchman spun 15 dead jest roots at 1,267% CPU. Both cost a whole campaign —
 * the first through starved rust-analyzer cases that read as a code defect, the
 * second by making a fresh 45-minute run worthless from its first second.
 *
 * The lease is already held here on purpose: the wait is bounded, and losing
 * our place in line to a peer would be a worse trade than starting a little
 * later. It never refuses — a rail that unrelated load can stop is a rail
 * nobody can use on a working machine.
 */
const campaignQuietBudgetMs = quietBoxBudgetMs(process.env, CAMPAIGN_QUIET_BOX_BUDGET_MS)
const admissionDeadlineMs = Date.now() + campaignQuietBudgetMs
const startWait = await waitForQuietBox({
  budgetMs: campaignQuietBudgetMs,
  admission: { deadlineMs: admissionDeadlineMs, now: () => Date.now() },
})
process.stdout.write(`[verification] ${describeQuietBoxWait(startWait)}\n`)

// The deadline bounds ADMISSION only: once this campaign has decided to start
// (quiet or explicitly hot), it must not become a wall-clock TTL for the child.
// In particular, a full shard campaign normally outlives this three-minute
// budget. Strip both our deadline and a stale inherited one before execution.
const executionEnv = { ...process.env }
delete executionEnv[ADMISSION_DEADLINE_ENV]
// Stress rails are intentionally outside interactive and merge-gating tiers.
// They run only in the scheduled cache-off campaign, where repeats expose
// order/concurrency flakes without multiplying smoke/PR/full wall time.
delete executionEnv[TEST_STRESS_ENV]
if (verificationTier === "nightly" && executionEnv.QUANTA_TEST_CACHE === "off") {
  executionEnv[TEST_STRESS_ENV] = "1"
}

let campaignExitCode: number | null = null
try {
  const handle = registry.spawnWorker({
    cmd: command,
    cwd: REPO_ROOT,
    env: {
      ...executionEnv,
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
  campaignExitCode = exit.code
} finally {
  const outcome = await registry.cancelAll()
  if (!outcome.drained) {
    // The RUNNER already refuses to bless a campaign whose descendants it
    // cannot account for; the wrapper was only warning, which is the weaker
    // half of the same rule and the half that matters more — this process is
    // what hands the lane to the next contender. A campaign that leaves
    // processes behind releases the lane to someone whose ports, worktrees and
    // HOME are still in use.
    process.exitCode = 1
    campaignExitCode = process.exitCode
    process.stderr.write(
      `[verification] INVALID — campaign group(s) unaccounted for: ${outcome.survivors.join(", ")}; ` +
        "refusing to bless this campaign\n",
    )
  }
  // A signal path already wrote its own receipt and exits; do not overwrite it.
  if (!terminating) {
    recordCampaign({
      outcome: campaignExitCode === 0 ? "passed" : "failed",
      exitCode: campaignExitCode,
      drained: outcome.drained,
      survivingGroups: outcome.survivors,
    })
  }
  removeOwnerSidecar()
  lease?.release()
}
