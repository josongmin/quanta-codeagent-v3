import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  acquirePatchGenBudgetLease,
  readPatchGenBudgetState,
} from "../../src/apps/bench/remote/token-budget"

/**
 * Every case gets a PRIVATE budget dir, minted fresh in `beforeEach`.
 *
 * The old shape shared ONE dir and merely `rm -rf`ed it between cases. Two ways
 * that leaked state across cases:
 *   - the AUTHORITATIVE lease store is a SIBLING of the budget dir
 *     (`<dir>.lease-state` — by design, so it survives an external `rm -rf` of
 *     the budget dir), and it was never wiped at all;
 *   - a released lease can be RE-CREATED after the wipe by a heartbeat beat that
 *     was already in flight when `release()` ran (see the PRODUCTION DEFECT note
 *     at the bottom of this file) — which lands in whatever dir that lease owns.
 * Both are invisible while each case runs alone and both bite under load, where
 * a stray 12-unit record from an earlier case shows up as the NEXT case's
 * `inUse`. A per-case dir makes the isolation structural rather than a cleanup
 * that has to win a race.
 */
let DIR = ""
const CREATED_DIRS: string[] = []
const stateDirOf = (dir: string): string => `${dir}.lease-state`

/**
 * DEADLOCK BACKSTOP for lock/lease waits that are UNCONTENDED by construction —
 * the case owns a private `DIR` and nothing else is competing for the mutation
 * lock, so the wait budget is never reached and never decides a verdict. The
 * old `waitMs: 1_000` DID decide verdicts: under full-suite congestion a single
 * `mkdir`+`atomicWriteJson` round trip lands past 1s and the acquire threw
 * "timed out waiting for the global patch-gen budget lock" with the lock free.
 * Cases where a SHORT wait is the mechanism under test (the fail-closed /
 * still-held-lock paths) keep their small values on purpose.
 */
const ACQUIRE_BACKSTOP_MS = 120_000
/** Per-test deadlock backstop (bun's implicit 5s default was acting as a verdict
 *  for cases whose real work is fs round trips + child processes). */
const TEST_BACKSTOP_MS = 180_000
/**
 * Heartbeat interval for cases whose invariant has NOTHING to do with
 * heartbeats. Without an explicit value they inherit the 15s production default
 * and get a background writer racing their `release()` — which, thanks to the
 * PRODUCTION DEFECT documented at the bottom of this file (an in-flight beat can
 * re-create a released lease record), turns an unrelated real bug into noise on
 * these cases the moment the box is slow. Parking the heartbeat past any
 * plausible test duration makes each case measure only its own invariant; the
 * cases that DO exercise a heartbeat set their own interval explicitly.
 */
const HEARTBEAT_PARKED_MS = 3_600_000
const CONDITION_POLL_MS = 10

/** Await a real observable condition instead of sleeping for a guessed duration.
 *  Throws on backstop so a trip reads as the deadlock it is. */
const awaitCondition = async (
  label: string,
  pred: () => boolean,
  backstopMs = ACQUIRE_BACKSTOP_MS,
): Promise<void> => {
  const deadline = Date.now() + backstopMs
  for (;;) {
    if (pred()) return
    if (Date.now() > deadline) {
      throw new Error(`deadlock backstop (${backstopMs}ms) waiting for: ${label}`)
    }
    await new Promise((r) => {
      setTimeout(r, CONDITION_POLL_MS)
    })
  }
}

/** Parse a lease record file, tolerating the instant it does not exist / is
 *  mid-rename (`atomicWriteJson` writes a tmp then renames). */
const readLeaseRecord = (path: string): { heartbeatAt?: string; units?: number } | undefined => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as { heartbeatAt?: string; units?: number }
  } catch {
    return undefined
  }
}

beforeEach(() => {
  DIR = mkdtempSync(join(tmpdir(), "bench-token-budget-"))
  CREATED_DIRS.push(DIR)
})

afterAll(() => {
  for (const dir of CREATED_DIRS) {
    rmSync(dir, { recursive: true, force: true })
    rmSync(stateDirOf(dir), { recursive: true, force: true })
  }
})

