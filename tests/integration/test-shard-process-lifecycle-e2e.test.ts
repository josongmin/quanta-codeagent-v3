import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  drainCampaign,
  groupHasRunningMemberFromPs,
  groupStateLines,
  hasRunningMember,
  killProcessTree,
  processGroupAlive,
  processGroupHoldsResources,
  runResourceAwareSchedule,
  ShardProcessRegistry,
  terminateCampaignOnSignal,
  terminationExitCode,
} from "../../tools/dev/test-shard-lifecycle"

const MODULE_PATH = join(import.meta.dir, "..", "..", "tools", "dev", "test-shard-lifecycle.ts")

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const waitFor = async (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) return false
    await Bun.sleep(25)
  }
  return true
}

/** Bun -e source for a worker that spawns a `sleep` grandchild and reports its pid. */
const grandchildWorkerSource = (pidFile: string, exitAfterSpawn: boolean): string =>
  `const gc = Bun.spawn({ cmd: ["sleep", "120"] });` +
  `await Bun.write(${JSON.stringify(pidFile)}, String(gc.pid));` +
  (exitAfterSpawn ? "process.exit(0);" : "await gc.exited;")

const scratchDirs: string[] = []
const leakedPids: number[] = []

const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "shard-lifecycle-test-"))
  scratchDirs.push(dir)
  return dir
}

const readGrandchildPid = (pidFile: string): number => {
  const pid = Number.parseInt(readFileSync(pidFile, "utf8"), 10)
  expect(Number.isSafeInteger(pid) && pid > 1).toBe(true)
  leakedPids.push(pid)
  return pid
}

