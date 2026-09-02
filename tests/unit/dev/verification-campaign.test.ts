import { afterEach, describe, expect, test } from "bun:test"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { gatesForStage } from "@/../tools/dev/gate-manifest"
import {
  mintExactVerificationReceipt,
  verificationReceiptPath,
  writeExactVerificationReceipt,
} from "@/../tools/dev/verification-receipt"
import {
  verificationContextForSnapshot,
  verificationManifestSha256,
} from "@/../tools/dev/verification-receipt-probe"

const roots: string[] = []
const source = (name: string): string =>
  join(import.meta.dir, "..", "..", "..", "tools", "dev", name)

const CAMPAIGN_MODULES = [
  "verification-campaign.ts",
  "test-shard-lease.ts",
  "test-shard-lifecycle.ts",
  "gate-manifest.ts",
  "verification-receipt.ts",
  "verification-receipt-probe.ts",
  "external-toolchain.ts",
] as const

// Campaign startup spawns bun twice and hashes the tree; on a box already
// running a suite that is comfortably past 5s. These waits gate on an EVENT
// having happened, never on it happening fast.
const waitFor = async (predicate: () => boolean, timeoutMs = 20_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out")
    await Bun.sleep(10)
  }
}

const cleanLeaseEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env }
  delete env.QUANTA_VERIFICATION_LEASE_TOKEN
  delete env.QUANTA_VERIFICATION_LEASE_OWNER_PID
  return env
}