describe("patch-gen budget lease", () => {
  test(
    "a second lease gets only the remaining global budget",
    async () => {
      // explicit `limit` ⇒ immune to a PARALLEL test poisoning the process-global
      // QUANTA_BENCH_PATCH_GEN_BUDGET env (resolveGlobalPatchGenBudget reads it).
      const first = await acquirePatchGenBudgetLease({
        label: "first",
        requestedUnits: 12,
        dir: DIR,
        limit: 16,
        waitMs: ACQUIRE_BACKSTOP_MS,
        pollMs: 10,
        heartbeatMs: HEARTBEAT_PARKED_MS,
      })
      const second = await acquirePatchGenBudgetLease({
        label: "second",
        requestedUnits: 16,
        dir: DIR,
        limit: 16,
        waitMs: ACQUIRE_BACKSTOP_MS,
        pollMs: 10,
        heartbeatMs: HEARTBEAT_PARKED_MS,
      })
      try {
        expect(first.units).toBe(12)
        expect(second.units).toBe(4)
        const state = await readPatchGenBudgetState({ dir: DIR, limit: 16 })
        expect(state.limit).toBe(16)
        expect(state.inUse).toBe(16)
        expect(state.available).toBe(0)
        expect(state.leases.map((lease) => lease.label)).toEqual(["first", "second"])
      } finally {
        await second.release()
        await first.release()
      }
    },
    TEST_BACKSTOP_MS,
  )

  test(
    "release returns the full budget to the pool",
    async () => {
      const lease = await acquirePatchGenBudgetLease({
        label: "only",
        requestedUnits: 7,
        dir: DIR,
        waitMs: ACQUIRE_BACKSTOP_MS,
        pollMs: 10,
        heartbeatMs: HEARTBEAT_PARKED_MS,
      })
      await lease.release()
      const state = await readPatchGenBudgetState({ dir: DIR })
      expect(state.inUse).toBe(0)
      expect(state.available).toBe(16)
      expect(state.leases).toEqual([])
    },
    TEST_BACKSTOP_MS,
  )

  test(
    "lease-file deletion failure ABORTS release instead of silently succeeding",
    async () => {
      const lease = await acquirePatchGenBudgetLease({
        label: "only",
        requestedUnits: 7,
        dir: DIR,
        waitMs: ACQUIRE_BACKSTOP_MS,
        pollMs: 10,
        heartbeatMs: HEARTBEAT_PARKED_MS,
      })
      const leasePath = join(DIR, `${lease.leaseId}.lease.json`)
      rmSync(leasePath, { force: true })
      mkdirSync(leasePath, { recursive: true })
      await expect(lease.release()).rejects.toThrow()
    },
    TEST_BACKSTOP_MS,
  )

  test(
    "a failed release stays retryable instead of leaking the budget forever",
    async () => {
      const lease = await acquirePatchGenBudgetLease({
        label: "retryable",
        requestedUnits: 7,
        dir: DIR,
        waitMs: 20,
        pollMs: 5,
        heartbeatMs: HEARTBEAT_PARKED_MS,
      })
      const lockDir = join(DIR, ".lock")
      mkdirSync(lockDir, { recursive: true })
      writeFileSync(
        join(lockDir, "owner.json"),
        `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`,
      )
      await expect(lease.release()).rejects.toThrow(
        /global patch-gen budget lock|timed out waiting/i,
      )
      rmSync(lockDir, { recursive: true, force: true })
      await lease.release()
      const state = await readPatchGenBudgetState({ dir: DIR })
      expect(state.inUse).toBe(0)
      expect(state.available).toBe(16)
      expect(state.leases).toEqual([])
    },
    TEST_BACKSTOP_MS,
  )

  test(
    "read state prunes a stale dead lease file",
    async () => {
      writeFileSync(
        join(DIR, "stale.lease.json"),
        `${JSON.stringify({
          leaseId: "stale",
          label: "dead",
          requestedUnits: 16,
          units: 16,
          pid: 999_999_999,
          acquiredAt: "2026-06-20T00:00:00.000Z",
          heartbeatAt: "2026-06-20T00:00:00.000Z",
        })}\n`,
      )
      const state = await readPatchGenBudgetState({
        dir: DIR,
        staleLeaseMs: 1_000,
        now: () => Date.parse("2026-06-20T00:10:00.000Z"),
      })
      expect(state.inUse).toBe(0)
      expect(state.available).toBe(16)
      expect(state.leases).toEqual([])
    },
    TEST_BACKSTOP_MS,
  )

  test(
    "invalid lease metadata ABORTS acquisition instead of being silently pruned away",
    async () => {
      writeFileSync(join(DIR, "broken.lease.json"), '{"leaseId":"broken","label":"ghost"}\n')
      let lease: Awaited<ReturnType<typeof acquirePatchGenBudgetLease>> | undefined
      let error: unknown
      try {
        lease = await acquirePatchGenBudgetLease({
          label: "fresh",
          requestedUnits: 16,
          dir: DIR,
          waitMs: ACQUIRE_BACKSTOP_MS,
          pollMs: 10,
          heartbeatMs: HEARTBEAT_PARKED_MS,
        })
      } catch (err) {
        error = err
      } finally {
        if (lease !== undefined) await lease.release()
      }
      expect(String(error)).toContain("invalid lease record")
    },
    TEST_BACKSTOP_MS,
  )

  test(
    "missing lock owner metadata FAIL-CLOSES instead of reclaiming a live lock by age alone",
    async () => {
      const lockDir = join(DIR, ".lock")
      mkdirSync(lockDir, { recursive: true })
      utimesSync(lockDir, new Date(0), new Date(0))
      let nowMs = 60_000
      let lease: Awaited<ReturnType<typeof acquirePatchGenBudgetLease>> | undefined
      let error: unknown
      try {
        lease = await acquirePatchGenBudgetLease({
          label: "fresh",
          requestedUnits: 1,
          dir: DIR,
          waitMs: 250,
          pollMs: 250,
          heartbeatMs: HEARTBEAT_PARKED_MS,
          staleLockMs: 5_000,
          now: () => nowMs,
          sleep: async (ms) => {
            nowMs += ms
          },
        })
      } catch (err) {
        error = err
      } finally {
        if (lease !== undefined) await lease.release()
      }
      expect(String(error)).toContain("timed out waiting for the global patch-gen budget lock")
    },
    TEST_BACKSTOP_MS,
  )

  test(
    "a live lease re-creates its budget dir so concurrent accounting cannot disappear after external deletion",
    async () => {
      const first = await acquirePatchGenBudgetLease({
        label: "first",
        requestedUnits: 12,
        dir: DIR,
        waitMs: ACQUIRE_BACKSTOP_MS,
        pollMs: 10,
        heartbeatMs: 1_000,
      })
      let second: Awaited<ReturnType<typeof acquirePatchGenBudgetLease>> | undefined
      let firstReleaseErr: unknown
      let secondReleaseErr: unknown
      try {
        rmSync(DIR, { recursive: true, force: true })
        // The claim is "a LIVE lease re-creates its budget dir". The old code slept
        // 1_100ms and assumed the 1_000ms heartbeat had fired — a bet on the timer
        // firing on schedule that a congested loop loses. Wait for the heartbeat's
        // OBSERVABLE EFFECT instead: the mirror record back on disk in the
        // re-created dir. That IS the behaviour under test, so the wait can never
        // be too short (nor pointlessly long).
        await awaitCondition(
          "the live lease's heartbeat to re-create its budget dir + mirror record",
          () => existsSync(join(DIR, `${first.leaseId}.lease.json`)),
        )
        second = await acquirePatchGenBudgetLease({
          label: "second",
          requestedUnits: 16,
          dir: DIR,
          waitMs: ACQUIRE_BACKSTOP_MS,
          pollMs: 10,
          heartbeatMs: HEARTBEAT_PARKED_MS,
        })
        expect(second.units).toBe(4)
        const state = await readPatchGenBudgetState({ dir: DIR })
        expect(state.inUse).toBe(16)
        expect(state.leases.map((lease) => lease.label)).toEqual(["first", "second"])
      } finally {
        try {
          await second?.release()
        } catch (err) {
          secondReleaseErr = err
        }
        try {
          await first.release()
        } catch (err) {
          firstReleaseErr = err
        }
      }
      expect(firstReleaseErr).toBeUndefined()
      expect(secondReleaseErr).toBeUndefined()
    },
    TEST_BACKSTOP_MS,
  )

  test(
    "external deletion cannot reopen the full budget BEFORE the next heartbeat lands",
    async () => {
      const first = await acquirePatchGenBudgetLease({
        label: "first",
        requestedUnits: 12,
        dir: DIR,
        waitMs: ACQUIRE_BACKSTOP_MS,
        pollMs: 10,
        // The premise of this case is that NO heartbeat lands while it runs. A
        // 60s interval was "long enough" only as long as the case itself stayed
        // fast; a heartbeat interval far beyond any plausible test duration makes
        // the premise structural instead of a race the box can win.
        heartbeatMs: 600_000,
      })
      let second: Awaited<ReturnType<typeof acquirePatchGenBudgetLease>> | undefined
      let firstReleaseErr: unknown
      let secondReleaseErr: unknown
      try {
        rmSync(DIR, { recursive: true, force: true })
        second = await acquirePatchGenBudgetLease({
          label: "second",
          requestedUnits: 16,
          dir: DIR,
          waitMs: ACQUIRE_BACKSTOP_MS,
          pollMs: 10,
          heartbeatMs: HEARTBEAT_PARKED_MS,
        })
        expect(second.units).toBe(4)
        const state = await readPatchGenBudgetState({ dir: DIR })
        expect(state.inUse).toBe(16)
        expect(state.leases.map((lease) => lease.label)).toEqual(["first", "second"])
      } finally {
        try {
          await second?.release()
        } catch (err) {
          secondReleaseErr = err
        }
        try {
          await first.release()
        } catch (err) {
          firstReleaseErr = err
        }
      }
      expect(firstReleaseErr).toBeUndefined()
      expect(secondReleaseErr).toBeUndefined()
    },
    TEST_BACKSTOP_MS,
  )

  test(
    "a waiting lease contender stays alive until timeout instead of exiting cleanly between polls",
    async () => {
      const held = await acquirePatchGenBudgetLease({
        label: "holder",
        requestedUnits: 16,
        dir: DIR,
        waitMs: ACQUIRE_BACKSTOP_MS,
        pollMs: 10,
        heartbeatMs: HEARTBEAT_PARKED_MS,
      })
      try {
        const script = `
        import { pathToFileURL } from "node:url"

        const mod = await import(pathToFileURL(${JSON.stringify(join(process.cwd(), "src/apps/bench/remote/token-budget.ts"))}).href)
        const { acquirePatchGenBudgetLease } = mod
        const realSetTimeout = globalThis.setTimeout
        globalThis.setTimeout = ((fn, _ms, ...args) => realSetTimeout(fn, 5, ...args)) as typeof setTimeout

        try {
          await acquirePatchGenBudgetLease({
            label: "waiter",
            requestedUnits: 1,
            dir: ${JSON.stringify(DIR)},
            waitMs: 20,
            pollMs: 5,
          })
          console.error("UNEXPECTED_OK")
          process.exit(99)
        } catch (err) {
          console.error(String(err))
          process.exit(23)
        }
      `
        const r = spawnSync(process.execPath, ["-e", script], {
          cwd: process.cwd(),
          encoding: "utf8",
          // DEADLOCK BACKSTOP only. The verdict is the child's EXIT CODE + message:
          // it must survive its own 20ms wait budget and then throw. A 5s kill
          // window was a second, load-sensitive clock on top of that — on a
          // congested box the child had not finished booting + importing the
          // module by then, and the case failed with status=null.
          timeout: TEST_BACKSTOP_MS,
        })
        expect(r.status).toBe(23)
        expect(r.stderr).toContain("timed out waiting for >=")
        expect(r.stderr).not.toContain("UNEXPECTED_OK")
      } finally {
        await held.release()
      }
    },
    TEST_BACKSTOP_MS,
  )

  test(
    "a lease holder stays alive after acquire instead of exiting cleanly between heartbeats",
    async () => {
      // INVARIANT: the heartbeat timer is NOT `unref()`ed, so a process that holds
      // a lease keeps running (and keeps beating) until something kills it. The
      // old shape asserted this by spawning with `timeout: 200` and demanding the
      // child come back SIGTERM/ETIMEDOUT — i.e. it asked "did the child fail to
      // finish within 200ms of wall clock?", which on a congested box the child
      // loses for the WRONG reason (it had not even acquired yet, so the paired
      // `ACQUIRED 1` assertion went red).
      //
      // Deterministic form: watch the child's OWN heartbeat land on disk. Seeing
      // `heartbeatAt` ADVANCE after the initial write proves (a) the child is
      // still alive after acquire and (b) its heartbeat loop is still armed —
      // exactly what an `unref()`ed / self-exiting holder could never produce.
      const script = `
      import { pathToFileURL } from "node:url"

      const mod = await import(pathToFileURL(${JSON.stringify(join(process.cwd(), "src/apps/bench/remote/token-budget.ts"))}).href)
      const { acquirePatchGenBudgetLease } = mod

      const lease = await acquirePatchGenBudgetLease({
        label: "holder",
        requestedUnits: 1,
        dir: ${JSON.stringify(DIR)},
        waitMs: 20,
        pollMs: 5,
        heartbeatMs: 5,
      })
      console.error("ACQUIRED", lease.units)
    `
      const child = Bun.spawn([process.execPath, "-e", script], {
        cwd: process.cwd(),
        stdout: "ignore",
        stderr: "ignore",
      })
      const exitedEarly = (stage: string) => (): boolean => {
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(
            `lease holder exited on its own (${stage}): code=${child.exitCode} signal=${child.signalCode}`,
          )
        }
        return false
      }
      try {
        // 1. the child acquired — its mirror record is on disk with the units it asked for.
        let leaseFile: string | undefined
        await awaitCondition("the holder child to write its lease record", () => {
          if (exitedEarly("before writing its lease record")()) return false
          const candidate = readdirSync(DIR).find((n) => n.endsWith(".lease.json"))
          if (candidate === undefined) return false
          leaseFile = join(DIR, candidate)
          return readLeaseRecord(leaseFile)?.heartbeatAt !== undefined
        })
        if (leaseFile === undefined) throw new Error("no lease record")
        const firstBeat = readLeaseRecord(leaseFile)?.heartbeatAt
        expect(readLeaseRecord(leaseFile)?.units).toBe(1)

        // 2. THE INVARIANT: a later beat lands, so the holder outlived its own
        //    heartbeat interval instead of exiting cleanly between beats.
        await awaitCondition("a SECOND heartbeat from the still-live holder", () => {
          if (exitedEarly("between heartbeats")()) return false
          const beat = readLeaseRecord(leaseFile as string)?.heartbeatAt
          return beat !== undefined && beat !== firstBeat
        })
        expect(child.exitCode).toBeNull()
      } finally {
        child.kill("SIGKILL")
        await child.exited
      }
    },
    TEST_BACKSTOP_MS,
  )
})

