/**
 * Plugin-isolation Bun-spawner — happy-path unit (ADR-0162 Phase A).
 *
 * Complements the hellgate by asserting the happy-path observable contract:
 * env wiring, multiple onMessage listeners, late-subscriber dispatch, default
 * gracefulKill constant, and unsubscribe idempotence.
 *
 * NOTE on the wire: the FIRST stdout line from the child is the READY
 * sentinel and is NOT forwarded to onMessage listeners (DXT semantics —
 * subscriptions only exist after spawn resolves, so dispatching the first
 * line would race). Tests that want to observe a payload always emit a
 * second line after the ready sentinel.
 */

import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createBunSpawner,
  DEFAULT_GRACEFUL_KILL_MS,
  DEFAULT_SPAWN_TIMEOUT_MS,
} from "@/plugin-isolation"

const BUN = process.execPath

const writeScript = async (
  body: string,
): Promise<{ path: string; cleanup: () => Promise<void> }> => {
  const dir = await mkdtemp(join(tmpdir(), "plugin-iso-spawner-unit-"))
  const path = join(dir, "child.mjs")
  await writeFile(path, body, "utf8")
  return { path, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

describe("ADR-0162 spawner happy-path", () => {
  const spawner = createBunSpawner()

  test("default constants are exposed and match DXT", () => {
    expect(DEFAULT_SPAWN_TIMEOUT_MS).toBe(5_000)
    expect(DEFAULT_GRACEFUL_KILL_MS).toBe(5_000)
  })

  test("QUANTA_SERVICE_NAME env is propagated to child", async () => {
    // Real env-access verification: ensure the parent process.env does NOT
    // already carry the value (otherwise the assertion would be tautological).
    const prev = process.env.QUANTA_SERVICE_NAME
    process.env.QUANTA_SERVICE_NAME = undefined
    // Emit ready line first (sentinel), then a payload line with the env.
    const body = `
      process.stdout.write(JSON.stringify({ kind: "ready" }) + "\\n")
      process.stdout.write(JSON.stringify({ svc: process.env.QUANTA_SERVICE_NAME }) + "\\n")
      setInterval(() => {}, 10000)
    `
    const { path, cleanup } = await writeScript(body)
    try {
      const handle = await spawner.spawn({
        entry: BUN,
        args: [path],
        serviceName: "alpha-svc",
        spawnTimeoutMs: 2000,
      })
      const got: unknown[] = []
      handle.onMessage((m) => got.push(m))
      const deadline = Date.now() + 1500
      while (got.length < 1 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25))
      }
      await handle.kill()
      expect(got).toContainEqual({ svc: "alpha-svc" })
      // Post: spawner did not mutate the PARENT env (child-only injection).
      expect(process.env.QUANTA_SERVICE_NAME).toBeUndefined()
    } finally {
      process.env.QUANTA_SERVICE_NAME = prev
      await cleanup()
    }
  })

  test("QUANTA_ALLOW_UNSIGNED env is set when opt-in", async () => {
    // Real env-access verification: clear in parent to prove the child sees
    // it ONLY because the spawner injected it.
    const prev = process.env.QUANTA_ALLOW_UNSIGNED
    process.env.QUANTA_ALLOW_UNSIGNED = undefined
    const body = `
      process.stdout.write(JSON.stringify({ kind: "ready" }) + "\\n")
      process.stdout.write(JSON.stringify({ unsigned: process.env.QUANTA_ALLOW_UNSIGNED ?? "unset" }) + "\\n")
      setInterval(() => {}, 10000)
    `
    const { path, cleanup } = await writeScript(body)
    try {
      const handle = await spawner.spawn({
        entry: BUN,
        args: [path],
        serviceName: "unsigned-svc",
        allowLoadingUnsignedLibraries: true,
        spawnTimeoutMs: 2000,
      })
      const got: unknown[] = []
      handle.onMessage((m) => got.push(m))
      const deadline = Date.now() + 1500
      while (got.length < 1 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25))
      }
      await handle.kill()
      expect(got).toContainEqual({ unsigned: "1" })
      // Parent env stays clear (child-only flag).
      expect(process.env.QUANTA_ALLOW_UNSIGNED).toBeUndefined()
    } finally {
      process.env.QUANTA_ALLOW_UNSIGNED = prev
      await cleanup()
    }
  })

  test("multiple onMessage listeners all fire (delayed payload)", async () => {
    // Use a SLOW payload (50ms after ready) so both subscribers can register
    // before the message arrives — this is the realistic shape (fan-out, not
    // race against the pump). The early-buffer semantic is asserted in a
    // separate test below.
    const body = `
      process.stdout.write(JSON.stringify({ kind: "ready" }) + "\\n")
      setTimeout(() => {
        process.stdout.write(JSON.stringify({ tick: 1 }) + "\\n")
      }, 50)
      setInterval(() => {}, 10000)
    `
    const { path, cleanup } = await writeScript(body)
    try {
      const handle = await spawner.spawn({
        entry: BUN,
        args: [path],
        serviceName: "multi",
        spawnTimeoutMs: 2000,
      })
      const a: unknown[] = []
      const b: unknown[] = []
      handle.onMessage((m) => a.push(m))
      handle.onMessage((m) => b.push(m))
      const deadline = Date.now() + 1500
      while ((a.length < 1 || b.length < 1) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25))
      }
      await handle.kill()
      expect(a).toEqual([{ tick: 1 }])
      expect(b).toEqual([{ tick: 1 }])
    } finally {
      await cleanup()
    }
  })

  test("first subscriber drains early-buffered messages (post-ready race)", async () => {
    // Child fires payload IMMEDIATELY after ready (same pump iteration). The
    // first subscriber must still see it — early-buffer semantic.
    const body = `
      process.stdout.write(JSON.stringify({ kind: "ready" }) + "\\n")
      process.stdout.write(JSON.stringify({ early: true }) + "\\n")
      setInterval(() => {}, 10000)
    `
    const { path, cleanup } = await writeScript(body)
    try {
      const handle = await spawner.spawn({
        entry: BUN,
        args: [path],
        serviceName: "early-buf",
        spawnTimeoutMs: 2000,
      })
      const got: unknown[] = []
      handle.onMessage((m) => got.push(m))
      const deadline = Date.now() + 1500
      while (got.length < 1 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25))
      }
      await handle.kill()
      expect(got).toContainEqual({ early: true })
    } finally {
      await cleanup()
    }
  })

  test("unsubscribe is idempotent + prevents further delivery", async () => {
    const body = `
      process.stdout.write(JSON.stringify({ kind: "ready" }) + "\\n")
      let n = 0
      const id = setInterval(() => {
        n++
        process.stdout.write(JSON.stringify({ n }) + "\\n")
      }, 20)
    `
    const { path, cleanup } = await writeScript(body)
    try {
      const handle = await spawner.spawn({
        entry: BUN,
        args: [path],
        serviceName: "unsub",
        spawnTimeoutMs: 2000,
      })
      const received: unknown[] = []
      const unsub = handle.onMessage((m) => received.push(m))
      await new Promise((r) => setTimeout(r, 150))
      unsub()
      unsub() // idempotent — must not throw
      const snapshot = received.length
      await new Promise((r) => setTimeout(r, 150))
      await handle.kill()
      // After unsubscribe, count must NOT keep growing.
      expect(received.length).toBe(snapshot)
      expect(snapshot).toBeGreaterThan(0)
    } finally {
      await cleanup()
    }
  })

  test("pid is positive and stable", async () => {
    const body = `process.stdout.write(JSON.stringify({ ready: true }) + "\\n"); setInterval(()=>{},10000)`
    const { path, cleanup } = await writeScript(body)
    try {
      const handle = await spawner.spawn({
        entry: BUN,
        args: [path],
        serviceName: "pid",
        spawnTimeoutMs: 2000,
      })
      expect(handle.pid).toBeGreaterThan(0)
      const a = handle.pid
      const b = handle.pid
      expect(a).toBe(b)
      await handle.kill()
    } finally {
      await cleanup()
    }
  })

  test("serviceName is mirrored on the handle", async () => {
    const body = `process.stdout.write(JSON.stringify({ ready: true }) + "\\n"); setInterval(()=>{},10000)`
    const { path, cleanup } = await writeScript(body)
    try {
      const handle = await spawner.spawn({
        entry: BUN,
        args: [path],
        serviceName: "mirror-svc",
        spawnTimeoutMs: 2000,
      })
      expect(handle.serviceName).toBe("mirror-svc")
      await handle.kill()
    } finally {
      await cleanup()
    }
  })

  test("send from inside an onMessage handler is safe (no re-entrance hazard)", async () => {
    // Child:
    //  1. ready line (sentinel — not delivered to listeners)
    //  2. echoes any { req:"echo", v } as { echoed: v }
    const body = `
      process.stdout.write(JSON.stringify({ kind: "ready" }) + "\\n")
      // Trigger payload to start the echo cycle without waiting for stdin.
      process.stdout.write(JSON.stringify({ kind: "go" }) + "\\n")
      let buf = ""
      process.stdin.on("data", (c) => {
        buf += c
        let nl
        while ((nl = buf.indexOf("\\n")) >= 0) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          if (!line) continue
          const m = JSON.parse(line)
          if (m.req === "echo") process.stdout.write(JSON.stringify({ echoed: m.v }) + "\\n")
        }
      })
    `
    const { path, cleanup } = await writeScript(body)
    try {
      const handle = await spawner.spawn({
        entry: BUN,
        args: [path],
        serviceName: "reent",
        spawnTimeoutMs: 2000,
      })
      const got: unknown[] = []
      handle.onMessage((m) => {
        got.push(m)
        // Re-entrant send from within handler — must not deadlock or throw.
        const o = m as { kind?: string }
        if (o.kind === "go") handle.send({ req: "echo", v: "hi" })
      })
      const deadline = Date.now() + 2000
      while (got.length < 2 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25))
      }
      await handle.kill()
      expect(got).toEqual([{ kind: "go" }, { echoed: "hi" }])
    } finally {
      await cleanup()
    }
  })
})
