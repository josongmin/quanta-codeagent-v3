/**
 * Plugin-isolation Bun-spawner — hellgate (ADR-0162 Phase A).
 *
 * Seals the spawner port + Bun adapter across 4 sections — 14 cases total.
 *
 * Sections:
 *   A. Validation surface (4)        — bad serviceName / empty entry /
 *                                       missing entry (spawn-failed) / abort
 *                                       pre-spawn.
 *   B. Spawn-timeout surface (3)     — no first line by deadline / child
 *                                       exits before first line / abort
 *                                       mid-spawn.
 *   C. Wire surface (4)              — happy round-trip / NUL-bearing line
 *                                       dropped / oversize line dropped /
 *                                       oversize send dropped.
 *   D. Lifecycle surface (3)         — kill is idempotent / SIGKILL escalation
 *                                       respects gracefulKillMs / exitPromise
 *                                       never rejects.
 *
 * Each spawned child is a Bun-executed JS one-liner so the hellgate has no
 * fixture files on disk.
 */

import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createBunSpawner,
  DEFAULT_SPAWN_TIMEOUT_MS,
  IsolatedSpawnError,
  MAX_MESSAGE_BYTES,
} from "@/plugin-isolation"

const BUN = process.execPath
// These tests exercise process semantics, not scheduler latency. Keep the
// product watchdog bounded, but let a contended CI worker actually schedule
// the child before deciding whether it exited or emitted its ready frame.
const FIXTURE_SPAWN_TIMEOUT_MS = 10_000
const FIXTURE_TEST_TIMEOUT_MS = FIXTURE_SPAWN_TIMEOUT_MS + 5_000
setDefaultTimeout(FIXTURE_TEST_TIMEOUT_MS)

