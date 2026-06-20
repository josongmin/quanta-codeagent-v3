import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  acquirePatchGenBudgetLease,
  readPatchGenBudgetState,
} from "../../src/apps/bench/remote/token-budget"

const DIR = mkdtempSync(join(tmpdir(), "bench-token-budget-"))

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(DIR, { recursive: true })
})

afterAll(() => {
  rmSync(DIR, { recursive: true, force: true })
})

describe("patch-gen budget lease", () => {
  test("a second lease gets only the remaining global budget", async () => {
    const first = await acquirePatchGenBudgetLease({
      label: "first",
      requestedUnits: 12,
      dir: DIR,
      waitMs: 1_000,
      pollMs: 10,
    })
    const second = await acquirePatchGenBudgetLease({
      label: "second",
      requestedUnits: 16,
      dir: DIR,
      waitMs: 1_000,
      pollMs: 10,
    })
    try {
      expect(first.units).toBe(12)
      expect(second.units).toBe(4)
      const state = await readPatchGenBudgetState({ dir: DIR })
      expect(state.limit).toBe(16)
      expect(state.inUse).toBe(16)
      expect(state.available).toBe(0)
      expect(state.leases.map((lease) => lease.label)).toEqual(["first", "second"])
    } finally {
      await second.release()
      await first.release()
    }
  })

  test("release returns the full budget to the pool", async () => {
    const lease = await acquirePatchGenBudgetLease({
      label: "only",
      requestedUnits: 7,
      dir: DIR,
      waitMs: 1_000,
      pollMs: 10,
    })
    await lease.release()
    const state = await readPatchGenBudgetState({ dir: DIR })
    expect(state.inUse).toBe(0)
    expect(state.available).toBe(16)
    expect(state.leases).toEqual([])
  })

  test("lease-file deletion failure ABORTS release instead of silently succeeding", async () => {
    const lease = await acquirePatchGenBudgetLease({
      label: "only",
      requestedUnits: 7,
      dir: DIR,
      waitMs: 1_000,
      pollMs: 10,
    })
    const leasePath = join(DIR, `${lease.leaseId}.lease.json`)
    rmSync(leasePath, { force: true })
    mkdirSync(leasePath, { recursive: true })
    await expect(lease.release()).rejects.toThrow()
  })

  test("read state prunes a stale dead lease file", async () => {
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
  })

  test("a waiting lease contender stays alive until timeout instead of exiting cleanly between polls", async () => {
    const held = await acquirePatchGenBudgetLease({
      label: "holder",
      requestedUnits: 16,
      dir: DIR,
      waitMs: 1_000,
      pollMs: 10,
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
        timeout: 5_000,
      })
      expect(r.status).toBe(23)
      expect(r.stderr).toContain("timed out waiting for >=")
      expect(r.stderr).not.toContain("UNEXPECTED_OK")
    } finally {
      await held.release()
    }
  })
})
