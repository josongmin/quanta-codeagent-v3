// meta-test: package-script contract; it intentionally reads package.json rather than importing src/.

import { describe, expect, test } from "bun:test"
import { join } from "node:path"

type PackageJson = { readonly scripts?: Record<string, string> }

/** Anchored on THIS file. `Bun.file("package.json")` resolved against the ambient
 *  cwd, so from anywhere but the repo root the read failed and the whole file
 *  died at module scope — found by the paired control: 4 pass at the root,
 *  0 pass / 1 fail from a foreign working directory. */
const packageJson = (await Bun.file(
  join(import.meta.dir, "..", "..", "package.json"),
).json()) as PackageJson
const shardRunner = await Bun.file(
  join(import.meta.dir, "..", "..", "tools", "dev", "run-test-shards.ts"),
).text()
const runShardSource = shardRunner.slice(
  shardRunner.indexOf("const runShard ="),
  shardRunner.indexOf("const main ="),
)
const mainSource = shardRunner.slice(
  shardRunner.indexOf("const main ="),
  shardRunner.indexOf("await main()"),
)
const planSource = await Bun.file(
  join(import.meta.dir, "..", "..", "tools", "dev", "test-shard-plan.ts"),
).text()
const optionsSource = await Bun.file(
  join(import.meta.dir, "..", "..", "tools", "dev", "test-shard-options.ts"),
).text()

