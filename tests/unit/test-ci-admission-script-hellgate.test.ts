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
/**
 * Slice a declaration out of the runner by its real boundaries.
 *
 * These were `indexOf(start) .. indexOf(end)`, and a DOCSTRING that mentioned
 * `await main()` while explaining why the runner cannot be imported landed at a
 * lower offset than `const main =`. The slice went negative-length, `mainSource`
 * became `""`, and three guards — drain-before-release, the signal handler, and
 * the repository-lane serialization — passed over an empty string with no
 * output. `lastIndexOf` anchors on the real call, and the floor below makes an
 * empty slice loud instead of vacuously satisfied.
 */
const sliceDeclaration = (source: string, from: string, to: string): string => {
  const start = source.indexOf(from)
  const end = source.lastIndexOf(to)
  if (start === -1) throw new Error(`admission guard: runner has no ${from}`)
  if (end <= start) {
    throw new Error(`admission guard: ${to} does not follow ${from} — the slice would be empty`)
  }
  return source.slice(start, end)
}

const runShardSource = sliceDeclaration(shardRunner, "const runShard =", "const main =")
const mainSource = sliceDeclaration(shardRunner, "const main =", "await main()")
const planSource = await Bun.file(
  join(import.meta.dir, "..", "..", "tools", "dev", "test-shard-plan.ts"),
).text()
const optionsSource = await Bun.file(
  join(import.meta.dir, "..", "..", "tools", "dev", "test-shard-options.ts"),
).text()
const prePushHook = await Bun.file(
  join(import.meta.dir, "..", "..", ".githooks", "pre-push"),
).text()

