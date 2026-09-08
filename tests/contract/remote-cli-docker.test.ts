/**
 * G-F9.4 — live Docker/Lima rail, split from install-time PATH lookup.
 *
 * Selection (`buildCliRemoteSeams`) does not exec docker/lima. This file
 * drives the SAME seams the CLI index injects (`createArgvCliProcess`)
 * against a real daemon when one is present. Absent daemon → skip locally;
 * `REQUIRE_CONTRACT=1` fails closed via {@link requireContract}.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { buildCliRemoteSeams } from "@/apps/cli/remote-dependencies/seams"
import { selectRemoteRunner } from "@/remote"
import { requireContract } from "./_guard"

const PROBE_MS = 8_000
const RUN_MS = 60_000

const probeArgv = async (argv: readonly string[]): Promise<boolean> => {
  try {
    const proc = Bun.spawn([...argv], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
    const timer = setTimeout(() => {
      try {
        proc.kill()
      } catch {
        // already exited
      }
    }, PROBE_MS)
    try {
      return (await proc.exited) === 0
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return false
  }
}

const inspectImage = async (name: string): Promise<boolean> =>
  probeArgv(["docker", "image", "inspect", name])

const pickLiveImage = async (): Promise<string | null> => {
  for (const name of ["alpine:latest", "alpine", "node:22-slim"] as const) {
    if (await inspectImage(name)) return name
  }
  return null
}

const dockerUp = requireContract("docker", await probeArgv(["docker", "version"]))
const liveImage = dockerUp ? await pickLiveImage() : null
const limaBin = Bun.which("limactl") !== null
const limaVmRunning =
  limaBin &&
  (await (async () => {
    try {
      const proc = Bun.spawn(["limactl", "list"], {
        stdout: "pipe",
        stderr: "ignore",
        stdin: "ignore",
      })
      const out = await new Response(proc.stdout).text()
      return (await proc.exited) === 0 && /\bRunning\b/i.test(out)
    } catch {
      return false
    }
  })())

const skipIfNoDocker = test.skipIf(!dockerUp)
const skipIfNoLocalImage = test.skipIf(liveImage === null)
const skipIfNoLimaBin = test.skipIf(!limaBin)
const skipIfNoLimaVm = test.skipIf(!limaVmRunning)

const spawned: Array<{ cancel: () => Promise<void> }> = []
afterAll(async () => {
  for (const item of spawned) {
    await item.cancel().catch(() => undefined)
  }
})

describe("G-F9.4 live remote CLI seams", () => {
  test("production builder still does not exec docker at selection", () => {
    const r = buildCliRemoteSeams({ QUANTA_REMOTE_RUNNER: "docker" })
    if (Bun.which("docker") === null) {
      expect(r.reason).toBe("missing-binary")
      expect(selectRemoteRunner({ QUANTA_REMOTE_RUNNER: "docker" }, r.seams)).toBeNull()
      return
    }
    expect(r.reason).toBe("ready")
    expect(r.seams.dockerProcess).toBeDefined()
    expect(selectRemoteRunner({ QUANTA_REMOTE_RUNNER: "docker" }, r.seams)).not.toBeNull()
  })

  skipIfNoDocker("docker daemon: production seams yield a runner", () => {
    const r = buildCliRemoteSeams({ QUANTA_REMOTE_RUNNER: "docker" })
    expect(r.reason).toBe("ready")
    expect(selectRemoteRunner({ QUANTA_REMOTE_RUNNER: "docker" }, r.seams)).not.toBeNull()
  })

  skipIfNoLocalImage(
    "live docker spawn/status/cancel via CLI argv seams",
    async () => {
      const env = { QUANTA_REMOTE_RUNNER: "docker" }
      const resolved = buildCliRemoteSeams(env)
      expect(resolved.reason).toBe("ready")
      const runner = selectRemoteRunner(env, resolved.seams)
      expect(runner).not.toBeNull()
      if (runner === null || liveImage === null) return
      const spawnedRun = await runner.spawn({
        image: liveImage,
        cmd: ["echo", "g-f9-live"],
      })
      expect(spawnedRun.ok).toBe(true)
      if (!spawnedRun.ok) return
      spawned.push({ cancel: async () => void (await runner.cancel(spawnedRun.value)) })
      const st = await runner.status(spawnedRun.value)
      expect(st.ok).toBe(true)
      const cancelled = await runner.cancel(spawnedRun.value)
      expect(cancelled.ok).toBe(true)
    },
    RUN_MS,
  )

  skipIfNoLimaBin("lima factory is non-null when limactl is on PATH", () => {
    const env = { QUANTA_REMOTE_RUNNER: "lima" }
    const resolved = buildCliRemoteSeams(env)
    expect(resolved.reason).toBe("ready")
    expect(selectRemoteRunner(env, resolved.seams)).not.toBeNull()
  })

  skipIfNoLimaVm(
    "live lima spawn/status/cancel via CLI argv seams",
    async () => {
      const env = { QUANTA_REMOTE_RUNNER: "lima" }
      const resolved = buildCliRemoteSeams(env)
      expect(resolved.reason).toBe("ready")
      const runner = selectRemoteRunner(env, resolved.seams)
      expect(runner).not.toBeNull()
      if (runner === null) return
      const spawnedRun = await runner.spawn({
        image: "alpine",
        cmd: ["echo", "g-f9-live"],
      })
      expect(spawnedRun.ok).toBe(true)
      if (!spawnedRun.ok) return
      spawned.push({ cancel: async () => void (await runner.cancel(spawnedRun.value)) })
      const st = await runner.status(spawnedRun.value)
      expect(st.ok).toBe(true)
      const cancelled = await runner.cancel(spawnedRun.value)
      expect(cancelled.ok).toBe(true)
    },
    RUN_MS,
  )
})