const usesNativeShardSpool = (source: string): boolean =>
  (source.match(/registry\.spawnWorker\s*\(/g) ?? []).length === 1 &&
  // No direct Bun.spawn: the worker must go through the registry so it leads
  // its own process group and cancellation can kill the whole tree.
  (source.match(/Bun\.spawn\s*\(/g) ?? []).length === 0 &&
  /stdoutFd:\s*spoolFd/.test(source) &&
  /stderrFd:\s*spoolFd/.test(source) &&
  /readFileSync\s*\(\s*spoolPath/.test(source)

const workerBailsAfterFirstFailure = (source: string): boolean =>
  (source.match(/registry\.spawnWorker\s*\(/g) ?? []).length === 1 &&
  (source.match(/["']--bail=1["']/g) ?? []).length === 1 &&
  /cmd:\s*\[[\s\S]*?["']bun["']\s*,\s*["']test["'][\s\S]*?["']--bail=1["']/.test(source)

const watchdogKillsWorkerTree = (source: string): boolean =>
  /void\s+handle\.cancel\s*\(\s*\)/.test(source) && !/proc\.kill\s*\(/.test(source)

const scheduleCancelsPeersAndReapsAll = (source: string): boolean =>
  (source.match(/runResourceAwareSchedule\s*(?:<[^\n>]*>\s*)?\(/g) ?? []).length === 1 &&
  /cancelAll:\s*\(\)\s*=>\s*input\.registry\.cancelAll\s*\(\s*\)/.test(source) &&
  /desiredConcurrency:\s*measuredConcurrency/.test(source) &&
  /resourceClassesOverlap\s*\(/.test(source) &&
  !/await\s+Promise\.all\s*\(/.test(source)

const mainDrainsBeforeRelease = (source: string): boolean => {
  const finallyBlock = /finally\s*\{([\s\S]*?)\}\s*\}/.exec(source)?.[1]
  if (finallyBlock === undefined) return false
  const drainAt = finallyBlock.indexOf("await drainCampaign(")
  const releaseAt = finallyBlock.indexOf("lease?.release()")
  // Descendants drained first, run root handled inside drainCampaign, lease
  // released only after — and never a bare rmSync racing live workers.
  return drainAt >= 0 && releaseAt > drainAt && !finallyBlock.includes("rmSync(runRoot")
}

const mainHandlesTerminationSignals = (source: string): boolean =>
  /process\.on\(\s*["']SIGINT["']/.test(source) &&
  /process\.on\(\s*["']SIGTERM["']/.test(source) &&
  (source.match(/terminateCampaignOnSignal\s*\(/g) ?? []).length === 1

const wiresRepositoryLease = (source: string): boolean =>
  (source.match(/acquireTestShardLease\s*\(/g) ?? []).length === 1 &&
  // A campaign wrapper may hand down the lane (inherited token, owner-pid
  // validated); a stray token fails closed instead of bypassing serialization.
  /inheritedTestShardLeaseState\s*\(/.test(source) &&
  /===\s*["']invalid["']/.test(source) &&
  /finally\s*\{[\s\S]*?lease\?\.release\s*\(\s*\)/.test(source)

describe("test:ci admission gate", () => {
  test("uses the live feature-catalog changed-file authority", () => {
    const script = packageJson.scripts?.["test:admission"]
    expect(script).toBe("bun fc check-changed")
    expect(script).not.toContain("tools/test-admission")
  })

  test("does not retain a sibling script pointing at the removed admission CLI", () => {
    const stale = Object.entries(packageJson.scripts ?? {}).filter(([, script]) =>
      script.includes("tools/test-admission"),
    )
    expect(stale).toEqual([])
  })

  test("keeps the manual shard escape hatch bounded", () => {
    const script = packageJson.scripts?.["test:shard"]
    expect(script).toContain("--timeout=60000")
    expect(script).toContain("--parallel=1")
  })

  test("serializes every shared-process test entrypoint", () => {
    const serialScripts = [
      "test",
      "test:unit",
      "test:unit:ci",
      "test:fast",
      "test:integration",
      "test:full:ci",
      "test:shard",
      "test:contract",
      "test:cov",
      "test:watch",
    ]
    for (const name of serialScripts) {
      expect(packageJson.scripts?.[name], name).toContain("--parallel=1")
    }
  })

  test("test:ci IS the manifest executor — one verification authority", () => {
    // The old test:ci was a hand-maintained chain that overlapped but did not
    // equal the prepush gate set, so "test:ci green" and "prepush green" were
    // different claims. It now delegates to the campaign-wrapped gate runner.
    expect(packageJson.scripts?.["test:ci"]).toBe("bun run prepush")
    expect(packageJson.scripts?.prepush).toBe(
      "bun run tools/dev/verification-campaign.ts -- bun run tools/dev/gate.ts prepush --reuse-receipt --keep-going",
    )
    expect(packageJson.scripts?.["prepush:cold"]).toBe(
      "QUANTA_TEST_CACHE=off bun run tools/dev/verification-campaign.ts -- bun run tools/dev/gate.ts prepush --keep-going",
    )
    expect(packageJson.scripts?.["verify:smoke"]).toContain("smoke-battery.test.ts")
    expect(packageJson.scripts?.["verify:prepush"]).toContain("gate.ts prepush")
    expect(packageJson.scripts?.["verify:prepush"]).not.toContain("verify:prepush")
    expect(packageJson.scripts?.["verify:full"]).toContain("--keep-going")
    expect(packageJson.scripts?.["test:ci"]).not.toContain("verify:")
    // The one authoritative execution the receipt-consuming gates derive from.
    const full = packageJson.scripts?.["test:full:ci"] ?? ""
    expect(full).toContain(
      "run-test-shards.ts --suite=full --junit-out=.cache/full-junit.xml --parallel=1",
    )
  })

  test("the authoritative full-suite runner bounds a wedged shard worker", () => {
    expect(packageJson.scripts?.test).toContain("tools/dev/run-test-shards.ts")
    expect(shardRunner).toContain("const SHARD_INACTIVITY_TIMEOUT_MS = 12 * 60_000")
    expect(shardRunner).toContain("lastProgressAt = Date.now()")
    expect(shardRunner).toContain("idle=$" + "{idleMs}ms")
    expect(shardRunner).toContain("discoverSuiteFiles(")
    expect(shardRunner).toContain("planTestChunks(manifest")
    expect(shardRunner).toContain("loadTestTimings(TIMING_STORE)")
    expect(shardRunner).toContain("harvestTimings(cached.chunk, result)")
    expect(shardRunner).toContain("result.executedFiles === plan.files.length")
    expect(shardRunner).toContain("aborting remaining shards")
    expect(shardRunner).not.toContain(["--shard=", "{shard}"].join("$"))
    expect(shardRunner).toContain("checkout changed during run")
    expect(shardRunner).toContain("checkout changed after chunk")
    expect(shardRunner).toContain("require a clean checkout")
    expect(shardRunner).toContain("opts.junitOut")
    expect(shardRunner).toContain("parseShardRunnerOptions")
    expect(shardRunner).toContain("cacheMode")
    expect(shardRunner).toContain("QUANTA_SCAN_REACH_RECORD: scanReachSink")
    expect(shardRunner).toContain("HOME: workerHome")
    expect(shardRunner).toContain("QUANTA_HOME: quantaHome")
    expect(shardRunner).not.toContain("QUANTA_CONFIG_DIR: quantaHome")
    expect(shardRunner).toContain("QUANTA_PREFS_HOME: prefsHome")
    // QUANTA_HOME already isolates the derived bench root. Injecting the more
    // specific override would hide the production precedence contract from
    // tests that intentionally mutate QUANTA_HOME.
    expect(shardRunner).not.toContain("QUANTA_BENCH_HOME: benchHome")
    expect(shardRunner).toContain("writeScanReachReceipt(")
    expect(optionsSource).toContain("--junit-out=")
    expect(optionsSource).toContain("--cache=")
    expect(planSource).toContain("chooseShardConcurrency")
    expect(planSource).toContain("TWO_WORKER_MIN_AVAILABLE_BYTES")
    // Class-aware chunk planning: the classifier, the conservative overlap
    // matrix, and the LPT bin placement must all remain live exports.
    expect(planSource).toContain("classifyTestResource")
    expect(planSource).toContain("VALIDATED_NONPURE_OVERLAPS")
    expect(planSource).toContain("lptBins")
  })

  test("the full-suite worker writes natively instead of relaying output through JS", () => {
    // Anti-vacuum: bind the scan to the one live worker spawn, not the small
    // git-capture helper or a comment/import mentioning the same identifiers.
    expect(runShardSource.match(/registry\.spawnWorker\s*\(/g)).toHaveLength(1)
    expect(usesNativeShardSpool(runShardSource)).toBe(true)

    // Red-on-injection: restoring the pipe that caused child backpressure must
    // make this guard fail even if the spool variables and comments remain.
    const piped = runShardSource.replace("stdoutFd: spoolFd", 'stdout: "pipe"')
    expect(usesNativeShardSpool(piped)).toBe(false)

    // Red-on-injection: a direct Bun.spawn worker shares the runner's process
    // group and cannot be tree-killed; the guard must reject it.
    const ungrouped = runShardSource.replace("registry.spawnWorker({", "Bun.spawn({")
    expect(usesNativeShardSpool(ungrouped)).toBe(false)
  })

  test("the shard child stops after its first failure", () => {
    expect(runShardSource.match(/registry\.spawnWorker\s*\(/g)).toHaveLength(1)
    expect(workerBailsAfterFirstFailure(runShardSource)).toBe(true)

    // Red-on-injection: a comment mentioning bail cannot preserve the guard if
    // the executable child argument is removed.
    const withoutBail = runShardSource.replace('"--bail=1",', "")
    expect(workerBailsAfterFirstFailure(withoutBail)).toBe(false)
  })

  test("the watchdog kills the worker's whole process tree, not just the Bun pid", () => {
    expect(watchdogKillsWorkerTree(runShardSource)).toBe(true)

    // Red-on-injection: restoring the direct-pid kill (which orphans browser/
    // LSP grandchildren) must fail even while the cancel identifier remains
    // mentioned in comments.
    const directKill = runShardSource.replace("void handle.cancel()", "proc.kill(9)")
    expect(watchdogKillsWorkerTree(directKill)).toBe(false)
  })

  test("a failing chunk cancels its peer group and the schedule is fully reaped", () => {
    expect(scheduleCancelsPeersAndReapsAll(runShardSource)).toBe(true)

    // Red-on-injection: reverting to bare Promise.all (the measured orphan
    // path — the peer worker and its grandchildren kept running after the
    // first shard verdict threw) must fail the guard.
    const orphaning = runShardSource.replace(
      /runResourceAwareSchedule\s*<[^\n>]*>\s*\(/,
      "await Promise.all((",
    )
    expect(scheduleCancelsPeersAndReapsAll(orphaning)).toBe(false)

    // Red-on-injection: dropping the per-start host measurement (memory/load
    // re-sampled before every worker) must fail the guard even while the
    // scheduler call remains.
    const unmeasured = runShardSource.replace(
      "desiredConcurrency: measuredConcurrency",
      "desiredConcurrency: () => Promise.resolve(2)",
    )
    expect(scheduleCancelsPeersAndReapsAll(unmeasured)).toBe(false)
  })

  test("the runner drains descendants before deleting the run root or releasing the lease", () => {
    expect(mainDrainsBeforeRelease(mainSource)).toBe(true)

    // Red-on-injection: the original shape — rmSync + release with no drain —
    // deleted the live workers' TMPDIR/HOME and let the next campaign overlap.
    const undrained = mainSource.replace(
      /await drainCampaign\([\s\S]*?\)\n/,
      "rmSync(runRoot, { recursive: true, force: true })\n",
    )
    expect(mainDrainsBeforeRelease(undrained)).toBe(false)
  })

  test("SIGINT/SIGTERM terminate the campaign through the draining path", () => {
    expect(mainHandlesTerminationSignals(mainSource)).toBe(true)

    // Red-on-injection: removing the handlers reverts to the default signal
    // disposition, which kills the runner instantly and orphans worker trees.
    const unhandled = mainSource
      .replace(/process\.on\(\s*["']SIGINT["']/, "noSignal(")
      .replace(/process\.on\(\s*["']SIGTERM["']/, "noSignal(")
    expect(mainHandlesTerminationSignals(unhandled)).toBe(false)
  })

  test("the full-suite runner serializes the repository lane across worktrees", () => {
    expect(mainSource.match(/acquireTestShardLease\s*\(/g)).toHaveLength(1)
    expect(wiresRepositoryLease(mainSource)).toBe(true)

    // Red-on-injection: an imported but unwired lease owner is not sufficient.
    const unwired = mainSource.replace("acquireTestShardLease({", "Promise.resolve({")
    expect(wiresRepositoryLease(unwired)).toBe(false)
  })
})
