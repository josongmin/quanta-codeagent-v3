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
  "verification-campaign-receipt.ts",
  "external-toolchain.ts",
  "verdict-env.ts",
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

  test("every campaign leaves a machine-readable record of what happened", async () => {
    // P2: lease wait, drain result, cancellation reason and host load existed
    // only as log lines, so diagnosing a stalled run meant grepping a
    // multi-megabyte transcript and reconstructing the order by eye.
    const root = mkdtempSync(join(tmpdir(), "quanta-verification-record-"))
    roots.push(root)
    const runner = copyCampaignOwner(root)
    const receiptPath = join(root, ".git", "quanta-verification-cache", "last-campaign.json")

    const green = Bun.spawn({
      cmd: [process.execPath, runner, "--", process.execPath, "-e", "process.exit(0)"],
      cwd: root,
      env: cleanLeaseEnv(),
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(await green.exited).toBe(0)
    const passed = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>
    expect(passed.schema).toBe("quanta.verification-campaign-receipt.v1")
    expect(passed.outcome).toBe("passed")
    expect(passed.exitCode).toBe(0)
    expect(passed.drained).toBe(true)
    expect(passed.survivingGroups).toEqual([])
    expect(passed.head).toMatch(/^[a-f0-9]{40}$/)
    expect(typeof passed.leaseWaitMs).toBe("number")
    expect(passed.leasePort).toBeGreaterThan(0)
    expect((passed.hostAtStart as { cpus: number }).cpus).toBeGreaterThan(0)

    // A red campaign is recorded as red, with the child's exit code.
    const red = Bun.spawn({
      cmd: [process.execPath, runner, "--", process.execPath, "-e", "process.exit(3)"],
      cwd: root,
      env: cleanLeaseEnv(),
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(await red.exited).toBe(3)
    const failed = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>
    expect(failed.outcome).toBe("failed")
    expect(failed.exitCode).toBe(3)
    expect(failed.cancellationReason).toBeUndefined()
  }, 30_000)

  test("a reuse is recorded as its own outcome, not left as the previous run", () => {
    // Without this, `last-campaign.json` described some older campaign while
    // the operator was looking at a fresh reuse — the file silently lagged the
    // thing it exists to explain.
    const root = mkdtempSync(join(tmpdir(), "quanta-verification-reused-"))
    roots.push(root)
    const runner = copyCampaignOwner(root)
    const env = cleanLeaseEnv()
    const receiptPath = join(root, ".git", "quanta-verification-cache", "last-campaign.json")
    const nestedGateEnv = {
      ...env,
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
    expect(reuse.exitCode, `${reuse.stdout.toString()}\n${reuse.stderr.toString()}`).toBe(0)
    const recorded = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>
    expect(recorded.outcome).toBe("reused")
    expect(recorded.head).toBe(head)
    // No lane was taken — that is the point of the reuse path.
    expect(recorded.leasePort).toBeNull()
    expect(recorded.exitCode).toBe(0)
  }, 30_000)

  test("a second campaign at the same state executes the gates zero times", () => {
    // THE DEDUPE INVARIANT, without a race. The first version raced two
    // campaigns and asserted the loser reused — which is decided by how fast
    // the follower's interpreter starts relative to the leader's gates, i.e.
    // by host load, and it flipped inside a full campaign while passing
    // standalone every time. Serialising makes the property the test actually
    // means: once a green exists for this exact state, the next campaign runs
    // NOTHING. Contention is covered separately by the lease tests above.
    const root = mkdtempSync(join(tmpdir(), "quanta-verification-dedupe-"))
    roots.push(root)
    mkdirSync(join(root, "tools", "dev"), { recursive: true })
    for (const file of CAMPAIGN_MODULES) {
      if (file === "gate-manifest.ts") continue
      copyFileSync(source(file), join(root, "tools", "dev", file))
    }
    copyFileSync(source("gate.ts"), join(root, "tools", "dev", "gate.ts"))
    const runs = Array.from({ length: 21 }, () => "true")
    runs[10] = "printf x >> .git/gate-count"
    writeFileSync(join(root, "tools", "dev", "gate-manifest.ts"), syntheticManifestSource(runs))
    initCommittedRepo(root)
    const runner = join(root, "tools", "dev", "verification-campaign.ts")
    const env = cleanLeaseEnv()
    const campaign = (): { code: number; out: string } => {
      const p = Bun.spawnSync(
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
      return { code: p.exitCode ?? 1, out: `${p.stdout.toString()}${p.stderr.toString()}` }
    }

    const first = campaign()
    expect(first.code, first.out).toBe(0)
    expect(readFileSync(join(root, ".git", "gate-count"), "utf8")).toBe("x")

    const second = campaign()
    expect(second.code, second.out).toBe(0)
    expect(second.out).toContain("REUSED exact receipt")
    // The counting gate did not run a second time.
    expect(readFileSync(join(root, ".git", "gate-count"), "utf8")).toBe("x")
  }, 60_000)
})
