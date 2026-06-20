/**
 * ★ CONTRACT — single-box guard: same-host single-box mode must fail closed
 *   src pointer: src/apps/bench/remote/single-box-guard.ts:138
 *   Every assertion below is CONTRACT.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acquireSingleBoxGuard } from "../../src/apps/bench/remote/single-box-guard"

const TEMP_DIRS = new Set<string>()

const allocTempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  TEMP_DIRS.add(dir)
  return dir
}

afterAll(() => {
  for (const dir of TEMP_DIRS) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("single-box guard hellgate", () => {
  test("a second claimant FAIL-CLOSES while the first guard is held", async () => {
    const root = allocTempDir("bench-single-box-guard-")
    const dir = join(root, "guard")
    const first = await acquireSingleBoxGuard({
      label: "first",
      dir,
    })
    try {
      await expect(
        acquireSingleBoxGuard({
          label: "second",
          dir,
        }),
      ).rejects.toThrow(/single-box|owner/i)
    } finally {
      await first.release()
    }
  })

  test("a guard release deletion failure ABORTS instead of silently succeeding", async () => {
    const root = allocTempDir("bench-single-box-release-")
    const dir = join(root, "guard")
    const guard = await acquireSingleBoxGuard({
      label: "release-failure",
      dir,
    })
    chmodSync(root, 0o555)
    try {
      await expect(guard.release()).rejects.toThrow(
        /EACCES|EPERM|permission|operation not permitted/i,
      )
    } finally {
      chmodSync(root, 0o755)
      await guard.release().catch(() => undefined)
    }
  })

  test("missing owner metadata FAIL-CLOSES instead of reclaiming a live guard by age alone", async () => {
    const root = allocTempDir("bench-single-box-metadata-")
    const dir = join(root, "guard")
    const ownerMeta = join(dir, "owner.json")
    const first = await acquireSingleBoxGuard({
      label: "first",
      dir,
      heartbeatMs: 60_000,
    })
    try {
      unlinkSync(ownerMeta)
      utimesSync(dir, new Date(0), new Date(0))
      await expect(
        acquireSingleBoxGuard({
          label: "second",
          dir,
          staleHeartbeatMs: 1_000,
          now: () => Date.now() + 60_000,
        }),
      ).rejects.toThrow(/single-box|owner/i)
    } finally {
      await first.release().catch(() => undefined)
    }
  })

  test("malformed owner metadata FAIL-CLOSES instead of reclaiming a live guard by dir age alone", async () => {
    const root = allocTempDir("bench-single-box-malformed-")
    const dir = join(root, "guard")
    const ownerMeta = join(dir, "owner.json")
    const first = await acquireSingleBoxGuard({
      label: "first",
      dir,
      heartbeatMs: 60_000,
    })
    try {
      writeFileSync(ownerMeta, '{"label":"broken"}\n')
      utimesSync(dir, new Date(0), new Date(0))
      await expect(
        acquireSingleBoxGuard({
          label: "second",
          dir,
          staleHeartbeatMs: 1_000,
          now: () => Date.now() + 60_000,
        }),
      ).rejects.toThrow(/single-box|owner/i)
    } finally {
      await first.release().catch(() => undefined)
    }
  })

  test("a live guard re-creates its owner dir so external deletion cannot open a second launch lane", async () => {
    const root = allocTempDir("bench-single-box-heartbeat-")
    const dir = join(root, "guard")
    const first = await acquireSingleBoxGuard({
      label: "first",
      dir,
      heartbeatMs: 1_000,
    })
    let firstReleaseErr: unknown
    try {
      rmSync(dir, { recursive: true, force: true })
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 1_100)
      })
      await expect(
        acquireSingleBoxGuard({
          label: "second",
          dir,
        }),
      ).rejects.toThrow(/single-box|owner/i)
    } finally {
      try {
        await first.release()
      } catch (err) {
        firstReleaseErr = err
      }
    }
    expect(firstReleaseErr).toBeUndefined()
  })

  test("a failed release keeps the heartbeat alive so external deletion still cannot open a second launch lane", async () => {
    const root = allocTempDir("bench-single-box-release-heartbeat-")
    const dir = join(root, "guard")
    const first = await acquireSingleBoxGuard({
      label: "first",
      dir,
      heartbeatMs: 1_000,
    })
    let firstReleaseErr: unknown
    chmodSync(root, 0o555)
    try {
      await expect(first.release()).rejects.toThrow(
        /EACCES|EPERM|permission|operation not permitted/i,
      )
    } finally {
      chmodSync(root, 0o755)
    }
    try {
      rmSync(dir, { recursive: true, force: true })
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 1_100)
      })
      await expect(
        acquireSingleBoxGuard({
          label: "second",
          dir,
        }),
      ).rejects.toThrow(/single-box|owner/i)
    } finally {
      try {
        await first.release()
      } catch (err) {
        firstReleaseErr = err
      }
    }
    expect(firstReleaseErr).toBeUndefined()
  })
})