/**
 * PRODUCTION DEFECT — NOT fixed here (found while de-flaking this file; the fix
 * belongs in `src/apps/bench/remote/`, which this change deliberately does not
 * touch).
 *
 * `release()` (`token-budget.ts#runRelease`) calls `heartbeat.pause()` and then
 * unlinks the authoritative + mirror lease records. `pause()` only
 * `clearInterval`s — it does NOT await a beat that is ALREADY IN FLIGHT.
 * `createHeartbeatLoop` (`lease-fs.ts`) fires beats as `void beat().catch(...)`,
 * and a beat is `touchBudgetLease` = `atomicWriteJson(authoritative)` +
 * `atomicWriteJson(mirror)`, each of which `mkdir -p`s the parent. So a beat
 * that started before the pause can finish AFTER the unlinks and RE-CREATE both
 * records for a lease that is already released.
 *
 * Consequence: the released units stay booked. The revived record carries a LIVE
 * pid, so `leaseIsStale` (`heartbeatAge > staleLeaseMs && !processAlive(pid)`)
 * never prunes it while that process lives — the global patch-gen budget is
 * permanently short by that lease's units, and a later acquirer can block for
 * the full 45-minute default wait.
 *
 * Reproduction (100% at 400ms event-loop stalls, 0% on an idle loop — which is
 * why it only ever showed up as "the suite is flaky"):
 *
 *   1. preload a stall generator: `setInterval(() => { const end = Date.now() +
 *      400; while (Date.now() < end); }, 10)`
 *   2. `const lease = await acquirePatchGenBudgetLease({ label: "first",
 *        requestedUnits: 12, dir, waitMs: 60_000, pollMs: 10, heartbeatMs: 1_000 })`
 *   3. `await new Promise(r => setTimeout(r, 1_050))`  // a beat is now in flight
 *   4. `await lease.release()`
 *   5. `await new Promise(r => setTimeout(r, 1_500))`
 *   6. `readdirSync(`${dir}.lease-state`)` and `readdirSync(dir)` still contain
 *      `<leaseId>.lease.json`, and `readPatchGenBudgetState({ dir })` reports
 *      `inUse: 12` for a lease that was released.
 *
 * Suggested shape of a fix (for whoever owns that module): make the heartbeat
 * loop expose a `quiesce()` that awaits the in-flight beat, and have `release()`
 * await it before the unlinks (or have `touchBudgetLease` refuse to write once
 * the loop is stopped).
 */
