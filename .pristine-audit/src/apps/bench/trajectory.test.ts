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
  stream: async function* () {},
  provider: "openai" as const,
  model: "gpt-test",
  surfaceId: "openai-responses" as const,
  transportId: "public" as const,
  authMode: "api-key" as const,
}

/** A minimal streaming LLMPort so we can exercise the RECORD path end to end
 *  (the recorder wraps `.stream`, drains the events, and appends a cassette
 *  record). Yields one text delta + a stop so a real interaction is captured. */
const streamingFakeLlm = {
  ...fakeLlm,
  // biome-ignore lint/correctness/useYield: async generator streaming fake
  stream: async function* (): AsyncGenerator<{ type: string; delta?: string }> {
    yield { type: "text_delta", delta: "ok" }
    yield { type: "message_stop" }
  },
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
      const file = files[0]
      if (file === undefined) throw new Error("trajectory meta file was not written")
      const raw = await readFile(join(trajDir, file), "utf8")
      const meta = JSON.parse(raw)
      expect(meta.instanceId).toBe(instanceId)
      expect(meta.verdict).toMatchObject({ passed: true, patchBytes: 512 })
    })
  })
})

// One FILE = one SESSION: the primary port carries the instanceId ctx (run-main
// wires `instanceFreshLlm()`), so record mode must write the cassette to the
// per-instance path `trajectories/<ts>-<instanceId>.jsonl` AND stamp
// `metadata.instanceId` into every recorded interaction — the exact contract the
// trajectory viewer relies on to group turns into one instance session.
describe("applyBenchTrajectoryMode — per-instance cassette", () => {
  test("record + instanceId ⇒ cassette in trajectories/ with instanceId stamped", async () => {
    const dir = mkTmpDir()
    const trajDir = join(dir, "trajectories")
    await mkdir(trajDir, { recursive: true })
    const basePath = join(dir, "bench.jsonl")
    const instanceId = "astropy__astropy-13033"

    const port = applyBenchTrajectoryMode(
      streamingFakeLlm as unknown as Parameters<typeof applyBenchTrajectoryMode>[0],
      { kind: "record", path: basePath },
      { provider: "openai", model: "gpt-test" },
      { instanceId },
    )
    // Drive one interaction so the recorder appends a cassette record.
    for await (const _ of port.stream({
      messages: [{ role: "user", content: "reproduce the issue" }],
    } as unknown as Parameters<typeof port.stream>[0])) {
      // drain
    }
    await new Promise((r) => setTimeout(r, 80))

    const { readdirSync } = await import("node:fs")
    const cassettes = readdirSync(trajDir).filter((f) => f.endsWith(".jsonl"))
    // exactly one per-instance cassette, filename carries the (sanitized) id
    expect(cassettes).toHaveLength(1)
    const cassette = cassettes[0] ?? ""
    expect(cassette).toContain("astropy__astropy-13033")
    const lines = (await readFile(join(trajDir, cassette), "utf8")).split("\n").filter(Boolean)
    expect(lines.length).toBeGreaterThan(0)
    const rec = JSON.parse(lines[0] ?? "{}")
    // the stamp the viewer keys sessions on
    expect(rec.metadata.instanceId).toBe(instanceId)
  })
})