afterEach(() => {
  // Belt and braces: no test may leak a sleep(120) into the host even when
  // its assertions fail before the kill step.
  for (const pid of leakedPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // already dead — the expected case
    }
  }
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const spawnGrandchildWorker = (
  registry: ShardProcessRegistry,
  dir: string,
  options: { readonly exitAfterSpawn?: boolean } = {},
) => {
  const pidFile = join(dir, `gc-${Math.random().toString(36).slice(2)}.pid`)
  const handle = registry.spawnWorker({
    cmd: ["bun", "-e", grandchildWorkerSource(pidFile, options.exitAfterSpawn ?? false)],
    cwd: dir,
    env: process.env,
    stdoutFd: 1,
    stderrFd: 2,
  })
  return { handle, pidFile }
}

describe("shard worker process lifecycle", () => {
  test("cancel kills the whole process group, grandchildren included", async () => {
    const dir = scratch()
    const registry = new ShardProcessRegistry({ termGraceMs: 500, killGraceMs: 3_000 })
    const { handle, pidFile } = spawnGrandchildWorker(registry, dir)
    expect(await waitFor(() => existsSync(pidFile), 10_000)).toBe(true)
    const grandchild = readGrandchildPid(pidFile)
    expect(pidAlive(grandchild)).toBe(true)
    expect(registry.liveGroups()).toContain(handle.pid)

    expect(await handle.cancel()).toBe(true)
    expect(handle.cancelled).toBe(true)
    expect(pidAlive(grandchild)).toBe(false)
    // What a drain can promise is that nothing in the group is RUNNING. The
    // group may still exist for a moment as unreaped zombies, which own
    // nothing and cannot be killed; waiting for those is waiting forever.
    expect(processGroupHoldsResources(handle.pid)).toBe(false)
    expect(registry.liveGroups()).toHaveLength(0)
  }, 20_000)

  test("control: Promise.all abandons the peer's grandchild at rejection time", async () => {
    // This is the measured defect the batch primitive exists to close: the
    // moment Promise.all rejects, the sibling worker and its grandchild are
    // still alive and nothing awaits them.
    const dir = scratch()
    const registry = new ShardProcessRegistry({ termGraceMs: 500, killGraceMs: 3_000 })
    const { handle, pidFile } = spawnGrandchildWorker(registry, dir)
    const peer = handle.exited.then(() => {
      throw new Error("peer finished")
    })
    const failing = (async () => {
      expect(await waitFor(() => existsSync(pidFile), 10_000)).toBe(true)
      throw new Error("primary failure")
    })()
    await expect(Promise.all([failing, peer])).rejects.toThrow("primary failure")
    const grandchild = readGrandchildPid(pidFile)
    expect(pidAlive(grandchild)).toBe(true)
    // With a real process running the two predicates agree.
    expect(processGroupAlive(handle.pid)).toBe(true)
    expect(processGroupHoldsResources(handle.pid)).toBe(true)
    // Manual cleanup — exactly the burden the runner used to leave behind.
    expect(await handle.cancel()).toBe(true)
    await peer.catch(() => {})
    expect(pidAlive(grandchild)).toBe(false)
  }, 20_000)

  test("first failure cancels the peer group and reaps the schedule before rethrowing", async () => {
    const dir = scratch()
    const registry = new ShardProcessRegistry({ termGraceMs: 500, killGraceMs: 3_000 })
    const { handle, pidFile } = spawnGrandchildWorker(registry, dir)
    let peerSettled = false
    const schedule = runResourceAwareSchedule<string>({
      tasks: [
        {
          key: 1,
          resourceClass: "pure",
          run: async () => {
            expect(await waitFor(() => existsSync(pidFile), 10_000)).toBe(true)
            throw new Error("primary failure")
          },
        },
        {
          key: 2,
          resourceClass: "pure",
          run: async () => {
            const exit = await handle.exited
            peerSettled = true
            throw new Error(`peer killed by ${exit.signal ?? exit.code}`)
          },
        },
      ],
      overlap: () => true,
      desiredConcurrency: () => Promise.resolve(2),
      cancelAll: () => registry.cancelAll(),
    })
    await expect(schedule).rejects.toThrow("primary failure")
    // The rejection must carry the PRIMARY error, and by the time it
    // surfaces the peer is settled and its whole tree is gone.
    expect(peerSettled).toBe(true)
    const grandchild = readGrandchildPid(pidFile)
    expect(pidAlive(grandchild)).toBe(false)
    expect(processGroupHoldsResources(handle.pid)).toBe(false)
    expect(registry.liveGroups()).toHaveLength(0)
  }, 20_000)

  test("incompatible resource classes never overlap; pure rides alongside", async () => {
    const running = new Set<number>()
    const observedOverlaps: string[][] = []
    const concurrencyProbes: number[] = []
    const track = (key: number, resourceClass: string, holdMs: number) => ({
      key,
      resourceClass,
      run: async () => {
        running.add(key)
        observedOverlaps.push([...running].sort((a, b) => a - b).map(String))
        await Bun.sleep(holdMs)
        running.delete(key)
        return resourceClass
      },
    })
    const results = await runResourceAwareSchedule<string>({
      // Two "port" chunks must serialize against each other while a "pure"
      // chunk may overlap either of them.
      tasks: [track(1, "port", 120), track(2, "port", 120), track(3, "pure", 120)],
      overlap: (left, right) => left === "pure" || right === "pure",
      desiredConcurrency: (runningCount) => {
        concurrencyProbes.push(runningCount)
        return Promise.resolve(2)
      },
      cancelAll: () => Promise.resolve(),
    })
    expect([...results.values()].sort()).toEqual(["port", "port", "pure"])
    // No snapshot may ever contain BOTH port chunks (keys 1 and 2).
    for (const snapshot of observedOverlaps) {
      expect(snapshot.includes("1") && snapshot.includes("2")).toBe(false)
    }
    // Concurrency was re-measured before starts (at least one probe per task).
    expect(concurrencyProbes.length).toBeGreaterThanOrEqual(3)
  }, 15_000)

  test("a schedule with a single lane still finishes every task in order", async () => {
    const order: number[] = []
    const results = await runResourceAwareSchedule<number>({
      tasks: [1, 2, 3].map((key) => ({
        key,
        resourceClass: "pure",
        run: async () => {
          order.push(key)
          await Bun.sleep(10)
          return key
        },
      })),
      overlap: () => true,
      // A host under pressure measures 1: strict serial execution.
      desiredConcurrency: () => Promise.resolve(1),
      cancelAll: () => Promise.resolve(),
    })
    expect([...results.keys()].sort()).toEqual([1, 2, 3])
    expect(order).toEqual([1, 2, 3])
  }, 15_000)

  test("a green worker that leaks a grandchild keeps its group tracked until drained", async () => {
    const dir = scratch()
    const runRoot = join(dir, "run-root")
    mkdirSync(runRoot, { recursive: true })
    writeFileSync(join(runRoot, "marker"), "campaign")
    const registry = new ShardProcessRegistry({ termGraceMs: 500, killGraceMs: 3_000 })
    const { handle, pidFile } = spawnGrandchildWorker(registry, dir, { exitAfterSpawn: true })
    const exit = await handle.exited
    expect(exit.code).toBe(0)
    expect(await waitFor(() => existsSync(pidFile), 10_000)).toBe(true)
    const grandchild = readGrandchildPid(pidFile)
    expect(pidAlive(grandchild)).toBe(true)
    // Direct child exited green, but the group is NOT empty — it must stay
    // tracked so cleanup cannot run under the leaked descendant.
    expect(registry.liveGroups()).toContain(handle.pid)

    const lines: string[] = []
    const outcome = await drainCampaign({
      registry,
      runRoot,
      log: (line) => lines.push(line),
    })
    expect(outcome.drained).toBe(true)
    expect(pidAlive(grandchild)).toBe(false)
    expect(existsSync(runRoot)).toBe(false)
  }, 20_000)

  test("drainCampaign keeps the run root while a group survives SIGKILL", async () => {
    const dir = scratch()
    const runRoot = join(dir, "run-root")
    mkdirSync(runRoot, { recursive: true })
    const survivorRegistry = {
      cancelAll: () => Promise.resolve({ drained: false, survivors: [12345] as const }),
    }
    const lines: string[] = []
    const outcome = await drainCampaign({
      registry: survivorRegistry,
      runRoot,
      log: (line) => lines.push(line),
    })
    expect(outcome.drained).toBe(false)
    expect(existsSync(runRoot)).toBe(true)
    expect(lines.join("")).toContain("survived SIGKILL")
    expect(lines.join("")).toContain("12345")
  })

  test("terminateCampaignOnSignal drains, releases the lease, and maps exit codes", async () => {
    const dir = scratch()
    const runRoot = join(dir, "run-root")
    mkdirSync(runRoot, { recursive: true })
    let released = 0
    const registry = new ShardProcessRegistry()
    const code = await terminateCampaignOnSignal({
      registry,
      runRoot,
      signal: "SIGTERM",
      releaseLease: () => {
        released += 1
      },
      log: () => {},
    })
    expect(code).toBe(143)
    expect(released).toBe(1)
    expect(existsSync(runRoot)).toBe(false)
    expect(terminationExitCode("SIGINT")).toBe(130)
  })

  test("a real SIGTERM to a campaign driver drains the tree before exit", async () => {
    const dir = scratch()
    const runRoot = join(dir, "run-root")
    const pidFile = join(dir, "grandchild.pid")
    const resultFile = join(dir, "result.txt")
    const driverPath = join(dir, "driver.ts")
    writeFileSync(
      driverPath,
      [
        `import { ShardProcessRegistry, terminateCampaignOnSignal } from ${JSON.stringify(MODULE_PATH)}`,
        `import { mkdirSync, writeFileSync } from "node:fs"`,
        `const runRoot = ${JSON.stringify(runRoot)}`,
        `mkdirSync(runRoot, { recursive: true })`,
        `const registry = new ShardProcessRegistry({ termGraceMs: 500, killGraceMs: 3_000 })`,
        `const handle = registry.spawnWorker({`,
        `  cmd: ["bun", "-e", ${JSON.stringify(grandchildWorkerSource(pidFile, false))}],`,
        `  cwd: runRoot,`,
        `  env: process.env,`,
        `  stdoutFd: 1,`,
        `  stderrFd: 2,`,
        `})`,
        `let terminating = false`,
        `process.on("SIGTERM", () => {`,
        `  if (terminating) return`,
        `  terminating = true`,
        `  void terminateCampaignOnSignal({`,
        `    registry,`,
        `    runRoot,`,
        `    signal: "SIGTERM",`,
        `    releaseLease: () => writeFileSync(${JSON.stringify(resultFile)}, "released"),`,
        `    log: () => {},`,
        `  }).then((code) => process.exit(code))`,
        `})`,
        `await handle.exited`,
        `await Bun.sleep(30_000)`,
      ].join("\n"),
    )
    const driver = Bun.spawn({
      cmd: ["bun", driverPath],
      cwd: dir,
      stdout: "inherit",
      stderr: "inherit",
    })
    expect(await waitFor(() => existsSync(pidFile), 10_000)).toBe(true)
    const grandchild = readGrandchildPid(pidFile)
    expect(pidAlive(grandchild)).toBe(true)
    driver.kill("SIGTERM")
    const exitCode = await driver.exited
    expect(exitCode).toBe(143)
    expect(await waitFor(() => !pidAlive(grandchild), 5_000)).toBe(true)
    expect(readFileSync(resultFile, "utf8")).toBe("released")
    expect(existsSync(runRoot)).toBe(false)
  }, 30_000)

  test("killProcessTree is idempotent on an already-empty group", async () => {
    const dir = scratch()
    const registry = new ShardProcessRegistry()
    const handle = registry.spawnWorker({
      cmd: ["bun", "-e", "process.exit(0)"],
      cwd: dir,
      env: process.env,
      stdoutFd: 1,
      stderrFd: 2,
    })
    const exit = await handle.exited
    expect(exit.code).toBe(0)
    expect(await waitFor(() => !processGroupHoldsResources(handle.pid), 5_000)).toBe(true)
    expect(await killProcessTree(handle.pid)).toBe(true)
    expect(registry.liveGroups()).toHaveLength(0)
  }, 15_000)

  test("a recycled pgid is never killed — a stranger's group survives cancelAll", async () => {
    // A pgid is a recycled pid. If our leader dies and the OS hands that
    // number to an unrelated process that leads its own group, killing by
    // pgid alone SIGKILLs a stranger's tree. Simulated here by registering a
    // worker and then making the registry believe a DIFFERENT live group is
    // that worker's: the identity recorded at spawn no longer matches, so
    // the group must be left strictly alone.
    const dir = scratch()
    const registry = new ShardProcessRegistry({ termGraceMs: 500, killGraceMs: 3_000 })
    const { handle, pidFile } = spawnGrandchildWorker(registry, dir)
    expect(await waitFor(() => existsSync(pidFile), 10_000)).toBe(true)
    const grandchild = readGrandchildPid(pidFile)

    // The "stranger": a live, independent process group.
    const strangerDir = scratch()
    const strangerFile = join(strangerDir, "stranger.pid")
    const stranger = spawnGrandchildWorker(registry, strangerDir)
    expect(await waitFor(() => existsSync(stranger.pidFile), 10_000)).toBe(true)
    const strangerGrandchild = readGrandchildPid(stranger.pidFile)
    writeFileSync(strangerFile, String(stranger.handle.pid))

    // Rewrite the first worker's recorded leader so it looks recycled.
    const tracked = (registry as unknown as { tracked: Set<{ pgid: number; leader?: string }> })
      .tracked
    for (const worker of tracked) {
      if (worker.pgid === stranger.handle.pid) {
        ;(worker as { leader?: string }).leader = "Thu Jan  1 00:00:00 1970 someone-else"
      }
    }

    const outcome = await registry.cancelAll()

    // Our own worker's tree is gone…
    expect(pidAlive(grandchild)).toBe(false)
    // …and the "recycled" group was left untouched.
    expect(pidAlive(strangerGrandchild)).toBe(true)
    // Cancelling a group we no longer recognise reports FALSE, not "emptied".
    // Claiming success there was a false attestation: `drained: true` let the
    // campaign delete a run root out from under processes it could not
    // identify, and release the lane on evidence it never had.
    expect(await stranger.handle.cancel()).toBe(false)
    expect(outcome.drained).toBe(false)
    expect(outcome.survivors).toContain(stranger.handle.pid)
    await handle.exited.catch(() => undefined)
  }, 30_000)

  test("a group of zombies is drained, not 'survived SIGKILL'", () => {
    // MEASURED on the first full-suite campaign that reached the end: the
    // suite passed 30/30 and the drain check then refused it over four
    // `<defunct>` entries plus one exiting Chrome. A zombie answers
    // kill(-pgid, 0) — it is a reaped-pending table entry — but it is
    // unkillable by definition and holds no fd, port or working directory, so
    // counting it as alive turns a green 45-minute run red and leaves 97MB of
    // run root behind for nothing.
    const ps = [
      "  71030 Z",
      "  71030 ?E",
      "  71030 Z",
      "  99999 S", // another group, still running — must not leak in
    ].join("\n")
    expect(groupStateLines(ps, 71030)).toEqual(["Z", "?E", "Z"])
    expect(hasRunningMember(groupStateLines(ps, 71030))).toBe(false)

    // A genuinely running member still counts, whatever else is in the group.
    const withLive = `${ps}\n  71030 S`
    expect(hasRunningMember(groupStateLines(withLive, 71030))).toBe(true)
    // Common live states are not mistaken for exiting.
    for (const state of ["S", "R", "S+", "SN", "U"]) {
      expect(hasRunningMember([state]), state).toBe(true)
    }
    // An empty group is drained.
    expect(hasRunningMember(groupStateLines(ps, 12345))).toBe(false)
  })

  test("a ps that did not run is 'still alive', never 'drained'", () => {
    // The asymmetry matters: this predicate decides whether a campaign may be
    // blessed and its run root deleted. Reading a failed probe as "drained"
    // would bless a run whose workers are still executing — silently, and
    // exactly on the boxes where the probe is most likely to fail.
    expect(groupHasRunningMemberFromPs({ exitCode: 1, stdout: "" }, 71030)).toBe(true)
    expect(groupHasRunningMemberFromPs({ exitCode: 127, stdout: "garbage" }, 71030)).toBe(true)
    // And a probe that DID run is believed, in both directions.
    expect(groupHasRunningMemberFromPs({ exitCode: 0, stdout: "  71030 Z" }, 71030)).toBe(false)
    expect(groupHasRunningMemberFromPs({ exitCode: 0, stdout: "  71030 S" }, 71030)).toBe(true)
  })

  test("a spawn failure rejects the exit promise and tracks nothing", async () => {
    const dir = scratch()
    const registry = new ShardProcessRegistry()
    const handle = registry.spawnWorker({
      cmd: [join(dir, "does-not-exist-xyz")],
      cwd: dir,
      env: process.env,
      stdoutFd: 1,
      stderrFd: 2,
    })
    await expect(handle.exited).rejects.toThrow()
    expect(registry.liveGroups()).toHaveLength(0)
  })
})