const git = (root: string, args: readonly string[]): string => {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

const initCommittedRepo = (root: string): void => {
  Bun.spawnSync(["git", "init", "-q"], { cwd: root })
  git(root, ["config", "user.email", "campaign-test@example.invalid"])
  git(root, ["config", "user.name", "Campaign Test"])
  writeFileSync(join(root, ".gitignore"), ".cache/\n")
  writeFileSync(join(root, "tracked.txt"), "baseline\n")
  git(root, ["add", "."])
  git(root, ["commit", "-qm", "fixture"])
}

const copyCampaignOwner = (root: string): string => {
  mkdirSync(join(root, "tools", "dev"), { recursive: true })
  for (const file of CAMPAIGN_MODULES) {
    copyFileSync(source(file), join(root, "tools", "dev", file))
  }
  initCommittedRepo(root)
  return join(root, "tools", "dev", "verification-campaign.ts")
}

/** Fixture manifest: 9 precommit + 10 prepush shell gates (floors satisfied). */
const syntheticManifestSource = (runs: readonly string[]): string => {
  const entries = runs.map((run, index) => ({
    id: `gate-${index + 1}`,
    stage: index < 10 ? "precommit" : "prepush",
    run,
    why: `behavioral fixture gate ${index + 1}`,
  }))
  return `
export type GateStage = "precommit" | "prepush"
export interface Gate {
  readonly id: string
  readonly stage: GateStage
  readonly run: string
  readonly why: string
  readonly consumes?: string
  readonly hostDependent?: string
  readonly notInWorkflow?: string
}
export const GATES: readonly Gate[] = ${JSON.stringify(entries, null, 2)}
export const gatesForStage = (stage: GateStage): readonly Gate[] =>
  stage === "precommit" ? GATES.filter((gate) => gate.stage === "precommit") : GATES
`
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("whole verification campaign lease", () => {
  test("a second campaign cannot start even its first command before the first releases", async () => {
    const root = mkdtempSync(join(tmpdir(), "quanta-verification-campaign-"))
    roots.push(root)
    const runner = copyCampaignOwner(root)
    const firstMarker = join(root, "first-started")
    const secondMarker = join(root, "second-started")
    const first = Bun.spawn({
      cmd: [
        process.execPath,
        runner,
        "--",
        process.execPath,
        "-e",
        `const m = await import(${JSON.stringify(join(root, "tools", "dev", "test-shard-lease.ts"))}); ` +
          `await Bun.write(${JSON.stringify(firstMarker)}, m.inheritedTestShardLeaseState(process.env)); ` +
          "await Bun.sleep(300)",
      ],
      cwd: root,
      env: cleanLeaseEnv(),
      stdout: "pipe",
      stderr: "pipe",
    })
    await waitFor(() => existsSync(firstMarker))
    expect(readFileSync(firstMarker, "utf8")).toBe("valid")

    const second = Bun.spawn({
      cmd: [
        process.execPath,
        runner,
        "--",
        process.execPath,
        "-e",
        `await Bun.write(${JSON.stringify(secondMarker)}, "1")`,
      ],
      cwd: root,
      env: cleanLeaseEnv(),
      stdout: "pipe",
      stderr: "pipe",
    })
    await Bun.sleep(80)
    expect(existsSync(secondMarker)).toBe(false)

    expect(await first.exited).toBe(0)
    expect(await second.exited).toBe(0)
    expect(existsSync(secondMarker)).toBe(true)
  }, 15_000)

  test("an exact receipt returns before a busy repository lease", async () => {
    const root = mkdtempSync(join(tmpdir(), "quanta-verification-reuse-"))
    roots.push(root)
    const runner = copyCampaignOwner(root)
    const env = cleanLeaseEnv()
    const nestedGateEnv = {
      ...env,
      // `bun run` prepends the same executable search chain at each nested
      // launcher. The receipt is minted by the inner gate while this probe runs
      // in the outer wrapper, so duplicate entries must compare equivalent.
      PATH: [env.PATH, env.PATH].filter((value) => value !== undefined).join(delimiter),
    }
    const head = git(root, ["rev-parse", "HEAD"])
    writeExactVerificationReceipt(
      verificationReceiptPath(root),
      mintExactVerificationReceipt(
        verificationContextForSnapshot(
          root,
          { head, status: "" },
          verificationManifestSha256(gatesForStage("prepush")),
          nestedGateEnv,
        ),
      ),
    )

    const holderStarted = join(root, ".git", "holder-started")
    const holderFinished = join(root, ".git", "holder-finished")
    const holder = Bun.spawn({
      cmd: [
        process.execPath,
        runner,
        "--",
        process.execPath,
        "-e",
        `await Bun.write(${JSON.stringify(holderStarted)}, "1"); ` +
          `await Bun.sleep(800); await Bun.write(${JSON.stringify(holderFinished)}, "1")`,
      ],
      cwd: root,
      env,
      stdout: "pipe",
      stderr: "pipe",
    })
    await waitFor(() => existsSync(holderStarted))

    const reuse = Bun.spawnSync(
      [
        process.execPath,
        runner,
        "--",
        process.execPath,
        "run",
        "tools/dev/gate.ts",
        "prepush",
        "--reuse-receipt",
      ],
      { cwd: root, env, stdout: "pipe", stderr: "pipe" },
    )
    const reuseOut = reuse.stdout.toString()
    expect(reuse.exitCode, `${reuseOut}\n${reuse.stderr.toString()}`).toBe(0)
    // The invariant is that the reuse path returned WITHOUT taking the lane —
    // which the markers state directly. The first version asserted that the
    // 800ms holder had not finished yet, i.e. it raced the host: on a loaded
    // box the probe's own process startup outlives the holder and the test
    // fails while the product is correct.
    expect(reuseOut).toContain("REUSED exact receipt before repository lease")
    expect(reuseOut).not.toContain("LEASE acquired")
    expect(await holder.exited).toBe(0)
  }, 15_000)

  test("a signal during lease acquisition is never swallowed", async () => {
    // The window this pins: `terminate` used to be a wait-aborting stub until
    // the lease was acquired, so a signal landing between acquisition and the
    // real handler's installation hit a no-op — and the default disposition
    // was already replaced, so the campaign just kept running. Here the lane is
    // HELD by a first campaign, the contender is signalled while it waits, and
    // it must die rather than sit on a swallowed signal.
    const root = mkdtempSync(join(tmpdir(), "quanta-verification-signal-"))
    roots.push(root)
    const runner = copyCampaignOwner(root)
    const env = cleanLeaseEnv()
    const holderStarted = join(root, ".git", "holder-started")
    const holder = Bun.spawn({
      cmd: [
        process.execPath,
        runner,
        "--",
        process.execPath,
        "-e",
        `await Bun.write(${JSON.stringify(holderStarted)}, "1"); await Bun.sleep(4000)`,
      ],
      cwd: root,
      env,
      stdout: "pipe",
      stderr: "pipe",
    })
    await waitFor(() => existsSync(holderStarted))

    const contender = Bun.spawn({
      cmd: [process.execPath, runner, "--", process.execPath, "-e", "await Bun.sleep(4000)"],
      cwd: root,
      env,
      stdout: "pipe",
      stderr: "pipe",
    })
    // Give it time to enter the wait, then signal it.
    await Bun.sleep(400)
    contender.kill("SIGTERM")
    const contenderExit = await Promise.race([
      contender.exited,
      Bun.sleep(6_000).then(() => "still-running" as const),
    ])
    expect(contenderExit).not.toBe("still-running")

    holder.kill("SIGTERM")
    await holder.exited
  }, 20_000)

  test("the campaign hands its child a real stdin", async () => {
    // Test workers get no stdin by design, but the campaign's child is the
    // gate runner an operator talks to, and spawning it with stdin ignored
    // handed every gate an EOF. Asserting merely that a read SUCCEEDS is
    // vacuous — an ignored stdin is /dev/null, which reads clean and empty.
    // The discriminator is the BYTES: they only arrive through inherit.
    const root = mkdtempSync(join(tmpdir(), "quanta-verification-stdin-"))
    roots.push(root)
    const runner = copyCampaignOwner(root)
    const marker = join(root, "stdin-bytes")
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        runner,
        "--",
        process.execPath,
        "-e",
        `await Bun.write(${JSON.stringify(marker)}, await Bun.stdin.text())`,
      ],
      cwd: root,
      env: cleanLeaseEnv(),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    child.stdin.write("campaign-stdin-probe\n")
    child.stdin.end()
    expect(await child.exited).toBe(0)
    expect(readFileSync(marker, "utf8")).toBe("campaign-stdin-probe\n")
  }, 20_000)

  test("two concurrent same-HEAD campaigns execute the gates exactly once", async () => {
    // The measured P0: a contender that waited behind a green same-HEAD
    // campaign used to re-run the ENTIRE gate set. Under the campaign lease +
    // exact receipt, the follower must exit green with zero gate executions.
    const root = mkdtempSync(join(tmpdir(), "quanta-verification-dedupe-"))
    roots.push(root)
    mkdirSync(join(root, "tools", "dev"), { recursive: true })
    for (const file of CAMPAIGN_MODULES) {
      if (file === "gate-manifest.ts") continue
      copyFileSync(source(file), join(root, "tools", "dev", file))
    }
    copyFileSync(source("gate.ts"), join(root, "tools", "dev", "gate.ts"))
    const runs = Array.from({ length: 21 }, () => "true")
    // Count executions AND hold the lane long enough for the contender to
    // arrive while the leader is mid-campaign.
    runs[10] = "printf x >> .git/gate-count && sleep 1"
    writeFileSync(join(root, "tools", "dev", "gate-manifest.ts"), syntheticManifestSource(runs))
    initCommittedRepo(root)
    const runner = join(root, "tools", "dev", "verification-campaign.ts")
    const env = cleanLeaseEnv()
    const campaignCmd = [
      process.execPath,
      runner,
      "--",
      process.execPath,
      "run",
      "tools/dev/gate.ts",
      "prepush",
      "--reuse-receipt",
    ]
    const leader = Bun.spawn({ cmd: campaignCmd, cwd: root, env, stdout: "pipe", stderr: "pipe" })
    await waitFor(() => existsSync(join(root, ".git", "gate-count")), 10_000)
    const follower = Bun.spawn({ cmd: campaignCmd, cwd: root, env, stdout: "pipe", stderr: "pipe" })

    const [leaderExit, followerExit] = await Promise.all([leader.exited, follower.exited])
    const leaderOut = await new Response(leader.stdout).text()
    const followerOut = await new Response(follower.stdout).text()
    expect(leaderExit, leaderOut).toBe(0)
    expect(followerExit, followerOut).toBe(0)
    // Exactly one execution of the counting gate across BOTH campaigns.
    expect(readFileSync(join(root, ".git", "gate-count"), "utf8")).toBe("x")
    expect(followerOut).toContain("REUSED exact receipt")
  }, 30_000)
})