/** Write a tiny JS file in a tmp dir; return the file path + cleanup. */
const writeScript = async (
  body: string,
): Promise<{ path: string; cleanup: () => Promise<void> }> => {
  const dir = await mkdtemp(join(tmpdir(), "plugin-iso-spawner-"))
  const path = join(dir, "child.mjs")
  await writeFile(path, body, "utf8")
  return {
    path,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

// A child that writes one JSON ready-line then waits for stdin messages and
// echoes them back. Used as the "happy" child by several wire tests.
const ECHO_CHILD = `
process.stdout.write(JSON.stringify({ ready: true }) + "\\n")
let buf = ""
process.stdin.on("data", (c) => {
  buf += c
  let nl
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    if (!line) continue
    try {
      const msg = JSON.parse(line)
      process.stdout.write(JSON.stringify({ echoed: msg }) + "\\n")
    } catch {
      // ignore
    }
  }
})
`

describe("ADR-0162 spawner hellgate — A. Validation", () => {
  const spawner = createBunSpawner()

  test("rejects unicode in serviceName", async () => {
    await expect(spawner.spawn({ entry: BUN, serviceName: "héllo" })).rejects.toBeInstanceOf(
      IsolatedSpawnError,
    )
  })

  test("rejects empty entry", async () => {
    let caught: IsolatedSpawnError | null = null
    try {
      await spawner.spawn({ entry: "", serviceName: "ok" })
    } catch (e) {
      caught = e as IsolatedSpawnError
    }
    expect(caught).not.toBeNull()
    expect(caught?.code).toBe("invalid-entry")
  })

  test("rejects too-long serviceName", async () => {
    const longName = "a".repeat(65)
    await expect(spawner.spawn({ entry: BUN, serviceName: longName })).rejects.toBeInstanceOf(
      IsolatedSpawnError,
    )
  })

  test("rejects when entry does not exist", async () => {
    let caught: IsolatedSpawnError | null = null
    try {
      await spawner.spawn({
        entry: "/definitely/not/a/real/binary-zzzzz",
        serviceName: "missing",
        spawnTimeoutMs: 200,
      })
    } catch (e) {
      caught = e as IsolatedSpawnError
    }
    expect(caught).not.toBeNull()
    // A missing entry is the DETERMINISTIC synchronous-throw path: `Bun.spawn`
    // throws `ENOENT` from `posix_spawn` before any watchdog timer is armed, so
    // the adapter's sync catch surfaces `spawn-failed`. `spawn-timeout` can
    // NEVER occur here (the spawn never succeeds, so the deadline is never set
    // running). Pin the exact code — accepting the timeout masked the fact that
    // the timeout path is unreachable for a non-existent binary.
    expect(caught?.code).toBe("spawn-failed")
  })
})

describe("ADR-0162 spawner hellgate — B. Spawn-timeout", () => {
  const spawner = createBunSpawner()

  test("rejects with spawn-timeout when child never emits a ready line", async () => {
    // Child sits silently forever — Bun forever-loop with no stdout.
    const { path, cleanup } = await writeScript(`setInterval(() => {}, 10000)`)
    try {
      let caught: IsolatedSpawnError | null = null
      try {
        await spawner.spawn({
          entry: BUN,
          args: [path],
          serviceName: "silent",
          spawnTimeoutMs: 150,
        })
      } catch (e) {
        caught = e as IsolatedSpawnError
      }
      expect(caught?.code).toBe("spawn-timeout")
    } finally {
      await cleanup()
    }
  })

  test("rejects when child exits before first line", async () => {
    const { path, cleanup } = await writeScript(`process.exit(7)`)
    try {
      let caught: IsolatedSpawnError | null = null
      try {
        await spawner.spawn({
          entry: BUN,
          args: [path],
          serviceName: "die-early",
          spawnTimeoutMs: FIXTURE_SPAWN_TIMEOUT_MS,
        })
      } catch (e) {
        caught = e as IsolatedSpawnError
      }
      expect(caught?.code).toBe("spawn-failed")
    } finally {
      await cleanup()
    }
  })

  test("rejects with spawn-aborted when AbortSignal fires", async () => {
    const { path, cleanup } = await writeScript(`setInterval(() => {}, 10000)`)
    try {
      const ac = new AbortController()
      const pending = spawner.spawn({
        entry: BUN,
        args: [path],
        serviceName: "aborted",
        spawnTimeoutMs: 5000,
        signal: ac.signal,
      })
      ac.abort()
      let caught: IsolatedSpawnError | null = null
      try {
        await pending
      } catch (e) {
        caught = e as IsolatedSpawnError
      }
      expect(caught?.code).toBe("spawn-aborted")
    } finally {
      await cleanup()
    }
  })
})

describe("ADR-0162 spawner hellgate — C. Wire", () => {
  const spawner = createBunSpawner()

  test("happy round-trip — child echoes JSON messages back", async () => {
    const { path, cleanup } = await writeScript(ECHO_CHILD)
    try {
      const handle = await spawner.spawn({
        entry: BUN,
        args: [path],
        serviceName: "echo",
        spawnTimeoutMs: FIXTURE_SPAWN_TIMEOUT_MS,
      })
      const response = Promise.withResolvers<unknown>()
      const unsub = handle.onMessage(response.resolve)
      handle.send({ hello: "world" })
      const received = await response.promise
      unsub()
      await handle.kill()
      expect(received).toEqual({ echoed: { hello: "world" } })
    } finally {
      await cleanup()
    }
  })

  test("NUL-bearing stdout line is dropped (handler never invoked)", async () => {
    // Child writes a NUL-containing line then a clean ready line.
    const body = `
      const buf = Buffer.from([0x7b, 0x00, 0x7d, 0x0a])  // {\\x00}\\n
      process.stdout.write(buf)
      process.stdout.write(JSON.stringify({ ready: true }) + "\\n")
      process.stdout.write(JSON.stringify({ after: "nul" }) + "\\n")
      setInterval(() => {}, 10000)
    `
    const { path, cleanup } = await writeScript(body)
    try {
      const handle = await spawner.spawn({
        entry: BUN,
        args: [path],
        serviceName: "nul",
        spawnTimeoutMs: FIXTURE_SPAWN_TIMEOUT_MS,
      })
      const received: unknown[] = []
      const cleanFrame = Promise.withResolvers<void>()
      handle.onMessage((m) => {
        received.push(m)
        if (typeof m === "object" && m !== null && "after" in m) cleanFrame.resolve()
      })
      await cleanFrame.promise
      await handle.kill()
      // We must see the legitimate { after: "nul" } but NOT the NUL-line.
      expect(received).toContainEqual({ after: "nul" })
      for (const m of received) {
        // No element should match the NUL-truncated bogus payload — JSON.parse
        // would have produced `{}` if the NUL had been silently allowed.
        expect(m).not.toEqual({})
      }
    } finally {
      await cleanup()
    }
  })

  test("oversize stdout line is dropped", async () => {
    // Child writes a 1MB line first (over a small cap we'll set), then ready.
    // We override MAX_MESSAGE_BYTES indirectly by emitting a > cap payload.
    // Since the global cap is 10MB, we synthesise an >10MB line — keep it
    // modest (12MB) to avoid OOM on weak CI.
    const body = `
      const big = "x".repeat(${MAX_MESSAGE_BYTES + 1024})
      process.stdout.write(big + "\\n")
      process.stdout.write(JSON.stringify({ ready: true }) + "\\n")
      process.stdout.write(JSON.stringify({ after: "oversize" }) + "\\n")
      setInterval(() => {}, 10000)
    `
    const { path, cleanup } = await writeScript(body)
    try {
      const handle = await spawner.spawn({
        entry: BUN,
        args: [path],
        serviceName: "oversize",
        spawnTimeoutMs: FIXTURE_SPAWN_TIMEOUT_MS,
      })
      const cleanFrame = Promise.withResolvers<unknown>()
      handle.onMessage(cleanFrame.resolve)
      const received = await cleanFrame.promise
      await handle.kill()
      // The sentinel proves the stdout pump advanced past the rejected frame.
      expect(received).toEqual({ after: "oversize" })
    } finally {
      await cleanup()
    }
  })

  test("oversize send payload is silently dropped (NO-THROW)", async () => {
    const { path, cleanup } = await writeScript(ECHO_CHILD)
    try {
      const handle = await spawner.spawn({
        entry: BUN,
        args: [path],
        serviceName: "send-cap",
        spawnTimeoutMs: FIXTURE_SPAWN_TIMEOUT_MS,
      })
      // > MAX_MESSAGE_BYTES character string → encoded ≥ that many bytes.
      const huge = "y".repeat(MAX_MESSAGE_BYTES + 1024)
      expect(() => handle.send({ huge })).not.toThrow()
      const response = Promise.withResolvers<unknown>()
      handle.onMessage(response.resolve)
      handle.send({ after: "oversize-send" })
      expect(await response.promise).toEqual({ echoed: { after: "oversize-send" } })
      await handle.kill()
    } finally {
      await cleanup()
    }
  })
})

describe("ADR-0162 spawner hellgate — D. Lifecycle", () => {
  const spawner = createBunSpawner()

  test("kill() is idempotent — multiple invocations OK", async () => {
    const { path, cleanup } = await writeScript(ECHO_CHILD)
    try {
      const handle = await spawner.spawn({
        entry: BUN,
        args: [path],
        serviceName: "idem",
        spawnTimeoutMs: FIXTURE_SPAWN_TIMEOUT_MS,
      })
      await handle.kill()
      await handle.kill()
      await handle.kill("SIGKILL")
      // exitPromise resolves and never rejects.
      const res = await handle.exitPromise
      expect(res).toBeDefined()
    } finally {
      await cleanup()
    }
  })

  test("SIGKILL escalation fires when child traps SIGTERM (gracefulKillMs)", async () => {
    // Child traps SIGTERM and sleeps. Without escalation it would survive the
    // grace window.
    const body = `
      process.on("SIGTERM", () => {})  // trap
      process.stdout.write(JSON.stringify({ ready: true }) + "\\n")
      setInterval(() => {}, 10000)
    `
    const { path, cleanup } = await writeScript(body)
    try {
      const handle = await spawner.spawn({
        entry: BUN,
        args: [path],
        serviceName: "trap-term",
        spawnTimeoutMs: FIXTURE_SPAWN_TIMEOUT_MS,
        gracefulKillMs: 150,
      })
      const t0 = Date.now()
      await handle.kill()
      const elapsed = Date.now() - t0
      // Must have waited at least the gracefulKillMs before SIGKILL took
      // effect; allow plenty of slack for slow CI.
      expect(elapsed).toBeGreaterThanOrEqual(100)
      const res = await handle.exitPromise
      expect(res).toBeDefined()
    } finally {
      await cleanup()
    }
  })

  test("exitPromise never rejects, even on abnormal exit", async () => {
    const body = `
      process.stdout.write(JSON.stringify({ ready: true }) + "\\n")
      process.exit(42)
    `
    const { path, cleanup } = await writeScript(body)
    try {
      const handle = await spawner.spawn({
        entry: BUN,
        args: [path],
        serviceName: "exit-42",
        spawnTimeoutMs: FIXTURE_SPAWN_TIMEOUT_MS,
      })
      const res = await handle.exitPromise
      expect(res).toBeDefined()
      expect(typeof res.code === "number" || res.code === null).toBe(true)
    } finally {
      await cleanup()
    }
  })

  test("default spawn timeout constant is 5000ms", () => {
    expect(DEFAULT_SPAWN_TIMEOUT_MS).toBe(5_000)
  })
})