const usesNativeShardSpool = (source: string): boolean =>
  (source.match(/registry\.spawnWorker\s*\(/g) ?? []).length === 1 &&
  // No direct Bun.spawn: the worker must go through the registry so it leads
  // its own process group and cancellation can kill the whole tree.
  (source.match(/Bun\.spawn\s*\(/g) ?? []).length === 0 &&
  /stdoutFd:\s*spoolFd/.test(source) &&
  /stderrFd:\s*spoolFd/.test(source) &&
  // The runner reads the spool FILE rather than relaying the child's output
  // through a JS stream. It used to be `readFileSync(spoolPath)` — the whole
  // file, twice — and is now a bounded window read from the end, which is the
  // same property with the runner's own RSS protected.
  /readSpoolTail\s*\(\s*spoolPath/.test(source) &&
  !/readFileSync\s*\(\s*spoolPath/.test(source)

const workerBailsAfterFirstFailure = (source: string): boolean =>
  (source.match(/registry\.spawnWorker\s*\(/g) ?? []).length === 1 &&
  (source.match(/["']--bail=1["']/g) ?? []).length === 1 &&
  /cmd:\s*\[[\s\S]*?["']bun["']\s*,\s*["']test["'][\s\S]*?["']--bail=1["']/.test(source)

const hookInvokesCanonicalFailFastPrepush = (source: string): boolean =>
  (source.match(/if ! bun run prepush; then/g) ?? []).length === 1 &&
  !/bun run prepush\s+--(?:bail|keep-going)/.test(source)

const shardTreatsAdmissionDeadlineAsStartupOnly = (source: string): boolean =>
  (source.match(/delete\s+workerEnv\[ADMISSION_DEADLINE_ENV\]/g) ?? []).length === 1 &&
  !/admissionFromEnv\s*\(/.test(source) &&
  !/remainingBudgetMs\s*\(/.test(source) &&
  !source.includes("admission-budget-exhausted")

const shardOwnsSourceJsCleanupOnce = (source: string): boolean =>
  (source.match(/await preflightSourceJs\s*\(\s*\)/g) ?? []).length === 1 &&
  (source.match(/await assertNoNewSourceJs\s*\(\s*\)/g) ?? []).length === 1 &&
  source.includes("workerEnv[SOURCE_JS_CLEANED_ROOT_ENV] = SOURCE_ROOT") &&
  source.includes("rmSync(chunk.cachePath, { force: true })") &&
  source.includes('await import("../../tests/preload-clean-source-js")')

const watchdogKillsWorkerTree = (source: string): boolean =>
  /void\s+handle\.cancel\s*\(\s*\)/.test(source) && !/proc\.kill\s*\(/.test(source)

const scheduleCancelsPeersAndReapsAll = (source: string): boolean =>
  (source.match(/runResourceAwareSchedule\s*(?:<[^\n>]*>\s*)?\(/g) ?? []).length === 1 &&
  /cancelAll:\s*\(\)\s*=>\s*input\.registry\.cancelAll\s*\(\s*\)/.test(source) &&
  /desiredConcurrency:\s*measuredConcurrency/.test(source) &&
  /resourceClassesOverlap\s*\(/.test(source) &&
  !/await\s+Promise\.all\s*\(/.test(source)

/**
 * The LAST `finally { … }` body, by brace matching.
 *
 * Was `/finally\s*\{([\s\S]*?)\}\s*\}/` — non-greedy, so it stopped at the
 * first `}` followed by `}`. Adding a nested `if` inside the block truncated
 * the captured body before `lease?.release()` and this guard reported "the
 * runner does not drain before releasing" about a runner that does. A
 * text-shaped guard that a correct edit turns red is a guard that gets
 * relaxed; this one counts braces instead.
 */
const lastFinallyBody = (source: string): string | undefined => {
  const keyword = source.lastIndexOf("finally")
  if (keyword < 0) return undefined
  const open = source.indexOf("{", keyword)
  if (open < 0) return undefined
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === "{") depth += 1
    else if (ch === "}") {
      depth -= 1
      if (depth === 0) return source.slice(open + 1, i)
    }
  }
  return undefined
}

const mainDrainsBeforeRelease = (source: string): boolean => {
  const finallyBlock = lastFinallyBody(source)
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
  test("ANTI-VACUITY — the runner slices this file reads are non-empty", () => {
    // Every `toContain` below is satisfied by "" only in the negative form, but
    // the positive ones went RED silently pointing at the wrong cause when a
    // docstring reordered the anchors. Pinned explicitly so the NEXT time an
    // anchor moves, the failure names the slice rather than the property.
    expect(runShardSource.length).toBeGreaterThan(500)
    expect(mainSource.length).toBeGreaterThan(2_000)
    expect(mainSource).toContain("acquireTestShardLease")
    expect(runShardSource).toContain("registry.spawnWorker")
  })

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
    // SPLIT BY EXECUTOR, because `--parallel=1` only means something to one of
    // them. It is a real `bun test` flag — "run test files in N worker
    // processes, implies --isolate" — and the shared-`mock.module`/env/cwd
    // corpus genuinely needs it: a parallel sweep of `tests/unit src` produced
    // ~74 failures that ALL passed in isolation. But
    // `tools/dev/run-test-shards.ts` had `if (arg === "--parallel=1") continue`:
    // a silent no-op. Five scripts passed it to the shard runner and READ as
    // serial-isolated while the runner chose its own intra-worker width.
    //
    // DERIVED, not listed. The previous version hard-coded two arrays and
    // asserted `length === 10`, which is the same snapshot-instead-of-invariant
    // shape this campaign already fixed once — and it silently omitted
    // `test:pollution` (the whole unit corpus in one process) and
    // `eval:retrieval`, under a test titled "every shared-process entrypoint".
    const scripts = packageJson.scripts ?? {}

    /** A `bun test` target that is a DIRECTORY or a glob, i.e. a broad sweep. */
    const runsBroadBunTest = (command: string): boolean => {
      const at = command.indexOf("bun test ")
      if (at === -1) return false
      return command
        .slice(at + "bun test ".length)
        .split(/\s+/u)
        .some((token) => token.startsWith("tests/") && !token.endsWith(".test.ts"))
    }
    const usesShardRunner = (command: string): boolean => command.includes("run-test-shards.ts")

    const broad = Object.entries(scripts).filter(([, command]) => runsBroadBunTest(command))
    const shardRunner = Object.entries(scripts).filter(([, command]) => usesShardRunner(command))

    // ANTI-VACUITY, over the real script set rather than a constant: both
    // populations must be non-trivial, or every assertion below is about
    // nothing. Floors, not equalities, so adding an eleventh broad script is a
    // legitimate edit rather than an automatic red.
    expect(broad.length).toBeGreaterThanOrEqual(7)
    expect(shardRunner.length).toBeGreaterThanOrEqual(5)

    const unserialised = broad
      .filter(([, command]) => !usesShardRunner(command))
      .filter(([, command]) => !/--parallel=1\b/u.test(command))
      .map(([name]) => name)
    expect(
      unserialised,
      unserialised.length === 0
        ? ""
        : "these sweep a whole test directory in ONE bun process without --parallel=1, so they " +
            `inherit the shared mock.module/env/cwd corruption: ${unserialised.join(", ")}`,
    ).toEqual([])

    // The shard-runner entrypoints get their serialization from the runner's
    // resource classes and scheduler, which is where a shared-process hazard is
    // actually expressed. The flag must NOT be there: the runner now refuses it.
    const smuggled = shardRunner
      .filter(([, command]) => /--parallel/u.test(command))
      .map(([name]) => name)
    expect(smuggled).toEqual([])

    // The two the hard-coded lists had missed, named so a future deletion is a
    // deliberate edit rather than an omission nobody notices.
    for (const name of ["test:pollution", "eval:retrieval"]) {
      expect({ name, broad: runsBroadBunTest(scripts[name] ?? "") }).toEqual({ name, broad: true })
    }
  })

  test("test:ci IS the manifest executor — one verification authority", () => {
    // The old test:ci was a hand-maintained chain that overlapped but did not
    // equal the prepush gate set, so "test:ci green" and "prepush green" were
    // different claims. It now delegates to the campaign-wrapped gate runner.
    expect(packageJson.scripts?.["test:ci"]).toBe("bun run prepush")
    expect(packageJson.scripts?.prepush).toBe(
      "bun run tools/dev/verification-campaign.ts -- bun run tools/dev/gate.ts prepush --reuse-receipt --bail",
    )
    expect(packageJson.scripts?.["prepush:cold"]).toBe(
      "QUANTA_TEST_CACHE=off bun run tools/dev/verification-campaign.ts -- bun run tools/dev/gate.ts prepush --bail",
    )
    expect(packageJson.scripts?.prepush).not.toContain("--keep-going")
    expect(hookInvokesCanonicalFailFastPrepush(prePushHook)).toBe(true)
    expect(
      hookInvokesCanonicalFailFastPrepush(
        prePushHook.replace(
          "if ! bun run prepush; then",
          "if ! bun run prepush --keep-going; then",
        ),
      ),
    ).toBe(false)
    // `verify:smoke` no longer names the canary files itself. `smoke` had TWO
    // authorities — this script ran two files, `gate.ts smoke` ran seven static
    // gates, and they shared no manifest — so the script now delegates to the
    // gate runner and the manifest owns the canary as `smoke-canary`.
    expect(packageJson.scripts?.["verify:smoke"]).toBe("bun run tools/dev/gate.ts smoke")
    expect(packageJson.scripts?.["test:smoke-canary"]).toContain("smoke-battery.test.ts")
    expect(packageJson.scripts?.["verify:prepush"]).toContain("gate.ts prepush")
    expect(packageJson.scripts?.["verify:prepush"]).not.toContain("verify:prepush")
    expect(packageJson.scripts?.["verify:full"]).toContain("gate.ts full")
    expect(packageJson.scripts?.["verify:pr"]).toContain("gate.ts pr")
    expect(packageJson.scripts?.["verify:nightly"]).toContain("gate.ts nightly")
    expect(packageJson.scripts?.["verify:nightly"]).toContain("QUANTA_TEST_CACHE=off")
    expect(packageJson.scripts?.["verify:pr"]).not.toContain("gate.ts prepush")
    expect(packageJson.scripts?.["verify:full"]).not.toContain("gate.ts prepush")
    expect(packageJson.scripts?.["verify:nightly"]).not.toContain("gate.ts prepush")
    expect(packageJson.scripts?.["test:ci"]).not.toContain("verify:")
    // The one authoritative execution the receipt-consuming gates derive from.
    const full = packageJson.scripts?.["test:full:ci"] ?? ""
    expect(full).toContain("run-test-shards.ts --suite=full --junit-out=.cache/full-junit.xml")
    // …and not the no-op flag the shard runner used to swallow.
    expect(full).not.toContain("--parallel")
  })

  test("tests/README documents every verify:* script that package.json owns", async () => {
    const readme = await Bun.file(join(import.meta.dir, "..", "..", "tests", "README.md")).text()
    const verifyScripts = Object.keys(packageJson.scripts ?? {}).filter((name) =>
      name.startsWith("verify:"),
    )
    expect(verifyScripts.length).toBeGreaterThanOrEqual(5)
    for (const name of verifyScripts) {
      expect(readme, name).toContain(`bun run ${name}`)
    }
    const stripped = readme.replaceAll("`bun run verify:smoke`", "`bun run verify:MISSING`")
    expect(stripped).not.toContain("`bun run verify:smoke`")
    expect(readme).toContain("`bun run verify:smoke`")
  })

  test("the authoritative full-suite runner bounds a wedged shard worker", () => {
    expect(packageJson.scripts?.test).toContain("tools/dev/run-test-shards.ts")
    expect(shardRunner).toContain("const SHARD_INACTIVITY_TIMEOUT_MS = 12 * 60_000")
    expect(shardRunner).toContain("lastProgressAt = Date.now()")
    // The notice must say WHAT the worker was doing AND which bound it crossed.
    // It used to be a single `idle=…ms` string, because inactivity was the only
    // bound; there are now three (inactivity, total wall, output cap) and the
    // message names the one that fired — a kill notice that cannot say why is
    // not a lead.
    expect(shardRunner).toContain("describeWatchdogKill(action, tick)")
    expect(shardRunner).toContain("SHARD_TOTAL_WALL_TIMEOUT_MS")
    expect(shardRunner).toContain("SHARD_OUTPUT_CAP_BYTES")
    expect(shardRunner).toContain("discoverSuiteFiles(")
    expect(shardRunner).toContain("planTestChunks(manifest")
    expect(shardTreatsAdmissionDeadlineAsStartupOnly(shardRunner)).toBe(true)
    expect(
      shardTreatsAdmissionDeadlineAsStartupOnly(
        shardRunner.replace(
          "delete workerEnv[ADMISSION_DEADLINE_ENV]",
          "void workerEnv[ADMISSION_DEADLINE_ENV]",
        ),
      ),
    ).toBe(false)
    // The input-scope digest is computed by the cache-scope resolver now, not
    // inline: a chunk is only scoped when it is BOTH resource-certified and
    // declared-input certified, and that decision needs both registries.
    expect(shardRunner).toContain("resolveChunkCacheScope(")
    expect(shardOwnsSourceJsCleanupOnce(shardRunner)).toBe(true)
    expect(shardRunner).toContain("loadTestTimings(TIMING_STORE)")
    // Timings are journalled per chunk and committed ONCE, instead of
    // rewriting the whole store on every chunk completion.
    expect(shardRunner).toContain("journal.record(")
    expect(shardRunner).toContain("journal.commit()")
    // The chunk's execution is proved by the EXACT file set, not by a count.
    // This marker used to pin `result.executedFiles === plan.files.length` —
    // the very comparison P0-1 removed, so the guard was holding the defect in
    // place. Asserts the current property instead, and that the count cannot
    // come back.
    expect(shardRunner).toContain("executedFileSetVerdict(")
    expect(shardRunner).toContain("EXECUTED-SET MISMATCH")
    expect(shardRunner).not.toContain("result.executedFiles === plan.files.length")
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
    // Class-aware chunk planning: the classifier, overlap matrix, and hashed
    // membership must all remain live. LPT no longer chooses bucket membership.
    expect(planSource).toContain("classifyTestResource")
    expect(planSource).toContain("VALIDATED_NONPURE_OVERLAPS")
    expect(planSource).toContain("bucketForFile")
    expect(planSource).toContain("DEFAULT_MEMBERSHIP")
    expect(planSource).not.toContain("const lptBins")
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

    // Red-on-injection: loading the WHOLE spool back into the runner's memory
    // is the defect the bounded tail replaced — a pathological producer would
    // otherwise be answered by materialising everything it produced.
    const wholeFile = runShardSource.replace(
      "readSpoolTail(spoolPath, SPOOL_REPLAY_BYTES)",
      'readFileSync(spoolPath, "utf8")',
    )
    expect(usesNativeShardSpool(wholeFile)).toBe(false)

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
