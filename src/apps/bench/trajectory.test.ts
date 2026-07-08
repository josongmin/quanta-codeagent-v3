/**
 * patchRunMeta — unit tests for the post-run meta.json patch path.
 *
 * Pins three contracts:
 *   1. debug gate OFF ⇒ no-op (no throw, file untouched).
 *   2. No registered path ⇒ no-op (no throw).
 *   3. Registered path + debug ON ⇒ read + merge + write (extra keys land in file).
 *
 * Uses real tmp files (fast) to verify the actual FS contract; mock-only tests
 * would miss missing-file / read-failure edge cases.
 *
 * RED-on-injection: test 3 fails if the merge is skipped or the write is a no-op.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyBenchTrajectoryMode, patchRunMeta, resetMetaPathRegistry } from "./trajectory"

// ── helpers ─────────────────────────────────────────────────────────────────

const mkTmpDir = () => {
  const d = join(tmpdir(), `meta-test-${Date.now()}`)
  return d
}

/** Inject the debug gate without mutating process.env permanently. */
const withDebugGate = async (on: boolean, fn: () => Promise<void>): Promise<void> => {
  const prev = process.env.QUANTA_BENCH_TRAJECTORY_DEBUG
  const prevRec = process.env.QUANTA_BENCH_RECORD_TRAJECTORY
  if (on) {
    process.env.QUANTA_BENCH_TRAJECTORY_DEBUG = "1"
    delete process.env.QUANTA_BENCH_RECORD_TRAJECTORY
  } else {
    process.env.QUANTA_BENCH_TRAJECTORY_DEBUG = "0"
    delete process.env.QUANTA_BENCH_RECORD_TRAJECTORY
  }
  try {
    await fn()
  } finally {
    if (prev === undefined) delete process.env.QUANTA_BENCH_TRAJECTORY_DEBUG
    else process.env.QUANTA_BENCH_TRAJECTORY_DEBUG = prev
    if (prevRec === undefined) delete process.env.QUANTA_BENCH_RECORD_TRAJECTORY
    else process.env.QUANTA_BENCH_RECORD_TRAJECTORY = prevRec
  }
}

const fakeLlm = {
  complete: async function* () {},
  provider: "openai" as const,
  model: "gpt-test",
  surfaceId: "bench",
  transportId: "openai",
  authMode: "api-key" as const,
}

afterEach(() => resetMetaPathRegistry())

// ── tests ───────────────────────────────────────────────────────────────────

describe("patchRunMeta", () => {
  test("debug gate OFF ⇒ no-op, no throw", async () => {
    await withDebugGate(false, async () => {
      await expect(
        patchRunMeta("any-instance", { verdict: { passed: true } }),
      ).resolves.toBeUndefined()
    })
  })

  test("no registered path ⇒ no-op, no throw (debug ON)", async () => {
    await withDebugGate(true, async () => {
      await expect(
        patchRunMeta("unregistered-id", { verdict: { passed: false } }),
      ).resolves.toBeUndefined()
    })
  })

  test("registered path + debug ON ⇒ merges extra fields into existing meta", async () => {
    const dir = mkTmpDir()
    const trajDir = join(dir, "trajectories")
    // applyBenchTrajectoryMode does NOT mkdir trajectories/ itself — must pre-create.
    await mkdir(trajDir, { recursive: true })
    const basePath = join(dir, "bench.jsonl")
    const instanceId = "psf__requests-1234"

    await withDebugGate(true, async () => {
      // Register the meta path by calling applyBenchTrajectoryMode (which
      // writes the initial meta.json as a fire-and-forget side effect).
      applyBenchTrajectoryMode(
        fakeLlm,
        { kind: "record", path: basePath },
        { provider: "openai", model: "gpt-test" },
        { instanceId },
      )
      // Give the fire-and-forget write time to complete.
      await new Promise((r) => setTimeout(r, 80))

      await patchRunMeta(instanceId, { verdict: { passed: true, patchBytes: 512 } })

      // Find the meta.json in the trajectories/ subdir.
      const { readdirSync } = await import("node:fs")
      const files = readdirSync(trajDir).filter((f) => f.endsWith(".meta.json"))
      expect(files).toHaveLength(1)
      const raw = await readFile(join(trajDir, files[0]), "utf8")
      const meta = JSON.parse(raw)
      expect(meta.instanceId).toBe(instanceId)
      expect(meta.verdict).toMatchObject({ passed: true, patchBytes: 512 })
    })
  })
})
