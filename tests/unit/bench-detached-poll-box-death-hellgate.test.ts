/**
 * BUG 1 (jun-22 bench-remote bugbash) — the detached run+poll loop in
 * box-session.ts must NOT poll FOREVER when its box dies mid-grade.
 *
 * `runBenchDetachedPoll` launched the bench under `setsid` then polled an ssh
 * `cat run.exit` sentinel in a bare `for(;;)`. A spot box reclaimed mid-grade
 * NEVER writes `run.exit`, and every ssh poll to the dead box returns 255 — the
 * old loop IGNORED the failure and spun at the 15s cadence FOREVER, stranding the
 * worker and defeating the box-death-requeue invariant (rotation only re-checks
 * BETWEEN chunks).
 *
 * FIX: bound CONSECUTIVE poll failures; after the threshold, CONFIRM box liveness
 * via `aws ec2 describe-instances …State.Name`, and THROW a BoxDiedDuringRunError
 * (stamped BOX_DIED_DURING_RUN) when the box is gone so the pool requeues the
 * chunk on a FRESH box. A successful poll resets the counter.
 *
 * TEETH (red-on-injection — reverting any guard re-introduces the forever spin):
 *  - a box that dies mid-run (ssh poll fails forever + describe says `terminated`)
 *    causes the poll to issue a BOUNDED number of polls, then the chunk is
 *    requeued on a SECOND box where it succeeds — NOT lost, NOT an infinite spin;
 *  - the liveness confirmation actually queries describe-instances State.Name;
 *  - a CONCLUSIVELY dead state is required (a describe ERROR is inconclusive and
 *    must NOT abort a healthy run — covered by the control below).
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SpawnFn } from "../../src/apps/bench/remote/backend"
import { runBenchDetachedPoll } from "../../src/apps/bench/remote/box-session/detached-poll"
import { type PoolChunk, runPool } from "../../src/apps/bench/remote/pool"
import {
  createSpawnRecorder,
  ok,
  whenArgsInclude,
  whenCmd,
  whenSshRemote,
  whenSshRemoteIncludes,
  whenSshRemoteMatches,
} from "./bench-spawn-testkit"

const FULL_AUTH = JSON.stringify({
  access_token: "ACCESS",
  refresh_token: "REFRESH",
  id_token: "IDTOK",
  account_id: "acct",
  expires_at: "2099-01-01T00:00:00Z",
})

const TEMP_DIRS = new Set<string>()
const allocTempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  TEMP_DIRS.add(dir)
  return dir
}
const cleanup = (): void => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true })
  TEMP_DIRS.clear()
}

const TS_FIX_PATCH = [
  "diff --git a/src/index.ts b/src/index.ts",
  "--- a/src/index.ts",
  "+++ b/src/index.ts",
  "@@ -1 +1 @@",
  "-export const answer = 0",
  "+export const answer = 42",
].join("\n")

const writeDataset = (path: string): void => {
  const id = path.split("/").at(-1)?.replace(/\.jsonl$/, "") ?? "fixture"
  writeFileSync(path, `${JSON.stringify({ instance_id: `fixture__${id}`, patch: TS_FIX_PATCH })}\n`)
}

const RUN_EXIT_OK = ok("0\n==XQ-RUN-EXIT-XQ==\n")

const baseCfg = (spawn: SpawnFn, over: Record<string, unknown> = {}) => ({
  provision: {
    repoDir: "/tmp/repo",
    authJson: FULL_AUTH,
    datasetPath: "/tmp/unused.jsonl",
    spawn,
    sleep: async () => {},
    maxReadyPolls: 1,
  },
  workers: 1,
  preset: "agentless-v2",
  model: "gpt-5.4",
  concurrency: 8,
  singleBoxGuardDir: join(allocTempDir("poll-death-guard-"), "guard"),
  tokenBudgetDir: allocTempDir("poll-death-budget-"),
  tokenBudgetWaitMs: 5_000,
  tokenBudgetPollMs: 10,
  authJsonProvider: () => FULL_AUTH,
  // Forward the test seams down through gradeChunkOnBox → runBenchDetachedPoll so
  // the poll loop never really sleeps and its wall-clock clock is injectable.
  ...over,
})

afterAll(cleanup)

describe("BUG 1 — detached poll bounds box death (no forever spin)", () => {
  test("report+predictions completion breaks the poll even when run.exit is missing", async () => {
    const sshCommands: string[] = []
    const out = await runBenchDetachedPoll({
      iid: "i-report-complete",
      benchCmd: "bun run bench",
      runLog: "~/run.log",
      runExit: "~/run.exit",
      completionArtifacts: { reportJson: "~/report.json", predictionsJsonl: "~/preds.jsonl" },
      sleep: async () => {},
      pollIntervalMs: 1,
      onLine: () => {},
      aws: async () => ok("running\n"),
      ssh: async (remote) => {
        sshCommands.push(remote)
        if (remote.includes("setsid bash -c")) return ok("LAUNCHED\n")
        if (
          remote.includes("[ -s ~/report.json ]") &&
          remote.includes("json.load(open(sys.argv[1]))") &&
          remote.includes("[ -s ~/preds.jsonl ]")
        ) {
          return ok(`0\n==XQ-RUN-EXIT-XQ==\n`)
        }
        return ok(`\n==XQ-RUN-EXIT-XQ==\n`)
      },
    })

    expect(out.code).toBe(0)
    expect(sshCommands.some((cmd) => cmd.includes("[ -s ~/report.json ]"))).toBe(true)
  })

  test("non-parseable report does not trigger artifact-complete fallback before run.exit", async () => {
    let probes = 0
    const out = await runBenchDetachedPoll({
      iid: "i-report-half-written",
      benchCmd: "bun run bench",
      runLog: "~/run.log",
      runExit: "~/run.exit",
      completionArtifacts: { reportJson: "~/report.json", predictionsJsonl: "~/preds.jsonl" },
      sleep: async () => {},
      pollIntervalMs: 1,
      onLine: () => {},
      aws: async () => ok("running\n"),
      ssh: async (remote) => {
        if (remote.includes("setsid bash -c")) return ok("LAUNCHED\n")
        if (remote.includes("XQ-RUN-EXIT-XQ")) {
          probes += 1
          return probes === 1 ? ok(`\n==XQ-RUN-EXIT-XQ==\n`) : ok(`7\n==XQ-RUN-EXIT-XQ==\n`)
        }
        return ok("")
      },
    })

    expect(out.code).toBe(7)
    expect(probes).toBe(2)
  })

  test("a box that dies mid-run is requeued after a BOUNDED number of polls, not spun forever", async () => {
    const dsA = join(allocTempDir("poll-death-ds-"), "a.jsonl")
    writeDataset(dsA)

    let launchIdx = -1
    let probeCount = 0
    // The FIRST box (i-box0) dies: its run.exit/run.log polls fail forever AND
    // describe State.Name reports `terminated`. The SECOND box (i-box1) is healthy.
    const { fn, calls } = createSpawnRecorder(
      whenArgsInclude("describe-security-groups", ok("sg-abc")),
      whenCmd("curl", ok("203.0.113.7\n")), // SG ingress current-IP lookup (BUG 2)
      whenArgsInclude("run-instances", () => {
        launchIdx += 1
        return ok(`i-box${launchIdx}`)
      }),
      // State.Name query for the dead box (box0) ⇒ terminated; otherwise (the IP
      // describe, and box1's liveness) ⇒ running / an IP.
      whenArgsInclude("describe-instances", ({ args }) => {
        if (args.includes("Reservations[0].Instances[0].State.Name")) {
          return launchIdx === 0 ? ok("terminated\n") : ok("running\n")
        }
        return ok("1.2.3.4")
      }),
      whenArgsInclude("wait", ok("")),
      whenArgsInclude("terminate-instances", ok("")),
      whenSshRemoteIncludes("READY", ok("READY")),
      whenSshRemoteIncludes("setsid bash -c", ({ remote, onData }) => {
        const runId = remote.match(/~\/runs\/([^/]+)\/instances\.jsonl/)?.[1] ?? "unknown"
        if (remote.includes("cli.ts run")) onData?.(`[info] ${runId} started\n`)
        return ok("LAUNCHED")
      }),
      whenSshRemoteIncludes("mkdir ~/.pool-grade.lock", ok("LOCKED")),
      whenSshRemoteIncludes("rmdir ~/.pool-grade.lock", () =>
        // On the DEAD box the lock-release ssh also fails (255) — the fix must
        // still route this to requeue (the box-death marker wins over the
        // wrapped grade-lock-release failure).
        launchIdx === 0 ? { code: 255, stdout: "", stderr: "ssh: connect timed out" } : ok(""),
      ),
      // run.exit / run.log poll: box0 is dead ⇒ ssh 255 forever; box1 ⇒ exit 0.
      whenSshRemote(
        (remote) =>
          (remote.includes("run.exit") || remote.includes("XQ-RUN-EXIT-XQ")) &&
          !remote.includes("rm -f"),
        () => {
          probeCount += 1
          return launchIdx === 0
            ? { code: 255, stdout: "", stderr: "ssh: connect timed out" }
            : RUN_EXIT_OK
        },
      ),
      whenSshRemoteMatches(/cat ~\/runs\/([^/]+)\/report\.json/, () =>
        ok(JSON.stringify({ resolved_ids: ["fixture__a-1"] })),
      ),
      whenSshRemoteMatches(/tail -\d+ ~\/runs\/([^/]+)\/run\.log/, () => ok("")),
    )

    const chunks: PoolChunk[] = [{ runId: "a", datasetPath: dsA }]
    // provision.sleep (async noop) is forwarded as the detached-poll sleep seam, so
    // the box-death bound is exercised offline with no real 15s waits.
    const out = await runPool(chunks, baseCfg(fn, { maxChunkRetries: 2 }))

    // TEETH: the chunk was REQUEUED onto a fresh box and resolved — not lost,
    // not an infinite spin.
    expect(out).toHaveLength(1)
    const a = out[0]
    expect(a?.lost).toBe(false)
    expect(a?.attempts).toBe(2) // first box died, second succeeded
    expect(a?.result.resolved).toContain("fixture__a-1")
    // A SECOND box was provisioned (the requeue), proving the loop BROKE out of
    // the dead box instead of polling it forever.
    expect(calls.filter((c) => c.args.includes("run-instances")).length).toBe(2)
    // The dead box was probed a BOUNDED number of times then abandoned — the
    // threshold is 6 consecutive failures (jun-25: lowered 20→6 so a dead box is
    // requeued in minutes, not ~30min+). Assert it abandoned at the new, lower
    // bound — not the old 20, and never an unbounded spin.
    expect(probeCount).toBeGreaterThanOrEqual(6)
    expect(probeCount).toBeLessThan(20)
    // The liveness confirmation actually queried describe-instances State.Name.
    expect(
      calls.some(
        (c) =>
          c.cmd === "aws" && c.args.includes("Reservations[0].Instances[0].State.Name"),
      ),
    ).toBe(true)
  })
})
